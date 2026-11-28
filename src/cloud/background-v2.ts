/** P6 headless control + v2 business + independent bodies. Never opens a
 * legacy business snapshot/records service. Selected at build time. */
import type {BackgroundContext,BackgroundOutcome} from '@podjs/framework/background-handler';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
import {CloudGate} from './gate';
import {createCloudHostPorts,type CloudHostRequest} from './host-ports';
import {createCloudTransport} from './transport';
import {WatchCloudClient} from './client';
import {readCloudSecure} from './secure-read';
import {secureCallsite} from './secure-callsite';
import {CloudSyncDeadlineError} from './execution';
import {isTransportFailure} from '../network/recovery';
import {SyncV2Error} from '../sync-v2/http';
import type {SyncV2RoundResult} from '../sync-v2/product-start';
import {cloudHostFailure} from './host-capability';
import {backgroundDiagnostics} from './background-diagnostic';
import {recordFailureDiagnostic} from './record-diagnostic';
import {WatchAccountStore} from '../account/store';
import {WatchTokenManager} from '../account/token';
import {withAccountLease} from '../account/lease';
import {cloudAccountIdentity} from './identity';
import {OnboardingStore,ONBOARDING_KEY} from '../onboarding/store';
import {startupDestination} from '../onboarding/state';
import {createBackgroundLibraryPorts} from './background-library-ports';
import {SqlLibraryBodyRepository} from '../sync/library-body-repository';
import {watchAppVersion} from '../core/app-version';
import {openApplicationSyncV2Core} from '../sync-v2/application-core';
import {accountIdFromUserId} from '../sync-v2/signing';
import {MANUAL_INTENT_KEY,type ManualIntent,readManualIntent,completeManualIntent,manualEpochKey} from './manual-handoff';
import {SyncProgress} from './sync-progress';
import {cloudStatePort} from './state-sql';

function retryableV2Background(error:unknown){
 const code=(error as {code?:string;message?:string}|null)?.code??(error as Error|null)?.message;
 if(code&&['cloud_v2_read_only','cloud_v2_pending','choice_pending','body_channel_source_missing','body_channel_capacity_pending','replay_detected'].includes(code))return false;
 return error instanceof CloudSyncDeadlineError||isTransportFailure(error)||error instanceof SyncV2Error&&error.retryable||
  !!code&&['body_channel_waiting_wifi','body_channel_pending','body_channel_bluetooth_pending','body_channel_source_pending','network_error','network_timeout','transport_error','cloud_account_busy','cloud_sync_suspended','window_expired','projection_preparing','first_follow_pending','ref_conflict','choice_stale'].includes(code);
}

export async function finishSyncV2Background(result:SyncV2RoundResult,complete:()=>Promise<unknown>):Promise<BackgroundOutcome>{
 if(result.chunked)return {status:'retry',progress:true};
 if(result.completionError&&retryableV2Background(Error(result.completionError)))return 'retry';
 await complete();
 return result.completionError?'failure':'success';
}

