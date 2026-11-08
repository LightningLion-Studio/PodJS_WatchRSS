/** C7 N1: long notes under the PRODUCT local cipher and the Android host bounds
 * (one crypto.aesGcm* input <= 256 KiB, one sealed value <= 768 KiB, one host
 * request or reply <= 1 MiB). scan -> publish -> pull -> follow -> edit ->
 * publish, plus choose-cloud recovery and rollback. Synthetic backend only. */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {scope,idKey,libraryId,binding,cipher,noteValue,SqlFixture,PRODUCT_LIMITS,productCipherHost} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {P5Backend} from './p5-fixture';
import {FileHost} from './p3-fixture';
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
import {localProjectionCipher} from '../../src/sync-v2/host';
import {fromWire} from '../../src/sync-v2/business';
import {NOTE_TEXT_BUDGET,measureNote,splitOrdinary} from '../../src/sync-v2/note-segments';
import {initializeMemoSchema} from '../../src/notes/repository';

const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1},device='a'.repeat(32);
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
class C7Backend extends P5Backend {
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
}
const http=(server:SyntheticIndexBackend)=>new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,true,true);
/** Phone: projection-only writer with the unbounded fixture cipher. */
async function phone(server:C7Backend){
 const db=new SqlFixture(),store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});await store.initialize();await store.beginScan(binding);
 const h=http(server),publisher=new WatchIndexPublisher(store,h,crypto,keys,()=>server.clock,undefined,{noteSegments:true}),reader=new WatchCloudIndex(store,h,crypto,keys,approved,async()=>{},()=>server.clock,undefined,{noteSegments:true});
 return {store,
  async scan(rows:any[]){const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<rows.length;i++)await store.scanPage({page:async()=>({rows:[rows[i]],after:'r'+String(i).padStart(4,'0'),done:i===rows.length-1}),changed:async()=>[]});},
  async publish(){const plan=await publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));await publisher.flush();return plan;},
  async adopt(){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});},
  async note(id:string){await reader.pull(server.window());const s=await store.readState();let after='';for(;;){const page=await store.cloudRows(s.cloud.current.treeRoot,after,1);if(!page.length)return null;const r=page[0];if(r.meta.logicalId===id)return fromWire('note',r.meta.payload,r.state.payload);after=r.row.entityKey;}},
  close(){db.close();},
 };
}
/** Watch: business DB, product local ciphers, product host and SQL bounds. */
async function watch(server:C7Backend){
 const root=mkdtempSync(join(tmpdir(),'wrss-c7n1-')),db=new SqlFixture(join(root,'state.sqlite'));await initializeMemoSchema(db as any);
 const {host,stats}=productCipherHost(),projectionCipher=localProjectionCipher(host as any,'n1-projection'),spaceCipher=localProjectionCipher(host as any,'n1-space'),recoveryCipher=localProjectionCipher(host as any,'n1-recovery');
 await projectionCipher.seal('probe',{});await spaceCipher.seal('probe',{});await recoveryCipher.seal('probe',{});
 db.programCipher=projectionCipher;db.limits=PRODUCT_LIMITS;
 const projection=new WatchProjectionStore(db,projectionCipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true}),cache=new WatchSpaceStore(db,spaceCipher,new ContentFiles(new FileHost(join(root,'files')).request),'6'.repeat(64));await cache.init();
 const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>server.clock,source:async refs=>{if(refs.length)throw Error('closure_incomplete');return [];},reserve:async()=>async()=>{}});
 const native=new WatchAccountBusinessSql(db,projection,scope,idKey,{recoveryValue:async id=>{const c=await projection.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async row=>{if(row.bodyRevision!==null)throw Error('closure_incomplete');},async()=>async()=>{});await native.initialize();await projection.initialize();
 const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('no article body');}} as any)),h=http(server);
 const publisher=new WatchIndexPublisher(projection,h,crypto,keys,()=>server.clock,undefined,{noteSegments:true}),reader=new WatchCloudIndex(projection,h,crypto,keys,approved,async()=>{},()=>server.clock,undefined,{noteSegments:true});
 const control=new WatchAccountControl({store:projection,http:h,publisher,reader,crypto,approved,business:native,recovery,trustedNow:()=>server.clock,historyRestore:true,choiceApply:true,author:async()=>({deviceId:device,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision}})});
 async function scan(){const cp=await projection.checkpoint();if(!cp)await projection.beginScan(binding);else if(cp.phase==='complete')await projection.beginTailWindow();for(;;){const cp=await projection.checkpoint();if(cp?.phase==='complete')break;if(cp?.phase==='tail')await projection.catchUpPage(source);else await projection.scanPage(source);}}
 return {db,projection,publisher,reader,control,stats,scan,
  /** Foreground editor write (outside the background host). */
  write(id:string,text:string,updatedAt:number){db.raw.query('INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET markdown=excluded.markdown,plain_text=excluded.plain_text,base_markdown=excluded.base_markdown,content_hash=excluded.content_hash,updated_at=excluded.updated_at').run(id,null,'title '+id,text,text,'h'+updatedAt,'base-h',text,0,1,updatedAt,'watch',0,0);},
  async publish(){await scan();const plan=await publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));await publisher.flush();await reader.pull(server.window());return plan;},
  async follow(){const r=await control.follow(server.window());await scan();return r;},
  note:async(id:string)=>(await db.query('SELECT length(markdown) AS n,substr(markdown,1,16) AS head,substr(markdown,-16) AS tail FROM memo_notes WHERE note_id=?',[id]))[0]??null,
  close(){db.close();rmSync(root,{recursive:true,force:true});},
 };
}
/** Three equal CJK fields; `chars` per field. */
const text=(chars:number,tag:string)=>String.fromCharCode(0x4e00+tag.length).repeat(chars-tag.length)+tag;
const pnote=(id:string,t:string,updatedAt:number)=>({kind:'note',logicalId:id,value:{...noteValue(id),title:'title '+id,markdown:t,plainText:t,baseMarkdown:t,contentHash:'p'+updatedAt,updatedAt},addedAtMillis:1});
const B=(t:string)=>measureNote(splitOrdinary({version:2,entityKey:'0'.repeat(64),requiredFeatures:[],payload:{markdown:t,plainText:t,baseMarkdown:t},noteSegments:[]})).textBytes;
const ends=(t:string)=>({n:t.length,head:t.slice(0,16),tail:t.slice(-16)});

