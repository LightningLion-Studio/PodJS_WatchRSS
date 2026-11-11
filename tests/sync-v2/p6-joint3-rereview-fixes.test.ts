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



// Close a real persisted action gate during the authenticated-read IO boundary.
for(const boundary of ['authentication','page','late-page','commit'] as const)test(`P6J3WRR-01 gate closes during ${boundary}: keep the closed fence`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false,blocked=false,keyReads=0,pageReads=0,closed:any=null;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const svc=historyService(a),t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  const path=new URL(r.url).pathname;
  if(!started&&path.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(blocked&&path.includes('/requests/'))throw Error('query_unavailable');
  if(arm&&path.endsWith('/account/publish')){arm=false;throw Error('response_lost');}
  if(blocked&&!closed&&(boundary==='authentication'&&path.endsWith('/devices/signing-keys')&&++keyReads===2||boundary==='page'&&path.endsWith('/objects/batch-get')||boundary==='late-page'&&path.endsWith('/objects/batch-get')&&++pageReads===34)){
   await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});closed=await opened.ui.o.projection.readState();
  }
  return t.request(r);
 }};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{
  if(boundary==='commit'&&blocked&&!closed&&method==='sql.transaction'&&args.statements.some((s:any)=>s.sql==='INSERT INTO syncv2_commit_headers VALUES(?,?,?)')){
   await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});closed=await opened.ui.o.projection.readState();
  }
  return host(method,args);
 };
 try{
  if(boundary==='late-page')for(let i=0;i<40;i++)await b.db.execute("INSERT INTO memo_notes SELECT ?,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes LIMIT 1",['extra-'+i]);
  opened=await openApplicationSyncV2(a.options);arm=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const plan=(await opened.ui.o.projection.readState()).cloud.pendingPublish;
  await b.db.execute("UPDATE memo_notes SET title='remote after original choice',updated_at=60");await other.sync();
  const sent=a.server.publishedBodies.length;blocked=true;await opened.ui.syncNow();const after=await opened.ui.o.projection.readState();
  console.log('MID_READ_GATE',JSON.stringify({keyReads,closedVersion:closed?.stateVersion,afterVersion:after.stateVersion,closedRevision:closed?.account.revision,afterRevision:after.account.revision,choiceGate:after.cloud.p5Gates.choice_apply,samePending:canonical(after.cloud.pendingPublish)===canonical(plan),publishesUnchanged:sent===a.server.publishedBodies.length,closedChoiceRevision:closed?.pendingChoice?.accountRevision,afterChoiceRevision:after.pendingChoice?.accountRevision,closedGuard:closed?.cloud.pendingPublish.guardVersion,afterGuard:after.cloud.pendingPublish?.guardVersion}));
  expect(closed).toBeTruthy();expect(after.cloud.p5Gates.choice_apply).toBe(false);expect(a.server.publishedBodies.length).toBe(sent);expect(canonical(after.pendingChoice)).toBe(canonical(closed.pendingChoice));expect(canonical(after)).toBe(canonical(closed));
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const kind of ['cloud','local'] as const)test(`independent history closed allows ${kind} choice, follow and ACK`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const svc=historyService(a);svc.enabled=false;const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}return t.request(r);}};
 try{
  opened=await openApplicationSyncV2(a.options);await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:true});
  const view=await opened.ui.openChoice(),from=svc.calls.length,acks=a.server.applied.length;
  if(kind==='cloud')await opened.ui.chooseCloud(view);else await opened.ui.chooseLocal(view);
  await opened.ui.syncNow();expect((await opened.ui.o.projection.readState()).pendingChoice).toBeNull();expect(a.server.applied.length).toBeGreaterThan(acks);
  expect(svc.calls.slice(from)).not.toContain('/history');expect(svc.calls.slice(from)).not.toContain('/history/prepare');
  await other.sync();await b.db.execute("UPDATE memo_notes SET title='follow while history disabled',updated_at=90");await other.sync();const beforeAck=a.server.applied.length;await opened.ui.syncNow();
  expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('follow while history disabled');expect(a.server.applied.length).toBeGreaterThan(beforeAck);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const entry of ['warm','cold'] as const)test(`P6J3WRR-02 ${outcome} original request resumes after choice gate closes and reopens (${entry})`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const svc=historyService(a),t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(arm&&r.url.endsWith('/account/publish')){arm=false;if(outcome==='accepted')await t.request(r);throw Error('response_lost');}return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const store=opened.ui.o.projection,plan=(await store.readState()).cloud.pendingPublish,request=canonical(plan.request);
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});const closed=await store.readState();await opened.ui.syncNow();expect(canonical(await store.readState())).toBe(canonical(closed));
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:true});let failure:any=null;try{if(entry==='cold'){await opened.close();opened=await openApplicationSyncV2(a.options);}else await opened.ui.syncNow();}catch(e){failure=(e as Error).message;}
  let repeatFailure:any=null;try{await opened.ui.syncNow();}catch(e){repeatFailure=(e as Error).message;}const state=await opened.ui.o.projection.readState(),retained=state.cloud.pendingPublish??state.cloud.detachedPublications?.[plan.requestId],sends=a.server.publishedBodies.map(v=>parseCanonicalJson(Buffer.from(v,'base64'))).filter(v=>v.account.body.requestId===plan.requestId);
  console.log('GATE_REOPEN',outcome,JSON.stringify({failure,repeatFailure,phase:state.cloud.pendingPublish?.phase??null,detached:state.cloud.detachedPublications?.[plan.requestId]?.outcome??null,pendingChoice:!!state.pendingChoice,hasUnsentEdits:state.hasUnsentEdits,serverAccepted:a.server.requests.has(plan.requestId),originalSends:sends.length,requestUnchanged:!!retained&&canonical(retained.request)===request,activeMatchesHead:state.activeGeneration===a.server.account.commitOid}));
  expect(failure).toBeNull();expect(repeatFailure).toBeNull();expect(state.activeGeneration).toBe(a.server.account.commitOid);expect(state.cloud.pendingApplied).toBeNull();expect(state.cloud.detachedPublications?.[plan.requestId]).toBeUndefined();expect(a.server.applied.some(v=>v.commitOid===plan.commitOid)).toBe(true);expect(state.cloud.pendingPublish).toBeNull();expect(state.pendingChoice).toBeNull();expect(state.hasUnsentEdits).toBe(false);expect(a.server.requests.has(plan.requestId)).toBe(true);expect(sends).toHaveLength(1);expect(canonical(sends[0])).toBe(request);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const changed of ['edit','remote'] as const)test(`P6J3WRR-02 ${outcome} gate toggle retains the ${changed} stale fence`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(arm&&r.url.endsWith('/account/publish')){arm=false;if(outcome==='accepted')await t.request(r);throw Error('response_lost');}return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const store=opened.ui.o.projection,plan=(await store.readState()).cloud.pendingPublish;
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});
  if(changed==='edit')await a.db.execute("UPDATE memo_notes SET title='new local edit',updated_at=70");
  else{await other.sync();await b.db.execute("UPDATE memo_notes SET title='new remote head',updated_at=70");await other.sync();}
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:true});
  const sent=a.server.publishedBodies.length;await expect(opened.ui.o.control.resumePublication()).rejects.toThrow('choice_stale');
  const state=await store.readState();expect(state.hasUnsentEdits).toBe(true);expect(state.pendingChoice).toBeTruthy();expect(state.activeGeneration).not.toBe(plan.commitOid);expect(a.server.publishedBodies.length).toBe(sent);
  expect((await a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe(changed==='edit'?'new local edit':'local a');
  const retained=state.cloud.pendingPublish??state.cloud.detachedPublications[plan.requestId];expect(canonical(retained.request)).toBe(canonical(plan.request));
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const boundary of ['authentication','page','commit'] as const)test(`P6J3WRR-01 queued rollback closes history during ${boundary}`,async()=>{
 const a=await fixture();let opened:any,arm=false,blocked=false,closed:any=null;
 historyService(a);const t=a.options.transport;
 a.options.transport={request:async(r:any)=>{
  if(arm&&r.url.endsWith('/account/publish')){arm=false;throw Error('response_lost');}
  if(blocked&&r.url.includes('/requests/'))throw Error('query_unavailable');
  if(blocked&&!closed&&(boundary==='authentication'&&new URL(r.url).pathname.endsWith('/devices/signing-keys')||boundary==='page'&&r.url.endsWith('/objects/batch-get'))){
   await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:true});closed=await opened.ui.o.projection.readState();
  }
  return t.request(r);
 }};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{
  if(blocked&&!closed&&boundary==='commit'&&method==='sql.transaction'&&args.statements.some((s:any)=>s.sql==='INSERT INTO syncv2_commit_headers VALUES(?,?,?)')){
   await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:true});closed=await opened.ui.o.projection.readState();
  }return host(method,args);
 };
 try{
  opened=await openApplicationSyncV2(a.options);const target=a.server.account.commitOid;
  await a.db.execute("UPDATE memo_notes SET title='descendant',updated_at=30");await opened.sync();await opened.sync();
  arm=true;await expect(opened.ui.rollback(target)).rejects.toThrow('response_lost');const plan=(await opened.ui.o.projection.readState()).cloud.pendingPublish;
  // The synthetic service accepts only the already signed original request.
  // This exposes a new authenticated head while its result lookup is unavailable.
  await t.request({url:a.options.account.backendBaseUrl+'/functions/v1/sync/v2/account/publish',method:'POST',headers:{'Content-Type':'application/json'},body:jsonBytes(plan.request)});
  blocked=true;const sends=a.server.publishedBodies.length,acks=a.server.applied.length;await opened.ui.syncNow();
  expect(closed).toBeTruthy();expect(canonical(await opened.ui.o.projection.readState())).toBe(canonical(closed));expect(a.server.publishedBodies.length).toBe(sends);expect(a.server.applied.length).toBe(acks);
 }finally{await opened?.close();a.db.close();}
});

