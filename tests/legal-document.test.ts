import {expect,test} from 'bun:test';
import {fetchLegalDocument,type LegalDocumentPorts} from '../src/onboarding/legal-document.ts';
import config from '../pod.config.json';
import {bytesToBase64,stringToUtf8} from '@podjs/framework/bytes';
import type {DownloadResult} from '@podjs/framework/services';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const result=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {result,resolve,reject};
}
let fileSequence=0;
function fixture(text:string|Uint8Array){
 const bytes=typeof text==='string'?stringToUtf8(text):text;
 const calls:{args:Record<string,unknown>[];reads:{path:string;offset:number;maxBytes:number}[];removed:string[];cancels:number}={args:[],reads:[],removed:[],cancels:0};
 const ports:LegalDocumentPorts={
  async createTemp(directory){expect(directory).toBe('legal-documents');return {path:`${directory}/.pod-write-fixture-${++fileSequence}.part`};},
  download(args){calls.args.push(args);return {result:Promise.resolve({status:200,headers:{},url:String(args.url),path:String(args.path),size:bytes.length}),cancel(){calls.cancels++;}};},
  async read(path,offset,maxBytes){calls.reads.push({path,offset,maxBytes});const end=Math.min(bytes.length,offset+maxBytes);return {offset,size:bytes.length,eof:end===bytes.length,dataBase64:bytesToBase64(bytes.slice(offset,end))};},
  async remove(path){calls.removed.push(path);},
 };
 return {bytes,calls,ports};
}

test('legal request preserves native text, cache/version headers and timeout policy',async()=>{
 for(const text of [' \n正文中文😀𠮷\n ', ' {"content":"This remains JSON"} ', ' <h1>协议 &amp; 正文</h1> ']){
  const f=fixture(text);expect(await fetchLegalDocument('https://legal.example/privacy',f.ports).result).toBe(text.trim());
  expect(f.calls.args).toHaveLength(1);const args=f.calls.args[0];
  expect(args).toEqual({url:'https://legal.example/privacy',path:expect.stringMatching(/^legal-documents\/\.pod-write-[a-z0-9-]+\.part$/),temporary:true,maxBytes:512*1024,text:true,timeoutMs:8000,readTimeoutMs:12000,
   headers:{'Cache-Control':'no-cache, no-store','X-WatchRSS-App-Version':`watch-${config.versionName.trim()}+${config.versionCode}`}});
  expect(f.calls.removed).toEqual([args.path as string,args.path as string]);
 }
});

test('full 512 KiB response exceeds the Pocket fetch limit and decodes Unicode across chunk boundaries',async()=>{
 // Both three- and four-byte characters straddle the 64 KiB read boundary.
 for(const character of ['中','😀']){
  const body='x'.repeat(65535)+character+'y'.repeat(512*1024-65535-stringToUtf8(character).length);
  const f=fixture(body);expect(f.bytes.length).toBe(512*1024);
  expect(await fetchLegalDocument('https://legal.example/terms',f.ports).result).toBe(body);
  expect(f.calls.reads.map(row=>row.offset)).toEqual([0,65536,131072,196608,262144,327680,393216,458752]);
  expect(f.calls.reads.every(row=>row.maxBytes===65536)).toBe(true);
  expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
 }
});

test('concurrent requests own distinct paths and only clean their own files',async()=>{
 const f=fixture('协议');const requests=Array.from({length:10},()=>fetchLegalDocument('https://legal.example/terms',f.ports));
 expect(await Promise.all(requests.map(row=>row.result))).toEqual(Array(10).fill('协议'));
 const paths=f.calls.args.map(args=>args.path as string);expect(new Set(paths).size).toBe(10);
 expect([...f.calls.removed].sort()).toEqual([...paths,...paths].sort());
 expect(f.calls.reads.every(read=>paths.includes(read.path))).toBe(true);
});

test('download failures and invalid metadata never read or delete a response-selected path',async()=>{
 for(const invalid of [
  {size:512*1024+1},{size:-1},{size:1.5},{size:NaN},{size:Infinity},{status:404},{status:299.5},{path:'reader_assets/keep.txt'},
 ]){
  const f=fixture('x'),download=f.ports.download;
  f.ports.download=args=>{const request=download(args);return {...request,result:request.result.then(value=>({...value,...invalid}))};};
  await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toThrow();
  expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
 }
 const f=fixture('unused'),failure=Error('connection timed out');
 f.ports.download=args=>{f.calls.args.push(args);return {result:Promise.reject(failure),cancel(){f.calls.cancels++;}};};
 await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toBe(failure);
 expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
});

test('chunk corruption, noncanonical base64, and inconsistent offsets are rejected with cleanup',async()=>{
 const cases=[{offset:1},{size:99},{eof:false},{dataBase64:''},{dataBase64:'!!!!'},{dataBase64:'eB=='},{dataBase64:'eA==eA=='}];
 for(const invalid of cases){
  const f=fixture('x'),read=f.ports.read;
  f.ports.read=async(path,offset,maxBytes)=>({...await read(path,offset,maxBytes),...invalid});
  await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toThrow();
  expect(f.calls.reads).toHaveLength(1);expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
 }
 const f=fixture('xyz');f.ports.read=async()=>{throw Error('file disappeared');};
 await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toThrow('file disappeared');
 expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
});

