/** T-SYNCV2-UI section 1 adapter: a read-only SyncV2UiState snapshot plus a
 * change notification, built over the watchSyncV2 runtime and WatchAccountControl.
 * No UI components, no copy changes and no protocol extensions. Field names and
 * meanings are frozen by the tri-platform contract; body text, OIDs and keys never
 * enter the snapshot, the preview or any log. */
import {canonical,compareD64} from './protocol';
import {conflictNeutral} from './notes-conflict';
import {SyncV2Error} from './http';
import type {SyncState,Capture} from './state';
import type {WatchAccountControl} from './account-control';
/** One ChoicePreview side never exceeds this many rows; the rest is `more`. */
const PREVIEW_SIDE_LIMIT=50;
export type SyncV2UiStatePhase='idle'|'syncing'|'awaiting_choice'|'blocked'|'error';
export interface SyncV2UiState {
 enabled:boolean;
 phase:SyncV2UiStatePhase;
 lastSyncedAtMillis:number|null;
 errorCode:string|null;
 choice:null|{
  localChanges:number;
  cloudChanges:number;
  canMerge:boolean;
  mergeUnavailableReason:string|null;
  kind:'rollback'|'concurrent';
 };
 unopenableNotes:{noteId:string;title:string|null}[];
 recoveryCopies:{copyId:string;createdAtMillis:number;expiresAtMillis:number}[];
 keepDiscardedLocalChanges7Days:boolean;
 gates:{historyRestore:boolean;choiceApply:boolean;noteSegments:boolean};
 publication:null|{state:'pending'|'detached';since:number};
}
export interface ChoicePreview {
 local:{title:string|null;kind:'add'|'edit'|'delete'}[];
 cloud:{title:string|null;kind:'add'|'edit'|'delete'}[];
 /** Rows beyond PREVIEW_SIDE_LIMIT on each side, for the UI's "还有 N 项". */
 more:{local:number;cloud:number};
 canMerge:boolean;
 reason:string|null;
}
/** The object returned by `watchSyncV2(...).open()` (null when the feature is
 * closed). Only pull is consumed here; the rest stays runtime-private. */
export interface SyncV2RuntimeHandle {pull():Promise<unknown>;publish():Promise<unknown>}
/** The read-only slice of WatchProjectionStore this adapter needs. Passing the
 * real store keeps the existing APIs as the single source of truth. */
export interface SyncV2StateReader {
 readState():Promise<SyncState>;
 candidatePage(after?:string,limit?:number,maxBytes?:number):Promise<{entityKey:string;candidate:{meta:{kind:string;logicalId:string;payload:Record<string,any>};state:{payload:Record<string,any>}}}[]>;
 cloudRows(root:string,after?:string,limit?:number,maxBytes?:number):Promise<{row:{entityKey:string;deleted?:boolean};meta:{logicalId?:string;payload:Record<string,any>};state:{payload:Record<string,any>};unopenable?:{code:string}}[]>;
 editBases(state:SyncState):Promise<Record<string,any>>;
 readCandidate(entityKey:string):Promise<{meta:{kind:string;logicalId:string;payload:Record<string,any>};state:{payload:Record<string,any>}}|null>;
 segmentOptions():{noteSegments:boolean};
}
export interface SyncV2UiStateOptions {
 /** The opened runtime, or null when Sync v2 is not open on this device. */
 runtime:SyncV2RuntimeHandle|null;
 /** The WatchAccountControl created through runtime.accountControl(...). */
 control:WatchAccountControl|null;
 projection:SyncV2StateReader;
 /** Trusted server UTC, same contract as AccountControlOptions.trustedNow. */
 trustedNow?:()=>number|null;
 /** Test seam for the idempotency IDs the choose/rollback actions mint. */
 requestId?:()=>string;
}
/** A change set row reduced to exactly what the UI contract may ever show. */
interface SideRow {entityKey:string;title:string|null;kind:'add'|'edit'|'delete'}
/** Full model kept only inside collectSides for the three-way comparison. */
interface RowModel {entityKey:string;model:Record<string,any>;deleted:boolean}
const randomRequestId=()=>typeof globalThis.crypto?.randomUUID==='function'?globalThis.crypto.randomUUID().replace(/-/g,''):Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join('');
const codeOf=(error:unknown)=>error instanceof SyncV2Error?error.code:String((error as Error)?.message??error);
const titleOf=(model:Record<string,any>)=>{for(const key of ['title','name','originalFilename']){const v=model[key];if(typeof v==='string'&&v.length)return v;}return null;};
/** The planner compares note models with the empty conflict container
 * neutralized, exactly like the reader's stale-edit diff. */
