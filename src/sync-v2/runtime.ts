import {IndexObjectCache} from './index-object-cache';
import {WatchAccountControl,type AccountControlOptions} from './account-control';
/** Explicit P2 factory for isolated integration. No application startup hook. */
import {createSyncV2Crypto,unhex} from '@podjs/framework/crypto';
import {readCloudSecure} from '../cloud/secure-read';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {HttpTransport} from '../cloud/types';
import type {watchLocalProjection} from './index';
import {accountIdFromUserId} from './signing';
import {WatchServiceKeyPin} from './service-key';
import {WatchSigningIdentity} from './signing-store';
import {WatchSigningKeys,type ApprovedLegacyDevice} from './signing-keys';
import {WatchCloudIndex} from './cloud-index';
import {watchContentV2} from './content-runtime';
import {WatchIndexPublisher,type BodyResolver} from './publisher';
import {SyncV2Http,type Session,type OriginPolicy} from './http';
import type {TrustedClock} from './trusted-time';
import {hex} from '@podjs/framework/crypto';
import {canonical,exact,digest} from './protocol';
import {readUnchangedRound,type MissingOriginal} from './round-probe';
import type {ObjectKeys} from './sealed';
import {sameScope} from './wire';
type IndexAuthenticationOptions=Pick<Parameters<typeof watchSyncV2>[0],'host'|'origin'|'originPolicy'|'transport'|'session'|'bootstrap'|'indexWrite'|'historyRestore'|'choiceApply'|'clock'|'now'>;
export function watchIndexAuthentication(options:IndexAuthenticationOptions,session:Session,id:Uint8Array){
 const accountId=accountIdFromUserId(session.userId),crypto=createSyncV2Crypto(options.host);
 const secure={get:(key:string)=>readCloudSecure(options.host,key),async compareAndSet(key:string,expected:string|null,value:string){const result=await options.host<{updated:boolean}>('secure.compareAndSet',{key,expected,value});if(typeof result.updated!=='boolean')throw Error('secure_store_corrupt');return result.updated;}};
 const pin=new WatchServiceKeyPin(secure,accountId,options.bootstrap);
 const http=new SyncV2Http(options.transport,options.origin,session.scope,options.session,options.indexWrite??false,pin,false,false,options.historyRestore??false,options.choiceApply??false,options.originPolicy);
 const authors=new WatchSigningKeys(http,crypto,id,async()=>{
  const approved=await options.bootstrap();
  if(approved.accountId!==accountId)throw Error('cloud_account_busy');
  return approved.devices;
 },{storage:secure,slot:'watchrss.syncv2.revocations.'+digest([options.origin,accountId,session.scope])});
 const checkpoint=async(window?:any)=>{
  const response=window?.checkpoint?{version:2,scope:session.scope,...window.checkpoint}:await http.json('GET','/checkpoint');
  exact(response,['version','scope','body','signature']);
  const signed=await pin.checkpoint(crypto,{body:response.body,signature:response.signature},session.scope,(options.now??Date.now)());
  if(window&&(canonical(signed.account)!==canonical(window.account)||signed.serverRevision!==window.serverRevision))throw Error('ref_conflict');
  options.clock?.observe(signed.issuedAtMillis);
  return signed;
 };
 return {http,authors,crypto,secure,checkpoint};
}

/** `noteSegments` (default off) lets this client read and, when the backend
 * also advertises note-segments.v1, write rc7 segmented notes (25.8). */