for(const outcome of ['unknown','accepted'] as const)test(`P6J3WRR-01 ${outcome} result returns after the choice gate closes`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false,blocked=false,closed:any=null;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(arm&&r.url.endsWith('/account/publish')){arm=false;if(outcome==='accepted')await t.request(r);throw Error('response_lost');}
  const response=await t.request(r);
  if(blocked&&!closed&&r.url.includes('/requests/')){await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});closed=await opened.ui.o.projection.readState();}
  return response;
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const sends=a.server.publishedBodies.length,acks=a.server.applied.length;blocked=true;await opened.ui.syncNow();
  expect(closed).toBeTruthy();expect(canonical(await opened.ui.o.projection.readState())).toBe(canonical(closed));expect(a.server.publishedBodies.length).toBe(sends);expect(a.server.applied.length).toBe(acks);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const kind of ['cloud','local','cloud-journal'] as const)test(`P6J3WRR-02 gate-only changes preserve the ${kind} capture`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false;const requests:string[]=[];
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(r.url.endsWith('/choices/cloud')){requests.push(canonical(parseCanonicalJson(r.body)));if(arm){arm=false;throw Error('response_lost');}}return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);const view=await opened.ui.openChoice();
  if(kind==='cloud-journal'){arm=true;await expect(opened.ui.chooseCloud(view)).rejects.toThrow('response_lost');}
  const before=await opened.ui.o.projection.readState(),guard=before.cloud.pendingCloudChoice?.guardVersion;
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});
  await opened.ui.o.control.setWriteGates({history_restore:false,choice_apply:true});
  const after=await opened.ui.o.projection.readState();expect(after.stateVersion).not.toBe(before.stateVersion);expect(after.cloud.pendingCloudChoice?.guardVersion).toBe(guard);
  if(kind==='cloud-journal'){await opened.ui.o.control.resumeCloudChoice();expect(requests).toHaveLength(2);expect(requests[1]).toBe(requests[0]);}
  else if(kind==='cloud')await opened.ui.chooseCloud(view);else await opened.ui.chooseLocal(view);
  expect((await opened.ui.o.projection.readState()).pendingChoice).toBeNull();expect((await opened.ui.o.projection.readState()).hasUnsentEdits).toBe(false);
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

test('P6J3WRR-02 a previously observed accepted head does not hide a newer remote head after reopening',async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,arm=false,blocked=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const t=a.options.transport;b.options.transport=t;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(blocked&&r.url.includes('/requests/'))throw Error('query_unavailable');
  if(arm&&r.url.endsWith('/account/publish')){arm=false;await t.request(r);throw Error('response_lost');}return t.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);arm=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const store=opened.ui.o.projection,plan=(await store.readState()).cloud.pendingPublish;
  blocked=true;await opened.ui.syncNow();expect((await store.readState()).account.oid).toBe(plan.commitOid);
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:false});
  await other.sync();await b.db.execute("UPDATE memo_notes SET title='new remote head',updated_at=80");await other.sync();expect(a.server.account.commitOid).not.toBe(plan.commitOid);
  await opened.ui.o.control.setWriteGates({history_restore:true,choice_apply:true});blocked=false;
  await expect(opened.ui.o.control.resumePublication()).rejects.toThrow('choice_stale');
  const state=await store.readState();expect(state.hasUnsentEdits).toBe(true);expect(state.pendingChoice).toBeTruthy();expect(state.activeGeneration).not.toBe(plan.commitOid);expect((await a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('local a');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});
