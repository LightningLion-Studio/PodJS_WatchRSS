import {test,expect} from 'bun:test';
import {statSync} from 'node:fs';
import {fixture,id,now,sha} from './p3b-fixture';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';

test('P3BR pause budget must not starve the next candidate forever',async()=>{
 const f=await fixture();try{
  const {body,item}=await import('./p3b-fixture');
  for(let n=0;n<3;n++){const key=n.toString(16).padStart(64,'0');await f.add({...body(key),item:{...item(key),dirty:n<2}});}
  await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;
  const windows=[];for(let n=0;n<3;n++)windows.push(await f.space.runWindow(1,4));
  console.log(JSON.stringify({case:'scan-starvation',windows,requests:f.requests}));
  expect(windows.reduce((n,w)=>n+w.freed,0)).toBeGreaterThan(0);
 }finally{f.close();}
});

test('P3BR repeated restore and eviction must not accumulate abandoned transfer bodies',async()=>{
 const {ContentBackend,engine}=await import('./p3-fixture');
 const {WatchSpaceStore}=await import('../../src/sync-v2/space-store');
 const {WatchSpaceV2}=await import('../../src/sync-v2/space');
 const {cipher}=await import('./fixture');
 const {body,item}=await import('./p3b-fixture');
 const {mkdtempSync,mkdirSync,rmSync,readdirSync}=await import('node:fs');
 const {randomBytes}=await import('node:crypto');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'wrss-p3br-cycle-'));mkdirSync(join(root,'send'));mkdirSync(join(root,'recv'));
 const backend=new ContentBackend(),plain=randomBytes(262147),send=engine(join(root,'send'),backend,plain);let recv=engine(join(root,'recv'),backend,new Uint8Array());
 const key={entityKey:id,bodyRevision:'f'.repeat(32),kind:'file' as const,importedFile:true,addedAtMillis:1,sourceBinding:'immutable'};
 try{
  await send.store.init();await send.e.enqueue(key,'upload');await send.e.runWindow();
  const manifest=(await send.e.manifest(id,key.bodyRevision))!,{sourceBinding,...input}=key;
  await recv.store.init();await recv.e.enqueue({...input,...manifest},'download');await recv.e.runWindow();
  let cache=new WatchSpaceStore(recv.db,cipher,recv.store.files,recv.store.prefix);await cache.init();
  const descriptor=await recv.e.derivedBody(id,key.bodyRevision),value={...body(),item:{...item(),kind:'import',localBytes:plain.length,recipeOid:manifest.recipeOid},plaintextSha256:sha(plain)};
  await cache.register(descriptor.resources);await cache.add(value,descriptor.resources.map(r=>r.id));
  const bytes=()=>readdirSync(join(recv.host.root,recv.store.prefix)).filter(n=>n.endsWith('.data')).reduce((total,n)=>total+statSync(join(recv.host.root,recv.store.prefix,n)).size,0);
  const samples:number[]=[];
  for(let cycle=0;cycle<3;cycle++){
   const row=(await cache.journal.row(id))!;await recv.db.transaction([...cache.journal.replace(row,await cache.seal(id,{...value,status:'placeholder'})),cache.journal.detach('body:'+id),...await recv.e.prepareEviction(id,key.bodyRevision)]);
   for(let i=0;i<10;i++){if((await cache.collect()).files===0)break;}samples.push(bytes());if(cycle===2)break;
   recv.db.close();recv=engine(join(root,'recv'),backend,new Uint8Array());await recv.store.init();cache=new WatchSpaceStore(recv.db,cipher,recv.store.files,recv.store.prefix);await cache.init();
   const downloaded=backend.downloaded;await recv.e.enqueue({...input,...manifest},'download');await recv.e.runWindow();expect(backend.downloaded).toBe(downloaded);
   const restored=await recv.e.derivedBody(id,key.bodyRevision),space=new WatchSpaceV2(cache,{} as any);
   await space.restore(id,async()=>({resources:restored.resources,size:plain.length,read:(at,length)=>recv.e.readRange(id,key.bodyRevision,at,length)}));
  }
  console.log(JSON.stringify({case:'retained-transfer-growth',plainBytes:plain.length,dataBytesAfterEachEviction:samples}));
  expect(samples[2]).toBeLessThanOrEqual(samples[0]+4096);
 }finally{send.db.close();recv.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P3BR formally authenticated restored edit must retain its necessary body at N07 expiry',async()=>{
 const {setup}=await import('./p3br-formal-fixture');
 const {WatchSpaceStore}=await import('../../src/sync-v2/space-store');
 const {WatchRecovery}=await import('../../src/sync-v2/recovery');
 const {captureChoice}=await import('../../src/sync-v2/state');
 const {cipher}=await import('./fixture');const {recoveryCipher,accountOid}=await import('./p3b-fixture');
 const {writeFileSync}=await import('node:fs');const s=await setup(records=>{records.splice(0,records.length,...records.filter(r=>r.logicalId==='rss'));});
 try{
  const cache=new WatchSpaceStore(s.f.db,cipher,s.f.store.files,s.f.store.prefix);await cache.init();
  const state=await s.projection.readState();await s.projection.controlUpdate(state,{...state,account:{oid:accountOid,revision:'1',generation:'0'},lastSeenAccountOid:accountOid,lastSeenAccountRevision:'1',hasUnsentEdits:true,pendingChoice:{generation:'0',inboxKeys:[]}});
  const r=s.records.find(r=>r.logicalId==='rss'),value=await s.closures.recoveryValue(r.id),pending=await s.projection.readState();
  const recovery=new WatchRecovery(s.projection,cache,{cipher:recoveryCipher,randomId:async()=> 'a'.repeat(32),trustedNow:()=>now,source:(refs,changes)=>s.closures.source(refs,changes),reserve:async()=>async()=>{}});
  const copy=(await recovery.applyCloud({capture:captureChoice(pending,pending.account!),local:{[r.id]:value},cloud:{},explicitCloudChoice:true,next:{...pending,pendingChoice:null,hasUnsentEdits:false,activeGeneration:'cloud'},statements:[]}))!;
  const resources=await cache.journal.resourcePage('recovery:'+copy.copyId);
  // Retire only this scratch fixture's original local source after the cloud choice.
  const binding=await s.f.e.businessBinding(r.id),closure=await s.f.e.authenticatedClosure(r.id,binding.bodyRevision,undefined,true),plan=(await s.f.store.get('body:'+ (await import('../../src/sync-v2/protocol')).digest([r.id,binding.bodyRevision])))!.value;
  const key=(await import('../../src/sync-v2/protocol')).digest([r.id,binding.bodyRevision]);for(const path of [s.f.store.path(plan.recipeObject.cache),...plan.recipe.blocks.map((_:any,index:number)=>s.f.store.path('prepared:'+key+':'+index))])writeFileSync(s.f.host.path(path),new Uint8Array());
  s.f.e.options.source=async()=>{throw Error('source_retired_after_cloud_choice');};
  await recovery.restoreAsEdits(copy.copyId,async delta=>[
   {sql:'CREATE TABLE pending_body_edit(entity TEXT,value TEXT,body_refs TEXT)'},
   {sql:'INSERT INTO pending_body_edit VALUES(?,?,?)',params:[r.id,JSON.stringify(delta.changes),JSON.stringify(delta.bodyRefs)]}
  ]);
  const restored=await s.projection.readState(),purged=await recovery.purgeRecovery(now+SEVEN_DAYS),remaining=resources.reduce((n,r)=>n+statSync(s.f.host.path(r.path)).size,0);
  const restoredBody=await recovery.readBody(copy,value.bodyRefs[0]),readResult=sha(Buffer.concat(restoredBody));expect(value.bodyRefs[0].split(':sha256:')[1]).toBe(readResult);
  console.log(JSON.stringify({case:'formal-restore-expiry',authenticatedObjects:closure.objects.length,necessaryRefs:value.bodyRefs.length,hasUnsentEdits:restored.hasUnsentEdits,pendingEdits:(await s.f.db.query('SELECT entity FROM pending_body_edit')).length,remainingBodyBytes:remaining,readResult,purged}));
  expect(remaining).toBeGreaterThan(0);expect(restored.recoveryEditPins?.length).toBe(1);
 }finally{s.close();}
});

