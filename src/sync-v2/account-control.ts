import {SigningStateUnavailable} from './signing-store';
import {noteAssetKeys} from '../notes/cloud-assets';
import {conflictTexts} from './note-conflict-set';
import {sameBusinessRevision} from './business-revision';
import {sha256Hex} from '@podjs/framework/crypto';
import {phoneNotePlainText} from '../notes/phone-text';
/** Explicit account history/choice actions. No UI, scheduler or startup hook. */
import type {Statement} from '@podjs/framework/sql-projection';
import {canonical,digest,hexId,oid,exact,uint,nextD64,compareD64,bytes,type Kind} from './protocol';
import {choiceCurrent,publicationCurrent,captureChoice,checkChoiceWindow,checkCapture,currentAccount,observeAccount,type Capture,type SyncState} from './state';
import {fromWire,candidates,toWire} from './business';
import {canMerge} from './merge-planner';
import {verifyCommit,type SigningPort} from './signing';
import type {EnvelopeCrypto} from './sealed';
import type {ApprovedKey} from './head-pins';
import {PAGE_BYTES,type WatchProjectionStore,type SourceRecord} from './store';
import {recordFact,type RecordFact,type RecordFeed,type StatementFeed} from './record-feed';
import type {WatchCloudIndex} from './cloud-index';
import {PublicationLookupUnavailable,type WatchIndexPublisher,type BodyResolver} from './publisher';
import type {WatchRecovery,RecoveryValue} from './recovery';
import type {SyncV2Http} from './http';
import {parseNetwork} from './http';
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
type RecordRow={entityKey:string;rowSequence:string;candidate:any;manifest?:any;row?:any};
export interface AccountBusinessPort {
 /** Pure preparation against the same business DB. Commit must occur only at
  * WatchProjectionStore's CAS, never inside this callback. */
 prepare(records:SourceRecord[],before:SyncState):Promise<Statement[]>;
 /** R4: the same statements as a replayable feed over a replayable record feed. */
 prepareFeed?(records:RecordFeed,before:SyncState):StatementFeed;
 /** Authenticated complete local recovery closure, including note attachments. */
 recoveryValue(entityKey:string):Promise<RecoveryValue>;
 /** Verify the complete target recipe/blob closure without changing the DB. */
 verifyBody(row:any,windowId:string):Promise<void|{objects:{oid:string;storedBytes:number}[]}>;
 /** Actual persistent capacity reservation, kept until apply finishes. */
 reserve(bytes:number):Promise<()=>Promise<void>>;
}
export interface AccountControlOptions {
 store:WatchProjectionStore;http:SyncV2Http;reader:WatchCloudIndex;publisher:WatchIndexPublisher;
 crypto:EnvelopeCrypto&SigningPort;approved:(id:string)=>Promise<ApprovedKey>;
 author:()=>Promise<{deviceId:string;alias:string;own:{commitOid:string|null;revision:string}}>;
 business:AccountBusinessPort;recovery:WatchRecovery;resolveBody?:BodyResolver;
 /** Trusted server UTC only. Unknown/backwards time fails closed. */
 trustedNow:()=>number|null;rebuildProjection?:()=>Promise<void>;historyRestore?:boolean;choiceApply?:boolean;
 /** Product entries authenticate the winning head before reconciling an intent. */
 preserveStalePublication?:boolean;
}
export class WatchAccountControl {
 private plans=new WeakMap<object,{capture:Capture;local:RecordRow[];cloud:RecordRow[];merge:any;mergedRows?:RecordRow[];release?:()=>Promise<void>;legacyKey?:string;legacyHash?:string;legacyMerge?:any;applyPlan?:import('@podjs/framework/sql-program').SqlProgramRef}>();
 private activePreview?:object;
 constructor(private readonly o:AccountControlOptions){}
 private now(){const n=this.o.trustedNow();if(n===null)throw Error('clock_unknown');uint(n);return n;}
 private async gate(kind:'history'|'choice'){if(kind==='history'?(!this.o.historyRestore||!this.o.http.historyRestoreOpen()):!this.o.choiceApply)throw Error('feature_disabled');const s=await this.o.store.readStableState(),flag=kind==='history'?'history_restore':'choice_apply';if(s.cloud?.p5Gates?.[flag]===false)throw Error('feature_disabled');}
 async rebuildProjection(){if(!this.o.rebuildProjection)throw Error('feature_disabled');await this.o.rebuildProjection();return this.status();}
 async status(){const s=await this.o.store.readState();return {accountOid:s.account?.oid??null,revision:s.account?.revision??'0',generation:s.rollbackGeneration,lastSeen:s.lastSeen,activeGeneration:s.activeGeneration,awaitingUser:!!s.pendingChoice};}
 async history(pageToken:string|null=null){await this.gate('history');return this.o.reader.history(pageToken);}
 async settings(){const s=await this.o.store.readState();return {keepDiscardedLocalChanges7Days:s.keepDiscardedLocalChanges7Days,history_restore:this.o.historyRestore===true&&this.o.http.historyRestoreOpen()&&s.cloud?.p5Gates?.history_restore!==false,choice_apply:this.o.choiceApply===true&&s.cloud?.p5Gates?.choice_apply!==false,gc:false,key_rotation:false,custody_release:false};}
 async setWriteGates(flags:{history_restore:boolean;choice_apply:boolean}){
  exact(flags,['history_restore','choice_apply']);if(Object.values(flags).some(v=>typeof v!=='boolean'))throw Error('invalid_schema');if(flags.history_restore&&!this.o.http.historyRestore||flags.choice_apply&&!this.o.http.choiceApply)throw Error('feature_disabled');
  const before=await this.o.store.readState();await this.o.store.setWriteGates(before,flags);
 }
 async setKeepDiscardedLocalChanges7Days(value:boolean){if(typeof value!=='boolean')throw Error('invalid_schema');return this.o.recovery.setKeep(value);}
 async recoveryCopies(){await this.o.recovery.purgeRecovery(this.o.trustedNow());return (await this.o.store.readState()).recoveryCopies?.map(c=>({copyId:c.copyId,createdAtMillis:c.header.createdAtMillis,expiresAtMillis:c.header.expiresAtMillis}))??[];}
 async restoreRecovery(copyId:string){await this.gate('choice');await this.o.recovery.purgeRecovery(this.o.trustedNow());return this.o.recovery.restoreAsEdits(copyId,async delta=>{const before=await this.o.store.readState(),rows=new Map((await this.local()).map(r=>[r.entityKey,r]));for(const change of delta.changes){if(change.kind==='remove'){rows.delete(change.id);continue;}const identity=await this.o.store.identityForEntity(change.id),value={...change.value};if(Object.hasOwn(value,'readingProgressMicros')){value.readingProgress=value.readingProgressMicros/1000000;delete value.readingProgressMicros;}rows.set(change.id,{entityKey:change.id,rowSequence:nextD64(before.localChangeRevision),candidate:candidates(identity.kind,identity.logicalId,change.id,value,undefined,this.o.store.segmentOptions())});}const records=this.records([...rows.values()]),business=await this.o.business.prepare(records,before);return this.o.store.prepareAccountProjection({...before,localChangeRevision:nextD64(before.localChangeRevision)},records,business);});}
 private async local(){const out:RecordRow[]=[];let after='';for(;;){const page=await this.o.store.candidatePage(after,32);if(!page.length)break;out.push(...page);after=page.at(-1)!.entityKey;}return out;}
 private async cloud(s:SyncState){if(!s.account||s.cloud?.current?.commitOid!==s.account.oid)throw Error('choice_stale');const rows:RecordRow[]=[];let after='';for(;;){const page=await this.o.store.cloudRows(s.cloud.current.treeRoot,after,32);if(!page.length)break;for(const r of page){const row=await this.openable(r);if(row)rows.push(row);}after=page.at(-1)!.row.entityKey;}return rows;}
 /** F1: a cloud row this device cannot open is never applied. The local note
  * keeps its prior version; a remote tombstone still deletes it, using only the
  * authenticated non-text metadata. Without a local note the entity is absent. */
 private async openable(r:any):Promise<RecordRow|null>{
  const base={entityKey:r.row.entityKey,rowSequence:r.row.rowSequence,row:r.row,manifest:this.manifest(r.row)};if(!r.unopenable)return {...base,candidate:{meta:r.meta,state:r.state,addedAtMillis:r.row.addedAtMillis}};
  const local=await this.o.store.readCandidate(r.row.entityKey);if(!local)return null;if(!r.row.deleted)return {...base,candidate:local};
  const value=fromWire('note',local.meta.payload,local.state.payload),m=r.state.payload.metadata;if(value.deleted)return {...base,candidate:local};
  return {...base,candidate:candidates('note',local.meta.logicalId,r.row.entityKey,{...value,deleted:true,deletedAt:m.deletedAt,updatedAt:m.updatedAt,modifiedBy:m.modifiedBy},local.meta.addedAtSource==='original'?local.addedAtMillis:undefined,this.o.store.segmentOptions())};
 }
 private manifest(row:any){return Object.fromEntries(['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].map(k=>[k,row[k]]));}
 private model(rows:RecordRow[]){return Object.fromEntries(rows.map(r=>[r.entityKey,{identity:r.candidate.meta.logicalId,...r.candidate.meta.payload,...r.candidate.state.payload}]));}
 private merge(s:SyncState,local:RecordRow[],cloud:RecordRow[],editBases:Record<string,any>){
  const localMap=new Map(local.map(r=>[r.entityKey,r])),l=this.model(local),c=this.model(cloud),base=s.editBase.accountOid===s.account?.oid?clone(c):clone(editBases),creates=new Set<string>(s.cloud?.editCreates??[]),ops:any[]=[];
  for(const id of new Set([...Object.keys(l),...Object.keys(base)])){
   if(canonical(l[id]??null)===canonical(base[id]??null))continue;
   if(!base[id]&&canonical(l[id]??null)===canonical(c[id]??null))continue;
   const fields=Object.keys(l[id]??{}).filter(k=>k!=='identity'&&!(localMap.get(id)?.candidate.meta.kind==='note'&&['plainText','contentHash','baseContentHash','baseMarkdown','updatedAt','modifiedBy'].includes(k))&&canonical(l[id][k])!==canonical(base[id]?.[k]??null));
   const row=localMap.get(id),hasBody=row&&['article','book','asset'].includes(row.candidate.meta.kind),complete=!hasBody||!!row?.manifest?.recipeOid;
   if(!base[id]&&!creates.has(id))return {canMerge:false,reason:'missing_base'};
   ops.push({id,kind:!base[id]?'create':!l[id]||l[id].deleted?'delete':'update',fields,complete});
  }
  return canMerge({base,local:l,cloud:c,ops,noteConflictGenerations:{base:s.editBase.generation,local:s.editBase.generation,cloud:s.rollbackGeneration}});
 }
 /** Private process-local handle; copied/replayed handles are never trusted. */
 async pendingChoice(){
  if(this.activePreview)await this.closePreview(this.activePreview);
  if(!this.o.preserveStalePublication||(await this.o.store.readState()).cloud?.preparingPublication)await this.o.publisher.detachPublication?.();let state=await this.o.store.readState();if(!state.pendingChoice)return null;
  // An audit-only cloud intent cannot authorize a newer local window. Reopening
  // retires only that stale intent, so every choice remains available again.
  if(await this.retireStaleCloudChoice())state=await this.o.store.readState();
  const cp=await this.o.store.checkpoint();if(cp?.phase!=='complete'||!sameBusinessRevision(cp.businessRevision,state.businessRevision))throw Error('projection_incomplete');
  const capture=captureChoice(state,currentAccount(state)),local=await this.local(),cloud=await this.cloud(state),cloudMap=new Map(cloud.map(r=>[r.entityKey,r]));
  for(const entry of local){const existing=cloudMap.get(entry.entityKey);if(this.o.resolveBody)entry.manifest=await this.o.resolveBody(entry,existing);else if(existing&&canonical(entry.candidate.meta.payload)===canonical(existing.candidate.meta.payload))entry.manifest=existing.manifest;}
  let merge=state.pendingChoice!.inboxKeys.length?{canMerge:false,reason:'missing_base'}:this.merge(state,local,cloud,await this.o.store.editBases(state)),mergedRows:RecordRow[]|undefined,release:(()=>Promise<void>)|undefined;
  let applyPlan:import('@podjs/framework/sql-program').SqlProgramRef|undefined;
  if(merge.canMerge){try{mergedRows=this.mergedRows(merge.tree,local,cloud,await this.o.store.preparationClock(state,this.now()));const preflight=await this.prepareApply(state,mergedRows);release=preflight.release;applyPlan=preflight.plan;}catch(error){if(['choice_stale','projection_preparing'].includes((error as Error).message))throw error;const message=String(error);merge={canMerge:false,reason:/storage|quota/.test(message)?'storage_pressure':/content|closure|body_revision/.test(message)?'missing_content':'unsupported_feature'};}}

  if(canonical(await this.o.store.readStableState())!==canonical(state)){await release?.();throw Error('choice_stale');}
  const proof=Object.freeze({capture,canMerge:merge.canMerge,reason:merge.canMerge?null:merge.reason});this.activePreview=proof;this.plans.set(proof,{capture,local,cloud,merge,mergedRows,release,applyPlan});return {...state.pendingChoice,accountOid:capture.accountOid,accountRevision:capture.accountRevision,selectedLocalChangeRevision:capture.localChangeRevision,...proof,proof};
 }
 async closePreview(proof:object){const p=this.plans.get(proof);if(p){this.plans.delete(proof);if(!p.applyPlan||!await this.o.store.planOwned(p.applyPlan.id))await p.release?.();}}
 private mergedRows(tree:any,local:RecordRow[],cloud:RecordRow[],now=this.now()){
  const byId=new Map([...cloud,...local].map(r=>[r.entityKey,r])),cloudMap=new Map(cloud.map(r=>[r.entityKey,r])),localMap=new Map(local.map(r=>[r.entityKey,r]));return Object.entries(tree).map(([entityKey,model]:[string,any])=>{
   const original=byId.get(entityKey)!;if(!original)throw Error('closure_incomplete');const {identity,...value}=model,m=original.candidate.meta,meta:any={},state:any={};for(const [key,v]of Object.entries(value))(Object.hasOwn(m.payload,key)?meta:state)[key]=v;
   const business=fromWire(m.kind,meta,state),c=cloudMap.get(entityKey);
   if(m.kind==='note'&&(!c||canonical(model)!==canonical(this.model([c])[entityKey]))){business.plainText=phoneNotePlainText(business.markdown);business.contentHash=sha256Hex(bytes(business.markdown));business.baseMarkdown=c?.candidate.state.payload.markdown??business.baseMarkdown;business.baseContentHash=c?.candidate.meta.payload.contentHash??c?.candidate.state.payload.contentHash??business.baseContentHash;business.updatedAt=Math.max(now,business.updatedAt);business.modifiedBy=localMap.get(entityKey)?.candidate.state.payload.modifiedBy??business.modifiedBy;}
   return {...original,candidate:candidates(m.kind,identity,entityKey,business,m.addedAtSource==='original'?original.candidate.addedAtMillis:undefined,this.o.store.segmentOptions())};
  });
 }
 private async prepareApply(state:SyncState,rows:RecordRow[]){
  const assets=new Map(rows.filter(r=>r.candidate.meta.kind==='asset').map(r=>[r.candidate.meta.logicalId,r]));for(const r of rows)if(r.candidate.meta.kind==='note'){const p=r.candidate.state.payload,texts=[p.markdown,p.baseMarkdown,...(p.noteConflicts?conflictTexts(p.noteConflicts):[])];for(const text of texts)for(const id of noteAssetKeys(text)){const asset=assets.get(id);if(!asset||asset.candidate.state.payload.deleted||asset.manifest?.bodyRevision==null||asset.manifest?.recipeOid==null)throw Error('closure_incomplete');}}
  const wire=this.o.publisher.preflightRecords(rows),window=await this.o.http.negotiate([],[]),closure=new Map<string,number>();
  for(const r of rows){const body={entityKey:r.entityKey,...r.manifest,bodyRevision:r.manifest?.bodyRevision??null};const witness=await this.o.business.verifyBody(body,window.windowId);if(body.bodyRevision!==null&&!witness)throw Error('closure_incomplete');for(const o of witness?.objects??[]){oid(o.oid,o.oid.split(':')[0]!);uint(o.storedBytes);const old=closure.get(o.oid);if(old!==undefined&&old!==o.storedBytes)throw Error('closure_incomplete');closure.set(o.oid,o.storedBytes);}}
  const records=this.records(rows),business=await this.o.business.prepare(records,state),prepared=await this.o.store.prepareAccountProjection(state,records,business),plan=(prepared as any).preparedPlan as import('@podjs/framework/sql-program').SqlProgramRef;
  let required=wire.wireBytes+plan.bytes*6+bytes(canonical(state)).length*4+32768;for(const size of closure.values())required+=size*2;if(!Number.isSafeInteger(required))throw Error('object_too_large');
  const release=await this.o.store.existingPlanReservation(plan)??await this.reserveBytes(required);const reservation=(release as import('@podjs/framework/resource-journal').ResourceRelease).reservation;let reservedPlan=plan;try{reservedPlan=reservation?await this.o.store.keepPlanReservation(plan,reservation):plan;await this.o.store.validateAccountProjection(state,prepared);if(canonical(await this.o.store.readStableState())!==canonical(state))throw Error('choice_stale');return {plan:reservedPlan,release:async()=>{if(reservation)await this.o.store.releasePlanReservation(reservedPlan);else await release();},required};}catch(error){if(!await this.o.store.planOwned(plan.id))await release();throw error;}
 }
 private async reserveBytes(bytes:number){try{return await this.o.business.reserve(bytes);}catch(error){throw Object.assign(Error('storage_pressure'),{cause:error});}}
 private async reserveProjection(statements:import('@podjs/framework/sql-projection').Statement[]){const plan=(statements as any).preparedPlan as import('@podjs/framework/sql-program').SqlProgramRef|undefined;if(!plan)return this.reserveBytes(this.o.store.accountProjectionReservationBytes(statements));const release=await this.o.store.existingPlanReservation(plan)??await this.reserveBytes(this.o.store.accountProjectionReservationBytes(statements)),reservation=(release as import('@podjs/framework/resource-journal').ResourceRelease).reservation;let ref=plan;try{if(reservation)ref=await this.o.store.keepPlanReservation(plan,reservation);}catch(e){if(!await this.o.store.planOwned(plan.id))await release();throw e;}return async()=>{if(!await this.o.store.planOwned(plan.id)){if(reservation)await this.o.store.releasePlanReservation(ref);else await release();}};}
 private async checked(proof:object){const p=this.plans.get(proof);if(!p)throw Error('choice_stale');const s=await this.o.store.readState();checkCapture(s,p.capture);if(p.legacyKey&&digest(await this.o.store.legacyChoiceEntry(p.legacyKey))!==p.legacyHash)throw Error('choice_stale');return {p,s};}
 async pendingLegacyChoice(key:string){
  const view=await this.pendingChoice();if(!view)throw Error('choice_stale');const p=this.plans.get(view.proof)!;checkCapture(await this.o.store.readState(),p.capture,key);
  const incoming=await this.o.store.legacyChoiceEntry(key);if(incoming.entry.route!=='pendingChoice')throw Error('choice_stale');p.local=await this.legacyOverlay(p.local,incoming.entry);p.legacyKey=key;p.legacyHash=digest(incoming);
  let can=false;try{p.legacyMerge=await this.o.store.equivalentLegacy().planLegacyMerge(key);can=true;}catch(error){if((error as Error).message!=='merge_not_safe')throw error;}
  return {...view,canMerge:can,reason:can?null:'missing_base',inboxKey:key};
 }
 private async legacyOverlay(rows:RecordRow[],entry:any){
  const body=JSON.parse(entry.body),removed=entry.removedEntityKeys??[],keys=entry.entityKeys;if(!body||Object.getPrototypeOf(body)!==Object.prototype||!Array.isArray(removed)||!Array.isArray(keys)||new Set(keys).size!==keys.length||canonical([...new Set([...Object.keys(body),...removed])].sort())!==canonical([...keys].sort())||removed.some((id:string)=>Object.hasOwn(body,id)))throw Error('invalid_schema');
  const out=new Map(rows.map(r=>[r.entityKey,r]));for(const [id,raw]of Object.entries(body) as [string,any][]){
   const known=out.get(id),identity=known?{kind:known.candidate.meta.kind,logicalId:known.candidate.meta.logicalId}:entry.identitiesByEntity?.[id]??await this.o.store.identityForEntity(id);
   const {identity:logicalId,...value}=raw;if(logicalId!==identity.logicalId)throw Error('identity_conflict');this.o.store.validateEntityIdentity(id,identity.kind,identity.logicalId);const candidate=candidates(identity.kind,identity.logicalId,id,value,known?.candidate.meta.addedAtSource==='original'?known.candidate.addedAtMillis:undefined,this.o.store.segmentOptions());
   // Unknown body closures are preserved, never treated as an empty body.
   if(['article','book','asset'].includes(identity.kind)&&!entry.bodyRefsByEntity?.[id]?.length)throw Error('closure_incomplete');
   out.set(id,{entityKey:id,rowSequence:known?.rowSequence??'1',candidate,manifest:known?.manifest});
  }for(const id of removed)out.delete(id);return [...out.values()];
 }
 private records(rows:RecordRow[]):SourceRecord[]{return rows.map(r=>({kind:r.candidate.meta.kind,logicalId:r.candidate.meta.logicalId,value:fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload),...(r.candidate.meta.addedAtSource==='original'?{addedAtMillis:r.candidate.addedAtMillis}:{})}));}
 private async request(path:string,body:any){let known;try{known=await this.o.http.requestResult(body.requestId);}catch(error){throw new PublicationLookupUnavailable(error);}if(known.status==='succeeded')return known.response;if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');return this.o.http.json('POST',path,body);}
 async chooseCloud(proof:object,requestId:string,choiceId=requestId){
  await this.gate('choice');hexId(requestId,32);hexId(choiceId,32);const {p,s}=await this.checked(proof);if(s.pendingChoice!.inboxKeys.length&&!p.legacyKey)throw Error('legacy_choice_required');if(s.cloud?.pendingPublish||s.cloud?.pendingCloudChoice)throw Error('publication_pending');
  const next=clone(s);next.cloud={...next.cloud,pendingCloudChoice:{requestId,choiceId,...(p.legacyKey?{legacyKey:p.legacyKey,legacyHash:p.legacyHash}:{}),accountOid:p.capture.accountOid,accountRevision:p.capture.accountRevision,generation:p.capture.generation,localChangeRevision:p.capture.localChangeRevision,guardVersion:nextD64(s.stateVersion)}};
  await this.o.store.controlUpdate(s,next);await this.closePreview(proof);return this.resumeCloudChoice();
 }
 /** The request ID and capture fence survive process loss before/after audit.
  * A journal authorizes only its original window; it never captures new edits. */
 /** Reopening already retired stale cloud audit intents. Product automatic
  * resumption must leave that same escape path available without applying one.
  * Preserve the original result and do not invalidate a newer signed journal. */
 async retireStaleCloudChoice(){
  const before=await this.o.store.readState(),intent=before.cloud?.pendingCloudChoice;if(!intent||!this.o.choiceApply||before.cloud?.p5Gates?.choice_apply===false)return false;
  try{checkCapture(before,this.cloudChoiceCapture(intent));return false;}catch(error){if((error as Error).message!=='choice_stale')throw error;}
  const next=clone(before);next.cloud.pendingCloudChoice=null;next.cloud.retiredCloudChoices={...next.cloud.retiredCloudChoices,[intent.requestId]:intent};
  await this.o.store.choiceUpdate(before,next);return true;
 }
 private cloudChoiceCapture(intent:any):Capture{return Object.freeze({stateVersion:intent.guardVersion,accountOid:intent.accountOid,accountRevision:intent.accountRevision,generation:intent.generation,localChangeRevision:intent.localChangeRevision});}
 /** Accepted audit results survive a closed apply gate. This transaction only
  * records the original result; it never applies business rows or sends ACK. */
 private async acceptCloudChoice(requestId:string,reply:any){
  for(let attempt=0;;attempt++){
   const before=await this.o.store.readState(),intent=before.cloud?.pendingCloudChoice;if(intent?.requestId!==requestId)throw Error('choice_stale');
   if(intent.phase==='accepted'){if(canonical(intent.result)!==canonical(reply))throw Error('invalid_schema');return;}
   const next=clone(before);next.cloud.pendingCloudChoice={...intent,phase:'accepted',result:reply};
   try{await this.o.store.controlUpdate(before,next);return;}catch(error){if((error as Error).message!=='choice_stale'||attempt>=3)throw error;}
  }
 }
 async resumeCloudChoice(){
  await this.gate('choice');const s=await this.o.store.readState(),intent=s.cloud?.pendingCloudChoice;if(!intent){await this.flushApplied();return {applied:false,commit:null};}
  const capture=this.cloudChoiceCapture(intent);checkCapture(s,capture);
  const window=await this.o.http.negotiate([],[]),current=await this.o.store.readState();if(!choiceCurrent({...current,account:{oid:window.account.commitOid,revision:window.account.revision,generation:window.account.rollbackGeneration}},capture)){await this.o.reader.pull(window);throw Error('choice_stale');}
  const reply=intent.phase==='accepted'?intent.result:await this.request('/choices/cloud',{scope:this.o.http.scope,requestId:intent.requestId,choiceId:intent.choiceId,expectedAccountRevision:capture.accountRevision,expectedRollbackGeneration:capture.generation,selectedLocalChangeRevision:capture.localChangeRevision});
  if(reply.choiceId!==intent.choiceId||canonical(reply.confirmedAccount)!==canonical({commitOid:capture.accountOid,revision:capture.accountRevision,rollbackGeneration:capture.generation})||canonical(reply.account)!==canonical(reply.confirmedAccount))throw Error('choice_stale');
  await this.acceptCloudChoice(intent.requestId,reply);
  for(let attempt=0;;attempt++){
   const before=await this.o.store.readState();
   try{return await this.applyAcceptedCloudChoice();}catch(error){
    const after=await this.o.store.readState();if((error as Error).message!=='choice_stale'||attempt>=3||canonical(before)===canonical(after)||!choiceCurrent(after,capture))throw error;
   }
  }
 }
 private async applyAcceptedCloudChoice(){
  await this.gate('choice');const s=await this.o.store.readStableState(),intent=s.cloud?.pendingCloudChoice;if(intent?.phase!=='accepted')throw Error('choice_stale');
  const capture=this.cloudChoiceCapture(intent);checkCapture(s,capture);
  checkCapture(await this.o.store.readState(),capture);let localRows=await this.local(),cloudRows=await this.cloud(s),applyRows=cloudRows,capturedKeys:string[]|undefined,decision:Awaited<ReturnType<WatchProjectionStore['prepareLegacyDecision']>>|undefined;
  if(intent.legacyKey){const incoming=await this.o.store.legacyChoiceEntry(intent.legacyKey);if(digest(incoming)!==intent.legacyHash)throw Error('choice_stale');localRows=await this.legacyOverlay(localRows,incoming.entry);capturedKeys=incoming.entry.entityKeys;const map=new Map((await this.local()).map(r=>[r.entityKey,r]));for(const id of capturedKeys!){const cloud=cloudRows.find(r=>r.entityKey===id);if(cloud)map.set(id,cloud);else map.delete(id);}applyRows=await this.local();decision=await this.o.store.prepareLegacyDecision(s,intent.legacyKey,'discarded-for-cloud');}
  const records=this.records(applyRows),business=decision?[]:await this.o.business.prepare(records,s),next=decision?decision.next:this.applied(s,capture.accountOid,capture.accountRevision,capture.generation,intent.requestId);next.cloud.pendingCloudChoice=null;
  const statements=decision?decision.statements:await this.o.store.prepareAccountProjection(s,records,business),release=await this.reserveProjection(statements);
  try{
   const local:Record<string,RecoveryValue>={},cloud:Record<string,RecoveryValue>={};for(const r of localRows){const legacy=intent.legacyKey?(await this.o.store.legacyChoiceEntry(intent.legacyKey)).entry:null;const c=cloudRows.find(x=>x.entityKey===r.entityKey),value=fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload);local[r.entityKey]=c&&canonical(toWire(r.candidate.meta.kind,value))===canonical({meta:c.candidate.meta.payload,state:c.candidate.state.payload})?{kind:r.candidate.meta.kind,value,bodyRefs:[]}:legacy&&capturedKeys?.includes(r.entityKey)?{kind:r.candidate.meta.kind,value,bodyRefs:legacy.bodyRefsByEntity?.[r.entityKey]??[]}:await this.o.business.recoveryValue(r.entityKey);}for(const r of cloudRows)cloud[r.entityKey]={kind:r.candidate.meta.kind,value:fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload),bodyRefs:[]};
   checkCapture(await this.o.store.readStableState(),capture);await this.o.recovery.applyCloud({capture,local,cloud,...(capturedKeys?{capturedKeys}:{}),explicitCloudChoice:true,next,statements});
  }finally{await release();}
  if(!intent.legacyKey)await this.flushApplied();await this.o.store.dropInactiveCloudRows(s.cloud.current.treeRoot);return {applied:!intent.legacyKey,commit:null,...(intent.legacyKey?{discarded:true}: {})};
 }

 private applied(s:SyncState,commitOid:string,revision:string,generation:string,requestId:string){
  const next=clone(s);next.pendingChoice=s.pendingChoice?.inboxKeys.length?s.pendingChoice:null;next.activeGeneration=commitOid;next.hasUnsentEdits=false;next.acknowledgedLocalChangeRevision=s.localChangeRevision;next.editBase={accountOid:commitOid,generation};next.cloud={...next.cloud,editBases:{},editCreates:[],pendingApplied:{requestId:digest(['applied',requestId,commitOid,revision]).slice(0,32),commitOid,refRevision:revision,rollbackGeneration:generation}};return next;
 }
 async chooseLocal(proof:object,requestId:string){return this.choose(proof,requestId,false);}
 async chooseMerge(proof:object,requestId:string){return this.choose(proof,requestId,true);}
 private async choose(proof:object,requestId:string,merge:boolean){
  await this.gate('choice');const {p,s}=await this.checked(proof);if(s.cloud?.pendingPublish||s.cloud?.pendingCloudChoice)throw Error('publication_pending');if(s.pendingChoice!.inboxKeys.length&&!p.legacyKey)throw Error('legacy_choice_required');if(merge&&p.legacyKey){if(!p.legacyMerge)throw Object.assign(Error('merge_unavailable'),{reason:'missing_base'});const result=await this.o.store.equivalentLegacy().resolveLegacyMerge(p.legacyKey,p.legacyMerge);await this.closePreview(proof);return result;}let rows=p.local;
  if(merge){if(!p.merge.canMerge)throw Object.assign(Error('merge_unavailable'),{reason:p.merge.reason});const checked=this.merge(s,p.local,p.cloud,await this.o.store.editBases(s));if(!checked.canMerge||canonical(checked)!==canonical(p.merge))throw Object.assign(Error('merge_unavailable'),{reason:checked.reason??'missing_base'});
   rows=p.mergedRows!;if(!rows)throw Error('merge_unavailable');
  }
  for(const r of rows)if(['article','book','asset'].includes(r.candidate.meta.kind)&&!r.manifest?.recipeOid)throw Error('closure_incomplete');
  const author=await this.o.author(),window=await this.o.http.negotiate([],[]);for(const r of rows)await this.o.business.verifyBody({entityKey:r.entityKey,...r.manifest,bodyRevision:r.manifest?.bodyRevision??null},window.windowId);await this.checked(proof);const preflight=merge&&p.applyPlan?{plan:p.applyPlan,release:async()=>{}}:await this.prepareApply(s,rows);try{await this.o.publisher.prepareExplicit({kind:merge?'resolve-merge':'resolve-local',expected:s,...author,requestId,records:rows,applyPlan:preflight.plan,...(p.legacyKey?{legacyKey:p.legacyKey}:{})});const result=await this.resumePublication();await this.closePreview(proof);return result;}finally{if(!await this.o.store.planOwned(preflight.plan.id))await preflight.release();}
 }
 async rollback(targetCommitOid:string,capture:Capture,requestId:string){
  await this.recoverPreparation();await this.gate('history');hexId(requestId,32);oid(targetCommitOid,'commit');const before=await this.o.store.readState();this.checkWindow(before,capture);if(before.hasUnsentEdits||before.pendingChoice)throw Error('choice_pending');
  const lease=await this.request('/history/prepare',{scope:this.o.http.scope,requestId:digest(['history-prepare',requestId,targetCommitOid]).slice(0,32),targetCommitOid,expectedAccountRevision:capture.accountRevision,expectedRollbackGeneration:capture.generation});
  if(lease.targetCommitOid!==targetCommitOid)throw Error('invalid_schema');oid(lease.treeRoot,'tree');hexId(lease.leaseId,32);uint(lease.expiresAtMillis);if(lease.expiresAtMillis<=this.now())throw Error('snapshot_expired');
  const signed=parseNetwork(await this.o.http.object(targetCommitOid)),binding=await this.o.approved(signed.body.authorDeviceId),target=await verifyCommit(this.o.crypto,binding.publicKey,signed,targetCommitOid,this.o.http.scope);if(target.treeRoot!==lease.treeRoot)throw Error('hash_mismatch');if(target.requiredFeatures.some((f:string)=>f!=='note-conflicts.v1'))throw Error('unsupported_feature');
  const window=await this.o.http.negotiate([],[]),decoded=await this.o.reader.snapshot(target.treeRoot,window.windowId);if(decoded.some(r=>r.unopenable))throw Error('storage_pressure');for(const r of decoded)await this.o.business.verifyBody(r.row,window.windowId);
  const records=decoded.map(r=>({entityKey:r.row.entityKey,rowSequence:r.row.rowSequence,row:r.row,manifest:this.manifest(r.row),candidate:{meta:r.meta,state:r.state,addedAtMillis:r.row.addedAtMillis}})),preflight=await this.prepareApply(before,records);try{const author=await this.o.author();this.checkWindow(await this.o.store.readState(),capture);if(this.now()>=lease.expiresAtMillis)throw Error('snapshot_expired');
  await this.o.publisher.prepareExplicit({kind:'rollback',expected:before,...author,requestId,records,applyPlan:preflight.plan,target:{oid:targetCommitOid,treeRoot:target.treeRoot}});return await this.resumePublication();}finally{if(!await this.o.store.planOwned(preflight.plan.id))await preflight.release();}
 }
 async captureAccount(){await this.recoverPreparation();const s=await this.o.store.readState(),a=currentAccount(s);return Object.freeze({stateVersion:s.stateVersion,accountOid:a.oid,accountRevision:a.revision,generation:a.generation,localChangeRevision:s.localChangeRevision});}
 private checkWindow(s:SyncState,c:Capture){checkChoiceWindow(s,c);}
 /** Only the unsent preparation marker can be retired without a result query. */
 async recoverPreparation(){if((await this.o.store.readState()).cloud?.preparingPublication)await this.o.publisher.detachPublication();}
 async cancelPublication(){return this.o.publisher.detachPublication(true);}
 async reconcilePublications(){return this.o.publisher.reconcileDetached();}
 async resumePublication(){
  const initial=await this.o.store.readState(),original=initial.cloud?.pendingPublish;if(initial.cloud?.preparingPublication){await this.o.publisher.detachPublication();throw Error('choice_stale');}if(!original?.explicit)throw Error('publication_missing');await this.gate(original.kind==='rollback'?'history':'choice');
  try{await this.o.publisher.flush();}catch(error){if((error as Error).message==='choice_stale'&&!this.o.preserveStalePublication)await this.o.publisher.detachPublication();throw error;}let before=await this.o.store.readStableState(),plan=before.cloud?.pendingPublish;if(plan?.phase!=='confirmed')throw Error('choice_stale');
  // Every success must authenticate the current head, even if this device
  // previously observed the accepted head. A newer
  // head or real edit still fences this original apply journal.
  await this.o.reader.pull(await this.o.http.negotiate([],[]));await this.gate(plan.kind==='rollback'?'history':'choice');before=await this.o.store.readStableState();plan=before.cloud?.pendingPublish;if(plan?.phase!=='confirmed')throw Error('choice_stale');
  // An authenticated read may have observed this very publication while its
  // result lookup was unavailable. It cannot invalidate unchanged local edits.
  if(!publicationCurrent(before,plan)){await this.o.reader.pull(await this.o.http.negotiate([],[]));const latest=await this.o.store.readState();if(latest.cloud?.pendingPublish?.requestId===plan.requestId){await this.o.publisher.detachPublication(true);}throw Error('choice_stale');}
  const result=plan.result,rows:any[]=[];let after='';for(;;){const page=await this.o.store.cloudRows(plan.treeRoot,after,32);if(!page.length)break;rows.push(...page);after=page.at(-1).row.entityKey;}if(rows.length!==plan.rowCount)throw Error('closure_incomplete');
  const selected:RecordRow[]=[];for(const r of rows){const row=await this.openable(r);if(row)selected.push(row);}const records=this.records(selected),statements=plan.applyPlan?await this.o.store.resumeAccountProjection(before,plan.applyPlan):await this.o.store.prepareAccountProjection(before,records,await this.o.business.prepare(records,before)),next=observeAccount(before,{oid:plan.commitOid,revision:result.account.revision,generation:result.account.rollbackGeneration}),applied=this.applied(next,plan.commitOid,result.account.revision,result.account.rollbackGeneration,plan.requestId);
  applied.cloud={...applied.cloud,pendingPublish:null,current:{commitOid:plan.commitOid,treeRoot:plan.treeRoot,rowCount:plan.rowCount},lastPublication:{commitOid:plan.commitOid,localRevision:plan.capturedLocalRevision,result},pins:{...before.cloud.pins,accountOid:plan.commitOid,authors:{...before.cloud.pins.authors,[plan.commit.body.authorDeviceId]:{...await this.o.approved(plan.commit.body.authorDeviceId),sequence:plan.commit.body.deviceSequence,oid:plan.commitOid}}}};
  if(plan.legacyKey){const decision=await this.o.store.prepareLegacyDecision(before,plan.legacyKey,'resolve-local');applied.pendingChoice=decision.next.pendingChoice?.inboxKeys.length?decision.next.pendingChoice:null;applied.applied=decision.next.applied;statements.push(...decision.statements);}
  statements.push(...await this.o.store.preparePublicationFinish(plan));const persistent=plan.applyPlan?await this.o.store.existingPlanReservation(plan.applyPlan):null,release=persistent??await this.reserveProjection(statements);try{await this.o.store.observationUpdate(before,applied,statements);}finally{if(!plan.applyPlan||!await this.o.store.planOwned(plan.applyPlan.id))await release();}
  await this.flushApplied();await this.o.store.dropInactiveCloudRows(plan.treeRoot);return result;
 }
 /** A clean device follows the authenticated current account. A dirty device
  * retains its native DB and pending choice, including after event expiry. */
 async follow(window?:any){
  const pulled=await this.o.reader.pull(window??await this.o.http.negotiate([],[]));if(pulled.readOnly)return pulled;return this.followCurrent();
 }
 async poll(){const pulled=await this.o.reader.poll();if(pulled.readOnly)return pulled;return this.followCurrent();}
 private async followCurrent():Promise<any>{
  const before=await this.o.store.readState();if(before.pendingChoice||before.hasUnsentEdits)return {awaitingUser:!!before.pendingChoice,localEditsRetained:true};
  if(!this.o.choiceApply||before.cloud?.p5Gates?.choice_apply===false)return {applyDisabled:true};if(before.cloud?.pendingPublish)throw Error('publication_pending');if(before.cloud?.pendingApplied){const reply=await this.flushApplied();return reply?.signingUnavailable?reply:this.followCurrent();}
  if(!before.account||before.activeGeneration===before.account.oid)return {applied:false};const statements=await this.followStatements(before),requestId=digest(['follow',before.account]).slice(0,32),next=this.applied(before,before.account.oid,before.account.revision,before.account.generation,requestId),release=await this.reserveProjection(statements);
  try{await this.o.store.choiceUpdate(before,next,statements);}finally{await release();}await this.flushApplied();return {applied:true};
 }
 /** R4: follow reads the current tree one entity (or one bounded page) at a
  * time for every pass; the peak is one long note, whatever the row count. */
 private async followStatements(before:SyncState){
  if(!this.o.business.prepareFeed){const records=this.records(await this.cloud(before));return this.o.store.prepareAccountProjection(before,records,await this.o.business.prepare(records,before));}
  const feed=await this.cloudFeed(before);return this.o.store.prepareAccountProjection(before,feed,this.o.business.prepareFeed(feed,before));
 }
 private async cloudFeed(s:SyncState):Promise<RecordFeed>{
  if(!s.account||s.cloud?.current?.commitOid!==s.account.oid)throw Error('choice_stale');const root=s.cloud.current.treeRoot,keys:string[]=[],facts:RecordFact[]=[],input=this.o.store.inputHasher();let after='';
  // One decoding pass yields the keys, the small facts and the input digest.
  for(;;){const page=await this.o.store.cloudRows(root,after,32,PAGE_BYTES);if(!page.length)break;for(const r of page){const row=await this.openable(r);if(!row)continue;const [record]=this.records([row]);keys.push(r.row.entityKey);facts.push(recordFact(record!));input.add(record!);}after=page.at(-1)!.row.entityKey;}
  return {keys,facts,inputHash:input.finish(),read:async(from,limit)=>{const out:SourceRecord[]=[];let size=0;
   for(let i=from;i<Math.min(keys.length,from+limit);i++){const r=await this.o.store.cloudRow(root,keys[i]!);const row=r?await this.openable(r):null;if(!row)throw Error('choice_stale');const n=r.segments?PAGE_BYTES:JSON.stringify(r.state).length;if(out.length&&size+n>PAGE_BYTES)break;out.push(...this.records([row]));size+=n;}
   return out;}};
 }
 /** Durable post-commit ACK. Failure retries the same request and never reapplies. */
 async flushApplied(){const before=await this.o.store.readState(),ack=before.cloud?.pendingApplied;if(!ack)return null;let author;try{author=await this.o.author();}catch(error){if(error instanceof SigningStateUnavailable)return {signingUnavailable:true};throw error;}const reply=await this.request('/acks/applied',{scope:this.o.http.scope,...ack,deviceId:author.deviceId});if(reply.accepted!==true)throw Error('invalid_schema');const current=await this.o.store.readState();if(canonical(current.cloud?.pendingApplied)!==canonical(ack))throw Error('choice_stale');const next=clone(current);next.cloud.pendingApplied=null;await this.o.store.controlUpdate(current,next);return reply;}
}
