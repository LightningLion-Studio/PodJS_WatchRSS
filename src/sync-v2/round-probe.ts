import {businessAuditBinding} from './business';
import {sameBusinessRevision} from './business-revision';
import {compareD64,nextD64} from './protocol';
import type {watchIndexAuthentication} from './runtime';
import type {SyncState} from './state';
import type {WatchProjectionStore} from './store';

/** The account and local business witness must both be settled. */
function cleanAccount(state:SyncState){
 const {account,cloud}=state;
 return account&&cloud?.current?.commitOid===account.oid&&cloud.pins?.accountOid===account.oid&&
  state.activeGeneration===account.oid&&state.editBase.accountOid===account.oid&&
  state.rollbackGeneration===account.generation&&state.editBase.generation===account.generation&&
  state.localChangeRevision===(state.acknowledgedLocalChangeRevision??'0')&&
  !state.hasUnsentEdits&&!state.pendingChoice&&!cloud.pendingPublish&&!cloud.preparingPublication&&
  !cloud.pendingCloudChoice&&!cloud.pendingApplied&&!cloud.blockedCommitOid&&!cloud.witnessConflict&&
  cloud.p5Gates?.choice_apply!==false&&!Object.values(cloud.detachedPublications??{}).some((plan:any)=>plan.outcome==='unknown');
}

export async function rememberSettledRound(store:WatchProjectionStore,state:SyncState,schemaVersion:number){
 if(!cleanAccount(state)||!state.cloud.current.signingFingerprint)return;
 const checkpoint=await store.checkpoint();
 if(checkpoint?.phase!=='complete'||!sameBusinessRevision(checkpoint.businessRevision,state.businessRevision))return;
 if(schemaVersion<0||!await store.matchesRoundState(state,schemaVersion))return;
 const marker={version:nextD64(state.stateVersion),schemaVersion};
 try{await store.observationUpdate(state,{...state,cloud:{...state.cloud,settledRound:marker}});}
 catch(error){if((error as Error).message!=='choice_stale')throw error;}
}

function assertRoundHeadMonotonic(state:SyncState,window:Awaited<ReturnType<ReturnType<typeof watchIndexAuthentication>['checkpoint']>>){
 const remote=window.account,account=state.account;
 if(compareD64(remote.revision,state.lastSeenAccountRevision)<0||
  compareD64(remote.rollbackGeneration,state.rollbackGeneration)<0||
  compareD64(window.serverRevision,state.cloud?.cursor??'0')<0||
  account&&(remote.commitOid===null||
   remote.revision===account.revision&&remote.commitOid!==account.oid||
   remote.commitOid===account.oid&&(remote.revision!==account.revision||remote.rollbackGeneration!==account.generation)))throw Error('replay_detected');
}

export async function readUnchangedRound(store:WatchProjectionStore,auth:ReturnType<typeof watchIndexAuthentication>,keyVersion:number,now:()=>number){
 let state:SyncState;
 try{state=await store.readStableState();}
 catch(error){if(['choice_stale','projection_not_initialized'].includes((error as Error).message))return false;throw error;}
 const {account,cloud}=state,marker=cloud?.settledRound;
 if(!account||!cleanAccount(state)||marker?.version!==state.stateVersion||
  marker.schemaVersion!==await store.roundSchemaVersion())return false;

 const caps=await auth.http.capabilities();
 const window=await auth.checkpoint();
 const remote=window.account;
 assertRoundHeadMonotonic(state,window);
 await auth.authors.refresh(window.windowId,true);
 if(now()>window.expiresAtMillis)throw Error('window_expired');

 if(remote.commitOid!==account.oid||remote.revision!==account.revision||
  remote.rollbackGeneration!==account.generation||window.serverRevision!==cloud.cursor||
  compareD64(window.historyFloorRevision,cloud.cursor)>0||
  cloud.current.signingFingerprint!==auth.authors.fingerprint||
  cloud.auditBinding!==businessAuditBinding(auth.http.scope,keyVersion,caps.features))return false;
 // A user may save while a checkpoint or signing list is in flight.
 return store.matchesRoundState(state,marker.schemaVersion);
}