for(const logical of ['rss','note'])test('P3BR restored '+logical+' edit body survives expiry and SQLite reopen',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup(logical);try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);await s.reopen();
  const state=await s.projection.readState(),pin=state.recoveryEditPins![0];expect(state.recoveryCopies).toEqual([]);expect(state.hasUnsentEdits).toBe(true);
  for(const ref of s.value.bodyRefs)expect(sha(Buffer.concat(await s.recovery.readEditBody(pin.editId,ref)))).toBe(ref.split(':sha256:')[1]);
  expect((await s.cache.collect()).freed).toBe(0);
 }finally{s.close();}
});

test('P3BR restore transaction failure rolls back edit, descriptor and ownership together',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup();try{
  const before=await s.projection.readState();await expect(s.recovery.restoreAsEdits(s.copy.copyId,async()=>[{sql:'INSERT INTO no_such_pending_edit VALUES(1)'}])).rejects.toThrow();
  expect(await s.projection.readState()).toEqual(before);expect((await s.cache.journal.page()).filter(r=>r.id.startsWith('edit-recovery:'))).toEqual([]);
  for(const ref of s.value.bodyRefs)expect(sha(Buffer.concat(await s.recovery.readBody(s.copy,ref)))).toBe(ref.split(':sha256:')[1]);
 }finally{s.close();}
});

