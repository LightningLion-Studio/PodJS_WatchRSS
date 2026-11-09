/** C7 re-review fixes R1-R3: byte-exact long note reads (U+0000), read-only
 * quarantined notes with "keep both" for unsent edits, and explicit choices
 * that carry back every quarantined row. Synthetic backend only. */
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
import {jsonBytes,parseCanonicalJson,nextD64} from '../../src/sync-v2/protocol';
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
import {signCommit} from '../../src/sync-v2/signing';
import {NOTE_TEXT_BUDGET} from '../../src/sync-v2/note-segments';
import {initializeMemoSchema,MemoRepository} from '../../src/notes/repository';

const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1},device='a'.repeat(32);
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
const withC7=<T extends new(...a:any[])=>SyntheticIndexBackend>(Base:T)=>class extends Base {
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
};
const C7P5Backend=withC7(P5Backend);
type Server=InstanceType<typeof C7P5Backend>;
/** Projection-only writer device (the phone). */
async function client(server:Server){
 const db=new SqlFixture(),store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});await store.initialize();await store.beginScan(binding);
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin());
 const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>server.clock??100,undefined,{noteSegments:true}),reader=new WatchCloudIndex(store,http,crypto,keys,approved,async()=>{},()=>server.clock??100,undefined,{noteSegments:true});
 return {db,store,publisher,reader,
  async scan(rows:any[]){const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<rows.length;i++)await store.scanPage({page:async()=>({rows:[rows[i]],after:'r'+String(i).padStart(4,'0'),done:i===rows.length-1}),changed:async()=>[]});},
  async publish(){const plan=await publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));await publisher.flush();return plan;},
  async adopt(){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});},
  async row(e:string){const s=await store.readState();return store.cloudRow(s.cloud.current.treeRoot,e);},
  close(){db.close();},
 };
}
const pnote=(id:string,markdown:string,extra:any={})=>({kind:'note',logicalId:id,value:{...noteValue(id),markdown,plainText:'',baseMarkdown:'',...extra},addedAtMillis:1});
const entityOf=async(c:{store:WatchProjectionStore},id:string)=>(await c.store.candidatePage()).find((x:any)=>x.candidate.meta.logicalId===id)!.entityKey;
/** Decoded row of an entity in the server's current account tree. */
const serverRow=async(server:Server,e:string)=>{const c=await client(server);try{await c.reader.pull(server.window());return (await c.row(e))??null;}finally{c.close();}};
const markdownOf=(r:any)=>r?fromWire('note',r.meta.payload,r.state.payload).markdown:null;
/** Watch with the business DB, materializer and P5 account control. */
async function watchDevice(server:Server,budget:number){
 const root=mkdtempSync(join(tmpdir(),'wrss-c7rr-')),db=new SqlFixture(join(root,'state.sqlite'));await initializeMemoSchema(db as any);
 const projection=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true}),cache=new WatchSpaceStore(db,cipher,new ContentFiles(new FileHost(join(root,'files')).request),'6'.repeat(64));await cache.init();
 const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>server.clock,source:async refs=>{if(refs.length)throw Error('closure_incomplete');return [];},reserve:async()=>async()=>{}});
 const native=new WatchAccountBusinessSql(db,projection,scope,idKey,{recoveryValue:async id=>{const c=await projection.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async row=>{if(row.bodyRevision!==null)throw Error('closure_incomplete');},async()=>async()=>{});await native.initialize();await projection.initialize();
 const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('no article body');}} as any)),http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,true,true);
 const publisher=new WatchIndexPublisher(projection,http,crypto,keys,()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget}),reader=new WatchCloudIndex(projection,http,crypto,keys,approved,async()=>{},()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget});
 const control=new WatchAccountControl({store:projection,http,publisher,reader,crypto,approved,business:native,recovery,trustedNow:()=>server.clock,historyRestore:true,choiceApply:true,author:async()=>({deviceId:device,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision}})});
 async function scan(){const cp=await projection.checkpoint();if(!cp)await projection.beginScan(binding);else if(cp.phase==='complete')await projection.beginTailWindow();for(;;){const cp=await projection.checkpoint();if(cp?.phase==='complete')break;if(cp?.phase==='tail')await projection.catchUpPage(source);else await projection.scanPage(source);}}
 return {db,projection,publisher,reader,control,scan,memo:new MemoRepository(db as any,'watch-device',()=>randomBytes(16).toString('hex'),()=>server.clock),
  async follow(){const r=await control.follow(server.window());await scan();return r;},
  async prepare(){await scan();return publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));},
  async publish(){const plan=await this.prepare();await publisher.flush();await reader.pull(server.window());return plan;},
  note:async(id:string)=>(await db.query('SELECT * FROM memo_notes WHERE note_id=?',[id]))[0] as any??null,
  notes:async()=>(await db.query('SELECT note_id,markdown,deleted FROM memo_notes ORDER BY note_id')) as any[],
  close(){db.close();rmSync(root,{recursive:true,force:true});},
 };
}

