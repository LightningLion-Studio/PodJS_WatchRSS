import {test,expect} from 'bun:test';
import {fixture,scope} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {canonical,jsonBytes,parseCanonicalJson,nextD64} from '../../src/sync-v2/protocol';
import * as stateHelpers from '../../src/sync-v2/state';
import {crypto} from './p2-fixture';
import {signControl} from '../../src/sync-v2/signing';
import {TrustedClock} from '../../src/sync-v2/trusted-time';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// These probes change only SQL-host or synthetic transport scheduling.
// They do not replace any product reader, publisher, guard or apply method.
async function setup(outcome:'unknown'|'accepted'|'none',extra=0,diskMode?:'DELETE'|'WAL'){
 const diskRoot=diskMode?mkdtempSync(join(tmpdir(),'wrr2-cold-')):null,sqlPath=diskRoot?join(diskRoot,'state.sqlite'):undefined;
 const a=await fixture({path:sqlPath,mode:diskMode}),b=await fixture();let opened:any,other:any,started=false,lose=false,lookupFailure=false;
 const hooks:{network?:(r:any,stage:'before'|'after',response?:any)=>Promise<void>;sql?:(method:string,args:any,stage:'before'|'after')=>Promise<void>}={};
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");
 await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 for(let i=0;i<extra;i++)await b.db.execute("INSERT INTO memo_notes SELECT ?,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes LIMIT 1",['extra-'+i]);
 const service=a.server.request.bind(a.server);
 const transport={request:async(r:any)=>{
  if(new URL(r.url).pathname.endsWith('/capabilities')){const x=await service(r),v=parseCanonicalJson(x.body);v.flags.historyRestore=true;return {...x,body:jsonBytes(v)};}
  if(r.url.endsWith('/choices/cloud')){const body=parseCanonicalJson(r.body);return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId:body.choiceId,account:a.server.account,confirmedAccount:a.server.account})};}
  return service(r);
 }};
 b.options.transport=transport;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  await hooks.network?.(r,'before');
  if(lookupFailure&&r.url.includes('/requests/'))throw Error('query_unavailable');
  if(lose&&r.url.endsWith('/account/publish')){lose=false;if(outcome==='accepted')await transport.request(r);throw Error('response_lost');}
  const v=await transport.request(r);await hooks.network?.(r,'after',v);return v;
 }};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{await hooks.sql?.(method,args,'before');const result=await host(method,args);await hooks.sql?.(method,args,'after');return result;};
 opened=await openApplicationSyncV2(a.options);
 if(outcome!=='none'){lose=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');}
 const store=()=>opened.ui.o.projection,control=()=>opened.ui.o.control;
 const plan=(await store().readState()).cloud.pendingPublish;
 return {a,b,hooks,plan,store,control,get opened(){return opened;},get other(){return other;},transport,
  blockLookup(){lookupFailure=true;},unblockLookup(){lookupFailure=false;},
  async toggle(open:boolean){await control().setWriteGates({history_restore:true,choice_apply:open});},
  async remoteEdit(){await other.sync();await b.db.execute("UPDATE memo_notes SET title='new remote head',updated_at=95");await other.sync();},
  async reopen(){await opened.close();if(sqlPath){a.db.close();(a.db as any).raw=new Database(sqlPath);a.db.raw.exec('PRAGMA journal_mode='+diskMode);a.db.raw.exec('PRAGMA synchronous=FULL');}a.options.clock=new TrustedClock(()=>100);opened=await openApplicationSyncV2(a.options);},
  async close(){await opened?.close();await other?.close();a.db.close();b.db.close();if(diskRoot)rmSync(diskRoot,{recursive:true,force:true});}};
}
function databaseImage(x:Awaited<ReturnType<typeof setup>>){
 const tables=x.a.db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'syncv2_%' OR name LIKE 'podjs_%') ORDER BY name").all() as {name:string}[];
 return canonical(Object.fromEntries(tables.map(({name})=>[name,(x.a.db.raw.query('SELECT * FROM "'+name+'"').all() as any[]).map(canonical).sort()])));
}
function ownSends(x:Awaited<ReturnType<typeof setup>>){return x.a.server.publishedBodies.map(v=>parseCanonicalJson(Buffer.from(v,'base64'))).filter(v=>v.account.body.requestId===x.plan.requestId);}
async function assertFinished(x:Awaited<ReturnType<typeof setup>>){
 const s=await x.store().readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.pendingChoice).toBeNull();expect(s.cloud.pendingApplied).toBeNull();expect(s.hasUnsentEdits).toBe(false);expect(s.activeGeneration).toBe(x.plan.commitOid);expect(s.cloud.detachedPublications?.[x.plan.requestId]).toBeUndefined();expect(ownSends(x)).toHaveLength(1);expect(canonical(ownSends(x)[0])).toBe(canonical(x.plan.request));
}