for(const [label,chars] of [['650KB',72222],['2MiB',232900]] as const)test(`N1 ${label}: scan, publish, pull, follow, edit and publish a long note under product cipher and host bounds`,async()=>{
 const v1=text(chars,'w1'),bytes=B(v1);expect(bytes).toBeLessThanOrEqual(NOTE_TEXT_BUDGET);expect(bytes).toBeGreaterThan(label==='2MiB'?2*1024*1024-8192:640000);
 const server=new C7Backend(),p=await phone(server),w=await watch(server);try{
  // Watch creates the long note and publishes it.
  w.write('L',v1,10);const first=await w.publish();expect(first.segments.uploaded).toBeGreaterThanOrEqual(3);
  expect(ends((await p.note('L'))!.markdown)).toEqual(ends(v1));
  // The phone appends; the watch follows (pull, reassembly, apply to memo_notes).
  const v2=v1.slice(0,-2)+'p2';await p.adopt();await p.scan([pnote('L',v2,20)]);await p.publish();
  expect(await w.follow()).toEqual({applied:true});expect(await w.note('L')).toEqual(ends(v2));
  // The watch edits its tail and publishes; unchanged leading segments are reused.
  const v3=v2.slice(0,-2)+'w3';w.db.raw.query('UPDATE memo_notes SET markdown=?,updated_at=30 WHERE note_id=?').run(v3,'L');const edit=await w.publish();expect(edit.segments.reused).toBeGreaterThan(0);
  expect(ends((await p.note('L'))!.markdown)).toEqual(ends(v3));
  // Bounds held for every host call of the watch.
  expect(w.stats.maxAesBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.aesBytes);expect(w.stats.maxRequestBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.requestBytes);
  expect(w.db.maxTxBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.requestBytes);expect(w.db.maxReplyBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.replyBytes);
  console.log('C7-N1',JSON.stringify({label,B:bytes,aesCalls:w.stats.aesCalls,maxAesBytes:w.stats.maxAesBytes,maxTxBytes:w.db.maxTxBytes,maxReplyBytes:w.db.maxReplyBytes}));
 }finally{p.close();w.close();}
},900000);

