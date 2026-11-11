import {test,expect} from 'bun:test';
import {setup,ownSends} from './p6-joint3-rereview3-fixture';
import {MemoRepository} from '../../src/notes/repository';
import {p5Fixture} from './p5-fixture';
import {canonical,jsonBytes,nextD64} from '../../src/sync-v2/protocol';
import {fromWire} from '../../src/sync-v2/business';
const memo=(db:any)=>new MemoRepository(db,'review-local',()=> 'imported-note',()=>200);
test('WRR4 equivalent legacy merge must not consume an accepted original cloud journal',async()=>{
 const f=await p5Fixture();try{const first=await f.publish();await f.edit('second');await f.publish();await f.control.rollback(first.account.commitOid,await f.control.captureAccount(),'a'.repeat(32));const row=(await f.projection.candidatePage())[0],value=fromWire(row.candidate.meta.kind,row.candidate.meta.payload,row.candidate.state.payload),key=canonical(['review-merge-peer',14,'one']);await f.projection.receiveLegacy({peer:'review-merge-peer',version:14,cursor:'one',entityKeys:[row.entityKey],body:{[row.entityKey]:{identity:'n',...value}},bodyRefsByEntity:{[row.entityKey]:[]}},null);
 const preview=await f.control.pendingLegacyChoice(key);expect(preview.canMerge).toBe(true);f.server.onChoice=async()=>{await f.control.setWriteGates({history_restore:true,choice_apply:false});};await expect(f.control.chooseCloud(preview.proof,'b'.repeat(32))).rejects.toThrow('feature_disabled');f.server.onChoice=undefined;const accepted=await f.projection.readState();expect(accepted.cloud.pendingCloudChoice.phase).toBe('accepted');await f.control.setWriteGates({history_restore:true,choice_apply:true});const next=await f.control.pendingLegacyChoice(key);expect(next.canMerge).toBe(true);
 let mergeError:string|null=null,resumeError:string|null=null;try{await f.control.chooseMerge(next.proof,'c'.repeat(32));}catch(e){mergeError=(e as Error).message;}const merged=await f.projection.readState();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('pendingChoice');expect(merged.applied).toEqual(accepted.applied);expect(merged.pendingChoice).toEqual(accepted.pendingChoice);expect(merged.cloud.pendingCloudChoice).toEqual(accepted.cloud.pendingCloudChoice);try{await f.control.resumeCloudChoice();}catch(e){resumeError=(e as Error).message;}const final=await f.projection.readState();console.log('WRR4_LEGACY_JOURNAL',JSON.stringify({mergeError,resumeError,headBefore:accepted.account,headAfter:final.account,localBefore:accepted.localChangeRevision,localAfter:final.localChangeRevision,captured:accepted.cloud.pendingCloudChoice.localChangeRevision,pendingOriginal:final.cloud.pendingCloudChoice,pendingChoice:final.pendingChoice,route:(await f.projection.legacyChoiceEntry(key)).entry.route,applied:final.applied}));expect(mergeError).toBe('publication_pending');expect(resumeError).toBeNull();expect(final.cloud.pendingCloudChoice).toBeNull();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('discarded-for-cloud');}finally{f.close();}
});
test('WRR4 equivalent legacy merge must not consume an accepted original local publication journal',async()=>{
 const f=await p5Fixture();try{const first=await f.publish();await f.edit('second');await f.publish();await f.control.rollback(first.account.commitOid,await f.control.captureAccount(),'a'.repeat(32));const row=(await f.projection.candidatePage())[0],value=fromWire(row.candidate.meta.kind,row.candidate.meta.payload,row.candidate.state.payload),key=canonical(['review-local-peer',14,'one']);await f.projection.receiveLegacy({peer:'review-local-peer',version:14,cursor:'one',entityKeys:[row.entityKey],body:{[row.entityKey]:{identity:'n',...value}},bodyRefsByEntity:{[row.entityKey]:[]}},null);const preview=await f.control.pendingLegacyChoice(key);expect(preview.canMerge).toBe(true);f.server.losePublish=true;await expect(f.control.chooseLocal(preview.proof,'b'.repeat(32))).rejects.toThrow('synthetic_response_lost');const accepted=await f.projection.readState(),next=await f.control.pendingLegacyChoice(key);expect(next.canMerge).toBe(true);
 let mergeError:string|null=null,resumeError:string|null=null;try{await f.control.chooseMerge(next.proof,'c'.repeat(32));}catch(e){mergeError=(e as Error).message;}const blocked=await f.projection.readState();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('pendingChoice');expect(blocked.applied).toEqual(accepted.applied);expect(blocked.pendingChoice).toEqual(accepted.pendingChoice);expect(blocked.cloud.pendingPublish).toEqual(accepted.cloud.pendingPublish);try{await f.control.resumePublication();}catch(e){resumeError=(e as Error).message;}const final=await f.projection.readState();console.log('WRR4_LEGACY_LOCAL_JOURNAL',JSON.stringify({mergeError,resumeError,expected:accepted.cloud.pendingPublish.request.account.body,account:final.account,serverHead:f.server.account,localBefore:accepted.localChangeRevision,localAfter:final.localChangeRevision,pendingOriginal:final.cloud.pendingPublish?.requestId,phase:final.cloud.pendingPublish?.phase,route:(await f.projection.legacyChoiceEntry(key)).entry.route,pendingChoice:final.pendingChoice,applied:final.applied}));expect(mergeError).toBe('publication_pending');expect(resumeError).toBeNull();expect(final.cloud.pendingPublish).toBeNull();}finally{f.close();}
});
for(const outcome of ['unknown','accepted']as const)test(`WRR4 ${outcome} real edit invalidates old journal but permits a fresh product choice`,async()=>{
 const x=await setup(outcome);try{await memo(x.a.db).save({noteId:'local-a',title:'new edit must remain selectable',markdown:'real new content'});const errors:(string|null)[]=[];try{await x.opened.ui.syncNow();errors.push(null);}catch(e){errors.push((e as Error).message);}let fresh:any;for(let n=0;n<2;n++){try{fresh=await x.opened.ui.openChoice();errors.push(null);}catch(e){errors.push((e as Error).message);}}const after=await x.store().readState();console.log('WRR4_FRESH_PRODUCT_CHOICE',outcome,JSON.stringify({errors,originalRequest:x.plan.requestId,pendingOriginal:after.cloud.pendingPublish?.requestId,phase:after.cloud.pendingPublish?.phase,capturedLocalRevision:x.plan.capturedLocalRevision,actualLocalRevision:after.localChangeRevision,account:after.account,originalExpected:x.plan.request.account.body.expectedOid,originalOwn:x.plan.commitOid,acks:x.a.server.applied.length,received:ownSends(x).length}));expect([null,'choice_stale']).toContain(errors[0]);expect(errors.slice(1)).toEqual([null,null]);expect(fresh).toBeTruthy();expect(x.a.server.applied).toHaveLength(0);expect((await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('new edit must remain selectable');}finally{await x.close();}
});

import {NoteConflictPlan} from '../../src/sync-v2/notes-conflict';
import {vector} from './fixture';
test('WRR4 note model must not write an old maintenance snapshot',()=>{const v=vector('notes-conflict'),p=new NoteConflictPlan(v.initial),capture=p.capture(),action=v.resolutions[0];let error:string|null=null;try{p.resolve(capture,action.choice,action.manual,action.now,action.device,()=>{p.state.stateVersion='999';p.state.choiceControlRevision='50';p.state.cloud={cursor:'1000',p5Gates:{history_restore:true,choice_apply:false}};});}catch(e){error=(e as Error).message;}console.log('WRR4_MODEL_COMPARE',JSON.stringify({error,stateVersion:p.state.stateVersion,control:p.state.choiceControlRevision??null,cloud:p.state.cloud??null}));expect(BigInt(p.state.stateVersion)).toBeGreaterThanOrEqual(999n);expect(p.state.choiceControlRevision).toBe('50');expect(p.state.cloud).toEqual({cursor:'1000',p5Gates:{history_restore:true,choice_apply:false}});});

for(const mode of ['warm','DELETE','WAL'] as const)
test(`WRR4 edited unknown request detaches byte-exactly and never resends (${mode})`,async()=>{
 const x=await setup('unknown',0,mode==='warm'?undefined:mode);let productPublishes=0;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/account/publish'))productPublishes++;};
  await memo(x.a.db).save({noteId:'local-a',title:'retained edit',markdown:'new body'});
  if(mode==='warm')await x.opened.ui.syncNow();else await x.reopen();
  for(let n=0;n<2;n++){expect(await x.opened.ui.openChoice()).toBeTruthy();await x.opened.ui.syncNow();}
  expect(await x.control().reconcilePublications()).toContainEqual({requestId:x.plan.requestId,outcome:'unknown'});
  const state=await x.store().readState(),detached=state.cloud.detachedPublications[x.plan.requestId];
  expect(state.cloud.pendingPublish).toBeNull();expect(detached.outcome).toBe('unknown');expect(detached.phase).toBe('detached');expect(canonical(detached.request)).toBe(canonical(x.plan.request));expect(detached.commitOid).toBe(x.plan.commitOid);
  expect(state.account?.oid).toBe(x.plan.request.account.body.expectedOid);expect(state.localChangeRevision).not.toBe(x.plan.capturedLocalRevision);expect(state.hasUnsentEdits).toBe(true);expect(state.pendingChoice).toBeTruthy();expect(productPublishes).toBe(0);expect(ownSends(x)).toHaveLength(0);expect(x.a.server.applied).toHaveLength(0);expect((await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('retained edit');
 }finally{await x.close();}
});

for(const order of ['query-first','pull-first'] as const)
test(`WRR4 late success of a detached original request is an ordinary remote head (${order})`,async()=>{
 const x=await setup('unknown');let productPublishes=0;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/account/publish'))productPublishes++;};
  await memo(x.a.db).save({noteId:'local-a',title:'new edit survives late acceptance',markdown:'local tail'});await x.opened.ui.syncNow();expect((await x.store().readState()).cloud.pendingPublish).toBeNull();expect(await x.opened.ui.openChoice()).toBeTruthy();
  // Complete a delayed original service delivery. This bypasses the product
  // transport so the test can distinguish service completion from a resend.
  const accepted=await x.transport.request({url:'http://localhost:3000/functions/v1/sync/v2/account/publish',method:'POST',headers:{},body:jsonBytes(x.plan.request)});expect(accepted.status).toBe(200);
  if(order==='query-first')await x.control().reconcilePublications();await x.opened.ui.syncNow();if(order==='pull-first')await x.control().reconcilePublications();await x.opened.ui.syncNow();
  const state=await x.store().readState(),trace=state.cloud.detachedPublications[x.plan.requestId];expect(trace.outcome).toBe('succeeded');expect(trace.result.account.commitOid).toBe(x.plan.commitOid);expect(canonical(trace.request)).toBe(canonical(x.plan.request));expect(state.account?.oid).toBe(x.plan.commitOid);expect(state.cloud.pendingPublish).toBeNull();expect(state.hasUnsentEdits).toBe(true);expect(state.pendingChoice).toBeTruthy();expect(state.activeGeneration).not.toBe(x.plan.commitOid);expect((await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0].title).toBe('new edit survives late acceptance');expect(await x.opened.ui.openChoice()).toBeTruthy();expect(productPublishes).toBe(0);expect(ownSends(x)).toHaveLength(1);expect(x.a.server.applied).toHaveLength(0);
 }finally{await x.close();}
});

for(const read of ['first-result','second-result'] as const)
test(`WRR4 unknown edit during ${read} lookup frees the original selection without a resend`,async()=>{
 const x=await setup('unknown');let lookups=0,edited=false;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='after'&&new URL(r.url).pathname.endsWith('/requests/'+x.plan.requestId)&&++lookups===(read==='first-result'?1:2)){edited=true;await memo(x.a.db).save({noteId:'local-a',title:'edited during lookup',markdown:'new tail'});}};
  await x.opened.ui.syncNow();expect(edited).toBe(true);expect(await x.opened.ui.openChoice()).toBeTruthy();expect((await x.store().readState()).cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');expect(ownSends(x)).toHaveLength(0);expect(x.a.server.applied).toHaveLength(0);
 }finally{await x.close();}
});

