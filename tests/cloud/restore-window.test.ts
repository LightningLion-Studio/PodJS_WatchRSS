import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
import {crypto} from './k2-crypto';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';

test('near-deadline 8 MiB projection converges from durable suffixes; committed work never decreases',async()=>{
 const f=await fixture(),body=new Uint8Array(8*1024*1024).fill(17);let now=0,writes=0,previous=0,done=false;
 const write=f.cache.storeRestoreProjection.bind(f.cache);f.cache.storeRestoreProjection=async(...a)=>{await write(...a);now+=1500;writes++;};
 const receipts=new Set<string>();let token='';
 for(let round=0;round<12&&!done;round++){
  now=0;const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{if(now>=290000)throw Error('cloud_sync_deadline_exceeded');},()=>now).open('current-epoch','current-generation');
  if(!round){await cp.begin();token=await cp.token('current-source');}
  // First window starts five seconds before soft deadline; later ones have
  // ten seconds. Reopening the journal mimics a new guest, not a retained object.
  now=round?280000:285000;
  try{await cp.write(token,body);done=true;}catch(e){expect(String(e)).toContain('cloud_sync_deadline_exceeded');}
  expect(now).toBeLessThan(300000);expect(cp.work).toBeGreaterThanOrEqual(previous);previous=cp.work;
  const journal=JSON.parse((await f.state.restoreJournal())!);expect(journal.work).toBe(cp.work);
  for(let shard=0;shard<64;shard++){const raw=await f.state.restoreJournal(shard);if(!raw)continue;for(const id of Object.keys(JSON.parse(raw).projections)){receipts.add(id);}}
  expect(receipts.size).toBeGreaterThan(0);expect(cp.committed).toBe(true);cp.close();
 }
 expect(done).toBe(true);expect(receipts.size).toBe(32);
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('current-epoch','current-generation');
 expect(await cp.read(token)).toEqual(body);expect(cp.has('decoded:'+token)).toBe(true);cp.close();
 // Each window republishes only its small index; body parts are written once.
 expect(writes).toBeLessThan(45);
});

test('atomic receipt failure preserves the current header and cannot fabricate progress',async()=>{
 const f=await fixture(),cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('fresh-epoch','fresh-generation');await cp.begin();
 await cp.commit('current-prefix:9473');const before=await f.state.restoreJournal(),work=cp.work;
 f.state.storeRestoreJournalEntry=async()=>{throw Error('injected atomic secure failure');};
 await expect(cp.commit('current-prefix:9474')).rejects.toThrow('injected atomic');expect(cp.has('current-prefix:9474')).toBe(false);expect(cp.work).toBe(work);expect(await f.state.restoreJournal()).toBe(before);expect(cp.has('current-prefix:9473')).toBe(true);cp.close();
});

test('window/snapshot diagnostics keep only closed phases and numeric counts',async()=>{
 const lines:string[]=[];const d=backgroundDiagnostics(async<T>(_m:string,a:Record<string,unknown>)=>{lines.push(String(a.text));return null as T;});
 d.report(JSON.stringify({event:'window-unit',stage:'decrypt',outcome:'deferred',remainingMillis:900,content:'secret body',id:'private-id'}));
 d.report(JSON.stringify({event:'snapshot-work',stage:'checkpoint-write',bytes:262144,completedUnits:99,scope:'private-scope'}));
 d.report(JSON.stringify({event:'window-unit',stage:'private-id / secret body',code:'private-code'}));await d.flush();
 const text=lines.join('');expect(text).toContain('"stage":"decrypt"');expect(text).toContain('"stage":"checkpoint-write"');expect(text).not.toMatch(/secret|private/);
});