test('N1 2MiB: remote rollback over an unsent long edit keeps a chunked edit base; choose-cloud keeps a chunked recovery copy; restore and history rollback work',async()=>{
 const server=new C7Backend(),w=await watch(server);try{
  const v1=text(232900,'a1'),v2=v1.slice(0,-2)+'b2',v3=v1.slice(0,-2)+'c3';
  w.write('L',v1,10);await w.publish();const first=server.account.commitOid;w.write('L',v2,11);await w.publish();const second=server.account.commitOid;
  w.write('L',v3,12);await w.scan();
  // Another device rolls the account back to the first commit (P5 dirtyRollback shape).
  const signed=parseCanonicalJson(server.objects.get(second)!),target=parseCanonicalJson(server.objects.get(first)!),{signCommit}=await import('../../src/sync-v2/signing');
  const commit=await signCommit(crypto,'key',{...signed.body,deviceSequence:nextD64(signed.body.deviceSequence),previousOwnCommit:server.device.commitOid,accountParent:second,rollbackGeneration:'1',treeRoot:target.body.treeRoot,mergedParents:[first],operation:{kind:'rollback',rollbackTarget:first,resolvesGeneration:null}});
  server.objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));server.account={commitOid:commit.oid,revision:nextD64(server.account.revision),rollbackGeneration:'1'};server.device={...server.device,commitOid:commit.oid,revision:nextD64(server.device.revision)};server.serverRevision=nextD64(server.serverRevision);
  await w.reader.pull(server.window());const s=await w.projection.readState(),[entity]=Object.keys(s.cloud.editBases);
  expect(Object.keys(s.cloud.editBases[entity!])).toEqual(['$podjs.chunked']);expect(jsonBytes(s).length).toBeLessThan(64*1024);
  expect((await w.projection.editBases(s))[entity!].markdown).toBe(v2);
  const pending=await w.control.pendingChoice();expect(pending).not.toBeNull();
  await w.control.chooseCloud(pending!.proof,randomBytes(16).toString('hex'));expect(await w.note('L')).toEqual(ends(v1));
  const after=await w.projection.readStableState();expect(after.recoveryCopies!.length).toBe(1);expect(jsonBytes(after).length).toBeLessThan(64*1024);
  // The discarded long edit comes back from its chunked recovery copy.
  const [copy]=await w.control.recoveryCopies();expect(await w.control.restoreRecovery(copy!.copyId)).toBe(1);await w.scan();expect(await w.note('L')).toEqual(ends(v3));
  await w.publish();
  // History restore of the first commit (retired by a publication).
  const capture=await w.control.captureAccount();await w.control.rollback(first,capture,randomBytes(16).toString('hex'));expect(await w.note('L')).toEqual(ends(v1));
  expect(w.db.maxTxBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.requestBytes);expect(w.db.maxReplyBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.replyBytes);expect(w.stats.maxAesBytes).toBeLessThanOrEqual(PRODUCT_LIMITS.aesBytes);
 }finally{w.close();}
},900000);

test('N1: values sealed before the fix (single-call form) stay readable; a chunked value round-trips',async()=>{
 const {host}=productCipherHost(),c=localProjectionCipher(host as any,'old');const small=await c.seal('a',{v:'x'});expect(JSON.parse(small)).toHaveProperty('nonceBase64');expect(await c.open('a',small)).toEqual({v:'x'});
 const large={v:'长'.repeat(100000)},sealed=await c.seal('a',large);expect(sealed.startsWith('{"podjs":"chunked-aead"')).toBe(true);expect(await c.open('a',sealed)).toEqual(large);
 await expect(c.open('b',sealed)).rejects.toThrow('chunked_aead_corrupt');await expect(c.seal('a',{v:'x'.repeat(800*1024)})).rejects.toThrow('object_too_large');
});