for(const boundary of ['before-headers','after-headers','after-first-row-batch','page-35','before-final-observe'] as const)
test(`WRR2 independent close-open-close at ${boundary} preserves all persistent rows`,async()=>{
 const x=await setup('unknown',40);let closed:any=null,image='',pages=0,inside=false;
 try{
  await x.remoteEdit();x.blockLookup();
  const toggle=async()=>{inside=true;const before=await x.store().readState();for(const open of [false,true,false])await x.toggle(open);closed=await x.store().readState();image=databaseImage(x);expect((stateHelpers as any).publicationCurrent(closed,before.cloud.pendingPublish)).toBe(true);expect(closed.stateVersion).toBe(String(BigInt(before.stateVersion)+3n));expect(canonical(closed.cloud.pendingPublish)).toBe(canonical(before.cloud.pendingPublish));inside=false;};
  x.hooks.network=async(r,stage)=>{if(!closed&&boundary==='page-35'&&stage==='after'&&r.url.endsWith('/objects/batch-get')&&++pages===35)await toggle();};
  x.hooks.sql=async(method,args,stage)=>{
   if(closed||inside||method!=='sql.transaction')return;
   const ops=args.statements,header=ops.some((s:any)=>s.sql==='INSERT INTO syncv2_commit_headers VALUES(?,?,?)'),row=ops.some((s:any)=>s.sql.startsWith('INSERT INTO podjs_sql_cache_refs')),update=ops.some((s:any)=>s.sql.startsWith('UPDATE syncv2_state SET body='));
   if(boundary==='before-headers'&&stage==='before'&&header||boundary==='after-headers'&&stage==='after'&&header||boundary==='after-first-row-batch'&&stage==='after'&&row||boundary==='before-final-observe'&&stage==='before'&&update&&!row&&!header&&ops.some((s:any)=>s.sql.startsWith('DELETE FROM syncv2_unopenable_notes')))await toggle();
  };
  const acks=x.a.server.applied.length,sends=x.a.server.publishedBodies.length;
  const pulled=await x.opened.ui.syncNow();expect(closed).toBeTruthy();expect(pulled.readOnly).toBe(true);expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);expect(x.a.server.applied.length).toBe(acks);expect(x.a.server.publishedBodies.length).toBe(sends);
  console.log('WRR2_CLOSED',boundary,JSON.stringify({version:closed.stateVersion,localChangeRevision:closed.localChangeRevision,guard:closed.cloud.pendingPublish.guardVersion,pages,readOnly:pulled.readOnly}));
 }finally{await x.close();}
},60000);

for(const stage of ['before','after'] as const)
test(`WRR2 accepted apply transaction gate closes ${stage} commit and ACK follows durable business`,async()=>{
 const x=await setup('accepted');let fired=false,closed:any=null,ackChecks=0;
 try{
  await x.toggle(false);await x.toggle(true);
  x.a.server.onApplied=async()=>{ackChecks++;const s=await x.store().readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.pendingChoice).toBeNull();expect(s.activeGeneration).toBe(x.plan.commitOid);expect(s.cloud.pendingApplied.commitOid).toBe(x.plan.commitOid);const rows=await x.a.db.query('SELECT note_id,title FROM memo_notes');expect(rows).toEqual([{note_id:'local-a',title:'local a'}]);};
  x.hooks.sql=async(method,args,when)=>{if(!fired&&method==='sql.transaction'&&when===stage&&args.statements.some((s:any)=>s.program&&!s.program.validateOnly)){fired=true;await x.toggle(false);closed=await x.store().readState();}};
  await x.opened.ui.syncNow();expect(fired).toBe(true);
  if(stage==='before'){expect(ackChecks).toBe(0);expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(closed.cloud.pendingPublish.requestId).toBe(x.plan.requestId);await x.toggle(true);await x.opened.ui.syncNow();}
  expect(ackChecks).toBe(1);await assertFinished(x);console.log('WRR2_APPLY_GATE',stage,JSON.stringify({ackChecks,closedVersion:closed.stateVersion,closedHasJournal:!!closed.cloud.pendingPublish}));
 }finally{await x.close();}
});