export async function runSyncV2Background(context:BackgroundContext):Promise<BackgroundOutcome>{
 if(!context.request)return 'failure';
 const gate=new CloudGate(),window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>new CloudSyncDeadlineError()});
 const raw:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{try{return await context.request!('cloud.host',{method,args:secureCallsite(method,args)}) as T;}catch(error){throw cloudHostFailure(error,method);}};
 const bounded=windowedHost(raw,window),guard={require(){gate.require();if(context.isCancelled())throw Error('cloud_sync_suspended');}};
 const host:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{
  if(['cloud.release','secure.release','file.delete','file.closeText','crypto.closeSealedGzip'].includes(method))return window.cleanup(()=>raw<T>(method,args));
  guard.require();return bounded<T>(method,args);
 };
 const diagnostic=backgroundDiagnostics(raw);let cloudLease=false,summary:string|undefined,intent:ManualIntent|undefined;
 const complete=async()=>{if(intent)await completeManualIntent(host,intent);};
 const progress=new SyncProgress(Date.now,()=>()=>{},line=>{summary=line;},'background');
 try{
  if(!await gate.initialize(()=>raw('app.buildInfo',{})))return 'failure';
  const consent=await context.request('kv.get',{key:ONBOARDING_KEY}) as {exists:boolean;value?:unknown};
  if(startupDestination(new OnboardingStore({get:()=>consent.exists?consent.value:undefined,set:()=>{throw Error('consent_required');}}).load())!=='content')return 'success';
  const accounts=new WatchAccountStore({get:async key=>(await readCloudSecure(host,key))??null,set:(key,value)=>host('secure.set',{key,value}),remove:key=>host('secure.delete',{key}),exclusive:work=>withAccountLease(host,work)});
  const stored=await accounts.read();if(!stored)return 'success';
  progress.start();
  const network=await host<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>('discovery.networkSnapshot',{});if(!network.active||!network.validated)return 'retry';
  const transport=createCloudTransport(host,guard,{progress:()=>progress,reuseInputName:true}),account=stored.watchRefreshToken?await new WatchTokenManager(accounts,{backendBaseUrl:stored.backendBaseUrl,transport,appVersion:watchAppVersion}).freshAccount():stored;
  progress.stage('keys');
  const client=new WatchCloudClient(transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion},{sha256:async()=>{throw Error('unused');}},guard),bootstrap=await client.bootstrap();
  if(!bootstrap.syncV2)return 'success'; // No announcement never licenses v1.
  const payload=context.payload as {manual?:boolean;token?:string}|null;
  const saved=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});intent=readManualIntent(saved.value);
  if(payload?.manual&&(!intent||intent.token!==payload.token))return 'success';
  if(intent){const epoch=await cloudStatePort(host).get(manualEpochKey(account));if(intent.scope!==cloudAccountIdentity(account)||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch||intent.version===1&&!epoch)return 'success';}
  if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)return 'busy';cloudLease=true;
  const {db,libraryPorts,initialize}=await createBackgroundLibraryPorts(host,async key=>{const v=await context.request!('kv.get',{key}) as {exists:boolean;value?:unknown};return v.exists?v.value:undefined;},guard,true);
  const library=new SqlLibraryBodyRepository(db,libraryPorts);
  await accounts.ensureLibraryOwner(account,async()=>{await initialize();return library.hasLocalPrivateContent();});
  // The worker keeps one bounded account transaction through crypto/network.
  // Logout/refresh cannot clear or replace the account between a file check and
  // publication. All exits release both native leases in cleanup time.
  return await withAccountLease(host,async()=>{
   let cachedSession:{account:typeof account;at:number}|undefined;
   const session=async()=>{
    const nowMs=Date.now();
    if(cachedSession&&nowMs-cachedSession.at<1000)return cachedSession.account;
    const now=await accounts.read();if(!now||cloudAccountIdentity(now)!==cloudAccountIdentity(account))throw Error('cloud_account_busy');await accounts.assertLibraryOwner(now);
    cachedSession={account:now,at:Date.now()};
    return now;
   };
   await session();
   const tables=await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_local_identity','library_clear_journal')");
   if(tables.some(t=>t.name==='library_clear_journal')&&(await db.query('SELECT 1 FROM library_clear_journal WHERE id=1')).length)throw Error('cloud_sync_suspended');
   const installedDevice=tables.some(t=>t.name==='sync_local_identity')?(await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id:undefined;
   const deviceId=typeof installedDevice==='string'&&installedDevice?installedDevice:await initialize().then(()=>library.deviceId());
   const ports=createCloudHostPorts(host,guard),foundation=ports.foundation(account.userId,deviceId,transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion,assertCurrent:async()=>{await session();}}),device=bootstrap.devices.find(d=>d.deviceId===deviceId);
   if(!device||device.revokedAt){await complete();return 'failure';}
   const ready=await foundation.keys.acceptBootstrap(account.userId,deviceId,bootstrap.keyEnvelopes,bootstrap,device.attestation&&device.attestationKeyVersion?{keyVersion:device.attestationKeyVersion,mac:device.attestation}:undefined);
   if(ready!=='ready'){await complete();return 'failure';}
   const cleanup:CloudHostRequest=(method,args)=>window.cleanup(()=>raw(method,args));
   progress.stage('compare');
   const opened=await openApplicationSyncV2Core({singleRound:true,prepareLibrary:initialize,progress:()=>progress,remainingMillis:()=>window.remainingMillis(),host,cleanupHost:cleanup,transport,account,legacyDeviceId:deviceId,repository:library,session,keys:foundation.keys,bootstrap:async()=>{await session();return {accountId:accountIdFromUserId(account.userId),syncV2:bootstrap.syncV2,devices:bootstrap.devices,libraryEpoch:bootstrap.libraryEpoch,contentGeneration:bootstrap.contentGeneration};},allowBodies:async()=>!!intent||network.wifi&&network.metered===false});
   try{
    const result=opened?.initialResult??{completionError:'cloud_v2_repo_missing'};
    if(result.completionError&&!result.chunked)diagnostic.report(recordFailureDiagnostic(Error(result.completionError)));
    const outcome=await finishSyncV2Background(result,complete);
    if(outcome==='success')progress.finish('complete');
    return outcome;
   }finally{await opened?.close();}
  });
 }catch(error){
  if(error instanceof CloudSyncDeadlineError)return 'retry';
  diagnostic.report(recordFailureDiagnostic(error));
  if(retryableV2Background(error))return 'retry';
  await complete().catch(cause=>{diagnostic.report(recordFailureDiagnostic(cause));});
  return 'failure';
 }
 finally{if(cloudLease)await window.cleanup(()=>raw('cloud.release',{}));await diagnostic.flush();progress.finish('incomplete');
  if(summary)await window.cleanup(()=>raw('log.append',{path:'app_log.txt',text:new Date().toISOString()+' [I] CloudSyncRound '+summary+'\n',maxBytes:5*1024*1024})).catch(()=>{});
 }
}
