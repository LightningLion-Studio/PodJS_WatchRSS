import {test,expect} from 'bun:test';
import {fixture,scope} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {jsonBytes,parseCanonicalJson,canonical} from '../../src/sync-v2/protocol';

// Only synthetic service IO changes. Product opener, SQL, scanner, signing,
// reader, publisher, choices and native apply remain the production components.
function historyService(x:Awaited<ReturnType<typeof fixture>>){
 let enabled=true;const request=x.server.request.bind(x.server),calls:string[]=[];
 x.options.transport={request:async(r:any)=>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));calls.push(path);
  const body=r.body&&r.headers['Content-Type']!=='application/octet-stream'?parseCanonicalJson(r.body):null,json=(v:any)=>({status:200,headers:{},body:jsonBytes({version:2,scope,...v})});
  if(path==='/history')return json({items:[],pageToken:null});
  if(path==='/history/prepare')return json({targetCommitOid:body.targetCommitOid,treeRoot:parseCanonicalJson(x.server.objects.get(body.targetCommitOid)!).body.treeRoot,leaseId:'a'.repeat(32),expiresAtMillis:600000});
  if(path==='/choices/cloud')return json({choiceId:body.choiceId,account:x.server.account,confirmedAccount:x.server.account});
  const result=await request(r);if(path==='/capabilities'){const v=parseCanonicalJson(result.body);v.flags.historyRestore=enabled;return {...result,body:jsonBytes(v)};}return result;
 }};
 return {calls,set enabled(v:boolean){enabled=v;}};
}


for(const closed of ['server','local','missing'] as const)test(`P6J3WR history list gate ${closed}`,async()=>{
 const x=await fixture(),svc=historyService(x);let opened:any;
 if(closed==='server')svc.enabled=false;
 if(closed==='missing'){
  const t=x.options.transport;x.options.transport={request:async(r:any)=>{const v=await t.request(r);if(new URL(r.url).pathname.endsWith('/capabilities')){const j=parseCanonicalJson(v.body);delete j.flags.historyRestore;return {...v,body:jsonBytes(j)};}return v;}};
 }
 try{
  if(closed==='missing'){await expect(openApplicationSyncV2(x.options)).rejects.toThrow('invalid_schema');return;}
  opened=await openApplicationSyncV2(x.options);await opened.sync();
  if(closed==='local')await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:true});
  expect((await opened.ui.snapshot()).gates.historyRestore).toBe(false);
  const from=svc.calls.length;await expect(opened.ui.history()).rejects.toThrow('feature_disabled');await expect(opened.ui.rollback(x.server.account.commitOid)).rejects.toThrow('feature_disabled');
  console.log('HISTORY_CLOSED',closed,JSON.stringify(svc.calls.slice(from)));
  expect(svc.calls.slice(from)).not.toContain('/history');expect(svc.calls.slice(from)).not.toContain('/history/prepare');
 }finally{await opened?.close();x.db.close();}
});

