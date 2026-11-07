import {test,expect} from 'bun:test';
import {fixture,body,id,now,binding,sha,note} from './p3b-fixture';
import {installBusinessRevision} from '../../src/sync-v2/business-revision';
import {statSync} from 'node:fs';
import {WatchBusinessClosure} from '../../src/sync-v2/business-closure';
import {localProjectionCipher} from '../../src/sync-v2/host';
import {WatchServiceKeyPin} from '../../src/sync-v2/service-key';
import {SyncV2Http} from '../../src/sync-v2/http';
import {WatchContentHttp} from '../../src/sync-v2/content-http';
import {pin,crypt} from './p3-fixture';
import {scope} from './fixture';
const tables=['podjs_resource_gc_cursor','podjs_resources','podjs_resource_rows','podjs_resource_refs','sync2_space_round','sync2_space_examined','sync2_space_settings','syncv2_state'];
async function snapshot(f:any){const out:any={};for(const table of tables)out[table]=(await f.db.query('SELECT * FROM '+table)).map((row:any)=>({...row,...(typeof row.body==='string'?{body:'sha256:'+sha(Buffer.from(row.body))}:{})}));return out;}
async function pending(f:any){const r=await f.add();await f.cache.setAutoEvict(true);await f.cache.trustedTime(now);const row=(await f.cache.journal.row(id))!;await f.db.transaction(f.cache.placeholder(row,await f.cache.seal(id,{...body(),status:'placeholder'}),now));return r;}

test('REVIEW4 all SQL GC writes share the current-token transaction',async()=>{
 const f=await fixture();try{
  await pending(f);const session=await f.cache.beginRound(),original=f.db.transaction.bind(f.db),groups:any[]=[];
  f.db.transaction=async statements=>{groups.push(statements);return original(statements);};
  expect((await f.space.collect(session)).freed).toBe(128);f.db.transaction=original;
  const writes=groups.filter(g=>g.some((s:any)=>/INSERT|UPDATE|DELETE/.test(s.sql)));expect(writes.length).toBe(3);
  for(const group of writes){expect(group.some((s:any)=>s.sql.includes('sync2_space_round')&&s.sql.includes('controller=?')&&s.sql.includes('active=1'))).toBe(true);expect(group.some((s:any)=>s.sql.startsWith('UPDATE sync2_space_settings SET clock='))).toBe(true);}
  const retire=writes.find(g=>g.some((s:any)=>s.sql.startsWith('UPDATE podjs_resources SET retired=1')));expect(retire.some((s:any)=>s.sql.startsWith('INSERT INTO podjs_resource_gc_cursor'))).toBe(true);
  console.log(JSON.stringify({case:'all-gc-writes-guarded',transactions:writes.length,retireAndCursorSameTransaction:true}));
 }finally{f.close();}
});

test('REVIEW4 late retirement transaction failure rolls back clock/cursor/retirement and leaves bytes',async()=>{
 const f=await fixture();try{
  const r=await pending(f),session=await f.cache.beginRound(),before=await snapshot(f),original=f.db.transaction.bind(f.db);f.clock=now+10;
  f.db.transaction=async statements=>original(statements.some(s=>s.sql.startsWith('UPDATE podjs_resources SET retired=1'))?[...statements,{sql:'INSERT INTO podjs_sql_cas_guard VALUES(0)'}]:statements);
  await expect(f.space.collect(session)).rejects.toThrow('round_stale');f.db.transaction=original;
  expect(await snapshot(f)).toEqual(before);expect(statSync(f.host.path(r.path)).size).toBe(128);
 }finally{f.close();}
});

test('REVIEW4 confirmed delete followed by acknowledgement failure counts once after takeover and retry',async()=>{
 const f=await fixture();try{
  const r=await pending(f),session=await f.cache.beginRound(),discard=f.cache.files.discard.bind(f.cache.files);let latest:any;
  f.cache.files.discard=async path=>{const bytes=await discard(path);latest=await f.cache.beginRound();return bytes;};
  let error:any;try{await f.space.collect(session);}catch(e){error=e;}f.cache.files.discard=discard;
  expect(error.completed).toEqual({freed:128,files:1});expect(error.message).toBe('round_stale');expect(statSync(f.host.path(r.path)).size).toBe(0);
  const retry=await f.space.collect(latest);expect(retry).toEqual({freed:0,files:1});const again=await f.space.collect(latest);expect(again).toEqual({freed:0,files:0});
  expect(error.completed.freed+retry.freed+again.freed).toBe(128);console.log(JSON.stringify({case:'ack-takeover-count',confirmedPrefix:error.completed,retry,again,total:128}));
 }finally{f.close();}
});

