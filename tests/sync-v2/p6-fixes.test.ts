import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fixture,scope} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {watchSyncV2Product,leasedSyncV2Session} from '../../src/sync-v2/product-start';
import {WatchContentEngine} from '../../src/sync-v2/content-engine';
import {WatchBusinessClosure} from '../../src/sync-v2/business-closure';
import {recoveryDelta} from '../../src/sync-v2/recovery';
import {WatchCloudScheduler,CLOUD_INTERVAL} from '../../src/cloud/scheduler';
import {openV2} from '../../src/sync-v2/sealed';

// All production components run unchanged. Only SQL/secure/crypto/network host
// boundaries are supplied by the fixture; no scanner/control/publisher stubs.
test('P6 W01 existing remote notes reach the native DB before the applied ACK',async()=>{
 const seed=await fixture(),receiver=await fixture();let a:any,b:any;
 try{
  a=await openApplicationSyncV2(seed.options);await a.close();a=null;
  await receiver.db.execute('DELETE FROM memo_notes');receiver.options.transport=seed.server;
  seed.server.onApplied=async()=>{expect((await receiver.db.query('SELECT title FROM memo_notes')).map(r=>r.title)).toEqual(['title n']);};
  b=await openApplicationSyncV2(receiver.options);
  expect((await receiver.db.query('SELECT title FROM memo_notes')).map(r=>r.title)).toEqual(['title n']);
  const state=await b.ui.o.projection.readState();expect(state.activeGeneration).toBe(state.account.oid);
  expect(seed.server.applied).toHaveLength(1);expect((await b.ui.snapshot()).gates.choiceApply).toBe(true);
 }finally{await a?.close();await b?.close();seed.db.close();receiver.db.close();}
});

test('P6 W01 a real SQLite abort keeps the complete old native generation and emits no ACK',async()=>{
 const seed=await fixture(),receiver=await fixture();let a:any,b:any;
 try{
  a=await openApplicationSyncV2(seed.options);await a.close();a=null;
  await receiver.db.execute('DELETE FROM memo_notes');
  await receiver.db.execute("CREATE TRIGGER fail_apply BEFORE INSERT ON memo_notes BEGIN SELECT RAISE(ABORT,'synthetic_apply_abort');END");
  receiver.options.transport=seed.server;
  await expect(openApplicationSyncV2(receiver.options)).rejects.toThrow('synthetic_apply_abort');
  expect(await receiver.db.query('SELECT * FROM memo_notes')).toEqual([]);expect(seed.server.applied).toEqual([]);
  await receiver.db.execute('DROP TRIGGER fail_apply');b=await openApplicationSyncV2(receiver.options);
  expect((await receiver.db.query('SELECT title FROM memo_notes')).map(r=>r.title)).toEqual(['title n']);
  expect(seed.server.applied).toHaveLength(1);
 }finally{await a?.close();await b?.close();seed.db.close();receiver.db.close();}
});

