import {test,expect} from 'bun:test';
import {setup,databaseImage,assertFinished} from './p6-joint3-rereview3-fixture';
import {MemoRepository} from '../../src/notes/repository';
import {canonical,jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
const save=(x:any,title='retained detached edit',time=200)=>new MemoRepository(x.a.db,'independent-review',()=> 'review-note',()=>time).save({noteId:'local-a',title,markdown:'content '+title});
const own=(x:any,id:string)=>x.a.server.publishedBodies.map((v:string)=>parseCanonicalJson(Buffer.from(v,'base64'))).filter((v:any)=>v.account.body.requestId===id);
const title=async(x:any)=>(await x.a.db.query("SELECT title FROM memo_notes WHERE note_id='local-a'"))[0]?.title;
async function detached(mode?:'DELETE'|'WAL'){
 const x=await setup('unknown',0,mode);await save(x);await x.opened.ui.syncNow();const s=await x.store().readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');expect(canonical(s.cloud.detachedPublications[x.plan.requestId].request)).toBe(canonical(x.plan.request));expect(own(x,x.plan.requestId)).toHaveLength(0);return x;
}
async function deliver(x:any){const r=await x.transport.request({url:'http://localhost:3000/functions/v1/sync/v2/account/publish',method:'POST',headers:{},body:jsonBytes(x.plan.request)});expect(r.status).toBe(200);return parseCanonicalJson(r.body);}
async function dirty(x:any,want='retained detached edit'){
 const s=await x.store().readState();expect(await title(x)).toBe(want);expect(s.hasUnsentEdits).toBe(true);expect(s.pendingChoice).toBeTruthy();expect(s.activeGeneration).not.toBe(x.plan.commitOid);expect(x.a.server.applied).toHaveLength(0);expect(canonical(s.cloud.detachedPublications[x.plan.requestId].request)).toBe(canonical(x.plan.request));return s;
}
async function completeFresh(x:any,want='retained detached edit'){
 await x.opened.ui.chooseLocal(await x.opened.ui.openChoice());const s=await x.store().readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.pendingChoice).toBeNull();expect(s.hasUnsentEdits).toBe(false);expect(s.activeGeneration).toBe(s.account.oid);expect(s.account.oid).not.toBe(x.plan.commitOid);expect(await title(x)).toBe(want);expect(x.a.server.applied.length).toBeGreaterThan(0);expect(x.a.server.applied.every((a:any)=>a.commitOid===s.account.oid)).toBe(true);return s;
}
for(const change of ['already-closed','close-during-query','close-open-close-during-query']as const)test(`WRR5 detached accepted query ${change} with a new queued choice respects closed observation gate`,async()=>{
 const x=await detached();let newId='',fired=false,closed:any,image='';try{await deliver(x);await x.opened.ui.syncNow();await dirty(x);x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/account/publish')){newId=parseCanonicalJson(r.body).account.body.requestId;throw Error('review_new_request_lost');}};await expect(x.opened.ui.chooseLocal(await x.opened.ui.openChoice())).rejects.toThrow('review_new_request_lost');x.hooks.network=undefined;const capture=async()=>{await x.toggle(false);if(change==='close-open-close-during-query'){await x.toggle(true);await x.toggle(false);}closed=await x.store().readState();image=databaseImage(x);};
 if(change==='already-closed')await capture();else x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&new URL(r.url).pathname.endsWith('/requests/'+x.plan.requestId)){fired=true;await capture();}};
 let error:string|null=null;try{await x.control().reconcilePublications();}catch(e){error=(e as Error).message;}expect(closed).toBeTruthy();x.hooks.network=undefined;const after=await x.store().readState();expect(after.cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');expect(canonical(after.cloud.pendingPublish.request)).toBe(canonical(closed.cloud.pendingPublish.request));const same=canonical(after)===canonical(closed),sameImage=databaseImage(x)===image;expect(after.cloud.pendingPublish.requestId).toBe(newId);expect(x.a.server.applied).toHaveLength(0);console.log('WRR5_CLOSED_DETACHED',JSON.stringify({change,error,beforeVersion:closed.stateVersion,afterVersion:after.stateVersion,same,sameImage,oldOutcome:after.cloud.detachedPublications[x.plan.requestId].outcome,newId,gate:after.cloud.p5Gates.choice_apply}));await x.toggle(true);await x.control().reconcilePublications();expect((await x.store().readState()).cloud.detachedPublications[x.plan.requestId].outcome).toBe('succeeded');await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingPublish).toBeNull();expect(done.activeGeneration).toBe(done.account.oid);expect(await title(x)).toBe('retained detached edit');expect(x.a.server.applied.every((a:any)=>a.commitOid!==x.plan.commitOid)).toBe(true);expect(same).toBe(true);expect(sameImage).toBe(true);}finally{await x.close();}
});

