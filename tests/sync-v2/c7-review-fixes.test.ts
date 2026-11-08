/** C7 review fixes: F1 per-entity quarantine of over-budget remote notes and
 * W2/F6 empty conflict container equivalence. Synthetic backend only. */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {scope,idKey,libraryId,binding,cipher,noteValue,SqlFixture} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {P5Backend} from './p5-fixture';
import {FileHost} from './p3-fixture';
import {recoveryCipher} from './p3b-fixture';
import {jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {SyncV2Http,parseNetwork} from '../../src/sync-v2/http';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {ProjectionGate} from '../../src/sync-v2/gate';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {WatchRecovery} from '../../src/sync-v2/recovery';
import {WatchSpaceStore} from '../../src/sync-v2/space-store';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {WatchAccountBusinessSql} from '../../src/sync-v2/account-business';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {watchMaterializer} from '../../src/sync-v2/materializer';
import {fromWire} from '../../src/sync-v2/business';
import {NOTE_TEXT_BUDGET as NOTE_BUDGET} from '../../src/sync-v2/note-segments';
import {initializeMemoSchema} from '../../src/notes/repository';

const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1},device='a'.repeat(32);
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
/** C7 capability and missing-object answers on top of a synthetic backend. */
const withC7=<T extends new(...a:any[])=>SyntheticIndexBackend>(Base:T)=>class extends Base {
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
};
const C7Backend=withC7(SyntheticIndexBackend),C7P5Backend=withC7(P5Backend);
type Server=InstanceType<typeof C7Backend>;
/** Projection-only client (no business DB): writer devices and pull checks. */
async function client(server:Server,o:{budget?:number}={}){
 const db=new SqlFixture(),store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});await store.initialize();await store.beginScan(binding);
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin());
 const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{noteSegments:true,noteTextBudget:o.budget}),reader=new WatchCloudIndex(store,http,crypto,keys,approved,async()=>{},()=>100,undefined,{noteSegments:true,noteTextBudget:o.budget});
 return {db,store,publisher,reader,
  async scan(rows:any[]){const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<rows.length;i++)await store.scanPage({page:async()=>({rows:[rows[i]],after:'r'+String(i).padStart(4,'0'),done:i===rows.length-1}),changed:async()=>[]});},
  async publish(){const plan=await publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));await publisher.flush();return plan;},
  pull(){return reader.pull(server.window());},
  async adopt(){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});},
  async row(e:string){const s=await store.readState();return store.cloudRow(s.cloud.current.treeRoot,e);},
  close(){db.close();},
 };
}
const note=(id:string,markdown:string,extra:any={})=>({kind:'note',logicalId:id,value:{...noteValue(id),markdown,plainText:'',baseMarkdown:'',...extra}});
/** The watch materializer records memo created_at as addedAtMillis (original). */
const pnote=(id:string,markdown:string,extra:any={})=>({...note(id,markdown,extra),addedAtMillis:1});
const entityOf=async(c:{store:WatchProjectionStore},id:string)=>(await c.store.candidatePage()).find((x:any)=>x.candidate.meta.logicalId===id)!.entityKey;
/** Index row of an entity in the server's current account tree. */
const serverRow=async(server:Server,e:string)=>{const c=await client(server);try{await c.pull();return (await c.row(e))?.row??null;}finally{c.close();}};