for(const mode of ['not-uploaded','partial','expired','tampered','offline','old-version','edited-again','account-race'])test('P3BR '+mode+' cannot release a restored edit pin',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup();try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);
  await s.installCurrent(mode==='old-version'?rows=>{rows.find(r=>r.row.entityKey===s.record.id).row.bodyRevision='0'.repeat(32);}:undefined);
  if(mode==='not-uploaded'||mode==='edited-again'){const before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,...(mode==='not-uploaded'?{acknowledgedLocalChangeRevision:'0'}:{hasUnsentEdits:true})});}
  if(mode==='partial')s.backend.objects.delete(s.value.bodyRefs.find(ref=>ref.startsWith('blob:'))!);
  if(mode==='expired'||mode==='tampered')s.receiptMode=mode;if(mode==='offline')s.backend.busy=true;
  if(mode==='account-race'){const proof=s.recovery.ports.acknowledge!;s.recovery.ports.acknowledge=async(...args)=>{const result=await proof(...args),before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,account:{...before.account!,oid:'commit:sha256:'+'0'.repeat(64),revision:'2'}});return result;};await expect(s.recovery.releaseAcknowledgedEdits()).rejects.toThrow('choice_stale');}
  else expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(0);
  expect((await s.projection.readState()).recoveryEditPins?.length).toBe(1);expect((await s.cache.collect()).freed).toBe(0);
  const pin=(await s.projection.readState()).recoveryEditPins![0];for(const ref of s.value.bodyRefs)expect(sha(Buffer.concat(await s.recovery.readEditBody(pin.editId,ref)))).toBe(ref.split(':sha256:')[1]);
 }finally{s.close();}
});

for(const logical of ['rss','note'])test('P3BR uploaded '+logical+' edit releases only after fresh current closure acknowledgement',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup(logical);try{
  await s.restore();s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);await s.installCurrent();await s.reopen();
  const calls=s.backend.calls['/availability/check']??0;expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(1);expect(s.backend.calls['/availability/check']-calls).toBe(logical==='note'?3:1);
  expect((await s.projection.readState()).recoveryEditPins).toEqual([]);let freed=0;for(let i=0;i<8;i++){const result=await s.cache.collect();freed+=result.freed;if(result.files<32)break;}expect(freed).toBeGreaterThan(0);
  for(const r of s.resources)expect(statSync(s.f.host.path(r.path)).size).toBe(0);
 }finally{s.close();}
});

