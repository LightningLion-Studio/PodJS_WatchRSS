import {LocalBodyClaims} from './local-body-claims';
import {createCloudHostPorts} from '../cloud/host-ports';
import {BodyChannelHttp} from './body-channel-http';
import {WatchBodyChannel,independentBodyResolver} from './body-channel';
import {bodyChannelRepository,type BodyRepository} from './body-channel-repository';
import {refreshNoteAssets} from './note-assets';
import {installBusinessRevision} from './business-revision';
import {SyncV2Lifetime} from './lifetime';
/** 26.4 P6-10 application opener. Runs only when SYNC_V2_PRODUCT.syncV2 is on,
 * the bootstrap announces syncV2 and the v1 account keys are ready. */
import {createSyncV2Crypto} from '@podjs/framework/crypto';
import {readCloudSecure} from '../cloud/secure-read';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {HttpTransport} from '../cloud/types';
import {accountIdFromUserId} from './signing';
import {syncV2Origin} from './http';
import {accountContentKey,accountKeyPrefix,accountScopedStorage,fetchRepoIdentity,identityCryptoPort,receiveRepoIdentity,type AccountKeyring} from './product';

export interface ApplicationSyncV2Account {userId:string;backendBaseUrl:string;watchDeviceToken:string}
/** Receiver K_id step of the opener (P6-4/P6-5). Returns the installed record,
 * or null while the account has no repo yet (phone/mini creates it). */
export async function receiveApplicationIdentity(options:{host:CloudHostRequest;transport:HttpTransport;account:ApplicationSyncV2Account;legacyDeviceId:string;keys:AccountKeyring;allowLoopback?:boolean}){
 const {account}=options,base=account.backendBaseUrl.replace(/\/+$/,''),origin=syncV2Origin(base,{accountBaseUrl:base,allowLoopback:options.allowLoopback===true});
 const fetched=await fetchRepoIdentity(options.transport,origin,{accessToken:account.watchDeviceToken,legacyDeviceId:options.legacyDeviceId});if(!fetched)return null;
 const crypto=createSyncV2Crypto(options.host),accountId=accountIdFromUserId(account.userId),content=accountContentKey(options.keys,account.userId);
 const secure={get:(key:string)=>readCloudSecure(options.host,key),async compareAndSet(key:string,expected:string|null,value:string){const r=await options.host<{updated:boolean}>('secure.compareAndSet',{key,expected,value});if(typeof r.updated!=='boolean')throw Error('secure_store_corrupt');return r.updated;}};
 // The 18.1 recipient deviceId is H32; the v1 device UUID maps exactly like accountIdFromUserId.
 const deviceId=accountIdFromUserId(options.legacyDeviceId);
 let wrappingKey:Uint8Array|undefined;
 try{const installed=await receiveRepoIdentity({fetched,storage:accountScopedStorage(secure,accountKeyPrefix(base,account.userId)),crypto:identityCryptoPort(crypto),random:n=>crypto.random(n),member:async()=>({authorized:true,accountId,deviceId,platform:'watch'}),accountId,root:async version=>wrappingKey=(await content.at(version)).key});
 return {fetched,installed,origin};}finally{wrappingKey?.fill(0);}
}

import type {SqlLibrarySessionRepository} from '../sync/library-repository';
import {watchLocalProjection} from './index';
import {watchSyncV2} from './runtime';
import {PublicationLookupUnavailable} from './publisher';
import {ensureR0Scan} from './product';
import {stopExistingProjection} from './business-revision';
import {digest,canonical} from './protocol';
import {unhex} from '@podjs/framework/crypto';
import {TrustedClock} from './trusted-time';
import {articleBodyBytes,articleBodyResolver,articleBodyRevision} from './article-body';
import {carrierBodyRevision} from './body-channel-codec';
import type {SyncV2UiStateOptions} from './ui-state';
import {WatchAccountBusinessSql} from './account-business';
import {accountBodyVerifier} from './account-body';
import {WatchContentStore} from './content-store';
import {WatchContentEngine} from './content-engine';
import {WatchContentHttp} from './content-http';
import {AuthenticatedContentSessions} from '@podjs/framework/content-worker';
import {contentHostPorts} from '@podjs/framework/content-host';
import {localProjectionCipher,projectionSql} from './host';
import {watchSpaceV2} from './space-runtime';