for(const mode of ['DELETE','WAL'] as const)for(const cut of ['after-observe','before-apply','after-apply','ack-response-lost'] as const)
test(`WRR2 cold SQLite ${mode} recovery at ${cut} preserves original accepted journal and durable ACK order`,async()=>{
 const x=await setup('accepted',0,mode);let cutReached=false,armed=true,ackChecks=0,applicationCommits=0;
 try{
  await x.toggle(false);await x.toggle(true);
  // Startup may send the ACK before openApplicationSyncV2 returns its new UI.
  // Audit the live native SQL connection and the actual apply commit instead
  // of dereferencing the already disposed UI of the previous runtime.
  x.a.server.onApplied=async()=>{ackChecks++;expect(applicationCommits).toBe(1);expect((await x.a.db.query('SELECT awaiting_user FROM syncv2_state'))[0].awaiting_user).toBe(0);expect((await x.a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('local a');};
  x.hooks.sql=async(method,args,stage)=>{
   if(method!=='sql.transaction')return;
   const apply=args.statements.some((s:any)=>s.program&&!s.program.validateOnly);
   if(apply&&stage==='after')applicationCommits++;
   if(!armed)return;
   if((cut==='before-apply'&&stage==='before'||cut==='after-apply'&&stage==='after')&&apply){armed=false;cutReached=true;throw Error('WRR2_PROCESS_CRASH');}
   if(cut==='after-observe'&&stage==='after'&&args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_state SET body='))){const s=await x.store().readState();if(s.account.oid===x.plan.commitOid&&s.activeGeneration!==x.plan.commitOid&&s.cloud.pendingPublish?.phase==='confirmed'){armed=false;cutReached=true;throw Error('WRR2_PROCESS_CRASH');}}
  };
  x.hooks.network=async(r,stage)=>{if(armed&&cut==='ack-response-lost'&&stage==='after'&&r.url.endsWith('/acks/applied')){armed=false;cutReached=true;throw Error('WRR2_PROCESS_CRASH');}};
  await expect(x.opened.ui.syncNow()).rejects.toThrow('WRR2_PROCESS_CRASH');expect(cutReached).toBe(true);
  const atCut=await x.store().readState(),sent=x.a.server.publishedBodies.length;
  if(cut==='after-observe'||cut==='before-apply'){expect(atCut.account.oid).toBe(x.plan.commitOid);expect(atCut.cloud.pendingPublish.requestId).toBe(x.plan.requestId);expect(atCut.pendingChoice).toBeTruthy();expect(ackChecks).toBe(0);}else{expect(atCut.cloud.pendingPublish).toBeNull();expect(atCut.cloud.pendingApplied).toBeTruthy();}
  await x.reopen();await x.opened.ui.syncNow();await assertFinished(x);expect(applicationCommits).toBe(1);expect(x.a.server.publishedBodies.length).toBe(sent);expect(ackChecks).toBe(cut==='ack-response-lost'?2:1);
  console.log('WRR2_COLD',mode,cut,JSON.stringify({atCutVersion:atCut.stateVersion,phase:atCut.cloud.pendingPublish?.phase??null,ackChecks}));
 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const boundary of ['result','after-observe','before-apply'] as const)
test(`WRR2 ${outcome} real SQL edit at ${boundary} must not apply the old choice`,async()=>{
 const x=await setup(outcome);let editReached=false,inside=false;
 try{
  for(const open of [false,true,false,true])await x.toggle(open);
  const edit=async()=>{editReached=true;inside=true;await x.a.db.execute("UPDATE memo_notes SET title='newer business edit',updated_at=101");inside=false;};
  x.hooks.network=async(r,stage)=>{if(!editReached&&boundary==='result'&&stage==='after'&&r.url.includes('/requests/'))await edit();};
  x.hooks.sql=async(method,args,stage)=>{if(editReached||inside||method!=='sql.transaction')return;const apply=args.statements.some((s:any)=>s.program&&!s.program.validateOnly);if(boundary==='before-apply'&&stage==='before'&&apply)await edit();if(boundary==='after-observe'&&stage==='after'&&args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_state SET body='))){const s=await x.store().readState();if(s.account.oid===x.plan.commitOid&&s.activeGeneration!==x.plan.commitOid&&s.cloud.pendingPublish?.phase==='confirmed')await edit();}};
  const sent=x.a.server.publishedBodies.length,acks=x.a.server.applied.length;
  await expect(x.control().resumePublication()).rejects.toThrow('choice_stale');expect(editReached).toBe(true);
  const s=await x.store().readState();expect(s.activeGeneration).not.toBe(x.plan.commitOid);expect(s.pendingChoice).toBeTruthy();expect(s.hasUnsentEdits).toBe(true);expect((await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('newer business edit');expect(x.a.server.applied.length).toBe(acks);if(boundary==='result')expect(x.a.server.publishedBodies.length).toBe(sent);expect(s.localChangeRevision).not.toBe(x.plan.capturedLocalRevision);
  console.log('WRR2_REAL_EDIT',outcome,boundary,JSON.stringify({localChangeRevision:s.localChangeRevision,guard:x.plan.guardVersion}));
 }finally{await x.close();}
});

test('WRR2 queued closed choice remains read-only through signed history-expired poll recovery',async()=>{
 const x=await setup('unknown');
 try{
  await x.toggle(false);const before=await x.store().readState();
  // Make the signed retention floor genuinely newer than the saved cursor.
  x.a.server.serverRevision=nextD64(x.a.server.serverRevision);const originalWindow=x.a.server.window.bind(x.a.server);x.a.server.window=()=>({...originalWindow(),historyFloorRevision:x.a.server.serverRevision});
  const window=x.a.server.window();expect(BigInt(window.historyFloorRevision)).toBeGreaterThan(BigInt(before.cloud.cursor));
  const checkpoint=await signControl(crypto,'','wrss.sync.v2/checkpoint-sign',{scope,checkpointId:'c'.repeat(32),serverRevision:window.serverRevision,refs:window.refs,account:window.account,historyFloorRevision:window.historyFloorRevision,historyFloorMillis:0,windowId:window.windowId,issuedAtMillis:100,expiresAtMillis:300000});
  // Schedule only synthetic replies at the original transport boundary.
  const transport=x.control().o.http.transport,send=transport.request.bind(transport);
  transport.request=async(r:any)=>{const path=new URL(r.url).pathname;if(path.endsWith('/events'))return {status:410,headers:{},body:jsonBytes({error:{code:'history_expired',retryable:true,retryAfterMillis:null,details:{checkpoint}}})};if(path.endsWith('/account'))return {status:200,headers:{},body:jsonBytes(x.a.server.window())};if(path.endsWith('/checkpoint'))return {status:200,headers:{},body:jsonBytes({version:2,scope,...checkpoint})};return send(r);};
  const image=databaseImage(x),pulled=await x.control().poll(),after=await x.store().readState();expect(databaseImage(x)).toBe(image);expect(pulled.rebuilt).toBe(false);expect(pulled.rebuildRequired).toBe(true);await x.toggle(true);const errors:(string|null)[]=[];for(let i=0;i<2;i++){try{await x.opened.ui.syncNow();errors.push(null);}catch(e){errors.push((e as Error).message);}}
  const resumed=await x.store().readState();console.log('WRR2_EXPIRED_POLL',JSON.stringify({beforeVersion:before.stateVersion,afterVersion:after.stateVersion,readOnly:pulled.readOnly??null,rebuilt:pulled.rebuilt??null,reopenErrors:errors,originalGuard:x.plan.guardVersion,afterGuard:resumed.cloud.pendingPublish?.guardVersion??null,stillPending:!!resumed.cloud.pendingPublish}));expect(pulled.readOnly).toBe(true);expect(canonical(after)).toBe(canonical(before));expect(errors).toEqual([null,null]);await assertFinished(x);
 }finally{await x.close();}
});

for(const toggle of ['close','open-close-open'] as const)
test(`WRR2 cloud audit in flight ${toggle} preserves current gates and control offset`,async()=>{
 const x=await setup('none');let captured:any=null,closedImage='',fired=false;
 try{
  const preview=await x.opened.ui.openChoice(),native=await x.a.db.query('SELECT * FROM memo_notes');
  x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&r.url.endsWith('/choices/cloud')){fired=true;for(const open of toggle==='close'?[false]:[true,false,true])await x.toggle(open);captured=await x.store().readState();closedImage=databaseImage(x);}};
  let error:any=null;try{await x.opened.ui.chooseCloud(preview);}catch(e){error=(e as Error).message;}
  const after=await x.store().readState();
  console.log('WRR2_CLOUD_AUDIT',toggle,JSON.stringify({error,beforeVersion:captured?.stateVersion,afterVersion:after.stateVersion,beforeOffset:captured?.choiceControlRevision??null,afterOffset:after.choiceControlRevision??null,beforeGate:captured?.cloud.p5Gates?.choice_apply??null,afterGate:after.cloud.p5Gates?.choice_apply??null,gatesSql:await x.a.db.query('SELECT history_restore,choice_apply FROM syncv2_write_gates'),pendingChoice:!!after.pendingChoice,hasUnsentEdits:after.hasUnsentEdits,acks:x.a.server.applied.length,beforeNative:native.map((v:any)=>({noteId:v.note_id,title:v.title})),afterNative:(await x.a.db.query('SELECT note_id,title FROM memo_notes')).map((v:any)=>({noteId:v.note_id,title:v.title}))}));
  expect(fired).toBe(true);expect(after.choiceControlRevision).toBe(captured.choiceControlRevision);expect(canonical(after.cloud.p5Gates)).toBe(canonical(captured.cloud.p5Gates));
  if(toggle==='close'){
   // The coordinator permits one accepted-result journal transaction while
   // closed. It must not apply rows, clear the choice or send an ACK.
   expect(error).toBe('feature_disabled');expect(after.stateVersion).toBe(nextD64(captured.stateVersion));expect(after.pendingChoice).toEqual(captured.pendingChoice);expect(x.a.server.applied).toHaveLength(0);expect(await x.a.db.query('SELECT * FROM memo_notes')).toEqual(native);
   const intent=after.cloud.pendingCloudChoice;expect(intent.phase).toBe('accepted');expect(intent.requestId).toBe(captured.cloud.pendingCloudChoice.requestId);expect(intent.guardVersion).toBe(captured.cloud.pendingCloudChoice.guardVersion);
   const expected=JSON.parse(canonical(captured));expected.stateVersion=after.stateVersion;expected.cloud.pendingCloudChoice=intent;expect(canonical(after)).toBe(canonical(expected));
   await x.toggle(true);await x.opened.ui.syncNow();const finished=await x.store().readState();expect(finished.cloud.pendingCloudChoice).toBeNull();expect(finished.pendingChoice).toBeNull();expect(finished.hasUnsentEdits).toBe(false);expect(x.a.server.applied).toHaveLength(1);
  }else{expect(error).toBeNull();expect(after.pendingChoice).toBeNull();expect(after.hasUnsentEdits).toBe(false);expect(x.a.server.applied).toHaveLength(1);}

 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)
test(`WRR2 ${outcome} new remote head after original result query fences old choice`,async()=>{
 const x=await setup(outcome);let fired=false,afterRemoteAcks=0;
 try{
  await x.toggle(false);await x.toggle(true);
  x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&r.url.includes('/requests/')){fired=true;await x.remoteEdit();afterRemoteAcks=x.a.server.applied.length;}};
  const sends=x.a.server.publishedBodies.length;
  await expect(x.control().resumePublication()).rejects.toThrow('choice_stale');expect(fired).toBe(true);
  const s=await x.store().readState(),retained=s.cloud.pendingPublish??s.cloud.detachedPublications?.[x.plan.requestId];expect(s.activeGeneration).not.toBe(x.plan.commitOid);expect(s.pendingChoice).toBeTruthy();expect(s.hasUnsentEdits).toBe(true);expect(retained.requestId).toBe(x.plan.requestId);expect(canonical(retained.request)).toBe(canonical(x.plan.request));expect(x.a.server.applied.length).toBe(afterRemoteAcks);expect(x.a.server.publishedBodies.length).toBe(sends+1);expect((await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('local a');
  console.log('WRR2_REMOTE_AFTER_RESULT',outcome,JSON.stringify({observed:s.account.revision,remote:x.a.server.account.revision,originalSends:ownSends(x).length}));
 }finally{await x.close();}
});

for(const transition of ['close','close-open'] as const)for(const cold of [false,true])
test(`WRR2 cloud accepted journal keeps current controls at final ${transition}, cold=${cold}`,async()=>{
 const x=await setup('none',0,cold?'WAL':undefined);let fired=false,audits=0,atGate:any=null;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/choices/cloud'))audits++;};
  x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.program&&!s.program.validateOnly)){fired=true;await x.toggle(false);if(transition==='close-open')await x.toggle(true);atGate=await x.store().readState();}};
  const native=await x.a.db.query('SELECT * FROM memo_notes'),preview=await x.opened.ui.openChoice();let error:string|null=null;try{await x.opened.ui.chooseCloud(preview);}catch(e){error=(e as Error).message;}
  expect(fired).toBe(true);const state=await x.store().readState();expect(state.choiceControlRevision).toBe(atGate.choiceControlRevision);expect(state.cloud.p5Gates).toEqual(atGate.cloud.p5Gates);
  const mirror=(await x.a.db.query('SELECT * FROM syncv2_write_gates'))[0];expect(mirror.control_revision).toBe(state.choiceControlRevision);expect(mirror.choice_apply).toBe(transition==='close'?0:1);
  const requestId=atGate.cloud.pendingCloudChoice.requestId;
  if(transition==='close'){
   expect(error).toBe('feature_disabled');expect(state.cloud.pendingCloudChoice.phase).toBe('accepted');expect(state.cloud.pendingCloudChoice.requestId).toBe(requestId);expect(state.pendingChoice).toBeTruthy();expect(await x.a.db.query('SELECT * FROM memo_notes')).toEqual(native);expect(x.a.server.applied).toHaveLength(0);
   if(cold)await x.reopen();const closed=await x.store().readState();await x.opened.ui.syncNow();expect(canonical(await x.store().readState())).toBe(canonical(closed));
   await x.toggle(true);await x.opened.ui.syncNow();
  }else{expect(error).toBeNull();if(cold)await x.reopen();}
  const done=await x.store().readState();expect(done.cloud.pendingCloudChoice).toBeNull();expect(done.pendingChoice).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(x.a.server.applied).toHaveLength(1);expect(audits).toBe(1);expect((await x.a.db.query('SELECT note_id FROM memo_notes'))).toEqual([{note_id:'remote-b'}]);
 }finally{await x.close();}
},60000);

test('WRR2 accepted cloud journal cannot apply across a new remote head after reopening',async()=>{
 const x=await setup('none');let fired=false;
 try{
  x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&r.url.endsWith('/choices/cloud')){fired=true;await x.toggle(false);}};
  await expect(x.opened.ui.chooseCloud(await x.opened.ui.openChoice())).rejects.toThrow('feature_disabled');const pending=(await x.store().readState()).cloud.pendingCloudChoice;
  await x.remoteEdit();const acks=x.a.server.applied.length;await x.toggle(true);
  await expect(x.control().resumeCloudChoice()).rejects.toThrow('choice_stale');const after=await x.store().readState();expect(after.cloud.pendingCloudChoice.requestId).toBe(pending.requestId);expect(after.pendingChoice).toBeTruthy();expect(after.hasUnsentEdits).toBe(true);expect(x.a.server.applied.length).toBe(acks);expect((await x.a.db.query('SELECT note_id FROM memo_notes'))).toEqual([{note_id:'local-a'}]);
 }finally{await x.close();}
});

test('WRR2 recovery restore rechecks the choice gate at the final native transaction',async()=>{
 const x=await setup('none');let fired=false;
 try{
  await x.opened.ui.chooseCloud(await x.opened.ui.openChoice());const before=await x.store().readState(),copy=before.recoveryCopies[0],native=await x.a.db.query('SELECT * FROM memo_notes'),acks=x.a.server.applied.length;
  x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.program&&!s.program.validateOnly)){fired=true;await x.toggle(false);}};
  await expect(x.control().restoreRecovery(copy.copyId)).rejects.toThrow('feature_disabled');expect(fired).toBe(true);const after=await x.store().readState();expect(after.cloud.p5Gates.choice_apply).toBe(false);expect(after.choiceControlRevision).toBe('1');expect(after.recoveryCopies).toEqual(before.recoveryCopies);expect(await x.a.db.query('SELECT * FROM memo_notes')).toEqual(native);expect(x.a.server.applied.length).toBe(acks);
  await x.toggle(true);expect(await x.control().restoreRecovery(copy.copyId)).toBeGreaterThan(0);expect((await x.store().readState()).hasUnsentEdits).toBe(true);
 }finally{await x.close();}
});

