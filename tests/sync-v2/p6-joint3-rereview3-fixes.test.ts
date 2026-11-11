import {test,expect} from 'bun:test';
import {setup,databaseImage,ownSends,assertFinished} from './p6-joint3-rereview3-fixture';
import {canonical,jsonBytes,nextD64} from '../../src/sync-v2/protocol';
import {crypto} from './p2-fixture';
import {scope} from './p6-fix-fixture';
import {signControl} from '../../src/sync-v2/signing';
import {p5Fixture,dirtyRollback} from './p5-fixture';
import {fromWire} from '../../src/sync-v2/business';
import {randomBytes} from 'node:crypto';

// Only service replies and SQL-host scheduling are changed. All product
// state, reader, scanner, recovery and business-application code is original.
async function expiredWindow(x:Awaited<ReturnType<typeof setup>>){
 x.a.server.serverRevision=nextD64(x.a.server.serverRevision);const floor=x.a.server.serverRevision,window=x.a.server.window.bind(x.a.server);
 x.a.server.window=()=>({...window(),historyFloorRevision:floor});
 const checkpoint=async()=>{const w=x.a.server.window();return signControl(crypto,'','wrss.sync.v2/checkpoint-sign',{scope,checkpointId:'d'.repeat(32),serverRevision:w.serverRevision,refs:w.refs,account:w.account,historyFloorRevision:floor,historyFloorMillis:0,windowId:w.windowId,issuedAtMillis:100,expiresAtMillis:300000});};
 const transport=x.control().o.http.transport,send=transport.request.bind(transport);
 transport.request=async(r:any)=>{const path=new URL(r.url).pathname;
  if(path.endsWith('/events'))return {status:410,headers:{},body:jsonBytes({error:{code:'history_expired',retryable:true,retryAfterMillis:null,details:{checkpoint:await checkpoint()}}})};
  if(path.endsWith('/account'))return {status:200,headers:{},body:jsonBytes(x.a.server.window())};
  if(path.endsWith('/checkpoint'))return {status:200,headers:{},body:jsonBytes({version:2,scope,...await checkpoint()})};
  return send(r);
 };
}