test('R1: a long note with U+0000, surrogate pairs and multibyte characters across byte pieces survives follow -> scan -> publish',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,NOTE_TEXT_BUDGET);try{
  // Reads use 65536-byte pieces: '中' spans bytes 65535..65537 and '😀' spans 131070..131073.
  const markdown='h\u0000'+'a'.repeat(65533)+'中'+'\u0000'+'b'.repeat(65531)+'😀'+'TAIL'+'c'.repeat(200000)+'\u0000end';
  expect(Buffer.byteLength('h\u0000'+'a'.repeat(65533))).toBe(65535);expect(Buffer.byteLength(markdown.slice(0,markdown.indexOf('😀')))).toBe(131070);
  // SQLite TEXT length() counts plainText up to its U+0000 (9000 characters), so the
  // row takes the long-text path; every field then holds text after a U+0000.
  const plainText='p'.repeat(9000)+'\u0000p😀',baseMarkdown='base\u0000'+'中'.repeat(3000);
  await phone.scan([pnote('z',markdown,{plainText,baseMarkdown})]);await phone.publish();const ez=await entityOf(phone,'z'),s0=(await serverRow(server,ez))!.row.stateOid;
  expect(await watch.follow()).toEqual({applied:true});
  const stored=await watch.note('z');expect([stored.markdown,stored.plain_text,stored.base_markdown]).toEqual([markdown,plainText,baseMarkdown]);
  const candidate=fromWire('note',...(c=>[c.meta.payload,c.state.payload] as const)(await watch.projection.readCandidate(ez)));
  expect([candidate.markdown,candidate.plainText,candidate.baseMarkdown]).toEqual([markdown,plainText,baseMarkdown]);
  await watch.publish();const remote=(await serverRow(server,ez))!;expect(remote.row.stateOid).toBe(s0);expect(markdownOf(remote)).toBe(markdown);
 }finally{phone.close();watch.close();}
},600000);

/** x grows beyond the watch budget on the phone; o stays small. */
async function quarantine(server:Server,phone:Awaited<ReturnType<typeof client>>,watch:Awaited<ReturnType<typeof watchDevice>>,beforeGrowth?:()=>Promise<void>){
 await phone.scan([pnote('x','small v1'),pnote('o','o1')]);await phone.publish();const ex=await entityOf(phone,'x');
 expect(await watch.follow()).toEqual({applied:true});await beforeGrowth?.();
 await phone.adopt();await phone.scan([pnote('x','q'.repeat(600000)),pnote('o','o1')]);await phone.publish();
 return {ex,remoteX:(await serverRow(server,ex))!.row};
}
const copies=async(watch:Awaited<ReturnType<typeof watchDevice>>)=>(await watch.notes()).filter(n=>!['x','o','y'].includes(n.note_id));

test('R2: a note this device cannot open is read-only; edit entries return note_unopenable',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,300000);try{
  await quarantine(server,phone,watch);expect(await watch.follow()).toEqual({applied:true});
  expect((await watch.projection.readState()).cloud.unopenableNotes.x.code).toBe('storage_pressure');
  for(const edit of [()=>watch.memo.save({noteId:'x',markdown:'edit'}),()=>watch.memo.setPinned('x',true),()=>watch.memo.move('x',null),()=>watch.memo.delete('x')])await expect(edit()).rejects.toThrow('note_unopenable');
  expect((await watch.note('x')).markdown).toBe('small v1');expect((await watch.memo.save({noteId:'o',markdown:'o edit'})).markdown).toBe('o edit');
  // Shrink makes x openable again; the entries accept edits.
  await watch.publish();await phone.adopt();await phone.scan([pnote('x','small v3',{updatedAt:40}),pnote('o','o edit')]);await phone.publish();
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x')).markdown).toBe('small v3');
  expect((await watch.memo.save({noteId:'x',markdown:'x edit'})).markdown).toBe('x edit');
 }finally{phone.close();watch.close();}
},600000);