test('F1 (review W3): an over-budget remote note is quarantined per entity; other entities, ACK and own publication proceed; shrink and delete recover',async()=>{
 const server=new C7Backend(),phone=await client(server),watch=await client(server,{budget:300000});try{
  // The reader budget is a parameter; 300000 stands in for the 2 MiB watch budget against a larger writer budget.
  const big='p'.repeat(600000);
  await phone.scan([note('big',big),note('other','v1')]);await phone.publish();const eBig=await entityOf(phone,'big'),eOther=await entityOf(phone,'other');
  const remoteBig=(await serverRow(server,eBig))!;
  expect(await watch.pull().then(()=>'ok',(e:Error)=>e.message)).toBe('ok');
  let s=await watch.store.readState();expect(s.account!.revision).toBe(server.account.revision);expect(s.cloud.blockedCommitOid).toBe(null);
  expect(s.cloud.unopenableNotes).toEqual({big:{entityKey:eBig,code:'storage_pressure',deleted:false}});
  const held=await watch.row(eBig);expect(held.unopenable).toEqual({code:'storage_pressure'});expect(held.row.stateOid).toBe(remoteBig.stateOid);expect(held.state.payload.segmentedNote).toBe(true);expect(held).not.toHaveProperty('segments');
  // Another entity's remote edit applies on the next pull; the account and cursor advance.
  await phone.adopt();await phone.scan([note('big',big),note('other','v2 edited on phone')]);await phone.publish();
  expect(await watch.pull().then(()=>'ok',(e:Error)=>e.message)).toBe('ok');s=await watch.store.readState();
  expect(s.account!.revision).toBe(server.account.revision);expect(s.cloud.cursor).toBe(server.serverRevision);
  expect(fromWire('note',(await watch.row(eOther)).meta.payload,(await watch.row(eOther)).state.payload).markdown).toBe('v2 edited on phone');
  // The watch's own unrelated edit publishes and carries the quarantined row unchanged.
  await watch.scan([note('mine','watch local')]);expect(await watch.publish().then(()=>'ok',(e:Error)=>e.message)).toBe('ok');
  const carried=(await serverRow(server,eBig))!;expect(carried.stateOid).toBe(remoteBig.stateOid);expect(carried.metaOid).toBe(remoteBig.metaOid);
  await watch.pull();expect((await watch.store.readState()).cloud.unopenableNotes).toEqual({big:{entityKey:eBig,code:'storage_pressure',deleted:false}});
  // Shrinking below the budget recovers through the normal path.
  await phone.adopt();await phone.scan([note('big','small again'),note('other','v2 edited on phone')]);await phone.publish();
  await watch.pull();s=await watch.store.readState();expect(s.cloud.unopenableNotes).toEqual({});
  const readable=await watch.row(eBig);expect(readable.unopenable).toBeUndefined();expect(fromWire('note',readable.meta.payload,readable.state.payload).markdown).toBe('small again');
  // A long remote tombstone (W1 keeps its text) is quarantined, yet visible as deleted.
  await phone.adopt();await phone.scan([note('big',big,{updatedAt:30})]);await phone.publish();await phone.adopt();await phone.scan([note('big',big,{updatedAt:31,deleted:true,deletedAt:31})]);await phone.publish();
  await watch.pull();s=await watch.store.readState();expect(s.account!.revision).toBe(server.account.revision);
  expect(s.cloud.unopenableNotes).toEqual({big:{entityKey:eBig,code:'storage_pressure',deleted:true}});
 }finally{phone.close();watch.close();}
},240000);

/** Watch with the business DB, materializer and P5 account control. */
async function watchDevice(server:InstanceType<typeof C7P5Backend>,budget:number){
 const root=mkdtempSync(join(tmpdir(),'wrss-c7r-')),db=new SqlFixture(join(root,'state.sqlite'));await initializeMemoSchema(db as any);
 const projection=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true}),cache=new WatchSpaceStore(db,cipher,new ContentFiles(new FileHost(join(root,'files')).request),'6'.repeat(64));await cache.init();
 const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>server.clock,source:async refs=>{if(refs.length)throw Error('closure_incomplete');return [];},reserve:async()=>async()=>{}});
 const native=new WatchAccountBusinessSql(db,projection,scope,idKey,{recoveryValue:async id=>{const c=await projection.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async row=>{if(row.bodyRevision!==null)throw Error('closure_incomplete');},async()=>async()=>{});await native.initialize();await projection.initialize();
 const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('no article body');}} as any)),http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,true,true);
 const publisher=new WatchIndexPublisher(projection,http,crypto,keys,()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget}),reader=new WatchCloudIndex(projection,http,crypto,keys,approved,async()=>{},()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget});
 const control=new WatchAccountControl({store:projection,http,publisher,reader,crypto,approved,business:native,recovery,trustedNow:()=>server.clock,historyRestore:true,choiceApply:true,author:async()=>({deviceId:device,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision}})});
 async function scan(){const cp=await projection.checkpoint();if(!cp)await projection.beginScan(binding);else if(cp.phase==='complete')await projection.beginTailWindow();for(;;){const cp=await projection.checkpoint();if(cp?.phase==='complete')break;if(cp?.phase==='tail')await projection.catchUpPage(source);else await projection.scanPage(source);}}
 return {db,projection,publisher,reader,control,scan,
  async follow(){const r=await control.follow(server.window());await scan();return r;},
  async prepare(){await scan();return publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));},
  async publish(){const plan=await this.prepare();await publisher.flush();await reader.pull(server.window());return plan;},
  note:async(id:string)=>(await db.query('SELECT markdown,deleted FROM memo_notes WHERE note_id=?',[id]))[0]??null,
  close(){db.close();rmSync(root,{recursive:true,force:true});},
 };
}

