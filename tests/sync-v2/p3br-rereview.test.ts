import {test,expect} from 'bun:test';
import {fixture,body,item,now,sha} from './p3b-fixture';
import {restoredSetup} from './p3br-formal-fixture';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';
import {nextD64} from '../../src/sync-v2/protocol';

test('REREVIEW new old-RSS must precede an existing import after a sufficient window',async()=>{
 const f=await fixture();try{
  const first='b'.repeat(64),rss='a'.repeat(64),imported='c'.repeat(64);
  await f.add({...body(first),item:{...item(first),addedAtMillis:2}});
  await f.add({...body(imported),item:{...item(imported),kind:'import',addedAtMillis:1}});
  await f.cache.setAutoEvict(true);expect((await f.space.runWindow(1,10000)).freed).toBe(128);
  await f.add({...body(rss),item:{...item(rss),addedAtMillis:1}});
  const result=await f.space.runWindow(1,10000),rssState=(await f.cache.open((await f.cache.journal.row(rss))!)).status,importState=(await f.cache.open((await f.cache.journal.row(imported))!)).status;
  console.log(JSON.stringify({case:'cursor-new-rss-priority',rssState,importState,result,cursor:await f.cache.scanCursor()}));
  expect(rssState).toBe('placeholder');expect(importState).toBe('ready');
 }finally{f.close();}
});

test('REREVIEW newer acknowledged title with the same complete body must retire the old edit owner',async()=>{
 const s=await restoredSetup();try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);
  const pin=(await s.projection.readState()).recoveryEditPins![0];
  let state=await s.projection.readState();await s.projection.controlUpdate(state,{...state,localChangeRevision:nextD64(state.localChangeRevision),hasUnsentEdits:true});
  await s.installCurrent(rows=>{rows.find(r=>r.row.entityKey===s.record.id).meta.payload.title='newer title, same body';});
  state=await s.projection.readState();
  const {openV2}=await import('../../src/sync-v2/sealed'),{keys,scope}=await import('./p3-fixture');
  const row=s.rows.find(r=>r.row.entityKey===s.record.id).row,raw=Buffer.concat(await s.recovery.readEditBody(pin.editId,row.recipeOid)),recipe=(await openV2(s.f.e.crypto,keys.id,keys.content,scope,row.recipeOid,raw)).value;
  const fresh=await s.f.e.remote.availability({entityKey:s.record.id,bodyRevision:row.bodyRevision,recipeOid:row.recipeOid,blobOids:recipe.blocks.map((b:any)=>b.oid)});expect(fresh.status).toBe('cloud-ready');
  const calls=s.backend.calls['/availability/check']??0,result=await s.recovery.releaseAcknowledgedEdits(),remaining=(await s.projection.readState()).recoveryEditPins!.length;
  console.log(JSON.stringify({case:'superseded-edit-pin',freshStatus:fresh.status,pinRevision:pin.localChangeRevision,acknowledged:state.acknowledgedLocalChangeRevision,bodyRecipeUnchanged:s.rows[0].row.recipeOid=== (await s.projection.cloudRow(state.cloud.current.treeRoot,s.record.id)).row.recipeOid,result,remaining,availabilityCalls:(s.backend.calls['/availability/check']??0)-calls}));
  expect(result.released).toBe(1);expect(remaining).toBe(0);
 }finally{s.close();}
});

for(const mutation of ['add','touch'])test('REREVIEW '+mutation+' invalidates a paused candidate order across SQLite reopen',async()=>{
 const f=await fixture();let db:any;try{
  const {SqlFixture,cipher}=await import('./fixture'),{WatchSpaceStore}=await import('../../src/sync-v2/space-store'),{WatchSpaceV2}=await import('../../src/sync-v2/space'),{join}=await import('node:path');
  const prefix=['1'.repeat(64),'2'.repeat(64)],rss=mutation==='add'?'0'.repeat(64):prefix[0],imported='3'.repeat(64);
  for(const id of prefix)await f.add({...body(id),item:{...item(id),dirty:true}});await f.add({...body(imported),item:{...item(imported),kind:'import'}});
  await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;expect((await f.space.runWindow(1,4)).status).toBe('budget');expect((await f.cache.scanCursor()).after).not.toBe('');
  if(mutation==='add')await f.add(body(rss));else await f.cache.touch(rss,{dirty:false});expect((await f.cache.scanCursor()).after).toBe('');
  f.db.close();db=new SqlFixture(join(f.root,'state.sqlite'));const cache=new WatchSpaceStore(db,cipher,f.cache.files,f.cache.binding);await cache.init();const space=new WatchSpaceV2(cache,{...f.space.ports,projection:db.store()});expect((await space.runWindow(1,10000)).freed).toBe(128);
  expect((await cache.open((await cache.journal.row(rss))!)).status).toBe('placeholder');expect((await cache.open((await cache.journal.row(imported))!)).status).toBe('ready');
 }finally{db?.close();f.close();}
});

test('REREVIEW restoring an earlier RSS invalidates a paused import cursor',async()=>{
 const f=await fixture();try{
  const rss='0'.repeat(64),blocked='1'.repeat(64),imported='2'.repeat(64);await f.add(body(rss));await f.add({...body(blocked),item:{...item(blocked),kind:'import',dirty:true}});await f.add({...body(imported),item:{...item(imported),kind:'import'}});await f.cache.setAutoEvict(true);expect((await f.space.runWindow(1)).freed).toBe(128);
  let tick=0;f.space.ports.monotonic=()=>tick++;expect((await f.space.runWindow(1,4)).status).toBe('budget');const resource={id:'9'.repeat(64),path:f.cache.binding+'/'+'9'.repeat(64)+'.data',bytes:128},plain=new Uint8Array(128).fill(33);await f.cache.files.publish(resource.path,plain);await f.space.restore(rss,async()=>({resources:[resource],size:128,read:async(at,length)=>plain.subarray(at,at+length)}));
  expect((await f.space.runWindow(1,10000)).freed).toBe(128);expect((await f.cache.open((await f.cache.journal.row(rss))!)).status).toBe('placeholder');expect((await f.cache.open((await f.cache.journal.row(imported))!)).status).toBe('ready');
 }finally{f.close();}
});