test('WRR4 closed gate defers unknown detachment until a normal open round',async()=>{
 const x=await setup('unknown');
 try{
  await memo(x.a.db).save({noteId:'local-a',title:'edit while gate closes',markdown:'new tail'});await x.toggle(false);const before=canonical(await x.store().readState());await x.opened.ui.syncNow();expect(canonical(await x.store().readState())).toBe(before);expect((await x.store().readState()).cloud.pendingPublish.requestId).toBe(x.plan.requestId);await x.toggle(true);await x.opened.ui.syncNow();expect(await x.opened.ui.openChoice()).toBeTruthy();expect((await x.store().readState()).cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');expect(ownSends(x)).toHaveLength(0);expect(x.a.server.applied).toHaveLength(0);
 }finally{await x.close();}
});

async function equivalentInbox(f:Awaited<ReturnType<typeof p5Fixture>>,cursor:string){
 const row=(await f.projection.candidatePage())[0]!,value=fromWire(row.candidate.meta.kind,row.candidate.meta.payload,row.candidate.state.payload),peer='wrr4-final-owner',key=canonical([peer,14,cursor]);
 await f.projection.receiveLegacy({peer,version:14,cursor,entityKeys:[row.entityKey],body:{[row.entityKey]:{identity:row.candidate.meta.logicalId,...value}},bodyRefsByEntity:{[row.entityKey]:[]}},null);return key;
}
async function cleanRollback(f:Awaited<ReturnType<typeof p5Fixture>>){const first=await f.publish();await f.edit('second');await f.publish();await f.control.rollback(first.account.commitOid,await f.control.captureAccount(),'d'.repeat(32));}
for(const owner of ['cloud','local'] as const)
test(`WRR4 journal arriving at the final legacy snapshot keeps the inbox (${owner})`,async()=>{
 const f=await p5Fixture();let fired=false,seenInbox=false;
 try{
  await cleanRollback(f);const key=await equivalentInbox(f,'one'),preview=await f.control.pendingLegacyChoice(key);expect(preview.canMerge).toBe(true);const applied=(await f.projection.readState()).applied,query=f.db.query.bind(f.db),requestId='e'.repeat(32);
  f.db.query=async(sql,params)=>{
   if(!fired&&seenInbox&&sql.startsWith('SELECT * FROM syncv2_state')){fired=true;const other=await f.control.pendingLegacyChoice(key);if(owner==='cloud'){f.server.loseChoice=true;await expect(f.control.chooseCloud(other.proof,requestId)).rejects.toThrow('choice_response_lost');}else{f.server.losePublish=true;await expect(f.control.chooseLocal(other.proof,requestId)).rejects.toThrow('synthetic_response_lost');}}
   const rows=await query(sql,params);if(sql.startsWith('SELECT rowid,inbox_key,input_hash,body FROM syncv2_legacy_inbox'))seenInbox=true;return rows;
  };
  await expect(f.control.chooseMerge(preview.proof,'f'.repeat(32))).rejects.toThrow('publication_pending');expect(fired).toBe(true);const blocked=await f.projection.readState();expect(blocked.applied).toEqual(applied);expect(blocked.pendingChoice).toBeTruthy();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('pendingChoice');expect((owner==='cloud'?blocked.cloud.pendingCloudChoice:blocked.cloud.pendingPublish).requestId).toBe(requestId);
  if(owner==='cloud')await f.control.resumeCloudChoice();else await f.control.resumePublication();const done=await f.projection.readState();expect(owner==='cloud'?done.cloud.pendingCloudChoice:done.cloud.pendingPublish).toBeNull();
  const newKey=await equivalentInbox(f,'two'),fresh=await f.control.pendingLegacyChoice(newKey);expect(fresh.canMerge).toBe(true);await f.control.chooseMerge(fresh.proof,'1'.repeat(32));expect((await f.projection.legacyChoiceEntry(newKey)).entry.route).toBe('resolve-merge');
 }finally{f.close();}
});

for(const action of vector('notes-conflict').resolutions)
test(`WRR4 note hook keeps current maintenance and outbox for ${action.id}`,()=>{
 const v=vector('notes-conflict'),planner=new NoteConflictPlan(v.initial),capture=planner.capture(),maintenance={cursor:'1000',p5Gates:{history_restore:false,choice_apply:false}},event={kind:'maintenance-observation',cursor:'1000'};
 const result=planner.resolve(capture,action.choice,action.manual,action.now,action.device,()=>{planner.state={...planner.state,stateVersion:'999',choiceControlRevision:'50',cloud:maintenance,scanCheckpoint:{after:'retained-prefix'},outbox:[...planner.state.outbox,event]};});
 expect(result).toEqual(action.expected);expect(planner.state.stateVersion).toBe('1000');expect(planner.state.choiceControlRevision).toBe('50');expect(planner.state.cloud).toEqual(maintenance);expect(planner.state.scanCheckpoint).toEqual({after:'retained-prefix'});expect(planner.state.localChangeRevision).toBe(nextD64(capture.sync.localChangeRevision));expect(planner.state.outbox.slice(-2)).toEqual([event,{kind:'note-resolution',noteId:capture.noteId,resolvedConflictIds:capture.openConflictIds}]);
});
for(const invalidation of ['edit','head','counter-exhausted','budget'] as const)
test(`WRR4 note final ${invalidation} failure preserves the current hook state`,()=>{
 const v=vector('notes-conflict'),planner=new NoteConflictPlan(v.initial),capture=planner.capture(),action=v.resolutions[0];let atHook='';
 expect(()=>planner.resolve(capture,action.choice,action.manual,action.now,action.device,()=>{
  planner.state.stateVersion='999';planner.state.choiceControlRevision='50';planner.state.cloud={cursor:'1000',p5Gates:{choice_apply:false}};
  if(invalidation==='edit'){planner.state.localChangeRevision=nextD64(planner.state.localChangeRevision);planner.state.note.title='new business edit';}
  if(invalidation==='head'){planner.state.account.oid='commit:sha256:'+'e'.repeat(64);planner.state.lastSeenAccountOid=planner.state.account.oid;}
  if(invalidation==='counter-exhausted')planner.state.stateVersion='18446744073709551615';if(invalidation==='budget')planner.state.resolutionAvailableBytes=0;atHook=canonical(planner.state);
 })).toThrow(invalidation==='edit'||invalidation==='head'?'choice_stale':invalidation==='budget'?'storage_pressure':'counter_exhausted');expect(canonical(planner.state)).toBe(atHook);
});

test('WRR4 edited unknown rollback detaches and its late success preserves the new edit',async()=>{
 const f=await p5Fixture();let lose=true,publishes=0;
 try{
  const first=await f.publish();await f.edit('second');await f.publish();const service=f.server.request.bind(f.server);f.server.request=async r=>{if(new URL(r.url).pathname.endsWith('/account/publish')){publishes++;if(lose){lose=false;throw Error('rollback_response_lost');}}return service(r);};
  await expect(f.control.rollback(first.account.commitOid,await f.control.captureAccount(),'2'.repeat(32))).rejects.toThrow('rollback_response_lost');const plan=(await f.projection.readState()).cloud.pendingPublish;expect(plan.kind).toBe('rollback');await f.edit('new edit after queued rollback');await f.reader.pull(await f.http.negotiate([],[]));expect(await f.publisher.reconcileStalePublication()).toEqual({detached:true});
  let state=await f.projection.readState();expect(canonical(state.cloud.detachedPublications[plan.requestId].request)).toBe(canonical(plan.request));expect(state.cloud.pendingPublish).toBeNull();expect(await f.control.pendingChoice()).toBeTruthy();expect(publishes).toBe(1);
  const acks=f.server.acks.length;expect((await service({url:'http://localhost:3000/functions/v1/sync/v2/account/publish',method:'POST',headers:{},body:jsonBytes(plan.request)})).status).toBe(200);await f.control.reconcilePublications();await f.control.follow();state=await f.projection.readState();expect(state.account?.oid).toBe(plan.commitOid);expect(state.cloud.pendingPublish).toBeNull();expect(state.pendingChoice).toBeTruthy();expect(state.hasUnsentEdits).toBe(true);expect(state.cloud.detachedPublications[plan.requestId].outcome).toBe('succeeded');expect((await f.db.query("SELECT title FROM memo_notes WHERE note_id='n'"))[0]!.title).toBe('new edit after queued rollback');expect(f.server.acks.length).toBe(acks);expect(publishes).toBe(1);
 }finally{f.close();}
});

test('WRR4 an accepted result recorded while an old unknown lookup waits keeps the original journal',async()=>{
 const x=await setup('unknown');let fired=false;
 try{
  await x.control().o.reader.pull(await x.control().o.http.negotiate([],[]));
  x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&new URL(r.url).pathname.endsWith('/requests/'+x.plan.requestId)){
   fired=true;expect((await x.transport.request({url:'http://localhost:3000/functions/v1/sync/v2/account/publish',method:'POST',headers:{},body:jsonBytes(x.plan.request)})).status).toBe(200);await x.control().o.publisher.flush();await x.control().o.reader.pull(await x.control().o.http.negotiate([],[]));
  }};
  expect(await x.control().o.publisher.reconcileStalePublication()).toEqual({detached:false});expect(fired).toBe(true);const before=await x.store().readState();expect(before.cloud.pendingPublish.phase).toBe('confirmed');expect(before.cloud.pendingPublish.requestId).toBe(x.plan.requestId);expect(before.cloud.detachedPublications?.[x.plan.requestId]).toBeUndefined();await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingPublish).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(ownSends(x)).toHaveLength(1);expect(x.a.server.applied).toHaveLength(1);
 }finally{await x.close();}
});