export function watchSyncV2(options:{enabled?:boolean;noteSegments?:boolean;indexWrite?:boolean;historyRestore?:boolean;choiceApply?:boolean;bodyResolver?:BodyResolver;origin:string;local:ReturnType<typeof watchLocalProjection>;host:CloudHostRequest;transport:HttpTransport;session:()=>Promise<Session>;bootstrap:()=>Promise<{accountId:string;syncV2:unknown;devices:ApprovedLegacyDevice[]}>;identity:()=>Promise<{idKeyHex:string;scope:any}>;contentKey:()=>Promise<{key:Uint8Array;version:number}>;contentKeyAt?:import('./sealed').ContentKeyResolver;now?:()=>number;originPolicy?:OriginPolicy;clock?:TrustedClock;progress?:()=>import('../cloud/sync-progress').SyncProgress|undefined;maxChangedRows?:number;maxPrepareMillis?:number;uploadConcurrency?:number;readConcurrency?:number}){
 let opened:Promise<any>|undefined,ownedKeys:ObjectKeys|undefined;let destroyed=false;const indexObjects=new IndexObjectCache();const destroy=()=>{destroyed=true;indexObjects.clear();opened=undefined;ownedKeys?.id.fill(0);ownedKeys?.content.fill(0);ownedKeys=undefined;};const now=options.now??Date.now,segments=options.noteSegments===true;
 return {destroy,async open(){if(destroyed)throw Error('feature_disabled');if(options.enabled!==true)return null;return opened??=(async()=>{
  const local=await options.local.open();if(!local)throw Error('feature_disabled');const session=await options.session(),accountId=accountIdFromUserId(session.userId),identity=await options.identity();sameScope(identity.scope,session.scope);const content=await options.contentKey(),keys={id:unhex(identity.idKeyHex),content:content.key,version:content.version,readContentKey:options.contentKeyAt};
  ownedKeys=keys;if(destroyed){destroy();throw Error('feature_disabled');}
  const authentication=watchIndexAuthentication(options,session,keys.id),{http,authors,crypto,secure,checkpoint}=authentication,pin=http.servicePin!;
  const signer=new WatchSigningIdentity(secure,crypto,accountId,session.scope,keys.id);
  http.requestGuard=()=>{if(destroyed)throw Error('feature_disabled');};
  await http.capabilities();const reader=new WatchCloudIndex(local.store,http,crypto,keys,async deviceId=>authors.get(deviceId),async window=>{await checkpoint(window);},now,()=>local.rebuild(),{noteSegments:segments,indexObjects,progress:options.progress,readConcurrency:options.readConcurrency}),publisher=new WatchIndexPublisher(local.store,http,crypto,keys,now,options.bodyResolver,{noteSegments:segments,indexObjects,progress:options.progress,maxChangedRows:options.maxChangedRows,maxPrepareMillis:options.maxPrepareMillis,uploadConcurrency:options.uploadConcurrency});
  const authenticateWithRevision=async()=>{
   const registrationRevision=signer.registrationRevision;
   const window=await http.negotiate([],segments?['note-conflicts.v1','note-segments.v1']:['note-conflicts.v1']);
   const revision=await authors.refresh(window.windowId);
   return {window,revision,fingerprint:authors.fingerprint!,registrationRevision};
  };
  const authenticate=async()=>(await authenticateWithRevision()).window;
  const registerAuthor=async(proof:Awaited<ReturnType<typeof authenticateWithRevision>>,at:number)=>{
   const author=await signer.register(http,proof.revision,at);
   // Registration advances the approval revision and invalidates older windows.
   const window=proof.registrationRevision===signer.registrationRevision?proof.window:await authenticate();
   const own=window.refs.find((ref:any)=>ref.deviceId===author.deviceId);
   return {...author,own:{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'}};
  };
  let observed:Awaited<ReturnType<typeof authenticateWithRevision>>|undefined;
  let accountControl:WatchAccountControl|undefined;let contentOpen:ReturnType<ReturnType<typeof watchContentV2>['open']>|undefined,contentBinding:string|undefined;
  return {destroy,http,reader,publisher,authenticate,async bodyAuthor(){return registerAuthor(await authenticateWithRevision(),now());},async bodyCheck(){await http.requestGuard?.();await pin.assertBootstrap(false);},async pullReadOnly(){const proof=await authenticateWithRevision();return reader.pull(proof.window,true,proof.fingerprint);},approved:async(id:string)=>authors.get(id),refreshTrustedTime:()=>checkpoint(),readUnchanged:(missing?:MissingOriginal)=>readUnchangedRound(local.store,authentication,keys.version,now,missing),signingDeviceId:()=>signer.registeredDeviceId(),signingStatus:()=>signer.status(),accountControl(ports:Pick<AccountControlOptions,'business'|'recovery'|'trustedNow'|'preserveStalePublication'|'prepareArchivedBook'>){return accountControl=new WatchAccountControl({...ports,progress:options.progress,store:local.store,http,reader,authenticateWindow:authenticateWithRevision,publisher:new WatchIndexPublisher(local.store,http,crypto,keys,()=>{const n=ports.trustedNow();if(n===null)throw Error('clock_unknown');return n;},options.bodyResolver,{noteSegments:segments,progress:options.progress}),crypto,approved:async id=>authors.get(id),rebuildProjection:()=>local.rebuild(),resolveBody:options.bodyResolver,historyRestore:options.historyRestore,choiceApply:options.choiceApply,author:async()=>registerAuthor(await authenticateWithRevision(),ports.trustedNow()??(()=>{throw Error('clock_unknown');})())});},async content(business:Pick<Parameters<typeof watchContentV2>[0],'enabled'|'authBinding'|'source'|'sessions'|'allowChargingCellular'|'metric'>){
   if(business.enabled!==true)return null;if(options.indexWrite!==true)throw Error('feature_disabled');
   if(contentOpen&&contentBinding!==business.authBinding)throw Error('body_revision_changed');contentBinding=business.authBinding;
   return contentOpen??=(async()=>{const author=await registerAuthor(await authenticateWithRevision(),now());
    return watchContentV2({...business,origin:options.origin,originPolicy:options.originPolicy,host:options.host,session:options.session,servicePin:pin,keys,alias:author.alias,now,
     approved:async id=>authors.get(id),refreshApproved:async id=>{await authors.refresh(id);},assertCurrent:async()=>{
      const current=await options.session();if(accountIdFromUserId(current.userId)!==accountId)throw Error('cloud_account_busy');sameScope(current.scope,session.scope);
     }}).open();})().catch(error=>{contentOpen=undefined;throw error;});
  },async refreshAccount(){options.progress?.()?.stage('compare');const {window,fingerprint}=await authenticateWithRevision(),result=await reader.pull(window,false,fingerprint);if(now()>window.expiresAtMillis)throw Error('window_expired');return {...result,expiresAtMillis:window.expiresAtMillis};},async pull(){
   options.progress?.()?.stage('compare');
   observed=undefined;
   const authenticated=await authenticateWithRevision(),{window}=authenticated;
   const result=await (accountControl?accountControl.follow(window,authenticated.fingerprint):reader.pull(window,false,authenticated.fingerprint));
   if(!result?.readOnly)observed=authenticated;
   return {...result,expiresAtMillis:window.expiresAtMillis};
  },async publish(useObservedWindow=false,recheckKeys:readonly string[]=[]){
   options.progress?.()?.stage('upload');
   const proof=useObservedWindow?observed:undefined;observed=undefined;
   const current=await local.store.readState();if(current.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(current.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(current.pendingChoice)throw Error('choice_pending');
   const bound=proof&&proof.registrationRevision===signer.registrationRevision&&now()<=proof.window.expiresAtMillis&&proof.window.account.commitOid===(current.account?.oid??null)&&
    proof.window.account.revision===(current.account?.revision??'0')&&proof.window.account.rollbackGeneration===current.rollbackGeneration;
   const author=await registerAuthor(bound?proof:await authenticateWithRevision(),now());
   const requestId=hex(await crypto.random(16));
   let prepared;
   try{
    prepared=await publisher.prepare(author.deviceId,author.alias,author.own,requestId,recheckKeys);
   }catch(error){
    if((error as Error).message!=='projection_incomplete')throw error;
    // A local save may commit while the pull is acknowledging its applied head.
    await local.store.beginTailWindow();
    while((await local.store.checkpoint())?.phase==='tail')await local.store.catchUpPage(local.source);
    prepared=await publisher.prepare(author.deviceId,author.alias,author.own,requestId,recheckKeys);
   }
   return prepared.skipped?prepared:publisher.flush();
  }};
 })().catch(error=>{opened=undefined;destroy();throw error;});}};
}
