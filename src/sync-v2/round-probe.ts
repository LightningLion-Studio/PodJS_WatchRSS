import {businessAuditBinding} from './business';
import {sameBusinessRevision} from './business-revision';
import {compareD64,digest,nextD64} from './protocol';
import type {SyncV2RoundResult} from './product-start';
import type {watchIndexAuthentication} from './runtime';
import type {SyncState} from './state';
import type {WatchProjectionStore} from './store';

type HeldOriginal={entityKey:string;kind:'book'|'asset';id:string};
type HeldCreates={heldLocalRevision:string;digest:string;originals:HeldOriginal[]};
type SettledRound={version:string;schemaVersion:number;held?:HeldCreates};
export type MissingOriginal=(kind:HeldOriginal['kind'],id:string)=>Promise<boolean>;

async function originalsStillMissing(originals:HeldOriginal[],missing:MissingOriginal){
 for(const {kind,id} of originals)if(!await missing(kind,id))return false;
 return true;
}

/** The observed account must be applied, with no unfinished cloud work. */
function settledAccount(state:SyncState,held?:HeldCreates){
 const {account,cloud}=state;
 return account&&cloud?.current?.commitOid===account.oid&&cloud.pins?.accountOid===account.oid&&
  state.activeGeneration===account.oid&&state.editBase.accountOid===account.oid&&
  state.rollbackGeneration===account.generation&&state.editBase.generation===account.generation&&
  (held?state.hasUnsentEdits&&state.localChangeRevision===held.heldLocalRevision:
   !state.hasUnsentEdits&&state.localChangeRevision===(state.acknowledgedLocalChangeRevision??'0'))&&
  !state.pendingChoice&&!cloud.pendingPublish&&!cloud.preparingPublication&&
  !cloud.pendingCloudChoice&&!cloud.pendingApplied&&!cloud.blockedCommitOid&&!cloud.witnessConflict&&
  cloud.p5Gates?.choice_apply!==false&&!Object.values(cloud.detachedPublications??{}).some((plan:any)=>plan.outcome==='unknown');
}

export async function rememberSettledRound(store:WatchProjectionStore,state:SyncState,schemaVersion:number,held?:{
 keys:readonly string[];localRevision:string;missing:MissingOriginal;missingNoteAssets:ReadonlySet<string>;
}){
 let retained:HeldCreates|undefined;
 if(held){
  if(!held.keys.length||state.localChangeRevision!==held.localRevision)return;
  const originals:HeldOriginal[]=[];
  for(const entityKey of [...held.keys].sort()){
   const candidate=await store.readCandidate(entityKey);
   if(!candidate||candidate.state.payload.deleted)return;
   const {kind,logicalId:id}=candidate.meta;
   if(kind!=='book'&&kind!=='asset')return;
   originals.push({entityKey,kind,id});
  }
  const heldAssets=new Set(originals.filter(source=>source.kind==='asset').map(source=>source.id));
  for(const id of held.missingNoteAssets)if(!heldAssets.has(id))return;
  if(!await originalsStillMissing(originals,held.missing))return;
  retained={heldLocalRevision:held.localRevision,digest:digest(originals),originals};
 }
 if(!settledAccount(state,retained)||!state.cloud.current.signingFingerprint)return;
 const checkpoint=await store.checkpoint();
 if(checkpoint?.phase!=='complete'||!sameBusinessRevision(checkpoint.businessRevision,state.businessRevision))return;
 if(schemaVersion<0||!await store.matchesRoundState(state,schemaVersion))return;
 const marker:SettledRound={version:nextD64(state.stateVersion),schemaVersion,...(retained?{held:retained}:{})};
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

export async function readUnchangedRound(store:WatchProjectionStore,auth:ReturnType<typeof watchIndexAuthentication>,keyVersion:number,now:()=>number,missing?:MissingOriginal):Promise<SyncV2RoundResult|undefined>{
 let state:SyncState;
 try{state=await store.readStableState();}
 catch(error){if(['choice_stale','projection_not_initialized'].includes((error as Error).message))return undefined;throw error;}
 const {account,cloud}=state,marker:SettledRound|undefined=cloud?.settledRound;
 if(!account||marker?.version!==state.stateVersion||!settledAccount(state,marker.held)||
  marker.schemaVersion!==await store.roundSchemaVersion())return;

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
  cloud.auditBinding!==businessAuditBinding(auth.http.scope,keyVersion,caps.features))return;
 const held=marker.held;
 if(held&&(!missing||!held.originals.length||digest(held.originals)!==held.digest||
  !await originalsStillMissing(held.originals,missing)))return;
 if(held&&now()>window.expiresAtMillis)throw Error('window_expired');
 // A user may save while a checkpoint, signing list or file stat is in flight.
 if(await store.matchesRoundState(state,marker.schemaVersion)){
  return {completionError:held?'body_channel_source_missing':null};
 }
}
