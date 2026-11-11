import {test,expect} from 'bun:test';
import {fixture,scope} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {jsonBytes,parseCanonicalJson,canonical} from '../../src/sync-v2/protocol';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {watchMaterializer} from '../../src/sync-v2/materializer';

// Only synthetic service IO changes. Product opener, SQL, scanner, signing,
// reader, publisher, choices and native apply remain the production components.
function historyService(x:Awaited<ReturnType<typeof fixture>>){
 let enabled=true;const request=x.server.request.bind(x.server),calls:string[]=[];
 x.options.transport={request:async(r:any)=>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));calls.push(path);
  const body=r.body&&r.headers['Content-Type']!=='application/octet-stream'?parseCanonicalJson(r.body):null,json=(v:any)=>({status:200,headers:{},body:jsonBytes({version:2,scope,...v})});
  if(path==='/history/prepare')return json({targetCommitOid:body.targetCommitOid,treeRoot:parseCanonicalJson(x.server.objects.get(body.targetCommitOid)!).body.treeRoot,leaseId:'a'.repeat(32),expiresAtMillis:600000});
  if(path==='/choices/cloud')return json({choiceId:body.choiceId,account:x.server.account,confirmedAccount:x.server.account});
  const result=await request(r);if(path==='/capabilities'){const v=parseCanonicalJson(result.body);v.flags.historyRestore=enabled;return {...result,body:jsonBytes(v)};}return result;
 }};
 return {calls,set enabled(v:boolean){enabled=v;}};
}

test('P6J3-01 product opener permits rollback with the server history gate',async()=>{
 const x=await fixture(),service=historyService(x);let opened:any;
 try{
  opened=await openApplicationSyncV2(x.options);const first=x.server.account.commitOid;
  await x.db.execute("UPDATE memo_notes SET title='descendant',updated_at=30");await opened.sync();await opened.sync();
  expect((await opened.ui.snapshot()).gates.historyRestore).toBe(true);
  await opened.ui.rollback(first);expect(x.server.account.rollbackGeneration).toBe('1');
  expect((await x.db.query('SELECT title FROM memo_notes'))[0].title).toBe('title n');
  expect(service.calls).toContain('/history/prepare');expect(x.server.applied.length).toBeGreaterThan(0);
 }finally{await opened?.close();x.db.close();}
});

test('P6J3-01 server history gate closes rollback while native follow and ACK stay open',async()=>{
 const a=await fixture(),b=await fixture(),service=historyService(a);service.enabled=false;let remote:any,opened:any;
 try{
  remote=await openApplicationSyncV2(a.options);const first=a.server.account.commitOid;
  await b.db.execute('DELETE FROM memo_notes');b.options.transport=a.options.transport;opened=await openApplicationSyncV2(b.options);
  expect((await opened.ui.snapshot()).gates.historyRestore).toBe(false);
  expect(a.server.applied.length).toBeGreaterThan(0);
  await expect(opened.ui.rollback(first)).rejects.toThrow('feature_disabled');
  expect(service.calls.filter(p=>p==='/history/prepare')).toHaveLength(0);
  await a.db.execute("UPDATE memo_notes SET title='follow with history closed',updated_at=40");await remote.sync();await opened.ui.syncNow();
  expect((await b.db.query('SELECT title FROM memo_notes'))[0].title).toBe('follow with history closed');
 }finally{await opened?.close();await remote?.close();a.db.close();b.db.close();}
});

