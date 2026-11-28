import {expect,test} from 'bun:test';
import {openApplicationSyncV2Core} from '../../src/sync-v2/application-core';
import type {WatchProjectionStore} from '../../src/sync-v2/store';
import {digest,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {createCloudTransport} from '../../src/cloud/transport';
import {fixture} from './p6-fix-fixture';

const openApplicationSyncV2=(options:Omit<Parameters<typeof openApplicationSyncV2Core>[0],'createUi'>)=>
 openApplicationSyncV2Core({...options,createUi:({projection})=>({dispose(){},store:projection as WatchProjectionStore})});
const pathOf=(url:string)=>decodeURIComponent(new URL(url).pathname.replace('/functions/v1/sync/v2',''));
const putBytes=(path:string)=>path.startsWith('/objects/')&&path.includes('/parts/');
const readsIndex=(method:string,path:string)=>path==='/objects/batch-get'||
 method==='GET'&&(path.startsWith('/objects/')||path.startsWith('/state-refs/'));

async function addFolders(db:Awaited<ReturnType<typeof fixture>>['db'],count:number){
 const insert=db.raw.query('INSERT INTO memo_folders VALUES(?,?,?,?,?,0,0)');
 db.raw.transaction(()=>{
  for(let i=0;i<count;i++)insert.run('folder-'+i,'Folder '+i,0,100,'watch');
 })();
}

test('six upload lanes drain on error and a reopened worker keeps verified PUTs',async()=>{
 const f=await fixture();
 await addFolders(f.db,16);
 const active={objects:0,refs:0},peak={objects:0,refs:0},puts=new Map<string,number>();
 let fail=true,opened:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 const transport={async request(r:Parameters<typeof f.options.transport.request>[0]){
  const path=pathOf(r.url),kind=putBytes(path)||path.endsWith('/complete')?'objects':path==='/state-refs'?'refs':null;
  if(!kind)return f.server.request(r);
  peak[kind]=Math.max(peak[kind],++active[kind]);
  const injected=fail&&putBytes(path);
  if(injected)fail=false;
  try{
   await Bun.sleep(injected?1:6);
   if(injected)throw Error('injected_put_failure');
   const reply=await f.server.request(r);
   if(putBytes(path))puts.set(path,(puts.get(path)??0)+1);
   return reply;
  }finally{active[kind]--;}
 }};
 try{
  await expect(openApplicationSyncV2({...f.options,transport})).rejects.toThrow('injected_put_failure');
  expect(active).toEqual({objects:0,refs:0});
  expect(peak.objects).toBe(6);
  expect(puts.size).toBe(5);
  expect(f.server.publishedBodies).toHaveLength(0);
  opened=await openApplicationSyncV2({...f.options,transport});
  expect(opened!.initialResult.completionError).toBeNull();
  expect(f.server.publishedBodies).toHaveLength(1);
  expect(peak).toEqual({objects:6,refs:6});
  expect([...puts.values()].every(n=>n===1)).toBe(true);
 }finally{await opened?.close();f.db.close();}
});

test('a 64-row self publication is observed locally and the next chunk waits after 125 seconds',async()=>{
 const f=await fixture();
 await addFolders(f.db,65);
 let remaining=300_000,reads=0,opened:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 const transport={async request(r:Parameters<typeof f.options.transport.request>[0]){
  const path=pathOf(r.url),response=await f.server.request(r);
  if(readsIndex(r.method,path))reads++;
  if(path==='/account/publish'&&f.server.publishedBodies.length===1)remaining=175_000;
  return response;
 }};
 try{
  opened=await openApplicationSyncV2({...f.options,transport,remainingMillis:()=>remaining});
  expect(opened!.initialResult).toEqual({completionError:'cloud_v2_pending',chunked:true});
  expect(f.server.publishedBodies).toHaveLength(1);
  expect(reads).toBe(0);
  const store=opened!.ui.store,state=await store.readState(),current=state.cloud.current;
  expect(current.commitOid).toBe(f.server.account.commitOid);
  expect(current.signingFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(current.rowCount).toBe(64);
  const firstPage=await store.cloudRows(current.treeRoot);
  const rows=[...firstPage,...await store.cloudRows(current.treeRoot,firstPage.at(-1)!.row.entityKey)];
  expect(rows).toHaveLength(64);
  const witnesses=new Map([...await store.cloudWitnesses(current.treeRoot,rows.slice(0,32).map(r=>r.row.entityKey)),
   ...await store.cloudWitnesses(current.treeRoot,rows.slice(32).map(r=>r.row.entityKey))]);
  expect(witnesses.size).toBe(64);
  for(const {row} of rows)expect(witnesses.get(row.entityKey)?.wire).toBe(digest(row));
  expect(state.cloud.lastPublication.uploadId).toBeUndefined();
  expect((await f.db.query('SELECT COUNT(*) AS n FROM syncv2_upload_objects'))[0]?.n).toBe(0);
  remaining=300_000;
  await expect(opened!.sync()).resolves.toEqual({completionError:null});
  expect(f.server.publishedBodies).toHaveLength(2);
 }finally{await opened?.close();f.db.close();}
});

test('a slow PUT yields with its signed receipt and resumes the original chunk',async()=>{
 const f=await fixture();
 await addFolders(f.db,8);
 let remaining=300_000,slow=true,firstPut='',firstPutCalls=0,opened:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 const transport={async request(r:Parameters<typeof f.options.transport.request>[0]){
  const path=pathOf(r.url),response=await f.server.request(r);
  if(slow&&putBytes(path)){slow=false;remaining=79_000;firstPut=path;}
  if(path===firstPut)firstPutCalls++;
  return response;
 }};
 try{
  opened=await openApplicationSyncV2({...f.options,transport,remainingMillis:()=>remaining});
  expect(opened!.initialResult).toEqual({completionError:'cloud_v2_pending',chunked:true});
  expect(f.server.publishedBodies).toHaveLength(0);
  const store=opened!.ui.store,plan=(await store.readState()).cloud.pendingPublish;
  const id=firstPut.split('/')[2]!,receipt=await store.uploadReceipt(plan.requestId,id);
  expect(receipt.durableOffset).toBeGreaterThan(0);
  await opened!.close();
  remaining=300_000;
  opened=await openApplicationSyncV2({...f.options,transport,remainingMillis:()=>remaining});
  expect(opened!.initialResult.completionError).toBeNull();
  expect(f.server.publishedBodies).toHaveLength(1);
  expect(parseCanonicalJson(Buffer.from(f.server.publishedBodies[0]!,'base64')).account.body.requestId).toBe(plan.requestId);
  expect(firstPutCalls).toBe(1);
 }finally{await opened?.close();f.db.close();}
});

test('a budget yield retains the completed state-refs page',async()=>{
 const f=await fixture();
 await addFolders(f.db,20);
 const refs=new Map<string,number>();
 let remaining=300_000,opened:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 const transport={async request(r:Parameters<typeof f.options.transport.request>[0]){
  const response=await f.server.request(r);
  if(pathOf(r.url)==='/state-refs'){
   const id=parseCanonicalJson(r.body!).body.stateOid;
   refs.set(id,(refs.get(id)??0)+1);
   if(refs.size===16)remaining=79_000;
  }
  return response;
 }};
 try{
  opened=await openApplicationSyncV2({...f.options,transport,remainingMillis:()=>remaining});
  expect(opened!.initialResult).toEqual({completionError:'cloud_v2_pending',chunked:true});
  expect(f.server.publishedBodies).toHaveLength(0);
  expect(refs.size).toBe(16);
  expect((await opened!.ui.store.readState()).cloud.pendingPublish.stateRefsProgress.phase).toBe(0);
  remaining=300_000;
  await expect(opened!.sync()).resolves.toEqual({completionError:null});
  expect(refs.size).toBe(21);
  expect([...refs.values()].every(n=>n===1)).toBe(true);
 }finally{await opened?.close();f.db.close();}
});

test('six v2 uploads reserve only six device temp handles and clean response files',async()=>{
 const input=new Set<string>(),output=new Set<string>();
 let seq=0,active=0,peakNetwork=0,peakHandles=0;
 const transport=createCloudTransport(async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{
  const path=String(args.path);
  if(method==='file.createTemp'){
   const path='cloud-http/.pod-write-'+(++seq)+'.part';
   input.add(path);
   peakHandles=Math.max(peakHandles,input.size);
   return {path} as T;
  }
  if(method==='file.write')return {size:1} as T;
  if(method==='http.download'){
   expect(input.has(String(args.bodyPath))).toBe(true);
   expect(path).toBe(args.bodyPath+'.response');
   expect(output.has(path)).toBe(false);
   output.add(path);
   peakNetwork=Math.max(peakNetwork,++active);
   await Bun.sleep(5);
   active--;
   return {status:200,headers:{},size:0,path} as T;
  }
  if(method==='file.delete'){
   input.delete(path);output.delete(path);return {} as T;
  }
  throw Error(method);
 },{require(){}},{reuseInputName:true});
 await Promise.all(Array.from({length:12},()=>transport.request({method:'PUT',url:'https://cloud.invalid/index',headers:{},body:new Uint8Array(1)})));
 expect(peakNetwork).toBe(6);
 expect(peakHandles).toBe(6);
 expect(input.size+output.size).toBe(0);
});