for(const change of ['close-before-sql','close-open-before-sql','close-open-close-before-sql'] as const)
test(`WRR5 detached result ${change} retains the new signed journal and retries after reopening`,async()=>{
 const x=await detached();let fired=false,image='',closed:any,newPlan:any;
 try{
  await deliver(x);await x.opened.ui.syncNow();x.hooks.network=async(r,stage)=>{if(stage==='before'&&r.url.endsWith('/account/publish'))throw Error('new_response_lost');};await expect(x.opened.ui.chooseLocal(await x.opened.ui.openChoice())).rejects.toThrow('new_response_lost');x.hooks.network=undefined;newPlan=(await x.store().readState()).cloud.pendingPublish;
  x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.sql.startsWith('UPDATE syncv2_state SET body='))){fired=true;await x.toggle(false);if(change!=='close-before-sql')await x.toggle(true);if(change==='close-open-close-before-sql')await x.toggle(false);closed=await x.store().readState();image=databaseImage(x);}};
  await expect(x.control().reconcilePublications()).rejects.toThrow(change==='close-open-before-sql'?'choice_stale':'feature_disabled');expect(fired).toBe(true);x.hooks.sql=undefined;const after=await x.store().readState();expect(canonical(after)).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);expect(canonical(after.cloud.pendingPublish)).toBe(canonical(newPlan));expect(after.cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');
  if(change!=='close-open-before-sql')await x.toggle(true);await x.control().reconcilePublications();expect((await x.store().readState()).cloud.detachedPublications[x.plan.requestId].outcome).toBe('succeeded');await x.opened.ui.syncNow();const done=await x.store().readState();expect(done.cloud.pendingPublish).toBeNull();expect(own(x,newPlan.requestId)).toHaveLength(1);expect(canonical(own(x,newPlan.requestId)[0])).toBe(canonical(newPlan.request));expect(own(x,x.plan.requestId)).toHaveLength(1);expect(await title(x)).toBe('retained detached edit');expect(x.a.server.applied.every((a:any)=>a.commitOid===newPlan.commitOid)).toBe(true);
 }finally{await x.close();}
});

for(const writer of ['header','quarantine','account'] as const)for(const timing of ['already-closed','close-before-sql'] as const)
test(`WRR5 ${writer} observation ${timing} cannot write through a control path`,async()=>{
 const x=await setup('unknown');let fired=false,closed:any,image='';
 try{
  const baseline=await x.store().readState(),capture=async()=>{await x.toggle(false);closed=await x.store().readState();image=databaseImage(x);};
  if(timing==='already-closed')await capture();else x.hooks.sql=async(method,_args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'){fired=true;await capture();}};
  const operation=writer==='header'?x.store().stageHeaders([{oid:x.plan.commitOid,...x.plan.commit}],baseline,false):writer==='quarantine'?x.store().quarantineIncoming(baseline,baseline.account.oid,new Map(),'unsupported_feature',false):x.store().observe(baseline.account,async()=>({authors:baseline.knownAuthors,parents:baseline.knownAccountParents}));
  await expect(operation).rejects.toThrow('feature_disabled');x.hooks.sql=undefined;expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);expect(canonical((await x.store().readState()).cloud.pendingPublish)).toBe(canonical(x.plan));await x.toggle(true);await x.opened.ui.syncNow();await assertFinished(x);
 }finally{await x.close();}
});