for(const outcome of ['unknown','accepted'] as const)
test(`WRR3 deferred rebuild and ${outcome} original journal finish in normal open rounds`,async()=>{
 const x=await setup(outcome);const order:any[]=[];
 try{
  await x.toggle(false);await expiredWindow(x);const closed=await x.store().readState(),image=databaseImage(x),result=await x.control().poll();expect(result.readOnly).toBe(true);expect(result.rebuilt).toBe(false);expect(result.rebuildRequired).toBe(true);expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);
  x.hooks.sql=async(method,args,stage)=>{if(method==='sql.transaction'&&stage==='after'&&args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_checkpoint SET body='))){const s=await x.store().readState();order.push({version:s.stateVersion,phase:s.cloud.pendingPublish?.phase??null,business:args.statements.some((s:any)=>s.program&&!s.program.validateOnly),gate:s.cloud.p5Gates.choice_apply});}};
  await x.toggle(true);await x.opened.ui.syncNow();await x.opened.ui.syncNow();await assertFinished(x);expect(order.length).toBeGreaterThan(0);expect(order.every(e=>e.gate===true)).toBe(true);expect(ownSends(x)).toHaveLength(1);
  console.log('WRR3_REBUILD_ORDER',outcome,JSON.stringify(order));
 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)
test(`WRR3 ${outcome} original journal resumes after deferred rebuild and temporary lookup failure`,async()=>{
 const x=await setup(outcome);
 try{
  await x.toggle(false);await expiredWindow(x);const closed=await x.store().readState();expect((await x.control().poll()).readOnly).toBe(true);expect(canonical(await x.store().readState())).toBe(canonical(closed));await x.toggle(true);
  x.blockLookup();await x.opened.ui.syncNow();const deferred=await x.store().readState();expect(canonical(deferred.cloud.pendingPublish)).toBe(canonical(x.plan));expect(deferred.localChangeRevision).toBe(x.plan.capturedLocalRevision);expect(x.a.server.applied).toHaveLength(0);if(outcome==='unknown'){expect(x.a.server.account.commitOid).toBe(x.plan.request.account.body.expectedOid);expect(x.a.server.account.revision).toBe(x.plan.request.account.body.expectedRevision);}x.unblockLookup();
  const errors:(string|null)[]=[];for(let i=0;i<2;i++){try{await x.opened.ui.syncNow();errors.push(null);}catch(e){errors.push((e as Error).message);}}
  const after=await x.store().readState();console.log('WRR3_REBUILD_LOOKUP',outcome,JSON.stringify({errors,deferredVersion:deferred.stateVersion,afterVersion:after.stateVersion,guard:after.cloud.pendingPublish?.guardVersion??null,sameExpectedHead:after.account?.oid===x.plan.request.account.body.expectedOid&&after.account?.revision===x.plan.request.account.body.expectedRevision,localRevision:after.localChangeRevision,capturedLocalRevision:x.plan.capturedLocalRevision,pending:!!after.cloud.pendingPublish,originalReceived:ownSends(x).length,acks:x.a.server.applied.length}));if(after.cloud.pendingPublish){expect(after.cloud.pendingPublish.requestId).toBe(x.plan.requestId);expect(canonical(after.cloud.pendingPublish.request)).toBe(canonical(x.plan.request));}expect(errors).toEqual([null,null]);await assertFinished(x);
 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const transition of ['close','close-open','close-open-close'] as const)
test(`WRR3 ${outcome} deferred rebuild ${transition} after restart checkpoint retains the closed fence`,async()=>{
 const x=await setup(outcome);let captured:any=null,image='',fired=false,rebuildCommitsAfterClose=0;
 try{
  await x.toggle(false);await expiredWindow(x);const readonly=await x.control().poll();expect(readonly.readOnly).toBe(true);await x.toggle(true);
  x.hooks.sql=async(method,args,stage)=>{
   if(method!=='sql.transaction'||stage!=='after'||!args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_checkpoint SET body='))||args.statements.some((s:any)=>s.program))return;
   if(fired){if(transition!=='close-open')rebuildCommitsAfterClose++;return;}
   const s=await x.store().readState();if(s.cloud.pendingPublish?.phase!=='confirmed'||s.account?.oid!==x.plan.commitOid)return;
   fired=true;await x.toggle(false);if(transition!=='close')await x.toggle(true);if(transition==='close-open-close')await x.toggle(false);captured=await x.store().readState();image=databaseImage(x);
  };
  let error:string|null=null;try{await x.opened.ui.syncNow();}catch(e){error=(e as Error).message;}
  const after=await x.store().readState();console.log('WRR3_MID_REBUILD_GATE',outcome,transition,JSON.stringify({error,closedVersion:captured?.stateVersion,afterVersion:after.stateVersion,closedGuard:captured?.cloud.pendingPublish?.guardVersion,afterGuard:after.cloud.pendingPublish?.guardVersion,gate:after.cloud.p5Gates.choice_apply,rebuildCommitsAfterClose,pending:!!after.cloud.pendingPublish,acks:x.a.server.applied.length}));
  expect(fired).toBe(true);
  if(transition==='close-open'){expect(error).toBeNull();await assertFinished(x);expect(after.choiceControlRevision).toBe(captured.choiceControlRevision);}
  else{const afterImage=databaseImage(x),closedCommits=rebuildCommitsAfterClose;expect(x.a.server.applied).toHaveLength(0);expect(after.cloud.pendingPublish.requestId).toBe(x.plan.requestId);await x.toggle(true);await x.opened.ui.syncNow();await assertFinished(x);console.log('WRR3_MID_REBUILD_REOPEN',outcome,transition,JSON.stringify({originalSends:ownSends(x).length,completed:true,acks:x.a.server.applied.length}));expect(canonical(after)).toBe(canonical(captured));expect(afterImage).toBe(image);expect(closedCommits).toBe(0);}
 }finally{await x.close();}
});

for(const entry of ['warm','cold'] as const)
test(`WRR3 retained accepted cloud journal rejects a real local SQL edit (${entry})`,async()=>{
 const x=await setup('none',0,entry==='cold'?'WAL':undefined);let closed=false,audits=0;
 try{
  x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/choices/cloud'))audits++;if(!closed&&stage==='after'&&r.url.endsWith('/choices/cloud')){closed=true;await x.toggle(false);}};
  await expect(x.opened.ui.chooseCloud(await x.opened.ui.openChoice())).rejects.toThrow('feature_disabled');const accepted=(await x.store().readState()).cloud.pendingCloudChoice;expect(accepted.phase).toBe('accepted');
  await x.a.db.execute("UPDATE memo_notes SET title='real edit after accepted',updated_at=111 WHERE note_id='local-a'");const edited=await x.store().readState();expect(edited.localChangeRevision).not.toBe(accepted.localChangeRevision);
  if(entry==='cold')await x.reopen();expect((await x.store().readState()).cloud.pendingCloudChoice.requestId).toBe(accepted.requestId);expect(x.a.server.applied).toHaveLength(0);
  await x.toggle(true);await expect(x.opened.ui.syncNow()).rejects.toThrow('choice_stale');const after=await x.store().readState(),retained=after.cloud.pendingCloudChoice??after.cloud.retiredCloudChoices[accepted.requestId];expect(retained.requestId).toBe(accepted.requestId);expect(retained.result).toEqual(accepted.result);expect(after.pendingChoice).toBeTruthy();expect(after.hasUnsentEdits).toBe(true);expect((await x.a.db.query('SELECT note_id,title FROM memo_notes'))).toEqual([{note_id:'local-a',title:'real edit after accepted'}]);expect(x.a.server.applied).toHaveLength(0);expect(audits).toBe(1);
  console.log('WRR3_ACCEPTED_EDIT',entry,JSON.stringify({phase:retained.phase,retired:!after.cloud.pendingCloudChoice,localChangeRevision:after.localChangeRevision,control:after.choiceControlRevision}));
 }finally{await x.close();}
});

for(const method of ['controlUpdate','controlUpdateStable','observationUpdate','choiceUpdate'] as const)
test(`WRR3 ${method} cannot copy gate fields from an old next snapshot`,async()=>{
 const x=await setup('none');
 try{
  const old=await x.store().readState();await x.control().setWriteGates({history_restore:false,choice_apply:false});await x.control().setWriteGates({history_restore:false,choice_apply:true});const current=await x.store().readState();
  await x.store()[method](current,JSON.parse(canonical(old)));const after=await x.store().readState(),expected=JSON.parse(canonical(current));expected.stateVersion=nextD64(current.stateVersion);expect(canonical(after)).toBe(canonical(expected));const mirror=(await x.a.db.query('SELECT history_restore,choice_apply,control_revision FROM syncv2_write_gates'))[0];expect(mirror).toEqual({history_restore:0,choice_apply:1,control_revision:current.choiceControlRevision});
  console.log('WRR3_OLD_NEXT',method,JSON.stringify({oldVersion:old.stateVersion,currentVersion:current.stateVersion,afterVersion:after.stateVersion,control:after.choiceControlRevision,mirror}));
 }finally{await x.close();}
});

for(const transition of ['close','close-open'] as const)
test(`WRR3 normal follow final transaction ${transition} preserves current controls and native rows`,async()=>{
 const x=await setup('none');let fired=false,atGate:any=null;
 try{
  await x.opened.ui.chooseCloud(await x.opened.ui.openChoice());const native=await x.a.db.query('SELECT note_id,title FROM memo_notes');await x.remoteEdit();const acks=x.a.server.applied.length;
  x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.program&&!s.program.validateOnly)){fired=true;await x.toggle(false);if(transition==='close-open')await x.toggle(true);atGate=await x.store().readState();}};
  await expect(x.opened.ui.syncNow()).rejects.toThrow(transition==='close'?'feature_disabled':'choice_stale');expect(fired).toBe(true);const after=await x.store().readState();expect(after.cloud.p5Gates).toEqual(atGate.cloud.p5Gates);expect(after.choiceControlRevision).toBe(atGate.choiceControlRevision);expect(await x.a.db.query('SELECT note_id,title FROM memo_notes')).toEqual(native);expect(x.a.server.applied.length).toBe(acks);
  if(transition==='close')await x.toggle(true);await x.opened.ui.syncNow();const done=await x.store().readState();expect((await x.a.db.query('SELECT title FROM memo_notes'))[0].title).toBe('new remote head');expect(done.cloud.pendingApplied).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(x.a.server.applied.length).toBe(acks+1);
 }finally{await x.close();}
});

for(const transition of ['close','close-open'] as const)
test(`WRR3 legacy cloud journal final inbox transaction ${transition} preserves current gates`,async()=>{
 const f=await p5Fixture();let fired=false,atGate:any=null;
 try{
  await dirtyRollback(f);const r=(await f.projection.candidatePage())[0],value=fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload),key=canonical(['independent-peer',14,'one']);
  await f.projection.receiveLegacy({peer:'independent-peer',version:14,cursor:'one',entityKeys:[r.entityKey],body:{[r.entityKey]:{identity:'n',...value,title:'incoming legacy note'}},bodyRefsByEntity:{[r.entityKey]:[]}},null);
  const preview=await f.control.pendingLegacyChoice(key),requestId=randomBytes(16).toString('hex'),native=await f.db.query('SELECT * FROM memo_notes'),transaction=f.db.transaction.bind(f.db);
  f.db.transaction=async statements=>{if(!fired&&statements.some(s=>s.sql.startsWith('UPDATE syncv2_legacy_inbox SET body='))){fired=true;await f.control.setWriteGates({history_restore:true,choice_apply:false});if(transition==='close-open')await f.control.setWriteGates({history_restore:false,choice_apply:true});atGate=await f.projection.readState();}return transaction(statements);};
  let error:string|null=null;try{await f.control.chooseCloud(preview.proof,requestId);}catch(e){error=(e as Error).message;}expect(fired).toBe(true);const state=await f.projection.readState();expect(state.cloud.p5Gates).toEqual(atGate.cloud.p5Gates);expect(state.choiceControlRevision).toBe(atGate.choiceControlRevision);expect(await f.db.query('SELECT * FROM memo_notes')).toEqual(native);expect(f.server.acks).toHaveLength(0);expect(f.server.choiceCalls).toBe(1);
  if(transition==='close'){expect(error).toBe('feature_disabled');expect(state.cloud.pendingCloudChoice.requestId).toBe(requestId);expect(state.cloud.pendingCloudChoice.phase).toBe('accepted');expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('pendingChoice');await f.control.setWriteGates({history_restore:false,choice_apply:true});await f.control.resumeCloudChoice();}
  else expect(error).toBeNull();
  const done=await f.projection.readState();expect(done.cloud.pendingCloudChoice).toBeNull();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('discarded-for-cloud');expect(done.cloud.p5Gates).toEqual({history_restore:false,choice_apply:true});expect(f.server.choiceCalls).toBe(1);expect(f.server.acks).toHaveLength(0);
 }finally{f.close();}
});

for(const transition of ['close','close-open'] as const)
test(`WRR3 recovery-copy final transaction ${transition} does not restore native business early`,async()=>{
 const x=await setup('none');let fired=false,atGate:any=null;
 try{
  await x.opened.ui.chooseCloud(await x.opened.ui.openChoice());const before=await x.store().readState(),copy=before.recoveryCopies[0],native=await x.a.db.query('SELECT * FROM memo_notes'),acks=x.a.server.applied.length;
  x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.program&&!s.program.validateOnly)){fired=true;await x.toggle(false);if(transition==='close-open')await x.toggle(true);atGate=await x.store().readState();}};
  await expect(x.control().restoreRecovery(copy.copyId)).rejects.toThrow(transition==='close'?'feature_disabled':'choice_stale');expect(fired).toBe(true);const after=await x.store().readState();expect(after.cloud.p5Gates).toEqual(atGate.cloud.p5Gates);expect(after.choiceControlRevision).toBe(atGate.choiceControlRevision);expect(after.recoveryCopies).toEqual(before.recoveryCopies);expect(await x.a.db.query('SELECT * FROM memo_notes')).toEqual(native);expect(x.a.server.applied.length).toBe(acks);
  if(transition==='close')await x.toggle(true);await x.control().restoreRecovery(copy.copyId);expect((await x.store().readState()).hasUnsentEdits).toBe(true);expect((await x.a.db.query('SELECT note_id FROM memo_notes'))).toEqual([{note_id:'local-a'}]);expect(x.a.server.applied.length).toBe(acks);
 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)for(const boundary of ['restart','scan-page'] as const)
test(`WRR3 ${outcome} closes inside ${boundary} SQL transaction and resumes the committed prefix`,async()=>{
 const x=await setup(outcome);let fired=false,captured:any,image='',checkpoint='',restarts=0,atCloseRestarts=0;
 try{
  await x.toggle(false);await expiredWindow(x);expect((await x.control().poll()).readOnly).toBe(true);await x.toggle(true);
  x.hooks.sql=async(method,args,stage)=>{
   if(method!=='sql.transaction'||stage!=='before'||!args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_checkpoint SET body='))||args.statements.some((s:any)=>s.program))return;
   const state=await x.store().readState(),cp=await x.store().checkpoint();if(state.cloud.pendingPublish?.phase!=='confirmed'||state.account?.oid!==x.plan.commitOid)return;
   if(cp?.phase==='complete')restarts++;
   if(fired||(boundary==='restart'?cp?.phase!=='complete':cp?.phase!=='scan'||cp.after===''))return;
   fired=true;await x.toggle(false);captured=await x.store().readState();image=databaseImage(x);checkpoint=canonical(await x.store().checkpoint());atCloseRestarts=restarts;
  };
  await x.opened.ui.syncNow();expect(fired).toBe(true);expect(canonical(await x.store().readState())).toBe(canonical(captured));expect(databaseImage(x)).toBe(image);expect(canonical(await x.store().checkpoint())).toBe(checkpoint);expect(x.a.server.applied).toHaveLength(0);
  await x.toggle(true);await x.opened.ui.syncNow();await assertFinished(x);
  // A blocked restart may be retried. A committed scan prefix must not reset.
  if(boundary==='scan-page')expect(restarts).toBe(atCloseRestarts);
 }finally{await x.close();}
});

test('WRR3 cloud preview and accepted journal survive same-head maintenance without another audit',async()=>{
 const x=await setup('none');let audits=0,closed=false;
 try{
  const preview=await x.opened.ui.openChoice();x.a.server.serverRevision=nextD64(x.a.server.serverRevision);await x.control().o.reader.pull(await x.control().o.http.negotiate([],[]));
  x.hooks.network=async(r,stage)=>{if(!r.url.endsWith('/choices/cloud'))return;if(stage==='before')audits++;if(stage==='after'&&!closed){closed=true;await x.toggle(false);}};
  await expect(x.opened.ui.chooseCloud(preview)).rejects.toThrow('feature_disabled');const accepted=(await x.store().readState()).cloud.pendingCloudChoice;
  await x.control().o.recovery.purgeRecovery(100);
  await x.toggle(true);await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingCloudChoice).toBeNull();expect(done.pendingChoice).toBeNull();expect(done.hasUnsentEdits).toBe(false);expect(audits).toBe(1);expect(x.a.server.applied).toHaveLength(1);expect(accepted.phase).toBe('accepted');
 }finally{await x.close();}
});

for(const outcome of ['unknown','accepted'] as const)
test(`WRR3 a valid ${outcome} cloud journal cannot be replaced by a fresh cloud preview`,async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);const r=(await f.projection.candidatePage())[0]!,value=fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload),key=canonical(['pending-owner',14,'one']);
  await f.projection.receiveLegacy({peer:'pending-owner',version:14,cursor:'one',entityKeys:[r.entityKey],body:{[r.entityKey]:{identity:'n',...value}},bodyRefsByEntity:{[r.entityKey]:[]}},null);
  const original=randomBytes(16).toString('hex');if(outcome==='accepted')f.server.loseChoice=true;else f.server.onChoice=async()=>{throw Error('audit_unavailable');};
  await expect(f.control.chooseCloud((await f.control.pendingLegacyChoice(key)).proof,original)).rejects.toThrow(outcome==='accepted'?'choice_response_lost':'audit_unavailable');f.server.onChoice=undefined;
  const before=await f.projection.readState(),preview=await f.control.pendingLegacyChoice(key),calls=f.server.choiceCalls,newId=randomBytes(16).toString('hex');
  await expect(f.control.chooseCloud(preview.proof,newId)).rejects.toThrow('publication_pending');
  expect(canonical((await f.projection.readState()).cloud.pendingCloudChoice)).toBe(canonical(before.cloud.pendingCloudChoice));expect(f.server.choiceCalls).toBe(calls);expect(f.server.requests.has(newId)).toBe(false);expect(f.server.acks).toHaveLength(0);
  await f.control.resumeCloudChoice();expect((await f.projection.readState()).cloud.pendingCloudChoice).toBeNull();expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('discarded-for-cloud');expect(f.server.requests.has(original)).toBe(true);expect(f.server.choiceCalls).toBe(outcome==='accepted'?1:2);
 }finally{f.close();}
});
