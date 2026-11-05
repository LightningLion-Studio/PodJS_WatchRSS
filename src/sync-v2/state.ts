import {checkD64,compareD64,nextD64} from '@podjs/framework/sql-projection';
import {exact,oid,canonical} from './protocol';
export type Account={oid:string;revision:string;generation:string};
export type Capture=Readonly<{stateVersion:string;accountOid:string;accountRevision:string;generation:string;localChangeRevision:string}>;
export interface SyncState {
 stateVersion:string;localChangeRevision:string;rollbackGeneration:string;
 account:Account|null;lastSeenAccountOid:string|null;lastSeenAccountRevision:string;lastSeen:string;
 editBase:{accountOid:string|null;generation:string};pendingChoice:null|{generation:string;inboxKeys:string[]};
 activeGeneration:string|null;applied:Record<string,string>;knownAuthors:Record<string,unknown>;knownAccountParents:Record<string,unknown>;
 keepDiscardedLocalChanges7Days:boolean;hasUnsentEdits:boolean;
}
export function initialState():SyncState {return {stateVersion:'0',localChangeRevision:'0',rollbackGeneration:'0',account:null,lastSeenAccountOid:null,lastSeenAccountRevision:'0',lastSeen:'0',editBase:{accountOid:null,generation:'0'},pendingChoice:null,activeGeneration:null,applied:{},knownAuthors:{},knownAccountParents:{},keepDiscardedLocalChanges7Days:true,hasUnsentEdits:false};}
export function currentAccount(state:any):Account {
 try{exact(state.account,['oid','revision','generation']);oid(state.account.oid,'commit');if(checkD64(state.account.revision)==='0')throw Error();checkD64(state.account.generation);checkD64(state.rollbackGeneration);checkD64(state.localChangeRevision);checkD64(state.stateVersion);
  if(state.account.generation!==state.rollbackGeneration)throw Error();
  for(const [name,value]of [['lastSeenAccountOid',state.account.oid],['lastSeenAccountRevision',state.account.revision],['lastSeen',state.account.generation]])if(Object.hasOwn(state,name)&&state[name]!==value)throw Error();return state.account;
 }catch{throw Error('choice_stale');}
}
export function checkCapture(state:any,capture:any,key?:string){
 const account=currentAccount(state);
 try{exact(capture,['stateVersion','accountOid','accountRevision','generation','localChangeRevision']);if(!Object.isFrozen(capture))throw Error();for(const k of ['stateVersion','accountRevision','generation','localChangeRevision'])checkD64(capture[k]);oid(capture.accountOid,'commit');}catch{throw Error('choice_stale');}
 if(!state.pendingChoice||capture.stateVersion!==state.stateVersion||capture.localChangeRevision!==state.localChangeRevision||capture.accountOid!==account.oid||capture.accountRevision!==account.revision||capture.generation!==account.generation||capture.generation!==state.pendingChoice.generation||(key!==undefined&&!state.pendingChoice.inboxKeys.includes(key)))throw Error('choice_stale');
}
export function captureChoice(state:any,window:Account):Capture {
 currentAccount(state);const capture=Object.freeze({stateVersion:state.stateVersion,accountOid:window.oid,accountRevision:window.revision,generation:window.generation,localChangeRevision:state.localChangeRevision});checkCapture(state,capture);return capture;
}
/** Only an authenticated/pinned account reader may call this reducer. The SQL
 * writer also fences the captured version; no cloud apply is exposed in P1. */
export function observeAccount(state:SyncState,account:Account):SyncState {
 exact(account,['oid','revision','generation']);oid(account.oid,'commit');checkD64(account.generation);if(checkD64(account.revision)==='0')throw Error('invalid_schema');
 if(compareD64(account.generation,state.rollbackGeneration)<0||compareD64(account.revision,state.lastSeenAccountRevision)<0)throw Error('replay_detected');
 if(account.revision===state.lastSeenAccountRevision&&state.lastSeenAccountOid!==null&&account.oid!==state.lastSeenAccountOid)throw Error('replay_detected');
 const following=nextD64(state.stateVersion),next=JSON.parse(canonical(state)) as SyncState;
 next.account={...account};next.lastSeenAccountOid=account.oid;next.lastSeenAccountRevision=account.revision;next.lastSeen=account.generation;next.rollbackGeneration=account.generation;
 if(next.pendingChoice||compareD64(next.editBase.generation,account.generation)<0&&(next.localChangeRevision!=='0'||next.hasUnsentEdits))next.pendingChoice={generation:account.generation,inboxKeys:next.pendingChoice?.inboxKeys??[]};
 next.stateVersion=following;return next;
}

/** Old channels have no generation proof. Unknown impact is conservative. */
export function legacyInputRoute(state:{rollbackGeneration:string},entityKeys:string[],affected:string[]|null,cloudEnabled=true){
 if(!cloudEnabled)return 'legacy-only';checkD64(state.rollbackGeneration);
 return state.rollbackGeneration!=='0'&&(affected===null||entityKeys.some(key=>affected.includes(key)))?'pendingChoice':'normal';
}