const modelOf=(meta:{logicalId?:string;payload:Record<string,any>},state:{payload:Record<string,any>})=>({identity:meta.logicalId,...meta.payload,...conflictNeutral(state).payload});
/** Canonical plain-data clone: guarantees the snapshot/preview holds no class
 * instances, no handle objects and no non-contract fields. */
function cleanSnapshot<T>(value:T):T{return JSON.parse(canonical(JSON.parse(JSON.stringify(value))));}
function capped(rows:SideRow[]){const head=rows.slice(0,PREVIEW_SIDE_LIMIT);return {rows:head.map(r=>({title:r.title,kind:r.kind})),more:rows.length-head.length};}
export class WatchSyncV2UiState {
 private listeners=new Set<()=>void>();
 private previews=new WeakMap<ChoicePreview,object>();
 /** The one open preview (the control keeps a single active preview). */
 private active?:{preview:ChoicePreview;proof:object};
 /** canMerge/reason cache keyed by the state fingerprint, so one snapshot does
  * not re-run the heavy pendingChoice preparation on every UI frame. */
 private mergeCache?:{fingerprint:string;canMerge:boolean;reason:string|null};
 private inflightSyncs=0;
 private lastErrorCode:string|null=null;
 private lastSyncedAtMillis:number|null=null;
 /** Publication identities carry no timestamp in the protocol; the trusted
  * clock is sampled once per distinct pending/detached identity. */
 private publicationSeen=new Map<string,number>();
 constructor(private readonly o:SyncV2UiStateOptions){}
 private get enabled(){return this.o.runtime!==null&&this.o.control!==null;}
 private notify(){for(const listener of[...this.listeners])try{listener();}catch{/* a listener failure never unwinds an action */}}
 private trusted(){return this.o.trustedNow?.()??null;}
 private newRequestId(){return this.o.requestId?.()??randomRequestId();}
 /** Runs one action: enforces enabled, records the protocol error code and
  * notifies subscribers. Failures rethrow the original error untouched. */
 private async action<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.enabled)throw Error('feature_disabled');
  try{const result=await work();this.lastErrorCode=null;return result;}
  catch(error){this.lastErrorCode=codeOf(error);throw error;}
  finally{this.notify();}
 }
 /** Contract §1: one successful pull+ack pass; the moment is the trusted time. */
 async syncNow(){return this.action(async()=>{
  this.inflightSyncs++;
  try{
   const pulled=await this.o.runtime!.pull();
   await this.o.control!.flushApplied();
   const now=this.trusted();if(now!==null)this.lastSyncedAtMillis=now;
   return pulled;
  }finally{this.inflightSyncs--;}
 });}
 async history(pageToken:string|null=null){return this.action(()=>this.o.control!.history(pageToken));}
 async restoreRecovery(copyId:string){return this.action(()=>this.o.control!.restoreRecovery(copyId));}
 async setKeepDiscarded(value:boolean){return this.action(()=>this.o.control!.setKeepDiscardedLocalChanges7Days(value));}
 async rollback(targetCommitOid:string,capture?:Capture){return this.action(async()=>{
  const c=capture??await this.o.control!.captureAccount();
  return this.o.control!.rollback(targetCommitOid,c,this.newRequestId());
 });}
 /** Opens the selection preview. The proof handle stays process-local (WeakMap),
  * so a copied/replayed preview object can never drive an apply. */
 async openChoice(){return this.action(async()=>{
  const state=await this.o.projection.readState();
  if(!state.pendingChoice)throw Error('choice_stale');
  const view=await this.o.control!.pendingChoice();
  if(!view)throw Error('choice_stale');
  const side=await this.collectSides(state);
  const local=capped(side.localChanges),cloud=capped(side.cloudChanges);
  const preview:ChoicePreview=cleanSnapshot({local:local.rows,cloud:cloud.rows,more:{local:local.more,cloud:cloud.more},canMerge:view.canMerge===true,reason:view.canMerge===true?null:view.reason??null});
  this.previews.set(preview,view.proof as object);
  this.active={preview,proof:view.proof as object};
  this.mergeCache={fingerprint:fingerprintOf(state),canMerge:preview.canMerge,reason:preview.reason};
  return preview;
 });}
 async chooseLocal(preview:ChoicePreview){return this.action(async()=>await this.o.control!.chooseLocal(this.proofFor(preview),this.newRequestId()));}
 async chooseCloud(preview:ChoicePreview,choiceId?:string){return this.action(async()=>await this.o.control!.chooseCloud(this.proofFor(preview),this.newRequestId(),choiceId));}
 async chooseMerge(preview:ChoicePreview){return this.action(async()=>await this.o.control!.chooseMerge(this.proofFor(preview),this.newRequestId()));}
 async closeChoice(preview:ChoicePreview){return this.action(async()=>{
  const proof=this.proofFor(preview);
  await this.o.control!.closePreview(proof);
 });}
 /** A preview the UI never received (or no longer owns) must fail closed. */
 private proofFor(preview:ChoicePreview):object{
  const proof=this.previews.get(preview);if(!proof)throw Error('choice_stale');
  this.previews.delete(preview);if(this.active?.preview===preview)delete this.active;
  return proof;
 }
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 /** The read-only tri-platform snapshot. Every field is sampled through the
  * existing store/control APIs; nothing is fabricated. */
 async snapshot():Promise<SyncV2UiState>{
  if(!this.enabled)return cleanSnapshot<SyncV2UiState>({enabled:false,phase:'idle',lastSyncedAtMillis:null,errorCode:null,choice:null,unopenableNotes:[],recoveryCopies:[],keepDiscardedLocalChanges7Days:false,gates:{historyRestore:false,choiceApply:false,noteSegments:false},publication:null});
  const projection=this.o.projection,control=this.o.control!;
  const state=await projection.readState();
  const settings=await control.settings();
  const gates={historyRestore:settings.history_restore===true,choiceApply:settings.choice_apply===true,noteSegments:projection.segmentOptions().noteSegments===true};
  const side=await this.collectSides(state);
  const unopenableNotes=await this.unopenable(state);
  const choice=state.pendingChoice?await this.choiceState(state,side):null;
  const recoveryCopies=(await control.recoveryCopies()).map(c=>({copyId:c.copyId,createdAtMillis:c.createdAtMillis,expiresAtMillis:c.expiresAtMillis}));
  const publication=this.publication(state);
  const phase:SyncV2UiStatePhase=this.inflightSyncs>0?'syncing':state.pendingChoice?'awaiting_choice':unopenableNotes.length||state.cloud?.blockedCommitOid||this.lastErrorCode==='storage_pressure'?'blocked':this.lastErrorCode?'error':'idle';
  return cleanSnapshot<SyncV2UiState>({enabled:true,phase,lastSyncedAtMillis:this.lastSyncedAtMillis,errorCode:this.lastErrorCode,choice,unopenableNotes,recoveryCopies,keepDiscardedLocalChanges7Days:state.keepDiscardedLocalChanges7Days===true,gates,publication});
 }
 /** canMerge/reason only exist where the planner can answer: the open preview,
  * its fingerprint cache, or one fresh pendingChoice() pass. */
 private async choiceState(state:SyncState,side:{localChanges:SideRow[];cloudChanges:SideRow[]}){
  const kind:'rollback'|'concurrent'=compareD64(state.rollbackGeneration,state.editBase.generation)>0?'rollback':'concurrent';
  if(this.active)return{localChanges:side.localChanges.length,cloudChanges:side.cloudChanges.length,canMerge:this.active.preview.canMerge,mergeUnavailableReason:this.active.preview.reason,kind};
  const fingerprint=fingerprintOf(state);
  let canMerge:boolean,reason:string|null;
  if(this.mergeCache&&this.mergeCache.fingerprint===fingerprint){canMerge=this.mergeCache.canMerge;reason=this.mergeCache.reason;}
  else{
   try{
    const view=await this.o.control!.pendingChoice();
    if(!view)throw Error('choice_stale');
    canMerge=view.canMerge===true;reason=canMerge?null:view.reason??null;
    // The snapshot only reads; the preparation reservation is released at once.
    await this.o.control!.closePreview(view.proof as object);
   }catch(error){canMerge=false;reason=codeOf(error)==='choice_stale'?'choice_stale':'projection_incomplete';}
   if(!this.active)this.mergeCache={fingerprint,canMerge,reason};
  }
  return {localChanges:side.localChanges.length,cloudChanges:side.cloudChanges.length,canMerge,mergeUnavailableReason:canMerge?null:reason,kind};
 }
 /** The two change sets in planner semantics: local candidates that differ
  * from the current authenticated cloud tree (or from the kept baseline when
  * the device never saw the entity), and cloud rows that differ from the kept
  * baseline (or from local when no baseline was kept). Per-entity quarantined
  * (F1/R2 unopenable) rows are excluded both ways like the reader's diff. */
 private async collectSides(state:SyncState){
  const {projection}=this.o;
  const localRows:RowModel[]=[];let after='';
  for(;;){const page=await projection.candidatePage(after,32);if(!page.length)break;
   for(const r of page)localRows.push({entityKey:r.entityKey,model:modelOf({logicalId:r.candidate.meta.logicalId,payload:r.candidate.meta.payload},r.candidate.state),deleted:r.candidate.state.payload.deleted===true});
   after=page.at(-1)!.entityKey;}
  const quarantine=Object.entries((state.cloud?.unopenableNotes??{}) as Record<string,{entityKey:string;deleted?:boolean}>);
  const quarantined=new Set(quarantine.filter(([,v])=>v.deleted!==true).map(([,v])=>v.entityKey));
  const cloudRows:RowModel[]=[];
  if(state.account&&state.cloud?.current?.commitOid===state.account.oid){
   let cursor='';for(;;){const page=await projection.cloudRows(state.cloud.current.treeRoot,cursor,32);if(!page.length)break;
    for(const r of page)if(!r.unopenable)cloudRows.push({entityKey:r.row.entityKey,model:modelOf({logicalId:r.meta.logicalId,payload:r.meta.payload},r.state),deleted:r.row.deleted===true||r.state.payload.deleted===true});
    cursor=page.at(-1)!.row.entityKey;}
  }
  const bases=await projection.editBases(state);
  const localBy=new Map(localRows.map(r=>[r.entityKey,r])),cloudBy=new Map(cloudRows.map(r=>[r.entityKey,r]));
  const localChanges:SideRow[]=localRows.filter(r=>!quarantined.has(r.entityKey)&&canonical(r.model)!==canonical(cloudBy.get(r.entityKey)?.model??bases[r.entityKey]??null))
   .map(r=>({entityKey:r.entityKey,title:titleOf(r.model),kind:!cloudBy.has(r.entityKey)&&bases[r.entityKey]===undefined?'add':r.deleted?'delete':'edit'}));
  const cloudChanges:SideRow[]=cloudRows.filter(r=>canonical(r.model)!==canonical(bases[r.entityKey]??localBy.get(r.entityKey)?.model??null))
   .map(r=>({entityKey:r.entityKey,title:titleOf(r.model),kind:bases[r.entityKey]===undefined&&localBy.get(r.entityKey)?.model===undefined?'add':r.deleted?'delete':'edit'}));
  return {localChanges,cloudChanges};
 }
 /** unopenableNotes: state.cloud.unopenableNotes; the title comes from the
  * locally kept prior version, null when this device never had the note. */
 private async unopenable(state:SyncState){
  const out:{noteId:string;title:string|null}[]=[];
  for(const [noteId,entry]of Object.entries(state.cloud?.unopenableNotes??{}) as [string,{entityKey:string;deleted?:boolean}][]){
   if(entry.deleted===true)continue;
   let title:string|null=null;
   try{const candidate=await this.o.projection.readCandidate(entry.entityKey);const value=candidate?.meta.payload.title;title=typeof value==='string'&&value.length?value:null;}catch{title=null;}
   out.push({noteId,title});
  }
  return out;
 }
 private publication(state:SyncState){
  const cloud=state.cloud;
  const pending=cloud?.pendingPublish??cloud?.preparingPublication;
  if(pending?.requestId)return {state:'pending' as const,since:this.seen('pending:'+String(pending.requestId))};
  const open=Object.entries(cloud?.detachedPublications??{}).filter(([,plan])=>(plan as {outcome?:string})?.outcome!=='succeeded').map(([id])=>id).sort();
  if(!open.length)return null;
  return {state:'detached' as const,since:this.seen('detached:'+open.join(','))};
 }
 private seen(key:string){let at=this.publicationSeen.get(key);if(at===undefined){at=this.trusted()??0;this.publicationSeen.set(key,at);}return at;}
}
/** pendingChoice carries account/revision fences; they must not leak anywhere,
 * so only these non-identifying fields key the canMerge cache. */
function fingerprintOf(state:SyncState){return [state.stateVersion,state.localChangeRevision,state.pendingChoice?.generation??'0',state.pendingChoice?.inboxKeys.length??0].join('|');}
/** A read-only adapter over the runtime + control pair. `watchSyncV2` keeps its
 * open() null-closed contract; when it is closed the snapshot is inert. */
export function watchSyncV2UiState(options:SyncV2UiStateOptions){return new WatchSyncV2UiState(options);}