test('REREVIEW an in-flight import cannot commit after an earlier RSS joins the candidates',async()=>{
 const f=await fixture();try{
  const rss='a'.repeat(64),imported='c'.repeat(64);await f.add({...body(imported),item:{...item(imported),kind:'import'}});await f.cache.setAutoEvict(true);f.beforeProof=async()=>{f.beforeProof=undefined;await f.add(body(rss));};const first=await f.space.runWindow(1);
  expect(first.status).toBe('candidates-changed');expect(first.freed).toBe(0);expect((await f.cache.open((await f.cache.journal.row(imported))!)).status).toBe('ready');expect((await f.space.runWindow(1)).freed).toBe(128);expect((await f.cache.open((await f.cache.journal.row(rss))!)).status).toBe('placeholder');
 }finally{f.close();}
});

test('REREVIEW adding the candidate epoch resets an ambiguous legacy cursor once',async()=>{
 const f=await fixture();try{
  const {WatchSpaceStore}=await import('../../src/sync-v2/space-store'),{cipher}=await import('./fixture'),{WatchSpaceV2}=await import('../../src/sync-v2/space'),rss='a'.repeat(64),imported='c'.repeat(64);await f.add(body(rss));await f.add({...body(imported),item:{...item(imported),kind:'import'}});await f.cache.setAutoEvict(true);await f.cache.advanceScan(await f.cache.scanCursor(),(await f.cache.journal.row(rss))!.sort);await f.db.execute('DROP TABLE sync2_space_candidates');
  const cache=new WatchSpaceStore(f.db,cipher,f.cache.files,f.cache.binding);await cache.init();expect((await cache.scanCursor()).after).toBe('');expect((await new WatchSpaceV2(cache,f.space.ports).runWindow(1)).freed).toBe(128);expect((await cache.open((await cache.journal.row(rss))!)).status).toBe('placeholder');expect((await cache.open((await cache.journal.row(imported))!)).status).toBe('ready');
 }finally{f.close();}
});

for(const kind of ['reading','note-title','asset-filename'])test('REREVIEW acknowledged '+kind+' metadata does not retain unchanged body pins',async()=>{
 const s=await restoredSetup(kind==='note-title'?'note':kind==='asset-filename'?'current.png':'rss');try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);const before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,localChangeRevision:nextD64(before.localChangeRevision),hasUnsentEdits:true});
  await s.installCurrent(rows=>{const row=rows.find(r=>r.row.entityKey===s.record.id);if(kind==='reading')row.state.payload.readingProgressMicros=500000;else if(kind==='note-title')row.meta.payload.title='new note title';else row.meta.payload.originalFilename='renamed.png';});
  const calls=s.backend.calls['/availability/check']??0;expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(1);expect((s.backend.calls['/availability/check']??0)-calls).toBe(kind==='note-title'?3:1);expect((await s.cache.collect()).freed).toBeGreaterThan(0);
 }finally{s.close();}
});

for(const mode of ['recipe','body-revision','body-hash','partial','expired','unacknowledged'])test('REREVIEW metadata change with '+mode+' still retains necessary body pins',async()=>{
 const s=await restoredSetup();try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);const before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,localChangeRevision:nextD64(before.localChangeRevision),hasUnsentEdits:true});
  await s.installCurrent(rows=>{const row=rows.find(r=>r.row.entityKey===s.record.id);row.meta.payload.title='new title';if(mode==='recipe')row.row.recipeOid='recipe:sha256:'+'0'.repeat(64);if(mode==='body-revision')row.row.bodyRevision='0'.repeat(32);if(mode==='body-hash')row.row.opaqueContentId='0'.repeat(64);});
  if(mode==='partial')s.backend.objects.delete(s.value.bodyRefs.find(ref=>ref.startsWith('blob:'))!);if(mode==='expired')s.receiptMode='expired';if(mode==='unacknowledged'){const state=await s.projection.readState();await s.projection.controlUpdate(state,{...state,acknowledgedLocalChangeRevision:'0'});}
  expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(0);expect((await s.cache.collect()).freed).toBe(0);const pin=(await s.projection.readState()).recoveryEditPins![0];for(const ref of s.value.bodyRefs)expect(sha(Buffer.concat(await s.recovery.readEditBody(pin.editId,ref)))).toBe(ref.split(':sha256:')[1]);
 }finally{s.close();}
});

test('REREVIEW sufficient capacity closes a paused round and fences its stale cursor',async()=>{
 const f=await fixture();try{
  for(let n=0;n<3;n++){const id=n.toString(16).padStart(64,'0');await f.add({...body(id),item:{...item(id),dirty:true}});}await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;expect((await f.space.runWindow(1,4)).status).toBe('budget');const paused=await f.cache.scanCursor();expect(paused.after).not.toBe('');
  f.capacity=1;expect((await f.space.runWindow(1,4)).status).toBe('sufficient');expect((await f.cache.scanCursor()).after).toBe('');await expect(f.cache.advanceScan(paused,paused.after)).rejects.toThrow('scan_stale');expect((await f.cache.scanCursor()).after).toBe('');
 }finally{f.close();}
});