test('R2: an unsent edit when the note enters quarantine is kept as a new local note that publishes; the original travels back unchanged',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,300000);try{
  const {ex,remoteX}=await quarantine(server,phone,watch,async()=>{await watch.memo.save({noteId:'x',markdown:'WATCH EDIT OF X'});await watch.scan();});
  expect(await watch.follow()).toEqual({localEditsRetained:true,awaitingUser:false});
  expect((await watch.projection.readState()).cloud.unopenableNotes.x.code).toBe('storage_pressure');
  const [kept]=await copies(watch);expect(kept.markdown).toBe('WATCH EDIT OF X');expect(Number(kept.deleted)).toBe(0);
  expect((await watch.projection.readState()).hasUnsentEdits).toBe(true);
  await watch.publish();expect((await watch.projection.readState()).hasUnsentEdits).toBe(false);
  expect((await serverRow(server,ex))!.row.stateOid).toBe(remoteX.stateOid);
  const ek=await entityOf({store:watch.projection},kept.note_id);expect(markdownOf(await serverRow(server,ek))).toBe('WATCH EDIT OF X');
  // Remote shrink: x follows the remote text; the kept edit stays a separate note.
  await phone.adopt();await phone.scan([pnote('x','small v3',{updatedAt:40}),pnote('o','o1')]);await phone.publish();
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x')).markdown).toBe('small v3');
  expect((await copies(watch)).map(n=>[n.note_id,n.markdown])).toEqual([[kept.note_id,'WATCH EDIT OF X']]);
 }finally{phone.close();watch.close();}
},600000);

test('R2 (probe A): a quarantined note changed outside the edit entries is kept as a new note before hasUnsentEdits clears',async()=>{
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,300000);try{
  const {ex,remoteX}=await quarantine(server,phone,watch);expect(await watch.follow()).toEqual({applied:true});
  await watch.db.execute('UPDATE memo_notes SET markdown=?,updated_at=updated_at+1 WHERE note_id=?',['WATCH EDIT OF X','x']);
  await watch.publish();expect((await serverRow(server,ex))!.row.stateOid).toBe(remoteX.stateOid);
  const [kept]=await copies(watch);expect(kept?.markdown).toBe('WATCH EDIT OF X');expect((await watch.projection.readState()).hasUnsentEdits).toBe(true);
  await watch.publish();expect((await watch.projection.readState()).hasUnsentEdits).toBe(false);
  const ek=await entityOf({store:watch.projection},kept.note_id);expect(markdownOf(await serverRow(server,ek))).toBe('WATCH EDIT OF X');
  await phone.adopt();await phone.scan([pnote('x','small v3',{updatedAt:40}),pnote('o','o1')]);await phone.publish();
  expect(await watch.follow()).toEqual({applied:true});expect((await watch.note('x')).markdown).toBe('small v3');
  expect((await copies(watch)).map(n=>n.markdown)).toEqual(['WATCH EDIT OF X']);
  // No further copy appears once the edit is kept.
  await watch.publish();expect(await copies(watch)).toHaveLength(1);
 }finally{phone.close();watch.close();}
},600000);

/** Probe B: a rollback commit leaves a pending choice while the account holds a
 * remote-only note that the watch cannot open. */
