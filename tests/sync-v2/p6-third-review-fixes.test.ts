import {test,expect} from 'bun:test';
import {fixture} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {watchSyncV2Product,leasedSyncV2Session} from '../../src/sync-v2/product-start';
import {parseCanonicalJson} from '../../src/sync-v2/protocol';
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
// Review counterexamples: only host IO and synthetic service boundaries vary.
// Opener, scanner, signing identity, publisher, reader, controller and SQL run intact.
test('P6 RRW2-01 generation-zero first-publish loser chooses local after reopen and publishes later edits',async()=>{
 const a=await fixture(),b=await fixture();let other:any,opened:any,interleaved=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");b.options.transport=a.server;
 const options={...a.options,transport:{request:async(r:any)=>{
  if(!interleaved&&r.url.endsWith('/objects/reserve')){interleaved=true;other=await openApplicationSyncV2(b.options);}
  return a.server.request(r);
 }}};
 try{
  opened=await openApplicationSyncV2(options);const winner={...a.server.account};await opened.close();opened=await openApplicationSyncV2(options);
  const preview=await opened.ui.openChoice();expect(preview.local.map((r:any)=>r.title)).toContain('local a');expect(preview.cloud.map((r:any)=>r.title)).toContain('remote b');
  const projection=opened.ui.o.projection,before=await projection.readState();expect(before.rollbackGeneration).toBe('0');
  await opened.ui.chooseLocal(preview);await opened.ui.syncNow();
  const state=await projection.readState();expect(state.pendingChoice).toBeNull();expect(state.cloud.pendingPublish).toBeNull();expect(state.activeGeneration).toBe(a.server.account.commitOid);expect(state.rollbackGeneration).toBe('0');
  expect(await a.db.query('SELECT note_id,title FROM memo_notes WHERE deleted=0')).toEqual([{note_id:'local-a',title:'local a'}]);
  expect(await b.db.query('SELECT note_id,title FROM memo_notes WHERE deleted=0')).toEqual([{note_id:'remote-b',title:'remote b'}]);
  const sent=parseCanonicalJson(Buffer.from(a.server.publishedBodies.at(-1)!,'base64')),commit=parseCanonicalJson(a.server.objects.get(a.server.account.commitOid!)!);
  expect(sent.account.body.expectedOid).toBe(winner.commitOid);expect(sent.account.body.expectedRevision).toBe(winner.revision);
  expect(commit.body.accountParent).toBe(winner.commitOid);expect(commit.body.rollbackGeneration).toBe('0');expect(commit.body.operation).toEqual({kind:'normal',rollbackTarget:null,resolvesGeneration:null});
  expect(commit.body.deviceSequence).toBe('2');expect(a.server.objects.has(winner.commitOid!)).toBe(true);
  const revision=a.server.account.revision;await a.db.execute("UPDATE memo_notes SET title='after resolution',updated_at=50");await opened.sync();expect(a.server.account.revision).not.toBe(revision);
  expect((await projection.readState()).hasUnsentEdits).toBe(false);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const changed of ['local-edit','remote-before-confirmation','remote-at-CAS'])test('P6 RRW2-01 explicit generation-zero choice retains capture and CAS fences: '+changed,async()=>{
 const a=await fixture(),b=await fixture();let other:any,opened:any,interleaved=false,armed=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");b.options.transport=a.server;
 const options={...a.options,transport:{request:async(r:any)=>{
  if(!interleaved&&r.url.endsWith('/objects/reserve')){interleaved=true;other=await openApplicationSyncV2(b.options);}
  if(armed&&r.url.endsWith('/account/publish')){armed=false;await other.sync();}
  return a.server.request(r);
 }}};
 try{
  opened=await openApplicationSyncV2(options);const preview=await opened.ui.openChoice(),captured={...a.server.account},sends=a.server.publishedBodies.length;
  if(changed==='local-edit'){await a.db.execute("UPDATE memo_notes SET title='new local edit',updated_at=60");await opened.sync();}
  else{await b.db.execute("UPDATE memo_notes SET title='new remote edit',updated_at=60");if(changed==='remote-at-CAS')armed=true;else await other.sync();}
  await expect(opened.ui.chooseLocal(preview)).rejects.toThrow(changed==='remote-at-CAS'?'ref_conflict':'choice_stale');
  expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe(changed==='local-edit'?'new local edit':'local a');
  expect((await b.db.query('SELECT title FROM memo_notes'))[0].title).toBe(changed==='local-edit'?'remote b':'new remote edit');expect(a.server.account.rollbackGeneration).toBe('0');
  if(changed==='local-edit')expect(a.server.publishedBodies).toHaveLength(sends);
  if(changed==='remote-at-CAS'){const sent=parseCanonicalJson(Buffer.from(a.server.publishedBodies.at(-1)!,'base64'));expect(sent.account.body.expectedOid).toBe(captured.commitOid);expect(sent.account.body.expectedRevision).toBe(captured.revision);}
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

test('P6 RRW2-02 native signing_key_missing preserves receiver UI, fixed identity and the same pending ACK',async()=>{
 const seed=await fixture(),x=await fixture();let remote:any,opened:any;
 try{
  remote=await openApplicationSyncV2(seed.options);await x.db.execute('DELETE FROM memo_notes');x.options.transport=seed.server;opened=await openApplicationSyncV2(x.options);await opened.close();opened=null;
  const slot=[...x.secrets.keys()].find(k=>k.startsWith('watchrss.syncv2.signer.'))!,record=x.secrets.get(slot),identitySlot=[...x.secrets.keys()].find(k=>k.includes('watchrss.syncv2.identity.'))!,identity=x.secrets.get(identitySlot);
  const native=x.options.host;let missing=true,creates=0,signs=0;x.options.host=async(method:string,args:any)=>{if(method==='crypto.v2.sign')signs++;if(method==='crypto.v2.signingKey'){if(args.create)creates++;if(missing)throw Object.assign(Error('signing_key_missing'),{code:'host_error'});}return native(method,args);};
  await seed.db.execute("UPDATE memo_notes SET title='native unavailable',updated_at=30");await remote.sync();const ackCount=seed.server.applied.length;let pending:any;
  for(let i=0;i<2;i++){
   opened=await openApplicationSyncV2(x.options);expect(opened).not.toBeNull();const state=await opened.ui.o.projection.readState(),snapshot=await opened.ui.snapshot();
   expect((await x.db.query('SELECT title FROM memo_notes'))[0].title).toBe('native unavailable');expect(snapshot.phase).toBe('blocked');expect(snapshot.errorCode).toBe('signing_state_unavailable');
   expect(state.cloud.pendingApplied).toBeTruthy();if(pending)expect(state.cloud.pendingApplied).toEqual(pending);pending=state.cloud.pendingApplied;
   await opened.ui.syncNow();await opened.close();opened=null;
  }
  expect(seed.server.applied).toHaveLength(ackCount);expect(x.secrets.get(slot)).toBe(record);expect(x.secrets.get(identitySlot)).toBe(identity);expect(creates).toBe(0);expect(signs).toBe(0);
  missing=false;opened=await openApplicationSyncV2(x.options);expect(opened).not.toBeNull();expect(seed.server.applied).toHaveLength(ackCount+1);expect(seed.server.applied.at(-1).requestId).toBe(pending.requestId);expect((await opened.ui.o.projection.readState()).cloud.pendingApplied).toBeNull();
 }finally{await opened?.close();await remote?.close();x.db.close();seed.db.close();}
});

for(const code of ['feature_disabled','cloud_account_busy','cloud_sync_suspended'])test('P6 RRW2-02 native signer keeps account cancellation fatal: '+code,async()=>{
 const x=await fixture();let opened:any;
 try{
  opened=await openApplicationSyncV2(x.options);await opened.close();opened=null;const secrets=[...x.secrets.entries()],native=x.options.host;
  x.options.host=async(method:string,args:any)=>{if(method==='crypto.v2.signingKey')throw Error(code);return native(method,args);};
  await expect(openApplicationSyncV2(x.options)).rejects.toThrow(code);expect([...x.secrets.entries()]).toEqual(secrets);expect(Number((await x.db.query('SELECT enabled FROM syncv2_control'))[0].enabled)).toBe(0);
 }finally{await opened?.close();x.db.close();}
});

test('P6 P3-01 repeated authenticated pulls preserve success time while ACK is pending and advance after repair',async()=>{
 const seed=await fixture(),x=await fixture();let remote:any,opened:any;
 try{
  remote=await openApplicationSyncV2(seed.options);await x.db.execute('DELETE FROM memo_notes');x.options.transport=seed.server;opened=await openApplicationSyncV2(x.options);await opened.close();opened=null;
  const slot=[...x.secrets.keys()].find(k=>k.startsWith('watchrss.syncv2.signer.'))!,saved=x.secrets.get(slot)!;x.secrets.set(slot,'{');
  await seed.db.execute("UPDATE memo_notes SET title='one',updated_at=30");await remote.sync();opened=await openApplicationSyncV2(x.options);
  const projection=opened.ui.o.projection,pending=(await projection.readState()).cloud.pendingApplied;expect((await opened.ui.snapshot()).lastSyncedAtMillis).toBeNull();
  await seed.db.execute("UPDATE memo_notes SET title='two',updated_at=40");await remote.sync();const before=seed.server.applied.length;
  for(let i=0;i<2;i++){
   await opened.ui.syncNow();const state=await projection.readState(),snapshot=await opened.ui.snapshot();expect(state.account.oid).toBe(seed.server.account.commitOid);expect(state.cloud.pendingApplied).toEqual(pending);expect(seed.server.applied).toHaveLength(before);expect(snapshot.errorCode).toBe('signing_state_unavailable');expect(snapshot.lastSyncedAtMillis).toBeNull();
  }
  x.secrets.set(slot,saved);await opened.ui.syncNow();expect((await x.db.query('SELECT title FROM memo_notes'))[0].title).toBe('two');expect((await projection.readState()).cloud.pendingApplied).toBeNull();expect(seed.server.applied.slice(before).map((a:any)=>a.requestId)).toContain(pending.requestId);expect((await opened.ui.snapshot()).lastSyncedAtMillis).toBe(100);
 }finally{await opened?.close();await remote?.close();x.db.close();seed.db.close();}
});

for(const cancelWaiting of [false,true])test('P6 RRW2-03 overlapping stops share SQL cleanup and cancel waiting start='+cancelWaiting,async()=>{
 const x=await fixture(),entered=defer(),release=defer();let armed=false,paused=false,tail:Promise<unknown>=Promise.resolve(),opens=0;
 const exclusive=<T>(work:()=>Promise<T>)=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
 const cleanupHost:any=async(method:string,args:any)=>{const result=await x.options.host(method,args);if(armed&&!paused&&method==='sql.query'&&args.sql==="SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_control'"){paused=true;entered.resolve();await release.promise;}return result;};
 const product=watchSyncV2Product({enabled:true,drainOnStop:true,announced:async()=>true,open:async lifetime=>{opens++;const opened=await exclusive(()=>openApplicationSyncV2({...x.options,lifetime,cleanupHost}));return opened?leasedSyncV2Session(opened,exclusive):null;},install:()=>{}});
 let first:Promise<void>|undefined,second:Promise<void>|undefined,starting:ReturnType<typeof product.start>|undefined;
 try{
  expect(await product.start('owner-epoch-1')).not.toBeNull();armed=true;first=product.stop();await entered.promise;
  let firstDone=false,secondDone=false,startDone=false;void first.then(()=>{firstDone=true;});second=product.stop().then(()=>{secondDone=true;});starting=product.start('owner-epoch-2');void starting.then(()=>{startDone=true;});
  await new Promise(r=>setTimeout(r,20));expect(firstDone).toBe(false);expect(secondDone).toBe(false);expect(startDone).toBe(false);expect(opens).toBe(1);expect(product.active).toBe(false);
  const third=cancelWaiting?product.stop():undefined;release.resolve();await Promise.all([first,second,third]);let reopened=await starting;
  if(cancelWaiting){expect(reopened).toBeNull();expect(opens).toBe(1);reopened=await product.start('owner-epoch-3');}
  expect(reopened).not.toBeNull();expect(product.active).toBe(true);expect(Number((await x.db.query('SELECT enabled FROM syncv2_control'))[0].enabled)).toBe(1);
  await x.db.execute("UPDATE memo_notes SET title='after reopen',updated_at=60");const revision=x.server.account.revision;await reopened!.syncNow();expect(x.server.account.revision).not.toBe(revision);expect(Number((await x.db.query('SELECT enabled FROM syncv2_control'))[0].enabled)).toBe(1);
 }finally{release.resolve();await first;await second;await starting;await product.stop();x.db.close();}
});