test('P6J3WR changed announcement during rollback cannot leave an unresumable publication',async()=>{
 const x=await fixture(),svc=historyService(x);let opened:any,arm=false;
 const t=x.options.transport;x.options.transport={request:async(r:any)=>{if(arm&&new URL(r.url).pathname.endsWith('/capabilities'))svc.enabled=false;if(arm&&r.url.endsWith('/account/publish'))return {status:403,headers:{},body:jsonBytes({error:{code:'feature_disabled',retryable:false,retryAfterMillis:null,details:{}}})};return t.request(r);}};
 try{
  opened=await openApplicationSyncV2(x.options);const target=x.server.account.commitOid;
  await x.db.execute("UPDATE memo_notes SET title='descendant',updated_at=30");await opened.sync();await opened.sync();
  arm=true;await expect(opened.ui.rollback(target)).rejects.toThrow('feature_disabled');
  const s=await opened.ui.o.projection.readState();console.log('GATE_DURING',JSON.stringify({phase:s.cloud.pendingPublish?.phase,generation:x.server.account.rollbackGeneration,gate:(await opened.ui.snapshot()).gates.historyRestore}));
  expect(s.cloud.pendingPublish).toBeTruthy();const before=await opened.ui.o.projection.readState(),version=before.stateVersion;
  const from=svc.calls.length;await opened.sync();expect((await opened.ui.o.projection.readState()).stateVersion).toBe(version);expect(canonical(await opened.ui.o.projection.readState())).toBe(canonical(before));expect(svc.calls.slice(from)).toContain('/negotiate');expect(svc.calls.slice(from)).toContain('/devices/signing-keys');
 }finally{await opened?.close();x.db.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const entry of (outcome==='unknown'?['warm','cold','reconcile']:['warm','cold']) as ('warm'|'cold'|'reconcile')[])test(`P6J3WR ${outcome} ${entry} query failure does not block pulling a new head`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false,blocked=false,queries=0;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const svc=historyService(a),t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(blocked&&r.url.includes('/requests/')&&(entry!=='reconcile'||++queries>=3))throw Error('query_unavailable');
  if(arm&&r.url.endsWith('/account/publish')){arm=false;if(outcome==='accepted')await t.request(r);throw Error('response_lost');}
  return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;
  await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const store=opened.ui.o.projection,plan=(await store.readState()).cloud.pendingPublish;
  await other.sync();await b.db.execute("UPDATE memo_notes SET title='new remote',updated_at=60");await other.sync();
  blocked=true;const sent=a.server.publishedBodies.length,from=svc.calls.length;if(entry==='cold'){await opened.close();opened=await openApplicationSyncV2(a.options);}else await opened.ui.syncNow();
  const s=await opened.ui.o.projection.readState();console.log('LOOKUP_FAILURE',outcome,JSON.stringify({sameRequest:s.cloud.pendingPublish?.requestId===plan.requestId,observed:s.account.revision,remote:a.server.account.revision,negotiate:svc.calls.slice(from).filter(p=>p==='/negotiate').length}));
  expect(canonical(s.cloud.pendingPublish)).toBe(canonical(plan));expect(s.account.oid).toBe(a.server.account.commitOid);expect(svc.calls.slice(from)).toContain('/negotiate');expect(svc.calls.slice(from)).toContain('/devices/signing-keys');expect(svc.calls.slice(from)).toContain('/objects/batch-get');expect(a.server.publishedBodies.length).toBe(sent);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const entry of ['warm','cold'] as const)test(`P6J3WR interrupted rollback preparation recovers through ${entry} entry`,async()=>{
 const a=await fixture();historyService(a);let opened:any,arm=false;
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{
  if(arm&&method==='sql.transaction'&&args.statements.some((s:any)=>s.sql.startsWith('CREATE TABLE IF NOT EXISTS syncv2_upload_objects'))){arm=false;throw Error('prepare_interrupted');}
  return host(method,args);
 };
 try{
  opened=await openApplicationSyncV2(a.options);const target=a.server.account.commitOid;
  await a.db.execute("UPDATE memo_notes SET title='descendant',updated_at=30");await opened.sync();await opened.sync();arm=true;
  await expect(opened.ui.rollback(target)).rejects.toThrow('prepare_interrupted');
  const building=(await opened.ui.o.projection.readState()).cloud.preparingPublication;expect(building).toBeTruthy();
  if(entry==='cold'){await opened.close();opened=await openApplicationSyncV2(a.options);}
  await opened.ui.rollback(target);const state=await opened.ui.o.projection.readState();expect(state.cloud.preparingPublication).toBeNull();expect(state.cloud.pendingPublish).toBeNull();expect(state.cloud.detachedPublications[building.requestId].outcome).toBe('not-sent');expect(a.server.requests.has(building.requestId)).toBe(false);expect(a.server.account.rollbackGeneration).toBe('1');
 }finally{await opened?.close();a.db.close();}
});

for(const cut of [1,2] as const)test(`P6J3WR crash at post-accept transaction ${cut} resumes same request after restart`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false,transactions=0;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  const result=await t.request(r);if(arm&&r.url.endsWith('/account/publish'))transactions=1;return result;
 }};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{
  if(transactions&&method==='sql.transaction'){
   if(transactions++===cut){transactions=0;arm=false;throw Error('process_crash');}
  }
  return host(method,args);
 };
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;
  await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('process_crash');
  const before=await opened.ui.o.projection.readState(),p=before.cloud.pendingPublish;expect(p).toBeTruthy();
  console.log('CRASH',cut,JSON.stringify({phase:p.phase,known:a.server.requests.has(p.requestId)}));
  const sent=a.server.publishedBodies.length;await opened.close();let failure:any=null;try{opened=await openApplicationSyncV2(a.options);}catch(e){failure=e;}console.log('REOPEN',cut,JSON.stringify({error:failure?.message??null,publishCountUnchanged:a.server.publishedBodies.length===sent,originalAccepted:a.server.requests.has(p.requestId)}));expect(a.server.publishedBodies.length).toBe(sent);if(failure)throw failure;await opened.sync();
  const s=await opened.ui.o.projection.readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.hasUnsentEdits).toBe(false);expect(a.server.publishedBodies.length).toBe(sent);expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('local a');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});


test('P6J3WR queued choice gate closed sync preserves versions and continues authenticated reads',async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const svc=historyService(a),t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(arm&&r.url.endsWith('/account/publish')){arm=false;throw Error('response_lost');}return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;
  await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:false});const before=await opened.ui.o.projection.readState();
  await b.db.execute("UPDATE memo_notes SET title='new remote',updated_at=60");await other.sync();
  let failure:any=null;const from=svc.calls.length;try{await opened.ui.syncNow();}catch(e){failure=(e as Error).message;}
  const after=await opened.ui.o.projection.readState();console.log('CLOSED_QUEUED',JSON.stringify({failure,unchanged:canonical(before)===canonical(after),calls:svc.calls.slice(from)}));
  expect(canonical(after)).toBe(canonical(before));expect(failure).toBeNull();expect(svc.calls.slice(from)).toContain('/negotiate');expect(svc.calls.slice(from)).toContain('/devices/signing-keys');expect(svc.calls.slice(from)).toContain('/objects/batch-get');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

test('P6J3WR interrupted unsent choice preparation recovers after reopening',async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}return t.request(r);}};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{
  if(arm&&method==='sql.transaction'&&args.statements.some((s:any)=>s.sql.startsWith('CREATE TABLE IF NOT EXISTS syncv2_upload_objects'))){arm=false;throw Error('prepare_interrupted');}return host(method,args);
 };
 try{
  opened=await openApplicationSyncV2(a.options);const view=await opened.ui.openChoice();arm=true;await expect(opened.ui.chooseLocal(view)).rejects.toThrow('prepare_interrupted');
  const p=(await opened.ui.o.projection.readState()).cloud.preparingPublication;await opened.close();opened=await openApplicationSyncV2(a.options);
  const fresh=await opened.ui.openChoice(),s=await opened.ui.o.projection.readState();expect(s.cloud.preparingPublication).toBeNull();expect(s.cloud.detachedPublications[p.requestId].outcome).toBe('not-sent');await opened.ui.chooseCloud(fresh);expect((await opened.ui.o.projection.readState()).pendingChoice).toBeNull();
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});