for(const timing of ['already-closed','close-during-query'] as const)
test(`WRR5 cancellation outcome ${timing} waits for the observation gate`,async()=>{
 const x=await setup('unknown');let closed:any,image='',fired=false;
 try{
  const capture=async()=>{await x.toggle(false);closed=await x.store().readState();image=databaseImage(x);};if(timing==='already-closed')await capture();else x.hooks.network=async(r,stage)=>{if(!fired&&stage==='after'&&new URL(r.url).pathname.endsWith('/requests/'+x.plan.requestId)){fired=true;await capture();}};
  await expect(x.control().cancelPublication()).rejects.toThrow('feature_disabled');x.hooks.network=undefined;expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);expect(own(x,x.plan.requestId)).toHaveLength(0);await x.toggle(true);await x.control().cancelPublication();expect((await x.store().readState()).cloud.pendingPublish).toBeNull();expect((await x.store().readState()).cloud.detachedPublications[x.plan.requestId].outcome).toBe('unknown');expect(own(x,x.plan.requestId)).toHaveLength(0);
 }finally{await x.close();}
});

import {LocalWitnessStore} from '../../src/sync-v2/witness';
import {WatchContentStore} from '../../src/sync-v2/content-store';
import {ContentFiles} from '@podjs/framework/content-files';
import {cipher} from './fixture';
import {proofs} from './p4-fixture';
import {objectOid} from '../../src/sync-v2/sealed';
for(const timing of ['already-closed','close-before-sql'] as const)
test(`WRR5 authenticated witness ${timing} preserves the queued journal and content records`,async()=>{
 const x=await setup('unknown'),[session,peer]=await proofs(['witness']);let closed:any,image='',fired=false;
 try{
  const scope=x.control().o.http.scope,records=new WatchContentStore(x.a.db,cipher,new ContentFiles(async()=>{throw Error('unexpected_file_io');}),{scope,fixture:'wrr5-observation'});await records.init();
  const witness=new LocalWitnessStore(records,x.store(),scope,x.control().o.crypto,x.control().o.approved),value={scope,head:x.plan.commitOid,headers:[{commitOid:x.plan.commitOid,headerOid:objectOid('commit-header',jsonBytes(x.plan.commit)),...x.plan.commit}]};
  const capture=async()=>{await x.toggle(false);closed=await x.store().readState();image=databaseImage(x);};if(timing==='already-closed')await capture();else x.hooks.sql=async(method,args,stage)=>{if(!fired&&method==='sql.transaction'&&stage==='before'&&args.statements.some((s:any)=>s.sql.startsWith('INSERT INTO sync2_content_projection'))){fired=true;await capture();}};
  await expect(witness.receive(value,session)).rejects.toThrow('feature_disabled');x.hooks.sql=undefined;expect(canonical(await x.store().readState())).toBe(canonical(closed));expect(databaseImage(x)).toBe(image);expect(await records.page('',32,'witness:')).toHaveLength(0);await x.toggle(true);await witness.receive(value,session);expect(await records.page('',32,'witness:')).toHaveLength(1);expect(canonical((await x.store().readState()).cloud.pendingPublish)).toBe(canonical(x.plan));await x.opened.ui.syncNow();await assertFinished(x);
 }finally{session.close();peer.close();await x.close();}
});