test('F6/W2: following container-free rows from another device produces no reseal publication',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,NOTE_BUDGET);try{
  const long='r'.repeat(280000);
  // The phone form carries no conflict container; the watch materializer always adds an empty one.
  await phone.scan([pnote('x','small v1'),pnote('l',long)]);await phone.publish();const ex=await entityOf(phone,'x'),el=await entityOf(phone,'l');
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('l'))!.markdown).toBe(long);
  const before=(await watch.projection.readState()).cloud.current.treeRoot,rows=[(await serverRow(server,ex))!,(await serverRow(server,el))!];
  const quiet=await watch.prepare();expect(quiet.segments).toEqual({uploaded:0,reused:0});expect((await watch.projection.readState()).cloud.pendingPublish.treeRoot).toBe(before);
  await watch.publisher.flush();await watch.reader.pull(server.window());
  expect([(await serverRow(server,ex))!.stateOid,(await serverRow(server,el))!.stateOid]).toEqual(rows.map(r=>r.stateOid));
  // The phone publishes again without the container; the watch still keeps the received form.
  await phone.adopt();await phone.scan([pnote('x','small v2'),pnote('l',long)]);await phone.publish();const lAgain=(await serverRow(server,el))!.stateOid;
  expect(await watch.follow()).toEqual({applied:true});const again=await watch.prepare();expect(again.segments).toEqual({uploaded:0,reused:0});
  await watch.publisher.flush();expect((await serverRow(server,el))!.stateOid).toBe(lAgain);
 }finally{phone.close();watch.close();}
},300000);

test('F1 follow keeps the local version of an unopenable note, recovers on shrink and applies a remote tombstone',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,300000);try{
  const big='q'.repeat(600000);
  await phone.scan([pnote('x','small v1'),pnote('o','o1')]);await phone.publish();const ex=await entityOf(phone,'x');
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x'))!.markdown).toBe('small v1');
  // The phone grows x beyond the watch budget and edits o.
  await phone.adopt();await phone.scan([pnote('x',big),pnote('o','o2')]);await phone.publish();const remoteX=(await serverRow(server,ex))!;
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x'))!.markdown).toBe('small v1');expect((await watch.note('o'))!.markdown).toBe('o2');
  expect((await watch.projection.readState()).cloud.unopenableNotes.x.code).toBe('storage_pressure');
  // The watch's own edit publishes; x travels back with its original OIDs.
  await watch.db.execute('UPDATE memo_notes SET markdown=?,updated_at=updated_at+1 WHERE note_id=?',['o3 on watch','o']);await watch.publish();
  const carried=(await serverRow(server,ex))!;expect([carried.stateOid,carried.metaOid]).toEqual([remoteX.stateOid,remoteX.metaOid]);
  // Shrink recovers the remote text; a later long tombstone deletes the local note.
  await phone.adopt();await phone.scan([pnote('x','small v3',{updatedAt:40}),pnote('o','o3 on watch',{updatedAt:3})]);await phone.publish();
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x'))!.markdown).toBe('small v3');expect((await watch.projection.readState()).cloud.unopenableNotes).toEqual({});
  await phone.adopt();await phone.scan([pnote('x',big,{updatedAt:41}),pnote('o','o3 on watch',{updatedAt:3})]);await phone.publish();await phone.adopt();await phone.scan([pnote('x',big,{updatedAt:42,deleted:true,deletedAt:42}),pnote('o','o3 on watch',{updatedAt:3})]);await phone.publish();
  expect(await watch.follow()).toEqual({applied:true});const gone=(await watch.note('x'))!;expect(Number(gone.deleted)).toBe(1);expect(gone.markdown).toBe('small v3');
  expect((await watch.projection.readState()).cloud.unopenableNotes.x.deleted).toBe(true);
 }finally{phone.close();watch.close();}
},300000);