test('P6 W02 same-session scheduled sync captures a later local edit through the writer lease',async()=>{
 const x=await fixture();let installs=0,held=false;
 const exclusive=async<T>(work:()=>Promise<T>)=>{expect(held).toBe(false);held=true;try{return await work();}finally{held=false;}};
 const product=watchSyncV2Product({enabled:true,drainOnStop:true,announced:async()=>true,open:async()=>{const s=await exclusive(()=>openApplicationSyncV2(x.options));return s?leasedSyncV2Session(s,exclusive):null;},install:p=>{if(p)installs++;}});
 let now=0,timer:(()=>void)|undefined,running:Promise<boolean>|undefined;
 const scheduler=new WatchCloudScheduler({now:()=>now,sync:manual=>{expect(manual).toBe(false);return running=product.sync('same-owner').then(()=>true);},delay:(_ms,fn)=>{timer=fn;return()=>{timer=undefined;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},{require(){}});
 try{
  await scheduler.start(true);scheduler.foreground(true);await running;for(let i=0;i<8;i++)await Promise.resolve();const revision=x.server.account.revision;
  await x.db.execute("UPDATE memo_notes SET title='scheduled edit',updated_at=3 WHERE note_id='n'");
  scheduler.trigger('library');expect(timer).toBeDefined();now=CLOUD_INTERVAL;timer!();await running;expect(installs).toBe(1);expect(x.server.account.revision).not.toBe(revision);
  expect((await (await product.start('same-owner'))!.snapshot()).enabled).toBe(true);
 }finally{scheduler.dispose();await product.stop();x.db.close();}
});

test('P6 W03 close zeros every reachable account-key buffer and disposes the old UI',async()=>{
 const x=await fixture();let opened:any;
 try{
  opened=await openApplicationSyncV2(x.options);const ui=opened.ui,o=ui.o;
  const buffers=[o.projection.key,o.control.o.publisher.keys.id,o.control.o.publisher.keys.content,o.control.o.business.idKey];
  expect(buffers.every(b=>b instanceof Uint8Array&&b.some((n:number)=>n!==0))).toBe(true);
  await opened.close();await opened.close();
  for(const b of buffers)expect(b.every((n:number)=>n===0)).toBe(true);
  expect(ui.o.runtime).toBeNull();expect(ui.o.control).toBeNull();expect(ui.o.projection).toBeNull();
  await expect(ui.syncNow()).rejects.toThrow('feature_disabled');expect((await ui.snapshot()).enabled).toBe(false);
 }finally{await opened?.close();x.db.close();}
});

test('P6 W03 failed opening zeros acquired account content keys',async()=>{
 const x=await fixture(),buffers:Uint8Array[]=[],read=x.options.keys.accountKey;
 x.options.keys.accountKey=async()=>{const key=await read();buffers.push(key);return key;};
 x.server.failBeforePublishOnce=true;
 try{await expect(openApplicationSyncV2(x.options)).rejects.toThrow('synthetic_request_lost');expect(buffers.length).toBeGreaterThan(1);for(const b of buffers)expect(b.every(n=>n===0)).toBe(true);}finally{x.db.close();}
});

test('P6 W04 historical recipe ACK uses its authenticated version; missing key preserves state and pins',async()=>{
 const {setup}=await import('./p3br-formal-fixture'),{keys}=await import('./p3-fixture'),{scope}=await import('./fixture');
 const s=await setup(records=>records.splice(0,records.length,...records.filter(r=>r.logicalId==='rss')));
 try{
  const r=s.records[0]!,candidate=await s.projection.readCandidate(r.id),binding=await s.f.e.businessBinding(r.id),manifest=await s.f.e.manifest(r.id,binding!.bodyRevision),value=await s.closures.recoveryValue(r.id),root='tree:sha256:'+'9'.repeat(64),head='commit:sha256:'+'7'.repeat(64);
  const before=await s.projection.stageCloudRows(root,[{row:{entityKey:r.id,...manifest,deleted:false},meta:candidate.meta,state:candidate.state}],await s.projection.readState());
  await s.projection.controlUpdate(before,{...before,hasUnsentEdits:false,account:{oid:head,revision:'1',generation:'0'},lastSeenAccountOid:head,lastSeenAccountRevision:'1',cloud:{...before.cloud,current:{commitOid:head,treeRoot:root}}});
  const delta=recoveryDelta({[r.id]:value},{},{accountOid:head,generation:'0'}),read=async(ref:string)=>[s.backend.objects.get(ref)!];
  const upgradedKeys={...keys,version:2,content:new Uint8Array(32).fill(9),readContentKey:async(v:number)=>{if(v===1)return keys.content;throw Error('key_unavailable');}};
  const engine=new WatchContentEngine(s.f.store,s.f.e.remote,s.f.e.crypto,upgradedKeys,s.f.e.options),closures=new WatchBusinessClosure(s.projection,engine);
  const recipeOid=value.bodyRefs.find((id:string)=>id.startsWith('recipe:'))!;
  expect((await openV2(s.f.e.crypto,keys.id,upgradedKeys.readContentKey,scope,recipeOid,s.backend.objects.get(recipeOid)!)).header.keyVersion).toBe(1);
  expect((await closures.acknowledgeRecovery(delta,read,()=>s.backend.clock)).expiresAtMillis).toBeGreaterThan(s.backend.clock);
  const state=await s.projection.readStableState(),rows=await s.f.db.query('SELECT * FROM sync2_content_projection ORDER BY binding,id');
  expect(rows.length).toBeGreaterThan(0);
  const missing=new WatchBusinessClosure(s.projection,new WatchContentEngine(s.f.store,s.f.e.remote,s.f.e.crypto,{...upgradedKeys,readContentKey:async()=>{throw Error('key_unavailable');}},s.f.e.options));
  await expect(missing.acknowledgeRecovery(delta,read,()=>s.backend.clock)).rejects.toThrow('key_unavailable');
  expect(await s.projection.readStableState()).toEqual(state);expect(await s.f.db.query('SELECT * FROM sync2_content_projection ORDER BY binding,id')).toEqual(rows);
  const legacy=new WatchBusinessClosure(s.projection,new WatchContentEngine(s.f.store,s.f.e.remote,s.f.e.crypto,{...keys,version:2},s.f.e.options));
  await expect(legacy.acknowledgeRecovery(delta,read,()=>s.backend.clock)).rejects.toThrow('body_revision_changed');
 }finally{s.close();}
});

test('P6 W05 release browser artifact rejects runtime loopback booleans and the omitted policy',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'p6-release-'));
 try{
  const entry=join(dir,'entry.ts');writeFileSync(entry,`export {syncV2Origin,SyncV2Http} from ${JSON.stringify(resolve(import.meta.dir,'../../src/sync-v2/http.ts'))};`);
  const built=await Bun.build({entrypoints:[entry],target:'browser',conditions:['browser'],define:{'process.env.NODE_ENV':'"production"'},format:'esm',outdir:dir,naming:'release.mjs',minify:true});expect(built.success).toBe(true);
  const release=await import(join(dir,'release.mjs'));
  for(const origin of ['http://localhost:19999','http://127.0.0.1:19999','http://[::1]:19999']){
   expect(()=>release.syncV2Origin(origin,{accountBaseUrl:origin,allowLoopback:true})).toThrow('isolated_backend_required');
   expect(()=>new release.SyncV2Http({},origin,scope,async()=>null)).toThrow('isolated_backend_required');
  }
  expect(release.syncV2Origin('https://release.invalid',{accountBaseUrl:'https://release.invalid',allowLoopback:true})).toBe('https://release.invalid');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const mode of ['DELETE','WAL'])test('P6 W01 '+mode+' native replacement rolls back both notes and activeGeneration together',async()=>{
 const root=mkdtempSync(join(tmpdir(),'p6-atomic-')),seed=await fixture(),receiver=await fixture({path:join(root,'receiver.sqlite'),mode});let a:any,b:any;
 try{
  await seed.db.execute("INSERT INTO memo_notes SELECT 'm',folder_id,'old m',markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes WHERE note_id='n'");
  a=await openApplicationSyncV2(seed.options);await receiver.db.execute('DELETE FROM memo_notes');receiver.options.transport=seed.server;b=await openApplicationSyncV2(receiver.options);
  const projection=b.ui.o.projection,old=await receiver.db.query('SELECT * FROM memo_notes ORDER BY note_id'),active=(await projection.readState()).activeGeneration,acks=seed.server.applied.length;
  await seed.db.execute("UPDATE memo_notes SET title='new '||note_id,updated_at=4");await a.sync();
  // Abort the second native update, after one update has executed in SQLite.
  await receiver.db.execute("CREATE TEMP TABLE p6_apply_count(n INTEGER)");await receiver.db.execute('INSERT INTO p6_apply_count VALUES(0)');
  await receiver.db.execute("CREATE TEMP TRIGGER fail_second BEFORE UPDATE ON memo_notes BEGIN UPDATE p6_apply_count SET n=n+1; SELECT CASE WHEN (SELECT n FROM p6_apply_count)=2 THEN RAISE(ABORT,'second_native_write') END;END");
  await expect(b.ui.syncNow()).rejects.toThrow('second_native_write');
  expect(await receiver.db.query('SELECT * FROM memo_notes ORDER BY note_id')).toEqual(old);
  expect((await projection.readState()).activeGeneration).toBe(active);expect(seed.server.applied.length).toBe(acks);
  await receiver.db.execute('DROP TRIGGER fail_second');await b.ui.syncNow();
  expect((await receiver.db.query('SELECT title FROM memo_notes ORDER BY note_id')).map(r=>r.title)).toEqual(['new m','new n']);
  const current=await projection.readState();expect(current.activeGeneration).toBe(current.account.oid);expect(current.activeGeneration).not.toBe(active);expect(seed.server.applied.length).toBe(acks+1);
 }finally{await a?.close();await b?.close();seed.db.close();receiver.db.close();rmSync(root,{recursive:true,force:true});}
});

test('P6 W01 the persisted choice_apply gate still fences product business application',async()=>{
 const seed=await fixture(),receiver=await fixture();let a:any,b:any;
 try{
  a=await openApplicationSyncV2(seed.options);await receiver.db.execute('DELETE FROM memo_notes');receiver.options.transport=seed.server;b=await openApplicationSyncV2(receiver.options);
  const projection=b.ui.o.projection,active=(await projection.readState()).activeGeneration,acks=seed.server.applied.length;
  await b.ui.o.control.setWriteGates({history_restore:false,choice_apply:false});
  await seed.db.execute("UPDATE memo_notes SET title='remote edit',updated_at=5");await a.sync();await b.ui.syncNow();
  expect((await receiver.db.query('SELECT title FROM memo_notes'))[0]!.title).toBe('title n');expect((await projection.readState()).activeGeneration).toBe(active);expect(seed.server.applied.length).toBe(acks);expect((await b.ui.snapshot()).gates.choiceApply).toBe(false);
 }finally{await a?.close();await b?.close();seed.db.close();receiver.db.close();}
});