import {p5Fixture,dirtyRollback} from './p5-fixture';
import {fromWire} from '../../src/sync-v2/business';
for(const timing of ['already-closed','close-during-query'] as const)
test(`WRR5 prior ACK confirmation ${timing} preserves the newer queued choice`,async()=>{
 const f=await p5Fixture();let loseAck=true,losePublish=false,armed=false,fired=false,closed:any,image='';
 try{
  await dirtyRollback(f);const service=f.server.request.bind(f.server),sent:any[]=[];
  f.server.request=async r=>{const path=new URL(r.url).pathname;
   if(losePublish&&path.endsWith('/account/publish')){losePublish=false;sent.push(parseCanonicalJson(r.body));throw Error('new_request_lost');}
   if(path.endsWith('/account/publish'))sent.push(parseCanonicalJson(r.body));const response=await service(r);
   if(loseAck&&path.endsWith('/acks/applied')){loseAck=false;throw Error('ack_response_lost');}
   if(armed&&!fired&&path.endsWith('/requests/'+closedAck.requestId)){fired=true;await close();}return response;
  };
  await expect(f.control.chooseCloud((await f.control.pendingChoice())!.proof,'4'.repeat(32))).rejects.toThrow('ack_response_lost');const closedAck=(await f.projection.readState()).cloud.pendingApplied;expect(closedAck).toBeTruthy();expect(f.server.acks).toHaveLength(1);
  const row=(await f.projection.candidatePage())[0]!,value=fromWire(row.candidate.meta.kind,row.candidate.meta.payload,row.candidate.state.payload),peer='wrr5-ack',key=canonical([peer,14,'one']);await f.projection.receiveLegacy({peer,version:14,cursor:'one',entityKeys:[row.entityKey],body:{[row.entityKey]:{identity:row.candidate.meta.logicalId,...value}},bodyRefsByEntity:{[row.entityKey]:[]}},null);
  losePublish=true;await expect(f.control.chooseLocal((await f.control.pendingLegacyChoice(key)).proof,'5'.repeat(32))).rejects.toThrow('new_request_lost');const plan=(await f.projection.readState()).cloud.pendingPublish;
  async function close(){await f.control.setWriteGates({history_restore:true,choice_apply:false});closed=await f.projection.readState();image=databaseImage({a:{db:f.db}} as any);}
  if(timing==='already-closed')await close();else armed=true;await expect(f.control.flushApplied()).rejects.toThrow('feature_disabled');armed=false;const after=await f.projection.readState();expect(canonical(after)).toBe(canonical(closed));expect(databaseImage({a:{db:f.db}} as any)).toBe(image);expect(after.cloud.pendingApplied).toEqual(closedAck);expect(canonical(after.cloud.pendingPublish)).toBe(canonical(plan));expect(f.server.acks).toHaveLength(1);
  await f.control.setWriteGates({history_restore:true,choice_apply:true});await f.control.flushApplied();expect((await f.projection.readState()).cloud.pendingApplied).toBeNull();expect(f.server.acks).toHaveLength(1);await f.control.resumePublication();expect((await f.projection.readState()).cloud.pendingPublish).toBeNull();expect(sent).toHaveLength(2);expect(canonical(sent[0])).toBe(canonical(plan.request));expect(canonical(sent[1])).toBe(canonical(plan.request));expect(f.server.acks).toHaveLength(2);expect(f.server.acks[1].commitOid).toBe(plan.commitOid);
 }finally{f.close();}
});

test('WRR5 closed choice gate without a queued choice still permits detached observation',async()=>{
 const x=await detached();
 try{await deliver(x);await x.toggle(false);const before=await x.store().readState();expect(before.cloud.pendingPublish).toBeNull();expect(before.cloud.pendingCloudChoice??null).toBeNull();await x.control().reconcilePublications();const after=await x.store().readState();expect(after.cloud.detachedPublications[x.plan.requestId].outcome).toBe('succeeded');expect(after.cloud.p5Gates.choice_apply).toBe(false);expect(await title(x)).toBe('retained detached edit');expect(x.a.server.applied).toHaveLength(0);}finally{await x.close();}
});

test('WRR5 ordinary publication confirmation remains available without a queued choice',async()=>{
 const f=await p5Fixture();try{await f.control.setWriteGates({history_restore:false,choice_apply:false});await f.publish();const state=await f.projection.readState();expect(state.cloud.pendingPublish).toBeNull();expect(state.cloud.lastPublication.result.account.commitOid).toBe(state.account?.oid);expect(state.cloud.p5Gates).toEqual({history_restore:false,choice_apply:false});}finally{f.close();}
});