test('WRR2 migration reads the existing encrypted control offset before extending its SQL mirror',async()=>{
 const x=await setup('none');
 try{
  await x.toggle(false);await x.toggle(true);const before=await x.store().readState();await x.opened.close();await x.a.db.execute('ALTER TABLE syncv2_write_gates DROP COLUMN control_revision');await x.reopen();
  const after=await x.store().readState(),mirror=(await x.a.db.query('SELECT * FROM syncv2_write_gates'))[0];expect(after.choiceControlRevision).toBe(before.choiceControlRevision);expect(after.cloud.p5Gates).toEqual(before.cloud.p5Gates);expect(mirror.control_revision).toBe(before.choiceControlRevision);expect(mirror.choice_apply).toBe(1);
 }finally{await x.close();}
});

test('WRR2 queued cloud result query failure preserves its journal and continues authenticated reads',async()=>{
 const x=await setup('none');let lost=false;const auditBodies:string[]=[];
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/choices/cloud')){auditBodies.push(canonical(parseCanonicalJson(r.body)));if(!lost){lost=true;throw Error('response_lost');}}};
  await expect(x.opened.ui.chooseCloud(await x.opened.ui.openChoice())).rejects.toThrow('response_lost');const before=await x.store().readState(),calls:string[]=[];x.blockLookup();
  const hook=x.hooks.network;x.hooks.network=async(r,stage,response)=>{if(stage==='before')calls.push(new URL(r.url).pathname);await hook?.(r,stage,response);};
  await x.opened.ui.syncNow();const after=await x.store().readState();expect(canonical(after)).toBe(canonical(before));expect(calls.some(p=>p.endsWith('/negotiate'))).toBe(true);expect(calls.filter(p=>p.endsWith('/devices/signing-keys')).length).toBeGreaterThanOrEqual(2);expect(x.a.server.applied).toHaveLength(0);
  x.unblockLookup();await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingCloudChoice).toBeNull();expect(done.pendingChoice).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(auditBodies).toHaveLength(2);expect(auditBodies[1]).toBe(auditBodies[0]);expect(x.a.server.applied).toHaveLength(1);
 }finally{await x.close();}
});