test('P3BR two restored edits retain shared body until both revisions are acknowledged',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup();try{
  await s.restore();await s.restore();const pins=(await s.projection.readState()).recoveryEditPins!;expect(pins.length).toBe(2);
  s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);await s.installCurrent();let before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,acknowledgedLocalChangeRevision:pins[0].localChangeRevision});
  expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(1);expect((await s.cache.collect()).freed).toBe(0);expect(sha(Buffer.concat(await s.recovery.readEditBody(pins[1].editId,s.value.bodyRefs[0])))).toBe(s.value.bodyRefs[0].split(':sha256:')[1]);
  before=await s.projection.readState();await s.projection.controlUpdate(before,{...before,acknowledgedLocalChangeRevision:pins[1].localChangeRevision});expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(1);expect((await s.cache.collect()).freed).toBeGreaterThan(0);
 }finally{s.close();}
});

test('P3BR budget cursor survives SQLite reopen and wraps only after exhaustion',async()=>{
 const f=await fixture();let db:any;try{
  const {body,item}=await import('./p3b-fixture'),{SqlFixture,cipher}=await import('./fixture'),{WatchSpaceStore}=await import('../../src/sync-v2/space-store'),{WatchSpaceV2}=await import('../../src/sync-v2/space'),{join}=await import('node:path');
  for(let n=0;n<3;n++){const key=n.toString(16).padStart(64,'0');await f.add({...body(key),item:{...item(key),dirty:n<2}});}await f.cache.setAutoEvict(true);let tick=0;f.space.ports.monotonic=()=>tick++;
  expect((await f.space.runWindow(1,4)).status).toBe('budget');const cursor=await f.cache.scanCursor();expect(cursor.after).toBe((await f.cache.journal.page())[1].sort);
  f.db.close();db=new SqlFixture(join(f.root,'state.sqlite'));const cache=new WatchSpaceStore(db,cipher,f.cache.files,f.cache.binding);await cache.init();expect(await cache.scanCursor()).toEqual(cursor);
  const space=new WatchSpaceV2(cache,{...f.space.ports,projection:db.store()});expect((await space.runWindow(1,4)).freed).toBe(128);
  await cache.touch('0'.repeat(64),{dirty:false});expect((await space.runWindow(1,100)).scanned).toBe(0);expect((await cache.scanCursor()).after).toBe('');expect((await space.runWindow(1,100)).freed).toBe(128);
 }finally{db?.close();f.close();}
});

