import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const encoder=new TextEncoder();
function fixture(stop=''){
 const original=encoder.encode('汉😀verified\n{torn'),files=new Map<string,Uint8Array>([['journal.delta',original]]);let next=0;
 const request=async<T>(method:string,a:any):Promise<T>=>{
  let value:any;
  switch(method){
   case 'file.createTemp':{const path='watch-cloud-cache/.pod-write-'+(++next)+'.part';files.set(path,new Uint8Array());value={path};break;}
   case 'file.read':{const body=files.get(a.path)!;value={offset:a.offset,size:body.length,dataBase64:Buffer.from(body.subarray(a.offset,a.offset+a.maxBytes)).toString('base64')};break;}
   case 'file.write':{if(stop==='copy')throw Error(stop);const before=files.get(a.path)!,part=Buffer.from(a.dataBase64,'base64');expect(a.expectedOffset).toBe(before.length);files.set(a.path,Buffer.concat([before,part]));value={size:before.length+part.length};break;}
   case 'file.hash':if(stop==='hash')throw Error(stop);value={sha256:hash(files.get(a.path)!)};break;
   case 'file.commit':{if(stop==='before-publish')throw Error(stop);const body=files.get(a.path)!;expect(body.length).toBe(a.expectedSize);expect(hash(body)).toBe(a.expectedSha256);files.set(a.target,body);files.delete(a.path);if(stop==='after-publish')throw Error(stop);value={};break;}
   case 'file.delete':files.delete(a.path);value={};break;
   default:throw Error(method);
  }return value as T;
 };
 return {original,files,ports:createCloudHostPorts(request,{require(){}})};
}
test('prefix repair keeps the original until atomic publication and cleans every temporary',async()=>{
 for(const stop of ['', 'copy','hash','before-publish','after-publish'])for(const newline of [false,true]){
  const f=fixture(stop),prefix=encoder.encode('汉😀verified\n'),task=f.ports.files.repairJournal!('journal.delta',prefix.length,newline);
  if(stop)await expect(task).rejects.toThrow(stop);else await task;
  const expected=!stop||stop==='after-publish'?Buffer.concat([prefix,...(newline?[Buffer.from('\n')]:[])]):f.original;
  expect(f.files.get('journal.delta')).toEqual(expected);expect([...f.files.keys()]).toEqual(['journal.delta']);
 }
});
test('journal text streaming rejects malformed UTF8 before byte-prefix repair can copy the wrong offsets',async()=>{
 const calls:string[]=[];let closed=0,strict=false;
 const ports=createCloudHostPorts(async<T>(method:string,a:any)=>{
  calls.push(method);
  if(method==='file.stat')return {exists:true,file:true,size:5} as T;
  if(method==='file.openText'){strict=a.strictUtf8===true;return {id:'strict'} as T;}
  if(method==='file.readTextChunk'){try{return {text:new TextDecoder('utf-8',{fatal:strict}).decode(new Uint8Array([255])),eof:true} as T;}catch{throw Error('malformed UTF8');}}
  if(method==='file.closeText'){closed++;return {} as T;}
  throw Error(method);
 },{require(){}});
 await expect((async()=>{for await(const _ of ports.files.textChunks!('journal.delta')){throw Error('must not yield');}})()).rejects.toThrow('malformed UTF8');
 expect(closed).toBe(1);expect(calls).toEqual(['file.stat','file.openText','file.readTextChunk','file.closeText']);
});
