/** Instance-private rc6c equivalent-content capability. SQL owns persistence. */
import * as s from './notes-strict';
import {canonical,jsonBytes,entityKey as deriveEntityKey} from './protocol';
import {unhex,sha256Hex} from '@podjs/framework/crypto';
import {canMerge} from './merge-planner';
const c={canonical,jb:jsonBytes,canMerge};
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
const recoveryViews=(v:any)=>v;
/** A full canonical current-account observation is mandatory, including all known aliases. */
function currentAccount(state:any){
 try{
  const account=state.account;s.exact(account,['oid','revision','generation']);s.objectOid(account.oid,'commit');if(s.d64(account.revision)<1n)throw Error();s.d64(account.generation);s.d64(state.rollbackGeneration);s.d64(state.localChangeRevision);
  if(account.generation!==state.rollbackGeneration)throw Error();
  for(const [name,value]of [['lastSeenAccountOid',account.oid],['lastSeenAccountRevision',account.revision],['lastSeen',account.generation]])if(Object.hasOwn(state,name)&&state[name]!==value)throw Error();
  return account;
 }catch{throw Error('choice_stale');}
}
/** Refresh only the pending set. Previously issued snapshots are independent and never replaced. */
function refreshPending(next:any){
 const keys=Object.keys(next.legacyInbox).filter(key=>next.legacyInbox[key].route==='pendingChoice'&&!next.legacyInbox[key].applied),prior=next.pendingChoice;
 next.pendingChoice=keys.length?{generation:next.rollbackGeneration,inboxKeys:keys,...(prior&&Object.hasOwn(prior,'capture')?{capture:prior.capture}:{})}:null;
}
/** A cumulative business ACK may pass only the uninterrupted applied arrival prefix. */
function advanceApplied(next:any,peer:string){const queue=next.legacyQueues[peer]??[];let at=next.legacyAckIndex[peer]??0;while(at<queue.length&&next.legacyInbox[queue[at]].applied){next.applied[peer]=next.legacyInbox[queue[at]].cursor;at++;}next.legacyAckIndex[peer]=at;}
function freezeData<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeData(child);Object.freeze(value);}return value;}
const digest=(value:any)=>sha256Hex(jsonBytes(value));
export class LegacyEquivalentPlanner {
 state:any;
 #legacyMergePlans=new WeakMap<object,any>();
 constructor(saved:any={}){
  this.state={stateVersion:'0',revision:'0',identityMap:{},log:[],scan:{R0:'0',R1:null,page:0},legacyInbox:{},legacyQueues:{},legacyAckIndex:{},received:{},applied:{},pendingChoice:null,rows:{},...clone(saved)};
  // Upgrade the rc3 singleton choice without dropping any unresolved persisted input.
  for(const [key,entry]of Object.entries(this.state.legacyInbox) as any){const queue=this.state.legacyQueues[entry.peer]??=[];if(!queue.includes(key))queue.push(key);}refreshPending(this.state);
 }
 txn(fn:(next:any)=>any,hook?:()=>void){const next=clone(this.state),version=next.stateVersion,following=s.nextD64(version);const result=fn(next);if(hook)hook();if(this.state.stateVersion!==version)throw Error('choice_stale');next.stateVersion=following;this.state=next;return result;}
 mapPage(rows:any[],idKey:string,repoId:string,libraryId:string,nextPage:number,hook?:()=>void){return this.txn(next=>{for(const row of rows){const key=c.canonical([libraryId,repoId,row.kind,row.logicalId]);const entityKey=deriveEntityKey(unhex(idKey),repoId,row.kind,row.logicalId);if(next.identityMap[key]&&next.identityMap[key].entityKey!==entityKey)throw Error('identity_conflict');if(!next.identityMap[key]){next.identityMap[key]={entityKey,mappingVersion:2};next.log.push({revision:next.revision,entityKey});}}next.scan.page=nextPage;},hook);}
 finishScan(R1:string,hook?:()=>void){return this.txn(next=>{s.d64(R1);if(s.d64(R1)<s.d64(next.scan.R0))throw Error('invalid_schema');next.scan.R1=R1;},hook);}
 receiveLegacy(input:any,affected:string[]|null,cloudEnabled=true,hook?:()=>void){
  const removed=input.removedEntityKeys??[],bodyRefsByEntity=input.bodyRefsByEntity??{},captured=[...new Set([...Object.keys(input.body),...removed])].sort();
  if(!Array.isArray(removed)||!Array.isArray(input.entityKeys)||c.canonical([...new Set(input.entityKeys)].sort())!==c.canonical(captured)||removed.some((id:string)=>Object.hasOwn(input.body,id)))throw Error('invalid_schema');
  const intent={body:input.body,entityKeys:captured,removedEntityKeys:removed,bodyRefsByEntity},hash=digest(intent),key=input.peer+':'+input.version+':'+input.cursor;
  return this.txn(next=>{
   const prior=next.legacyInbox[key];if(prior){if(prior.hash!==hash)throw Error('idempotency_conflict');return {route:prior.route,applied:prior.applied};}
   const route=cloudEnabled&&next.rollbackKnown&&(affected===null||captured.some(k=>affected.includes(k)))?'pendingChoice':'normal';
   next.legacyInbox[key]={hash,...clone(intent),peer:input.peer,cursor:input.cursor,route,applied:false};const queue=next.legacyQueues[input.peer]??=[];queue.push(key);next.received[input.peer]=input.cursor;
   if(route==='pendingChoice'){refreshPending(next);return {route,applied:false};}
   next.rows={...next.rows,...clone(input.body)};for(const id of removed)delete next.rows[id];next.legacyInbox[key].applied=true;advanceApplied(next,input.peer);return {route:cloudEnabled?'normal':'legacy-only',applied:true};
  },hook);
 }
 /** The no-ancestor legacy adapter supports only equivalent business contents.
  * Current conflict facts may be retained, never imported from an unknown era.
  * All other branches stay closed until a trusted full three-way port exists.
  */
 private legacyMergeInput(key:string){
  const state=this.state,account=currentAccount(state),entry=state.legacyInbox[key];
  if(!entry||entry.applied||entry.route!=='pendingChoice'||!state.pendingChoice?.inboxKeys.includes(key))throw Error('merge_not_safe');
  if(!entry.body||Object.getPrototypeOf(entry.body)!==Object.prototype||digest({body:entry.body,entityKeys:entry.entityKeys,removedEntityKeys:entry.removedEntityKeys??[],bodyRefsByEntity:entry.bodyRefsByEntity??{}})!==entry.hash)throw Error('merge_not_safe');
  let supported=true;
  try{s.exact(state.editBase,['accountOid','generation']);s.objectOid(state.editBase.accountOid,'commit');s.d64(state.editBase.generation);}catch{throw Error('merge_not_safe');}
  if(state.editBase.generation!==account.generation||(entry.removedEntityKeys??[]).length)supported=false;
  const plain=(row:any)=>{if(!row||Object.getPrototypeOf(row)!==Object.prototype)throw Error('merge_not_safe');const copy={...row};delete copy.noteConflicts;return copy;};
  const local=clone(state.rows),cloud=clone(state.rows);
  for(const [id,incoming]of Object.entries(entry.body??{}) as any){
   if(!incoming||Object.getPrototypeOf(incoming)!==Object.prototype){supported=false;cloud[id]=clone(incoming);continue;}
   if(!Object.hasOwn(local,id)||c.canonical(plain(local[id]))!==c.canonical(plain(incoming)))supported=false;
   if(Object.hasOwn(incoming,'noteConflicts')){
    // Legacy traffic has no authenticated generation for nonempty incident sets.
    if(!Object.hasOwn(local[id]??{},'noteConflicts')||!incoming.noteConflicts||!Array.isArray(incoming.noteConflicts.records)||incoming.noteConflicts.records.length)supported=false;
   }
   cloud[id]=clone(incoming);
  }
  return {base:clone(local),local,cloud,ops:[],noteConflictGenerations:{base:account.generation,local:account.generation,cloud:account.generation},unsupported:!supported};
 }
 /** A plan is an opaque, instance-owned immutable handle, never a persisted flag. */
 planLegacyMerge(key:string){
  const account=currentAccount(this.state),capture=this.captureLegacyChoice(account);this.checkCloudChoice(capture,key);
  const input=this.legacyMergeInput(key),plan=c.canMerge(input);
  if(!plan.canMerge||c.canonical(plan.tree)!==c.canonical(input.local))throw Error('merge_not_safe');
  const sourceHash=digest(this.state),snapshotsHash=digest(input),candidateHash=digest(plan.tree);
  const proof=Object.freeze({kind:'legacy-merge.v1',inboxKey:key,capture,sourceHash,snapshotsHash,candidateHash});
  this.#legacyMergePlans.set(proof,freezeData({key,capture,sourceHash,input:clone(input),candidate:clone(plan.tree),snapshotsHash,candidateHash}));return proof;
 }
 private checkLegacyMergePlan(key:string,proof:any){
  const record=proof&&typeof proof==='object'?this.#legacyMergePlans.get(proof):undefined;if(!record||record.key!==key)throw Error('choice_stale');
  this.checkCloudChoice(record.capture,key);
  if(digest(this.state)!==record.sourceHash||digest(this.legacyMergeInput(key))!==record.snapshotsHash)throw Error('choice_stale');
  const checked=c.canMerge(record.input);if(!checked.canMerge||digest(checked.tree)!==record.candidateHash||digest(record.candidate)!==record.candidateHash)throw Error('merge_not_safe');return record;
 }
 resolveLegacyMerge(key:string,proof:any,hook?:()=>void){
  const plan=this.checkLegacyMergePlan(key,proof);
  const result=this.txn(next=>{next.rows=clone(plan.candidate);const entry=next.legacyInbox[key];entry.applied=true;entry.route='resolve-merge';advanceApplied(next,entry.peer);refreshPending(next);return {operation:entry.route,applied:true};},()=>{if(hook)hook();this.checkLegacyMergePlan(key,proof);});
  this.#legacyMergePlans.delete(proof);return result;
 }
 resolveLegacy(key:string,choice:string,hook?:()=>void){if(choice!=='merge')throw Error('feature_disabled');return this.resolveLegacyMerge(key,this.planLegacyMerge(key),hook);}
 captureLegacyChoice(window:any){
  currentAccount(this.state);
  const capture=Object.freeze({stateVersion:this.state.stateVersion,accountOid:window?.oid,accountRevision:window?.revision,generation:window?.generation,localChangeRevision:this.state.localChangeRevision});this.checkCloudChoice(capture);return capture;
 }
 checkCloudChoice(capture:any,key?:string){
  const state=this.state,account=currentAccount(state),p=state.pendingChoice;
  try{
   s.capture(capture);
  }catch{throw Error('choice_stale');}
  if(!p||capture.stateVersion!==state.stateVersion||capture.localChangeRevision!==state.localChangeRevision||capture.generation!==account.generation||capture.generation!==p.generation||capture.accountOid!==account.oid||capture.accountRevision!==account.revision||(key!==undefined&&(!p.inboxKeys.includes(key)||state.legacyInbox[key]?.route!=='pendingChoice')))throw Error('choice_stale');
 }
}