test('REVIEW4 takeover after entry validation cannot trigger an unguarded sync-state reconciliation',async()=>{
 const f=await fixture();try{
  const r=await pending(f);await f.db.execute('CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT)');await installBusinessRevision(f.db);await f.projection.readState();
  const stable=await f.projection.readState();await f.projection.controlUpdate(stable,{...stable,hasUnsentEdits:false});const old=await f.cache.beginRound();
  const query=f.db.query.bind(f.db);let hook=true,before:any;
  f.db.query=async(sql,params)=>{const rows=await query(sql,params);if(hook&&sql.startsWith('SELECT last_id FROM podjs_resource_gc_cursor')){hook=false;await f.cache.beginRound();await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);before=await snapshot(f);}return rows;};
  f.space.ports.localProof=async()=>{throw Error('dirty business data cannot authorize GC');};
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');f.db.query=query;
  const after=await snapshot(f);console.log(JSON.stringify({case:'reconciliation-after-takeover',beforeVersion:before.syncv2_state[0].state_version,afterVersion:after.syncv2_state[0].state_version,fileBytes:statSync(f.host.path(r.path)).size,availabilityRequests:f.requests}));
  expect(after).toEqual(before);
 }finally{f.close();}
});


test('REVIEW4 takeover before guarded commit cannot trigger an unguarded sync-state reconciliation',async()=>{
 const f=await fixture();try{
  const r=await pending(f);await f.db.execute('CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT)');await installBusinessRevision(f.db);await f.projection.readState();
  const stable=await f.projection.readState();await f.projection.controlUpdate(stable,{...stable,hasUnsentEdits:false});const old=await f.cache.beginRound();let before:any;
  f.beforeProof=async()=>{await f.cache.beginRound();await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);before=await snapshot(f);};
  await expect(f.space.collect(old)).rejects.toThrow('round_stale');
  const after=await snapshot(f);console.log(JSON.stringify({case:'control-update-reconciliation-after-takeover',beforeVersion:before.syncv2_state[0].state_version,afterVersion:after.syncv2_state[0].state_version,fileBytes:statSync(f.host.path(r.path)).size,availabilityRequests:f.requests}));
  expect(after).toEqual(before);
 }finally{f.close();}
});

async function business(f:Awaited<ReturnType<typeof fixture>>){await f.db.execute('CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT)');await installBusinessRevision(f.db);await f.projection.readState();}
for(const point of ['candidate-page','detach-preparation'])test('REVIEW4 cleanup '+point+' takeover plus business edit leaves zero additional writes',async()=>{
 const f=await fixture();try{
  const r=await f.add();await business(f);await f.cache.setAutoEvict(true);let before:any;
  const takeover=async()=>{await f.cache.beginRound();await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);before=await snapshot(f);};
  if(point==='candidate-page'){const query=f.db.query.bind(f.db);let once=true;f.db.query=async(sql,params)=>{const rows=await query(sql,params);if(once&&sql.startsWith('SELECT r.id,r.revision,r.sort_key,r.value')){once=false;await takeover();}return rows;};}
  else f.space.ports.detach=async()=>{await takeover();return [];};
  expect(await f.space.runWindow(1)).toMatchObject({status:'candidates-changed',freed:0});expect(before).toBeDefined();expect(await snapshot(f)).toEqual(before);expect(statSync(f.host.path(r.path)).size).toBe(128);
 }finally{f.close();}
});

test('REVIEW4 stable snapshot rejects a business edit without reconciliation or witness repair',async()=>{
 const f=await fixture();try{
  await business(f);await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);const before=await snapshot(f),version=before.syncv2_state[0].state_version;
  await expect(f.projection.readStableState()).rejects.toThrow('choice_stale');expect(await snapshot(f)).toEqual(before);
  const reconciled=await f.projection.readState();expect(reconciled.stateVersion).not.toBe(version);expect(reconciled.hasUnsentEdits).toBe(true);expect(await f.projection.readStableState()).toEqual(reconciled);
  await f.db.execute('DELETE FROM business_sync_revision');const missing=await snapshot(f);await expect(f.projection.readStableState()).rejects.toThrow('choice_stale');expect(await f.db.query('SELECT * FROM business_sync_revision')).toEqual([]);expect(await snapshot(f)).toEqual(missing);
 }finally{f.close();}
});

test('REVIEW4 cleanup business proof never calls the coordinating state reader',async()=>{
 const f=await fixture();try{
  await business(f);await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);const before=await snapshot(f);f.projection.readState=async()=>{throw Error('coordinating_reader_called');};
  await expect(new WatchBusinessClosure(f.projection,{} as any).cloudProof(body())).rejects.toThrow('choice_stale');expect(await snapshot(f)).toEqual(before);
 }finally{f.close();}
});