test('interruption after each part receipt preserves all earlier parts and never rewrites a historical header',async()=>{
 const body=new Uint8Array(8*1024*1024);for(let i=0;i<body.length;i++)body[i]=(i*31+i%251)%256;
 for(let boundary=1;boundary<=32;boundary++){
  const f=await fixture(),open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('live-epoch','live-generation');let cp=await open();await cp.begin();await cp.commit('live-prefix:9474');const token=await cp.token('object'),writes=new Map<string,number>();
  const write=f.cache.storeRestoreProjection.bind(f.cache);f.cache.storeRestoreProjection=async(user,id,b)=>{if(/-p\d+$/.test(id))writes.set(id,(writes.get(id)??0)+1);await write(user,id,b);};
  const entry=f.state.storeRestoreJournalEntry.bind(f.state);let n=0;f.state.storeRestoreJournalEntry=async(...args)=>{await entry(...args);if(++n===boundary)throw Error('guest interrupted after durable boundary');};
  await expect(cp.write(token,body)).rejects.toThrow('guest interrupted');cp.close();f.state.storeRestoreJournalEntry=entry;
  const historical=JSON.parse((await f.state.restoreJournal())!).work;
  cp=await open();expect(cp.has('live-prefix:9474')).toBe(true);await cp.write(token,body);expect(cp.work).toBeGreaterThanOrEqual(historical);expect(await cp.read(token)).toEqual(body);expect(cp.has('decoded:'+token)).toBe(true);cp.close();
  // A receipt committed before an abrupt process exit is authoritative after
  // reconstruction, even when the old guest did not see its acknowledgement.
  expect([...writes.values()].every(n=>n===1)).toBe(true);
 }
});

test('two zero-progress windows report retryable stalled without changing journal counters; real progress resets the streak',async()=>{
 const f=await fixture(),open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('latest-epoch','latest-generation');let cp=await open();await cp.begin();await cp.commit('latest-prefix:9474');cp.close();const current=await f.state.restoreJournal();
 cp=await open();expect(String(await cp.noProgress(Error('cloud_sync_deadline_exceeded')))).toContain('cloud_sync_deadline_exceeded');cp.close();
 cp=await open();expect(String(await cp.noProgress(Error('cloud_sync_deadline_exceeded')))).toContain('cloud_snapshot_progress_stalled');expect(await f.state.restoreJournal()).toBe(current);await cp.commit('latest-prefix:9475');expect(String(await cp.noProgress(Error('cloud_sync_deadline_exceeded')))).toContain('cloud_sync_deadline_exceeded');cp.close();
 cp=await open();expect(cp.has('latest-prefix:9474')).toBe(true);expect(cp.has('latest-prefix:9475')).toBe(true);expect(String(await cp.noProgress(Error('cloud_sync_deadline_exceeded')))).toContain('cloud_sync_deadline_exceeded');cp.close();
});

test('interruption after every atomic part file but before its receipt preserves the committed prefix and all bytes',async()=>{
 const body=new Uint8Array(8*1024*1024).fill(59);
 for(let boundary=1;boundary<=32;boundary++){
  const f=await fixture(),open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('current-epoch','current-generation');let cp=await open();await cp.begin();await cp.commit('prefix:current');const token=await cp.token('in-flight-object');
  const store=f.cache.storeRestoreProjection.bind(f.cache);let n=0;f.cache.storeRestoreProjection=async(...a)=>{await store(...a);if(/-p\d+$/.test(a[1])&&++n===boundary)throw Error('process exit before secure receipt');};
  await expect(cp.write(token,body)).rejects.toThrow('before secure receipt');cp.close();const work=JSON.parse((await f.state.restoreJournal())!).work;f.cache.storeRestoreProjection=store;
  cp=await open();expect(cp.has('prefix:current')).toBe(true);expect(cp.work).toBeGreaterThanOrEqual(work);await cp.write(token,body);expect(await cp.read(token)).toEqual(body);cp.close();
 }
});


test('native materialization never receives an over-64MiB projection; larger representations retain the portable reader',async()=>{
 const f=await fixture(),body=new Uint8Array(65*1024*1024).fill(41);let native=0;
 f.session.codec=new WatchCloudCodec({...crypto,openSealedParts:async()=>{native++;throw Error('native aggregate limit exceeded');}},{require(){}});
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('current-epoch','current-generation');await cp.begin();const token=await cp.token('large-local-projection');await cp.write(token,body);expect(await cp.read(token)).toEqual(body);expect(native).toBe(0);cp.close();
});