/** Product assembly over the original v1 library and authenticated account.
 * The caller serializes this opener after v1 releases its writer lease. */
export async function openApplicationSyncV2Core<Ui extends {dispose():void}>(options:{lifetime?:SyncV2Lifetime;host:CloudHostRequest;cleanupHost?:CloudHostRequest;transport:HttpTransport;account:ApplicationSyncV2Account;legacyDeviceId:string;keys:AccountKeyring;repository:Pick<SqlLibrarySessionRepository,'cloudRestoreMetadata'|'cloudArticleBody'>&Partial<BodyRepository&Pick<SqlLibrarySessionRepository,'cloudArticlePlain'>>;session:()=>Promise<ApplicationSyncV2Account>;bootstrap:()=>Promise<{accountId:string;syncV2:unknown;devices:import('./signing-keys').ApprovedLegacyDevice[];libraryEpoch?:string;contentGeneration?:string}>;createUi?:(ports:SyncV2UiStateOptions)=>Ui;allowLoopback?:boolean;bodyInstall?:<T>(work:()=>Promise<T>)=>Promise<T>;allowBodies?:()=>Promise<boolean>;prepareArchivedAsset?:import('./account-control').AccountControlOptions['prepareArchivedAsset'];prepareArchivedBook?:import('./account-control').AccountControlOptions['prepareArchivedBook'];now?:()=>number;clock?:TrustedClock}){
 const {account,repository}=options,lifetime=options.lifetime??new SyncV2Lifetime();
 // Retain the writer lease through SQL. Read/crypto/network waits can unwind
 // immediately; their late results cannot cross another guarded IO boundary.
 const host:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{
  const cleanup=['file.delete','secure.release','cloud.release','crypto.closeSealedGzip'].includes(method);
  if(cleanup)return options.host<T>(method,args);
  lifetime.require();
  const result=method.startsWith('sql.')||method.startsWith('secure.')?await options.host<T>(method,args):await lifetime.read(()=>options.host<T>(method,args));
  lifetime.require();return result;
 };
 const transport:HttpTransport={request:r=>lifetime.read(()=>options.transport.request({...r,background:lifetime}))};
 const held=new Set<Uint8Array>(),keyring:AccountKeyring={currentKeyVersion:u=>options.keys.currentKeyVersion(u),accountKey:async(u,v)=>{const key=await options.keys.accountKey(u,v);if(closed){key?.fill(0);throw Error('feature_disabled');}if(key)held.add(key);return key;}};
 let localFactory:ReturnType<typeof watchLocalProjection>|undefined,runtimeFactory:ReturnType<typeof watchSyncV2>|undefined,ui:Ui|undefined,installedRecord:{idKeyHex:string}|undefined,closed=false,activeClock=options.clock,syncRound:(()=>Promise<{completionError:string|null}>)|undefined;
 let offClose=()=>{},closingPromise:Promise<void>|undefined;
 const close=()=>{
  if(closingPromise)return closingPromise;
  closed=true;offClose();lifetime.cancel();ui?.dispose();ui=undefined;runtimeFactory?.destroy();runtimeFactory=undefined;
  for(const key of held)key.fill(0);held.clear();if(installedRecord)installedRecord.idKeyHex='';installedRecord=undefined;activeClock?.clear();syncRound=undefined;
  const closing=localFactory;localFactory=undefined;
  return closingPromise=(async()=>{if(closing){try{await closing.gate.close().catch(()=>{});}finally{await stopExistingProjection(projectionSql(options.cleanupHost??options.host));}}})();
 };
 offClose=lifetime.onCancel(()=>{void close().catch(()=>{});});
 try{
 lifetime.require();
 const received=await receiveApplicationIdentity({...options,host,transport,keys:keyring});if(!received){await close();return null;}
 installedRecord=received.installed;if(closed){received.installed.idKeyHex='';installedRecord=undefined;throw Error('feature_disabled');}lifetime.require();
 const {fetched,installed,origin}=received,accountScope=canonical([account.backendBaseUrl.replace(/\/+$/,''),account.userId]),libraryId=accountIdFromUserId(options.legacyDeviceId),content=accountContentKey(keyring,account.userId),clock=activeClock=options.clock??new TrustedClock();
 const assertCurrent=async()=>{if(closed)throw Error('feature_disabled');const current=await options.session();if(canonical([current.backendBaseUrl.replace(/\/+$/,''),current.userId])!==accountScope)throw Error('cloud_account_busy');return current;};
 const guardedHost:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{await assertCurrent();if(method==='secure.get'&&args.offset===undefined)return await readCloudSecure(host,String(args.key)) as T;return host<T>(method,args);};
 const identity={installed:async(descriptor:unknown)=>{await assertCurrent();if(digest(descriptor)!==digest(fetched.descriptor))throw Error('identity_conflict');return installed;}};
 // v1 initializes its metadata tables before the SQL source enumerates them.
 await repository.cloudRestoreMetadata({ids:[],limit:1});
 await WatchAccountBusinessSql.initializeSchema(projectionSql(guardedHost));
 const rawBodyRepository=repository.cloudNotes&&repository.cloudNoteAsset&&repository.mergeCloudNoteAsset&&repository.cloudBookBody&&repository.receiveCloudBook?bodyChannelRepository(repository as BodyRepository):undefined;
 const bodyRepository=rawBodyRepository?{...rawBodyRepository,install:async(...args:Parameters<typeof rawBodyRepository.install>)=>{await assertCurrent();const install=()=>rawBodyRepository.install(...args);await (options.bodyInstall?options.bodyInstall(install):install());await assertCurrent();}}:undefined;
 let bodyError:string|null=null;
 localFactory=watchLocalProjection({enabled:true,host:guardedHost,identity,descriptor:fetched.descriptor,scope:fetched.scope,libraryId,accountScope,metadata:repository});
  const local=await localFactory.open();if(!local)throw Error('feature_disabled');
  const refreshAssets=async()=>{
   if(!repository.cloudNotes||!repository.cloudNoteAsset)return;
   const state=await local.store.readState(),current=state.cloud?.current;
   const errors=await refreshNoteAssets(projectionSql(guardedHost),repository as BodyRepository,options.legacyDeviceId,options.now??Date.now,async(id,hash)=>{
    if(!state.account||current?.commitOid!==state.account.oid)return false;
    const entity=local.store.entityKeyFor('asset',id),entry=await local.store.cloudRow(current.treeRoot,entity);
    return entry?.meta.kind==='asset'&&entry.meta.logicalId===id&&!entry.row.deleted&&entry.row.bodyRevision===carrierBodyRevision('asset',entity,hash);
   });
   bodyError=errors[0]??null;
  };
  const crypto=createSyncV2Crypto(guardedHost),current=await content.current(),keys={id:unhex(installed.idKeyHex),content:current.key,version:current.version,readContentKey:async(v:number)=>(await content.at(v)).key};
  held.add(keys.id);
  const readArticlePlain=async(id:string)=>{
   if(repository.cloudArticlePlain){
    const body=await repository.cloudArticlePlain(id);
    return body&&articleBodyBytes(body);
   }
   const prepared=await repository.cloudArticleBody(id);
   return prepared?.manifest.bodyAvailable?articleBodyBytes(prepared.article):undefined;
  };
  const articleResolver=articleBodyResolver({crypto,keys,scope:fetched.scope,read:readArticlePlain}),resolveBody=bodyRepository?independentBodyResolver(bodyRepository,articleResolver,code=>{bodyError=bodyError??code;}):articleResolver;
  runtimeFactory=watchSyncV2({enabled:true,indexWrite:true,historyRestore:true,choiceApply:true,origin,originPolicy:{accountBaseUrl:origin,allowLoopback:options.allowLoopback===true},host:guardedHost,transport,local:localFactory,identity:async()=>{await assertCurrent();return installed;},contentKey:content.current,contentKeyAt:keys.readContentKey,bootstrap:options.bootstrap,session:async()=>{const a=await assertCurrent();return {userId:a.userId,accessToken:a.watchDeviceToken,legacyDeviceId:options.legacyDeviceId,scope:fetched.scope};},bodyResolver:resolveBody,clock,now:options.now});
  const runtime=await runtimeFactory.open();
  if(!runtime)throw Error('feature_disabled');
  // Read/cache and recovery ports share the existing bounded P3 implementation.
  // No content worker is started and contentWrite remains false on this HTTP port.
  const ports=contentHostPorts(guardedHost,new AuthenticatedContentSessions()),db=projectionSql(guardedHost),binding={scope:fetched.scope,accountScope,libraryId},store=new WatchContentStore(db,localProjectionCipher(guardedHost,'content:'+digest(binding)),ports.files,binding);await store.init();
  const engine=new WatchContentEngine(store,new WatchContentHttp(runtime.http,crypto,options.now??Date.now,true),crypto,keys,{source:async()=>{throw Error('feature_disabled');},approved:runtime.approved,alias:'',assertCurrent:async()=>{await assertCurrent();},signals:async()=>ports.signals(false),yieldControl:()=>guardedHost('runtime.delay',{milliseconds:1})});
  const space=await watchSpaceV2({enabled:true,host:guardedHost,projection:local.store,content:engine,accountScope,trustedNow:()=>clock.now()});if(!space)throw Error('feature_disabled');
  const business=new WatchAccountBusinessSql(db,local.store,fetched.scope,keys.id,space.closures,accountBodyVerifier(runtime.http,crypto,keys,runtime.approved),space.recovery.ports.reserve,async(id,entity)=>{
   const plain=await readArticlePlain(id);
   return plain?articleBodyRevision(entity,plain):undefined;
  });await business.initialize();
  const control=runtime.accountControl({business,recovery:space.recovery,trustedNow:()=>clock.now(),preserveStalePublication:true,prepareArchivedBook:options.prepareArchivedBook,prepareArchivedAsset:options.prepareArchivedAsset});
  const recoverConflict=async()=>{
   // Confirm the same immutable request first. Only a recorded CAS rejection
   // authorizes refreshing the winning identity/account and retiring its journal.
   await runtime.publisher.retryAfterConflict(async()=>{
    const winner=await receiveApplicationIdentity({...options,host,transport,keys:keyring});
    if(!winner)throw Error('identity_not_installed');
    try{if(digest(winner.fetched.descriptor)!==digest(fetched.descriptor)||winner.installed.idKeyHex!==installed.idKeyHex)throw Error('identity_conflict');}
    finally{winner.installed.idKeyHex='';}
    await runtime.refreshAccount();
   },true);
  };
  const reconcileStalePublication=async()=>{
   if(await control.retireStaleCloudChoice())return true;
   if(!(await local.store.readState()).cloud?.pendingPublish?.explicit)return false;
   await runtime.refreshAccount();
   return (await runtime.publisher.reconcileStalePublication()).detached;
  };
  const flushPublication=async()=>{
   await control.recoverPreparation();
   const state=await local.store.readState();if(state.cloud?.pendingCloudChoice){try{await runtime.authenticate();await control.resumeCloudChoice();}catch(error){if((error as Error).message==='choice_stale')await control.retireStaleCloudChoice();throw error;}return;}const pending=state.cloud?.pendingPublish;if(!pending)return false;
   if(pending.phase==='conflicted'&&!pending.explicit&&pending.capturedLocalRevision===state.localChangeRevision){await recoverConflict();return;}
   try{if(pending.explicit){await runtime.authenticate();await control.resumePublication();}else await runtime.publisher.flush();}catch(error){
    if(pending.explicit&&['choice_stale','ref_conflict'].includes((error as Error).message)){
     if(!(await local.store.readState()).cloud?.pendingPublish||await reconcileStalePublication())return;
     throw error;
    }
    if(pending.explicit)throw error;
    const latest=await local.store.readState();
    if((error as Error).message==='choice_stale'&&latest.cloud?.pendingPublish?.requestId===pending.requestId&&latest.localChangeRevision!==pending.capturedLocalRevision){
     await runtime.publisher.flush();
     return;
    }
    if((error as Error).message!=='ref_conflict'||latest.cloud?.pendingPublish?.phase!=='conflicted')throw error;
    await recoverConflict();
   }
  };
  // Query failure and closed action gates preserve the original publication;
  // they do not prevent this round from authenticating a read.
  const flush=async()=>{
   try{return await flushPublication();}catch(error){
    const state=await local.store.readState(),pending=state.cloud?.pendingPublish;
    // An accepted choice already journals the retry and its original request.
    if(state.cloud?.pendingCloudChoice?.phase==='accepted'&&(error as Error).message==='storage_pressure')return true;
    if((pending?.explicit||state.cloud?.pendingCloudChoice)&&(error instanceof PublicationLookupUnavailable||(error as Error).message==='feature_disabled'))return true;
    throw error;
   }
  };
  const round=async()=>{
   await assertCurrent();
   await runtime.http.refreshClosedReadGate();
   await refreshAssets();await installBusinessRevision(projectionSql(guardedHost));await runtime.refreshTrustedTime();const deferred=await flush();
   if(deferred){
    const state=await local.store.readState(),pending=state.cloud?.pendingPublish,settings=await control.settings();
    if(state.cloud?.pendingCloudChoice&&!settings.choice_apply||pending?.explicit&&(pending.kind==='rollback'?!settings.history_restore:!settings.choice_apply)){await runtime.pullReadOnly();return {readOnly:true};}
    await ensureR0Scan(local);await local.store.beginTailWindow();await ensureR0Scan(local);return runtime.refreshAccount();
   }
   await ensureR0Scan(local);await local.store.beginTailWindow();await ensureR0Scan(local);const pulled=await runtime.pull();if(pulled?.readOnly)return pulled;
   const state=await local.store.readState();
   if(state.cloud?.pendingPublish)await flush();
   else if(!state.pendingChoice&&(state.hasUnsentEdits||!state.account&&!state.cloud?.lastPublication)&&await runtime.signingStatus()==='ready'){
    try{await runtime.publish(true);}catch(error){
     if((error as Error).message!=='ref_conflict'||(await local.store.readState()).cloud?.pendingPublish?.phase!=='conflicted')throw error;
     await recoverConflict();
    }
   }else return pulled;
   // First-follow publication leaves the merged head unapplied locally.
   const followed=state.account&&state.activeGeneration===null?await runtime.pull():pulled;
   return {...followed,refreshBodies:true};
  };
  const bodyPorts=createCloudHostPorts(guardedHost,{require(){lifetime.require();}});
  const bluetoothBodies=new LocalBodyClaims(projectionSql(guardedHost));
  const channel=bodyRepository?new WatchBodyChannel({http:new BodyChannelHttp({enabled:true,origin,policy:{accountBaseUrl:origin,allowLoopback:options.allowLoopback===true},scope:fetched.scope,transport,check:async()=>{await assertCurrent();await runtime.bodyCheck();},session:async()=>{const a=await assertCurrent(),b=await options.bootstrap();if(!b.libraryEpoch||!b.contentGeneration)throw Error('scope_mismatch');return {accessToken:a.watchDeviceToken,legacyDeviceId:options.legacyDeviceId,legacyEpoch:b.libraryEpoch,legacyGeneration:b.contentGeneration};}}),scope:fetched.scope,projection:local.store,crypto:bodyPorts.crypto,signer:crypto,author:runtime.bodyAuthor,approved:runtime.approved,key:async v=>(await content.at(v)).key,currentKey:content.current,files:bodyPorts.files,root:'watch-cloud-cache/'+digest([origin,account.userId]).slice(0,32)+'/body-v1',repository:bodyRepository,localReceiving:binding=>bluetoothBodies.has(canonical(fetched.scope),binding),receivedFromPeer:(binding,sha256)=>bluetoothBodies.received(canonical(fetched.scope),binding,sha256),now:options.now,check:async()=>{await assertCurrent();},yieldControl:async()=>{await guardedHost('runtime.delay',{milliseconds:1});}}):undefined;
  const bodyRound=async(expiresAtMillis:number)=>{if(!channel)return;try{if(!await channel.hasWork())return;const allowed=options.allowBodies?await options.allowBodies():(await guardedHost<{wifi:boolean;metered:boolean}>('discovery.networkSnapshot',{}));if(allowed!==true&&!(typeof allowed==='object'&&allowed.wifi&&allowed.metered===false)){bodyError=bodyError??'body_channel_waiting_wifi';return;}const result=await channel.sync(expiresAtMillis);bodyError=bodyError??result.errors[0]??null;}catch(error){bodyError=String((error as Error).message);}};
  const sync=async()=>{
   bodyError=null;
   const result=await round();
   if(!result?.readOnly){
    if(channel&&(result?.refreshBodies||await channel.hasWork())){
     let observation=result?.refreshBodies||result?.expiresAtMillis===undefined?await runtime.refreshAccount():result;
     if(await channel.needsPublication()){
      await runtime.publish();
      observation=await runtime.refreshAccount();
     }
     await bodyRound(observation.expiresAtMillis);
    }
    if(bodyRepository)try{await guardedHost('sql.notify',{topic:'watchrss-library'});}catch{await assertCurrent();}
   }
   return result;
  };
  const synchronize=async()=>{
   const result=await sync();
   let completionError:string|null=null;
   // The worker makes its own retry decision directly from bodyError.
   if(options.createUi){
    const state=await local.store.readState();
    if(state.pendingChoice)completionError='choice_pending';
    else if(result?.readOnly||state.cloud?.blockedCommitOid||result?.applyDisabled&&state.account&&state.activeGeneration!==state.account.oid)completionError='cloud_v2_read_only';
    else if(bodyError)completionError=bodyError;
    else if(state.hasUnsentEdits||state.cloud?.pendingPublish||state.cloud?.pendingApplied)completionError='cloud_v2_pending';
   }
   return {completionError};
  };
  const initialResult=await synchronize();
  ui=options.createUi?.({bodyError:()=>bodyError,runtime:{pull:sync,publish:()=>runtime.publish(),resumeChoice:async()=>{await flush();},reconcileStalePublication,signingDeviceId:runtime.signingDeviceId,signingStatus:runtime.signingStatus},control,projection:local.store,trustedNow:()=>clock.now(),productErrors:true});
  syncRound=synchronize;
  return {ui:ui!,bodyError:()=>bodyError,initialResult,sync:async()=>{if(!syncRound)throw Error('feature_disabled');return syncRound();},close};
 }catch(error){await close().catch(()=>{});throw productError(error);}
}
/** Internal compatibility codes stop at the application boundary. */
export function productError(error:unknown){return (error as Error)?.message==='clock_unknown'?Error('trusted_time_unavailable'):error;}