test('REVIEW4 cleanup with a missing business witness never repairs it',async()=>{
 const f=await fixture();try{
  await pending(f);const session=await f.cache.beginRound();await f.db.execute('DELETE FROM business_sync_revision');const before=await snapshot(f);
  await expect(f.space.collect(session)).rejects.toThrow('round_stale');expect(await snapshot(f)).toEqual(before);expect(await f.db.query('SELECT * FROM business_sync_revision')).toEqual([]);expect(f.requests).toBe(0);
 }finally{f.close();}
});

test('REVIEW4 reading local ciphertext with a missing key never generates or persists a key',async()=>{
 const calls:string[]=[],cipher=localProjectionCipher(async(method:string)=>{calls.push(method);if(method==='secure.get')return null as any;throw Error('unexpected_write:'+method);},'synthetic-cleanup');
 await expect(cipher.open('aad',JSON.stringify({nonceBase64:'',ciphertextBase64:''}))).rejects.toThrow('local_key_not_persisted');expect(calls).toEqual(['secure.get']);
 await expect(cipher.open('aad',JSON.stringify({nonceBase64:'',ciphertextBase64:''}))).rejects.toThrow('local_key_not_persisted');expect(calls).toEqual(['secure.get','secure.get']);
});

for(const missing of ['before-request','after-response'])test('REVIEW4 readonly availability refuses missing pin '+missing+' without secure writes',async()=>{
 const f=await fixture();try{
  const service=await pin().assertBootstrap();let stored:string|null=missing==='before-request'?null:JSON.stringify(service),writes=0,requests=0;
  // Use the canonical bytes that the real pin writer would store.
  const {canonical}=await import('../../src/sync-v2/protocol');if(stored)stored=canonical(service);
  const servicePin=new WatchServiceKeyPin({get:async()=>stored,compareAndSet:async()=>{writes++;throw Error('unexpected_pin_write');}},'a'.repeat(32),async()=>({accountId:'a'.repeat(32),syncV2:service}));
  const http=new SyncV2Http({request:async input=>{requests++;const path=input.url.split('/sync/v2')[1]?.split('?')[0];let value:any;
   if(path==='/capabilities')value={version:2,scope,minVersion:2,maxVersion:2,features:[],maxPartBytes:65536,historyDays:7,flags:{read:true,indexWrite:false,contentWrite:true,relay:false,gc:false,historyRestore:false},receiptKeyId:service.receiptKeyId,receiptSigningPublicKey:service.receiptSigningPublicKey};
   else {const a=await f.space.ports.remote.availability(f.proof);stored=null;value={version:2,scope,availability:{scope,entityKey:id,bodyRevision:f.proof.bodyRevision,recipeOid:f.proof.recipeOid,...a},leaseId:null,expiresAtMillis:null};}
   return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(value))};
  }},'http://127.0.0.1:18999',scope,async()=>({userId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',legacyDeviceId:'synthetic',accessToken:'synthetic',scope}),false,servicePin,true);
  await expect(new WatchContentHttp(http,crypt,()=>now).availability(f.proof,true)).rejects.toThrow('service_key_unpinned');expect(writes).toBe(0);expect(requests).toBe(missing==='before-request'?0:2);
 }finally{f.close();}
});

test('REVIEW4 stale round claim cannot advance the initial cleanup clock',async()=>{
 const f=await fixture();try{
  const query=f.db.query.bind(f.db);let once=true,before:any;f.db.query=async(sql,params)=>{const rows=await query(sql,params);if(once&&sql.includes('lower(hex(randomblob(16))) AS claim')){once=false;await f.cache.beginRound();before=await snapshot(f);}return rows;};
  await expect(f.cache.beginRound(now+10)).rejects.toThrow('round_stale');expect(await snapshot(f)).toEqual(before);
 }finally{f.close();}
});

test('REVIEW4 recovery expiry racing a business edit never coordinates before rejecting its CAS',async()=>{
 const f=await fixture();try{
  await business(f);await f.choice({[id]:note()},{});const cipher=f.recovery.ports.cipher,open=cipher.open.bind(cipher);let once=true,before:any;
  f.recovery.ports.cipher={...cipher,open:async(aad,sealed)=>{const value=await open(aad,sealed);if(once){once=false;await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);before=await snapshot(f);}return value;}};
  await expect(f.recovery.purgeRecovery(now+7*86400000)).rejects.toThrow('choice_stale');expect(before).toBeDefined();expect(await snapshot(f)).toEqual(before);
 }finally{f.close();}
});

test('REVIEW4 recovery edit pin cleanup never reconciles a pending business revision',async()=>{
 const f=await fixture();try{
  await business(f);await f.db.execute('INSERT INTO articles VALUES(?,?)',['local-change','new title']);const before=await snapshot(f);f.recovery.ports.acknowledge=async()=>{throw Error('must_not_authorize');};
  await expect(f.recovery.releaseAcknowledgedEdits()).rejects.toThrow('choice_stale');expect(await snapshot(f)).toEqual(before);
 }finally{f.close();}
});