for(const kind of ['local'] as const)for(const entry of ['sync','choice'] as const)test(`P6J3-02 ${kind} loser recovers through ${entry} in the same product runtime`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,armed=false,lookupBlocked=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 const service=historyService(a),transport=a.options.transport;b.options.transport=transport;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  // The first request-result lookup happens after the explicit intent is durable.
  if(armed&&r.url.includes('/requests/')){armed=false;await b.db.execute("UPDATE memo_notes SET title='winner',updated_at=60");await other.sync();}
  return transport.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);const preview=await opened.ui.openChoice();
  armed=true;
  await expect(kind==='local'?opened.ui.chooseLocal(preview):opened.ui.chooseMerge(preview)).rejects.toThrow('choice_stale');
  if(entry==='sync')await opened.ui.syncNow();
  const fresh=await opened.ui.openChoice(),state=await opened.ui.o.projection.readState();
  expect(state.account.oid).toBe(a.server.account.commitOid);expect(state.cloud.pendingPublish).toBeNull();expect(state.hasUnsentEdits).toBe(true);
  expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('local a');
  await opened.ui.chooseCloud(fresh);await opened.ui.syncNow();
  expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('winner');
  expect((await opened.ui.o.projection.readState()).pendingChoice).toBeNull();
  expect(service.calls).toContain('/choices/cloud');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const entry of ['sync','choice'] as const)test(`P6J3-02 real rollback merge loser recovers through ${entry}`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,armed=false;
 historyService(a);const transport=a.options.transport;b.options.transport=transport;
 a.options.transport={request:async(r:any)=>{
  if(armed&&r.url.includes('/requests/')){armed=false;await b.db.execute("UPDATE memo_notes SET title='winner',updated_at=60");await other.sync();}
  return transport.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);const target=a.server.account.commitOid;
  await b.db.execute('DELETE FROM memo_notes');other=await openApplicationSyncV2(b.options);
  await b.db.execute("UPDATE memo_notes SET title='descendant',updated_at=30");await other.sync();await other.sync();await opened.sync();
  await a.db.execute('UPDATE memo_notes SET pinned=1');
  const store=opened.ui.o.projection,source=await SqlBusinessSource.open(a.db,watchMaterializer(a.db,a.options.repository,(table:any,locator:any)=>store.readCandidateBySource(table,locator),(kind:any,id:any)=>store.readCandidate(store.entityKeyFor(kind,id))));
  await store.beginTailWindow();while((await store.checkpoint()).phase!=='complete')await store.catchUpPage(source);
  await other.ui.rollback(target);await opened.sync();const preview=await opened.ui.openChoice();expect(preview.canMerge).toBe(true);
  armed=true;await expect(opened.ui.chooseMerge(preview)).rejects.toThrow('choice_stale');
  if(entry==='sync')await opened.ui.syncNow();
  const fresh=await opened.ui.openChoice(),s=await store.readState();expect(s.account.oid).toBe(a.server.account.commitOid);expect(s.cloud.pendingPublish).toBeNull();
  expect((await a.db.query('SELECT title,pinned FROM memo_notes'))[0]).toEqual({title:'descendant',pinned:1});
  await opened.ui.chooseCloud(fresh);await opened.ui.syncNow();expect((await store.readState()).pendingChoice).toBeNull();expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('winner');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});

for(const outcome of ['unknown','accepted'] as const)test(`P6J3-02 ${outcome} response loss resumes the original explicit request`,async()=>{
 const a=await fixture(),b=await fixture();let opened:any,other:any,started=false,armed=false,lookupBlocked=false;
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 historyService(a);const transport=a.options.transport;b.options.transport=transport;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  if(lookupBlocked&&r.url.includes('/requests/'))throw Error('request_result_unavailable');
  if(armed&&r.url.endsWith('/account/publish')){armed=false;if(outcome==='accepted')await transport.request(r);throw Error('response_lost');}
  return transport.request(r);
 }};
 try{
  opened=await openApplicationSyncV2(a.options);armed=true;
  await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');
  const projection=opened.ui.o.projection,plan=(await projection.readState()).cloud.pendingPublish,request=canonical(plan.request);
  lookupBlocked=true;await expect(opened.ui.syncNow()).rejects.toThrow('request_result_unavailable');
  expect(canonical((await projection.readState()).cloud.pendingPublish.request)).toBe(request);
  expect((await projection.readState()).cloud.detachedPublications?.[plan.requestId]).toBeUndefined();
  lookupBlocked=false;await opened.ui.syncNow();const state=await projection.readState();
  expect(state.cloud.pendingPublish).toBeNull();expect(state.pendingChoice).toBeNull();expect(state.hasUnsentEdits).toBe(false);
  expect(a.server.requests.has(plan.requestId)).toBe(true);expect(canonical(a.server.requests.get(plan.requestId).account)).toBe(canonical(a.server.account));
  const sends=a.server.publishedBodies.map(v=>parseCanonicalJson(Buffer.from(v,'base64'))).filter(v=>v.account.body.requestId===plan.requestId);
  expect(sends.length).toBe(1);expect(canonical(sends[0])).toBe(request);
  expect((await a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('local a');
 }finally{await opened?.close();await other?.close();a.db.close();b.db.close();}
});
