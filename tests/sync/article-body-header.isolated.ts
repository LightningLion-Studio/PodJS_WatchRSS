import {test,expect,mock} from 'bun:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {encodeUtf8} from '@podjs/framework/bytes';
import {stableGzipHeader} from '@podjs/framework/crypto';
import {encodeBodyJson} from '../../src/sync/article-body';
import {initializeSchema} from '../../src/core/schema';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {article,parseUri} from './ble-v2-fixture';

const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
const files=new Map<string,Uint8Array>();let serial=0,smallSupported=true,invalid=false;
const gzip=(bytes:Uint8Array)=>{const zipped=new Uint8Array(gzipSync(bytes,{level:6}));zipped[4]=17;zipped[9]=0;if(invalid)zipped[3]=2;return zipped;};
const temp=(bytes=new Uint8Array())=>{const path='cloud-crypto/.pod-write-test'+(++serial)+'.part';files.set(path,bytes);return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
const fileChunks={createTemp:async()=>temp(),append:async(path:string,data:string,offset:number)=>{const old=files.get(path)!,part=unb64(data);expect(offset).toBe(old.length);const bytes=new Uint8Array(old.length+part.length);bytes.set(old);bytes.set(part,old.length);files.set(path,bytes);return {size:bytes.length};},read:async(path:string,offset:number,maxBytes:number)=>{const bytes=files.get(path)!;return {size:bytes.length,offset,dataBase64:b64(bytes.subarray(offset,offset+maxBytes))};},remove:async(path:string)=>{files.delete(path);},gzipBytes:async(data:string)=>{if(!smallSupported)throw Error('unknown method');return {dataBase64:b64(gzip(unb64(data)))};},gzip:async(path:string)=>temp(gzip(files.get(path)!))};
mock.module('@podjs/framework/services',()=>({fileChunks,sqlite:{},uri:{parse:parseUri},hostOperation:()=>{throw Error('unexpected host call');},bytesToBase64:b64,base64ToBytes:unb64}));
mock.module('@podjs/framework/text-layout',()=>({yieldWorkTurn:()=>({result:Promise.resolve()})}));
const {hostArticleBodyCodec}=await import('../../src/sync/article-body-host');

test('default foreground codec normalizes small, large and legacy-file fallback output without changing JSON',async()=>{
 for(const supported of [true,false])for(const text of ['', '中文/🙂\n\ud800', '大/🙂'.repeat(20000)]){
  smallSupported=supported;const body={contentHtml:'<p>'+text+'</p>',contentText:text};const zipped=await hostArticleBodyCodec.encode(body);
  expect([...zipped.subarray(0,10)]).toEqual([31,139,8,0,0,0,0,0,0,255]);expect(gunzipSync(zipped)).toEqual(Buffer.from(encodeUtf8(encodeBodyJson(body),'question')));expect(files.size).toBe(0);
 }
 smallSupported=true;invalid=true;
 try{await expect(hostArticleBodyCodec.encode({contentHtml:null,contentText:'x'})).rejects.toThrow('invalid_stable_gzip_header');await expect(hostArticleBodyCodec.encode({contentHtml:null,contentText:'x'.repeat(100000)})).rejects.toThrow('invalid_stable_gzip_header');expect(files.size).toBe(0);}finally{invalid=false;}
});

test('default headless repository stores the same stable wire encoding and preserves it on replay',async()=>{
 const sql=new Database(':memory:');const db={query:async(q:string,p:readonly unknown[]=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q:string,p:readonly unknown[]=[])=>{sql.query(q).run(...p as any[]);},transaction:async(ss:any[])=>{sql.transaction(()=>ss.forEach(s=>sql.query(s.sql).run(...(s.params??[]))))();}};
 try{
  await initializeSchema(db,{seedBuiltinChannels:false});await new SyncSavedStateStore(db).initializeDevice('watch');
  const host=async<T>(method:string,a:any):Promise<T>=>{
   switch(method){
    case 'sql.query':return db.query(a.sql,a.params) as Promise<T>;
    case 'sql.execute':await db.execute(a.sql,a.params);return undefined as T;
    case 'sql.transaction':return sql.transaction(()=>{const changes=a.statements.map((s:any)=>{sql.query(s.sql).run(...(s.params??[]));return Number((sql.query('SELECT changes() n').get() as any).n);});return a.reportChanges?changes:undefined;})() as T;
    case 'file.createTemp':return temp() as T;
    case 'file.write':{const bytes=unb64(a.dataBase64);if(a.append){const old=files.get(a.path)!;expect(a.expectedOffset).toBe(old.length);files.set(a.path,new Uint8Array(Buffer.concat([old,bytes])));}else files.set(a.path,bytes);return {size:files.get(a.path)!.length} as T;}
    case 'file.read':return fileChunks.read(a.path,a.offset,a.maxBytes) as Promise<T>;
    case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0} as T;
    case 'file.hash':return {sha256:createHash('sha256').update(files.get(a.path)!).digest('hex'),size:files.get(a.path)!.length} as T;
    case 'file.delete':files.delete(a.path);return undefined as T;
    case 'file.gzip':return temp(gzip(files.get(a.path)!)) as T;
    case 'file.gunzip':return temp(new Uint8Array(gunzipSync(files.get(a.path)!))) as T;
    case 'crypto.hash':return {digestBase64:createHash('sha256').update(unb64(a.dataBase64)).digest('base64')} as T;
    case 'uri.parse':return parseUri(a.value) as Promise<T>;
    default:throw Error('unexpected headless host '+method);
   }
  };
  const repo=await createBackgroundLibrary(host,async()=>null,{require(){}}),a=article({contentHtml:null,contentText:'后台正文/🙂'});
  await repo.mergeCloud([], [a], 'phone');const expected=stableGzipHeader(gzip(encodeUtf8(encodeBodyJson(a),'question'))),row=(await db.query('SELECT body_hash,chunk_hashes,body_bytes FROM article_sync_content'))[0];
  expect(row.body_hash).toBe(createHash('sha256').update(expected).digest('hex'));expect(row.body_bytes).toBe(expected.length);expect(JSON.parse(row.chunk_hashes)).toEqual([row.body_hash]);
  await repo.mergeCloud([], [a], 'phone');expect((await db.query('SELECT body_hash,chunk_hashes,body_bytes FROM article_sync_content'))[0]).toEqual(row);expect(files.size).toBe(0);
 }finally{sql.close();files.clear();}
});