test('short but consistent reads progress, while malformed UTF-8 and empty text fail',async()=>{
 const f=fixture('A中😀B'),read=f.ports.read;
 f.ports.read=(path,offset)=>read(path,offset,1);
 expect(await fetchLegalDocument('https://legal.example/terms',f.ports).result).toBe('A中😀B');
 expect(f.calls.reads.map(row=>row.offset)).toEqual([0,1,2,3,4,5,6,7,8]);
 for(const body of ['', ' \r\n\t ',new Uint8Array([0xe4,0xb8])]){
  const invalid=fixture(body);await expect(fetchLegalDocument('https://legal.example/terms',invalid.ports).result).rejects.toThrow();
  expect(invalid.calls.removed).toEqual([invalid.calls.args[0].path as string,invalid.calls.args[0].path as string]);
 }
});

test('cancelling pending download rejects promptly, is idempotent, and ignores late success',async()=>{
 const f=fixture('late'),pending=deferred<DownloadResult>(),started=deferred<void>();
 f.ports.download=args=>{f.calls.args.push(args);started.resolve();return {result:pending.result,cancel(){f.calls.cancels++;}};};
 const request=fetchLegalDocument('https://legal.example/terms',f.ports);
 await started.result;
 request.cancel();request.cancel();await expect(request.result).rejects.toThrow('已取消');expect(f.calls.cancels).toBe(1);
 const args=f.calls.args[0];pending.resolve({status:200,headers:{},url:String(args.url),path:String(args.path),size:f.bytes.length});
 await Promise.resolve();await Promise.resolve();
 expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([args.path as string,args.path as string]);
});

test('cancelling an in-flight read suppresses its result and still cleans only the owned download',async()=>{
 const f=fixture('late'),pending=deferred<Awaited<ReturnType<LegalDocumentPorts['read']>>>(),reading=deferred<void>();
 f.ports.read=async(path,offset,maxBytes)=>{f.calls.reads.push({path,offset,maxBytes});reading.resolve();return pending.result;};
 const request=fetchLegalDocument('https://legal.example/terms',f.ports);await reading.result;
 request.cancel();await expect(request.result).rejects.toThrow('已取消');expect(f.calls.cancels).toBe(1);
 pending.resolve({offset:0,size:f.bytes.length,eof:true,dataBase64:bytesToBase64(f.bytes)});await Promise.resolve();await Promise.resolve();await Promise.resolve();
 expect(f.calls.reads).toHaveLength(1);expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
});

test('cleanup failure preserves download failure and completed requests ignore later cancellation',async()=>{
 const f=fixture('正文');f.ports.remove=async path=>{f.calls.removed.push(path);if(f.calls.removed.length%2===0)throw Error('cleanup failure');};
 const request=fetchLegalDocument('https://legal.example/terms',f.ports);expect(await request.result).toBe('正文');
 request.cancel();expect(f.calls.cancels).toBe(0);
 f.ports.read=async()=>{throw Error('read failed');};
 await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toThrow('read failed');
});

test('temporary allocation failure or an unexpected allocation path never deletes existing data',async()=>{
 for(const mode of ['failure','unexpected-path']){
  const f=fixture('正文');
  f.ports.createTemp=async()=>{if(mode==='failure')throw Error('temporary files full');return {path:'reader_assets/keep.txt'};};
  await expect(fetchLegalDocument('https://legal.example/terms',f.ports).result).rejects.toThrow();
  expect(f.calls.args).toEqual([]);expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([]);
 }
 const f=fixture('正文'),sentinel='legal-documents/.pod-write-existing.part',allocated='legal-documents/.pod-write-owned.part';
 const files=new Map([[sentinel,'kept original']]);
 f.ports.createTemp=async()=>{expect(files.has(allocated)).toBe(false);files.set(allocated,'');return {path:allocated};};
 const download=f.ports.download;f.ports.download=args=>{expect(files.has(String(args.path))).toBe(false);files.set(String(args.path),'正文');return download(args);};
 f.ports.remove=async path=>{f.calls.removed.push(path);return files.delete(path);};
 expect(await fetchLegalDocument('https://legal.example/terms',f.ports).result).toBe('正文');
 expect([...files]).toEqual([[sentinel,'kept original']]);expect(f.calls.removed).toEqual([allocated,allocated]);
});

test('cancellation before allocation completes releases only the late owned file and never downloads',async()=>{
 const f=fixture('正文'),allocated=deferred<{path:string}>();f.ports.createTemp=()=>allocated.result;
 const request=fetchLegalDocument('https://legal.example/terms',f.ports);request.cancel();
 await expect(request.result).rejects.toThrow('已取消');
 const path='legal-documents/.pod-write-cancelled.part';allocated.resolve({path});await Promise.resolve();await Promise.resolve();
 expect(f.calls.args).toEqual([]);expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([path]);expect(f.calls.cancels).toBe(0);
});

test('cancelling while final cleanup is pending never delivers already decoded text',async()=>{
 const f=fixture('正文'),cleanup=deferred<void>(),cleaning=deferred<void>();
 f.ports.remove=async path=>{f.calls.removed.push(path);if(f.calls.removed.length===2){cleaning.resolve();await cleanup.result;}};
 const request=fetchLegalDocument('https://legal.example/terms',f.ports);await cleaning.result;
 request.cancel();await expect(request.result).rejects.toThrow('已取消');cleanup.resolve();await Promise.resolve();await Promise.resolve();
 expect(f.calls.removed).toEqual([f.calls.args[0].path as string,f.calls.args[0].path as string]);
});