test('WRR2 a stale accepted cloud journal still permits a fresh product choice',async()=>{
 const x=await setup('none');let closed=false;
 try{
  x.hooks.network=async(r,stage)=>{if(!closed&&stage==='after'&&r.url.endsWith('/choices/cloud')){closed=true;await x.toggle(false);}};
  await expect(x.opened.ui.chooseCloud(await x.opened.ui.openChoice())).rejects.toThrow('feature_disabled');const old=(await x.store().readState()).cloud.pendingCloudChoice;
  await x.remoteEdit();await x.toggle(true);await expect(x.opened.ui.syncNow()).rejects.toThrow('choice_stale');
  const fresh=await x.opened.ui.openChoice();expect(fresh).toBeTruthy();expect((await x.a.db.query('SELECT note_id FROM memo_notes'))).toEqual([{note_id:'local-a'}]);
  const state=await x.store().readState();expect(state.cloud.pendingCloudChoice).toBeNull();expect(state.cloud.retiredCloudChoices[old.requestId].result).toEqual(old.result);expect(state.cloud.retiredCloudChoices[old.requestId].requestId).toBe(old.requestId);
  await x.opened.ui.chooseCloud(fresh);expect((await x.store().readState()).pendingChoice).toBeNull();expect((await x.store().readState()).hasUnsentEdits).toBe(false);
 }finally{await x.close();}
});

test('WRR2 an inflight cloud intent still rejects a newer local publication',async()=>{
 const x=await setup('none');let loseCloud=true;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/choices/cloud')&&loseCloud){loseCloud=false;throw Error('response_lost');}};
  await expect(x.opened.ui.chooseCloud(await x.opened.ui.openChoice())).rejects.toThrow('response_lost');const before=await x.store().readState(),old=before.cloud.pendingCloudChoice;x.blockLookup();const fresh=await x.opened.ui.openChoice();x.unblockLookup();
  await expect(x.opened.ui.chooseLocal(fresh)).rejects.toThrow('publication_pending');const rejected=await x.store().readState();expect(rejected.cloud.pendingPublish).toBeNull();expect(canonical(rejected.cloud.pendingCloudChoice)).toBe(canonical(old));expect(x.a.server.applied).toHaveLength(0);
  await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingCloudChoice).toBeNull();expect(done.pendingChoice).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(x.a.server.applied).toHaveLength(1);
 }finally{await x.close();}
});
