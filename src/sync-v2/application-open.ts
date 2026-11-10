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
 const installed=await receiveRepoIdentity({fetched,storage:accountScopedStorage(secure,accountKeyPrefix(base,account.userId)),crypto:identityCryptoPort(crypto),random:n=>crypto.random(n),member:async()=>({authorized:true,accountId,deviceId,platform:'watch'}),accountId,root:async version=>(await content.at(version)).key});
 return {fetched,installed,origin};
}

import type {SqlLibrarySessionRepository} from '../sync/library-repository';
import {watchLocalProjection} from './index';
import {watchSyncV2} from './runtime';
import {ensureR0Scan} from './product';
import {stopExistingProjection} from './business-revision';
import {digest,canonical} from './protocol';
import {unhex} from '@podjs/framework/crypto';
import {TrustedClock} from './trusted-time';
import {articleBodyResolver} from './article-body';
import {WatchSyncV2UiState} from './ui-state';
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
export async function openApplicationSyncV2(options:{host:CloudHostRequest;cleanupHost?:CloudHostRequest;transport:HttpTransport;account:ApplicationSyncV2Account;legacyDeviceId:string;keys:AccountKeyring;repository:Pick<SqlLibrarySessionRepository,'cloudRestoreMetadata'|'cloudArticleBody'>;session:()=>Promise<ApplicationSyncV2Account>;bootstrap:()=>Promise<{accountId:string;syncV2:unknown;devices:import('./signing-keys').ApprovedLegacyDevice[]}>;allowLoopback?:boolean;now?:()=>number;clock?:TrustedClock}){
 const {account,host,repository}=options,received=await receiveApplicationIdentity(options);if(!received)return null;
 const {fetched,installed,origin}=received,accountScope=canonical([account.backendBaseUrl.replace(/\/+$/,''),account.userId]),libraryId=accountIdFromUserId(options.legacyDeviceId),content=accountContentKey(options.keys,account.userId),clock=options.clock??new TrustedClock();let closed=false;
 const assertCurrent=async()=>{if(closed)throw Error('feature_disabled');const current=await options.session();if(canonical([current.backendBaseUrl.replace(/\/+$/,''),current.userId])!==accountScope)throw Error('cloud_account_busy');return current;};
 const guardedHost:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{await assertCurrent();if(method==='secure.get'&&args.offset===undefined)return await readCloudSecure(host,String(args.key)) as T;return host<T>(method,args);};
 const identity={installed:async(descriptor:unknown)=>{await assertCurrent();if(digest(descriptor)!==digest(fetched.descriptor))throw Error('identity_conflict');return installed;}};
 // v1 initializes its metadata tables before the SQL source enumerates them.
 await repository.cloudRestoreMetadata({ids:[],limit:1});
 await WatchAccountBusinessSql.initializeSchema(projectionSql(guardedHost));
 const localFactory=watchLocalProjection({enabled:true,host:guardedHost,identity,descriptor:fetched.descriptor,scope:fetched.scope,libraryId,accountScope,metadata:repository});
 try{
  const local=await localFactory.open();if(!local)throw Error('feature_disabled');
  const crypto=createSyncV2Crypto(guardedHost),current=await content.current(),keys={id:unhex(installed.idKeyHex),content:current.key,version:current.version,readContentKey:async(v:number)=>(await content.at(v)).key};
  const resolveBody=articleBodyResolver({crypto,keys,scope:fetched.scope,read:id=>repository.cloudArticleBody(id)});
  const runtime=await watchSyncV2({enabled:true,indexWrite:true,origin,originPolicy:{accountBaseUrl:origin,allowLoopback:options.allowLoopback===true},host:guardedHost,transport:options.transport,local:localFactory,identity:async()=>{await assertCurrent();return installed;},contentKey:content.current,contentKeyAt:keys.readContentKey,bootstrap:options.bootstrap,session:async()=>{const a=await assertCurrent();return {userId:a.userId,accessToken:a.watchDeviceToken,legacyDeviceId:options.legacyDeviceId,scope:fetched.scope};},bodyResolver:resolveBody,clock,now:options.now}).open();
  if(!runtime)throw Error('feature_disabled');
  // Read/cache and recovery ports share the existing bounded P3 implementation.
  // No content worker is started and contentWrite remains false on this HTTP port.
  const ports=contentHostPorts(guardedHost,new AuthenticatedContentSessions()),db=projectionSql(guardedHost),binding={scope:fetched.scope,accountScope,libraryId},store=new WatchContentStore(db,localProjectionCipher(guardedHost,'content:'+digest(binding)),ports.files,binding);await store.init();
  const engine=new WatchContentEngine(store,new WatchContentHttp(runtime.http,crypto,options.now??Date.now,true),crypto,keys,{source:async()=>{throw Error('feature_disabled');},approved:runtime.approved,alias:'',assertCurrent:async()=>{await assertCurrent();},signals:async()=>ports.signals(false),yieldControl:()=>guardedHost('runtime.delay',{milliseconds:1})});
  const space=await watchSpaceV2({enabled:true,host:guardedHost,projection:local.store,content:engine,accountScope,trustedNow:()=>clock.now()});if(!space)throw Error('feature_disabled');
  const business=new WatchAccountBusinessSql(db,local.store,fetched.scope,keys.id,space.closures,accountBodyVerifier(runtime.http,crypto,keys,runtime.approved),space.recovery.ports.reserve);await business.initialize();
  const control=runtime.accountControl({business,recovery:space.recovery,trustedNow:()=>clock.now()});
  const round=async()=>{await assertCurrent();await runtime.refreshTrustedTime();const pending=await local.store.readState();if(pending.cloud?.pendingPublish)await runtime.publisher.flush();await ensureR0Scan(local);await local.store.beginTailWindow();await ensureR0Scan(local);await runtime.pull();const state=await local.store.readState();if(state.cloud?.pendingPublish)await runtime.publisher.flush();else if(!state.pendingChoice&&(state.hasUnsentEdits||!state.cloud?.lastPublication))await runtime.publish();};
  await round();
  const ui=new WatchSyncV2UiState({runtime:{pull:round,publish:()=>runtime.publish(),signingDeviceId:runtime.signingDeviceId},control,projection:local.store,trustedNow:()=>clock.now(),productErrors:true});
  return {ui,async close(){if(closed)return;closed=true;clock.clear();keys.id.fill(0);keys.content.fill(0);await localFactory.gate.close().catch(()=>{});await stopExistingProjection(projectionSql(options.cleanupHost??host));}};
 }catch(error){closed=true;await localFactory.gate.close().catch(()=>{});await stopExistingProjection(projectionSql(options.cleanupHost??host));clock.clear();throw productError(error);}
}
/** Internal compatibility codes stop at the application boundary. */
export function productError(error:unknown){return (error as Error)?.message==='clock_unknown'?Error('trusted_time_unavailable'):error;}