async function rollbackSetup(){
 const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,300000);
 const big='y'.repeat(600000);
 await phone.scan([pnote('o','o1')]);await phone.publish();await watch.follow();
 await phone.adopt();await phone.scan([pnote('o','o1'),pnote('y',big)]);await phone.publish();const c1=server.account.commitOid,ey=await entityOf(phone,'y');
 await watch.follow();
 await phone.adopt();await phone.scan([pnote('o','o2',{updatedAt:5}),pnote('y',big)]);await phone.publish();const c2=server.account.commitOid;
 await watch.follow();
 await watch.db.execute('UPDATE memo_notes SET markdown=?,updated_at=updated_at+10 WHERE note_id=?',['o3 on watch','o']);await watch.scan();
 const signed=parseCanonicalJson(server.objects.get(c2)!),target=parseCanonicalJson(server.objects.get(c1)!);
 const commit=await signCommit(crypto,'key',{...signed.body,deviceSequence:nextD64(signed.body.deviceSequence),previousOwnCommit:server.device.commitOid,accountParent:c2,rollbackGeneration:'1',treeRoot:target.body.treeRoot,mergedParents:[c1],operation:{kind:'rollback',rollbackTarget:c1,resolvesGeneration:null}});
 server.objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));server.account={commitOid:commit.oid,revision:nextD64(server.account.revision),rollbackGeneration:'1'};server.device={...server.device,commitOid:commit.oid,revision:nextD64(server.device.revision)};server.serverRevision=nextD64(server.serverRevision);
 await watch.reader.pull(server.window());
 return {server,phone,watch,ey};
}
for(const mode of ['local','merge'] as const)test(`R3 (probe B-${mode}): an explicit resolution keeps a remote-only unopenable note with the same OIDs`,async()=>{
 const {server,phone,watch,ey}=await rollbackSetup();try{
  const s=await watch.projection.readState();expect(Object.keys(s.cloud.unopenableNotes)).toEqual(['y']);expect(await watch.note('y')).toBeNull();
  const before=(await serverRow(server,ey))!.row,pending=(await watch.control.pendingChoice())!;expect(pending).not.toBeNull();
  let result:any;try{result=mode==='local'?await watch.control.chooseLocal(pending.proof,randomBytes(16).toString('hex')):await watch.control.chooseMerge(pending.proof,randomBytes(16).toString('hex'));}catch(e){result='error:'+(e as Error).message;}
  if(mode==='local'||pending.canMerge){expect(typeof result).toBe('object');expect(server.account.rollbackGeneration).toBe('1');}else expect(result).toBe('error:merge_unavailable');
  const after=(await serverRow(server,ey))!.row;expect([after.stateOid,after.metaOid]).toEqual([before.stateOid,before.metaOid]);
  expect(await watch.note('y')).toBeNull();
 }finally{phone.close();watch.close();}
},600000);

/** R4: the live JS heap after a full GC, sampled at every SQL transaction and
 * cloud-row/candidate read during follow, minus the heap before follow. */
test('R4: the follow peak does not grow with the number of long notes',async()=>{
 const MiB=1024*1024,out:any[]=[];
 // The first run warms the JIT and lazy module state; it is discarded.
 for(const n of [1,1,3,5]){
  const server=new C7P5Backend(),phone=await client(server),watch=await watchDevice(server,NOTE_TEXT_BUDGET);try{
   // About 650 KB of text per field, distinct per note (about 1.9 MiB of UTF-8 per note).
   const notes=Array.from({length:n},(_,i)=>{const t=String.fromCharCode(0x4e00+i).repeat(216666)+'x'.repeat(i);return pnote('n'+i,t,{plainText:t,baseMarkdown:t});});
   await phone.scan(notes);await phone.publish();await watch.reader.pull(server.window());
   let on=false,base=0,peak=0;const sample=()=>{if(!on)return;Bun.gc(true);peak=Math.max(peak,process.memoryUsage().heapUsed-base);};
   const wrap=(target:any,names:string[])=>{for(const name of names){const f=target[name].bind(target);target[name]=async(...a:any[])=>{sample();const r=await f(...a);sample();return r;};}};
   wrap(watch.projection,['cloudRow','cloudRows','candidatePage','readCandidate','controlUpdate']);wrap(watch.db,['transaction']);
   Bun.gc(true);base=process.memoryUsage().heapUsed;on=true;const r=await watch.control.follow(server.window());sample();on=false;
   expect(r).toEqual({applied:true});for(let i=0;i<n;i++)expect((await watch.note('n'+i)).markdown).toBe(notes[i]!.value.markdown);
   out.push({n,peakMiB:+(peak/MiB).toFixed(2)});
  }finally{phone.close();watch.close();}
 }
 out.shift();console.log('C7-R4',JSON.stringify(out));
 for(const o of out.slice(1))expect(o.peakMiB).toBeLessThan(out[0].peakMiB*1.5+2);
 for(const o of out)expect(o.peakMiB).toBeLessThan(256);
},900000);
