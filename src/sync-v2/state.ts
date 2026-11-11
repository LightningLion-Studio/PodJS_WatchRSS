import {frozenDataRecord} from '@podjs/framework/frozen-data';
import {checkD64,compareD64,nextD64} from '@podjs/framework/sql-projection';
import {exact,oid,canonical,digest} from './protocol';
export type Account={oid:string;revision:string;generation:string};
export type Capture=Readonly<{stateVersion:string;accountOid:string;accountRevision:string;generation:string;localChangeRevision:string}>;
export interface SyncState {
 recoveryEditPins?:import('./recovery').RecoveryEditPin[];
 recoveryCopies?:import('./recovery').RecoveryCopy[];recoveryPins?:import('./recovery').RecoveryPin[];recoveryClock?:number;
 cloud?:any;acknowledgedLocalChangeRevision?:string;
 /** Gate-only transactions advance SQL CAS, but not the choice fence. */
 choiceControlRevision?:string;
 stateVersion:string;localChangeRevision:string;rollbackGeneration:string;
 businessRevision?:import('./business-revision').BusinessRevision;
 account:Account|null;lastSeenAccountOid:string|null;lastSeenAccountRevision:string;lastSeen:string;
 editBase:{accountOid:string|null;generation:string};pendingChoice:null|{generation:string;inboxKeys:string[];accountOid?:string;accountRevision?:string;selectedLocalChangeRevision?:string};
 activeGeneration:string|null;applied:Record<string,string>;knownAuthors:Record<string,unknown>;knownAccountParents:Record<string,unknown>;
 keepDiscardedLocalChanges7Days:boolean;hasUnsentEdits:boolean;
}
export function initialState():SyncState {return {stateVersion:'0',localChangeRevision:'0',rollbackGeneration:'0',account:null,lastSeenAccountOid:null,lastSeenAccountRevision:'0',lastSeen:'0',editBase:{accountOid:null,generation:'0'},pendingChoice:null,activeGeneration:null,applied:{},knownAuthors:{},knownAccountParents:{},keepDiscardedLocalChanges7Days:true,hasUnsentEdits:false};}
/** Existing journals have no control offset and retain their original fence. */
export function choiceVersion(state:Pick<SyncState,'stateVersion'|'choiceControlRevision'>):string {
 const version=BigInt(checkD64(state.stateVersion)),control=BigInt(checkD64(state.choiceControlRevision??'0'));
 if(control>version)throw Error('choice_stale');return String(version-control);
}
/** Preview identity excludes gate configuration but retains every business field. */
export function choiceStateHash(state:SyncState):string {
 const next={...state,stateVersion:choiceVersion(state)};delete next.choiceControlRevision;
 if(next.cloud){next.cloud={...next.cloud};delete next.cloud.p5Gates;}return digest(next);
}
export function queuedReadOnly(state:SyncState):boolean {
 const plan=state.cloud?.pendingPublish;
 return !!plan?.explicit&&state.cloud?.p5Gates?.[plan.kind==='rollback'?'history_restore':'choice_apply']===false;
}
export function currentAccount(state:any):Account {
 try{exact(state.account,['oid','revision','generation']);oid(state.account.oid,'commit');if(checkD64(state.account.revision)==='0')throw Error();checkD64(state.account.generation);checkD64(state.rollbackGeneration);checkD64(state.localChangeRevision);checkD64(state.stateVersion);
  if(state.account.generation!==state.rollbackGeneration)throw Error();
  for(const [name,value]of [['lastSeenAccountOid',state.account.oid],['lastSeenAccountRevision',state.account.revision],['lastSeen',state.account.generation]])if(Object.hasOwn(state,name)&&state[name]!==value)throw Error();return state.account;
 }catch{throw Error('choice_stale');}
}
export function checkCapture(state:any,capture:any,key?:string){
 const account=currentAccount(state);
 try{frozenDataRecord(capture,['stateVersion','accountOid','accountRevision','generation','localChangeRevision']);for(const k of ['stateVersion','accountRevision','generation','localChangeRevision'])checkD64(capture[k]);oid(capture.accountOid,'commit');}catch{throw Error('choice_stale');}
 if(!state.pendingChoice||capture.stateVersion!==choiceVersion(state)||capture.localChangeRevision!==state.localChangeRevision||capture.accountOid!==account.oid||capture.accountRevision!==account.revision||capture.generation!==account.generation||capture.generation!==state.pendingChoice.generation||(key!==undefined&&!state.pendingChoice.inboxKeys.includes(key)))throw Error('choice_stale');
}
export function captureChoice(state:any,window:Account):Capture {
 currentAccount(state);const capture=Object.freeze({stateVersion:choiceVersion(state),accountOid:window.oid,accountRevision:window.revision,generation:window.generation,localChangeRevision:state.localChangeRevision});checkCapture(state,capture);return capture;
}
/** Only an authenticated/pinned account reader may call this reducer. The SQL
 * writer also fences the captured version; no cloud apply is exposed in P1. */
export function observeAccount(state:SyncState,account:Account):SyncState {
 exact(account,['oid','revision','generation']);oid(account.oid,'commit');checkD64(account.generation);if(checkD64(account.revision)==='0')throw Error('invalid_schema');
 if(compareD64(account.generation,state.rollbackGeneration)<0||compareD64(account.revision,state.lastSeenAccountRevision)<0)throw Error('replay_detected');
 if(account.revision===state.lastSeenAccountRevision&&state.lastSeenAccountOid!==null&&account.oid!==state.lastSeenAccountOid)throw Error('replay_detected');
 const following=nextD64(state.stateVersion),next=JSON.parse(canonical(state)) as SyncState;
 next.account={...account};next.lastSeenAccountOid=account.oid;next.lastSeenAccountRevision=account.revision;next.lastSeen=account.generation;next.rollbackGeneration=account.generation;
 if(next.pendingChoice||compareD64(next.editBase.generation,account.generation)<0&&(compareD64(next.localChangeRevision,next.acknowledgedLocalChangeRevision??'0')>0||next.hasUnsentEdits))next.pendingChoice={generation:account.generation,inboxKeys:next.pendingChoice?.inboxKeys??[],accountOid:account.oid,accountRevision:account.revision,selectedLocalChangeRevision:next.localChangeRevision};
 next.stateVersion=following;return next;
}

/** Old channels have no generation proof. Unknown impact is conservative. */
export function legacyInputRoute(state:{rollbackGeneration:string},entityKeys:string[],affected:string[]|null,cloudEnabled=true){
 if(!cloudEnabled)return 'legacy-only';checkD64(state.rollbackGeneration);
 return state.rollbackGeneration!=='0'&&(affected===null||entityKeys.some(key=>affected.includes(key)))?'pendingChoice':'normal';
}