test('P3BR shared OID survives another owner eviction and a mismatched recipe',async()=>{
 const {ContentBackend,engine,crypt,keys}=await import('./p3-fixture'),{WatchSpaceStore}=await import('../../src/sync-v2/space-store'),{sealV2}=await import('../../src/sync-v2/sealed'),{signControl}=await import('../../src/sync-v2/signing'),{jsonBytes,digest}=await import('../../src/sync-v2/protocol'),{cipher,scope}=await import('./fixture'),{body,item}=await import('./p3b-fixture');
 const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=mkdtempSync(join(tmpdir(),'wrss-p3br-shared-'));mkdirSync(join(root,'send'));mkdirSync(join(root,'recv'));
 const backend=new ContentBackend(),plain=new Uint8Array(65539).fill(29),send=engine(join(root,'send'),backend,plain),recv=engine(join(root,'recv'),backend,new Uint8Array()),revision='f'.repeat(32);
 try{
  await send.store.init();await recv.store.init();await send.e.enqueue({entityKey:id,bodyRevision:revision,kind:'file',addedAtMillis:1,sourceBinding:'immutable'},'upload');await send.e.runWindow();const manifest=(await send.e.manifest(id,revision))!,original=(await send.store.get('body:'+digest([id,revision])))!.value.recipe;
  const queue=async(entityKey:string,bad=false)=>{let m=manifest;if(entityKey!==id){const recipe={...original,entityKey,blocks:original.blocks.map((b:any)=>({...b,...(bad?{opaqueContentId:'0'.repeat(64)}:{})}))},sealed=await sealV2(crypt,keys.id,keys.content,scope,'recipe',1,jsonBytes(recipe));backend.objects.set(sealed.oid,sealed.bytes);await send.e.remote.http.json('POST','/recipe-refs',await signControl(crypt,'synthetic','wrss.sync.v2/recipe-refs-sign',{scope,recipeOid:sealed.oid,blobOids:recipe.blocks.map((b:any)=>b.oid)}));m={...manifest,recipeOid:sealed.oid};}await recv.e.enqueue({entityKey,kind:'file',addedAtMillis:1,...m},'download');};
  const second='d'.repeat(64);await queue(id);await queue(second);await recv.e.runWindow();const cache=new WatchSpaceStore(recv.db,cipher,recv.store.files,recv.store.prefix);await cache.init();
  for(const entityKey of [id,second]){const d=await recv.e.derivedBody(entityKey,revision);await cache.register(d.resources);await cache.add({...body(entityKey),item:{...item(entityKey),kind:'import',localBytes:plain.length,recipeOid:d.recipeOid},plaintextSha256:sha(plain)},d.resources.map(r=>r.id));}
  const row=(await cache.journal.row(id))!,value=await cache.open(row);await recv.db.transaction([...cache.journal.replace(row,await cache.seal(id,{...value,status:'placeholder'})),cache.journal.detach('body:'+id),...await recv.e.prepareEviction(id,revision)]);await cache.collect();
  expect(await recv.e.readRange(second,revision,0,plain.length)).toEqual(plain);const rawPath=recv.store.path('download:'+original.blocks[0].oid),rawBytes=statSync(recv.host.path(rawPath)).size;
  await queue('c'.repeat(64),true);await expect(recv.e.runWindow()).rejects.toThrow('fingerprint_mismatch');expect(statSync(recv.host.path(rawPath)).size).toBe(rawBytes);expect(await recv.e.readRange(second,revision,0,plain.length)).toEqual(plain);expect((await recv.e.authenticatedClosure(second,revision,undefined,true)).recipe.blocks[0].oid).toBe(original.blocks[0].oid);
 }finally{send.db.close();recv.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P3BR late restore handoff failure leaves neither edit SQL nor orphan edit pin',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup();try{
  const before=await s.projection.readState(),update=s.projection.controlUpdate.bind(s.projection);s.projection.controlUpdate=async(expected,next,statements)=>update(expected,next,[...statements??[],{sql:'INSERT INTO missing_after_handoff VALUES(1)'}]);
  await expect(s.restore()).rejects.toThrow('missing_after_handoff');s.projection.controlUpdate=update;expect(await s.projection.readState()).toEqual(before);expect((await s.cache.journal.page()).filter(r=>r.id.startsWith('edit-recovery:'))).toEqual([]);expect(await s.f.db.query("SELECT name FROM sqlite_master WHERE name='pending_body_edit'")).toEqual([]);
  expect(await s.restore()).toBe(1);s.time=now+SEVEN_DAYS;await s.recovery.purgeRecovery(s.time);expect((await s.cache.collect()).freed).toBe(0);
 }finally{s.close();}
});

test('P3BR valid acknowledgement retains the original unexpired recovery promise',async()=>{
 const {restoredSetup}=await import('./p3br-formal-fixture'),s=await restoredSetup();try{
  await s.restore();await s.installCurrent();expect((await s.recovery.releaseAcknowledgedEdits()).released).toBe(1);expect((await s.cache.collect()).freed).toBe(0);
  expect((await s.projection.readState()).recoveryCopies?.length).toBe(1);for(const ref of s.value.bodyRefs)expect(sha(Buffer.concat(await s.recovery.readBody(s.copy,ref)))).toBe(ref.split(':sha256:')[1]);
  s.time=now+SEVEN_DAYS;const purged=await s.recovery.purgeRecovery(s.time);expect('freed' in purged?purged.freed:0).toBeGreaterThan(0);
 }finally{s.close();}
});
