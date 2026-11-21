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
import {MANUAL_INTENT_KEY,readManualIntent,completeManualIntent,manualEpochKey} from './manual-handoff';
import {cloudStatePort} from './state-sql';

export async function runSyncV2Background(context:BackgroundContext):Promise<BackgroundOutcome>{
 if(!context.request)return 'failure';
 const gate=new CloudGate(),window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>new CloudSyncDeadlineError()});
 const raw:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{try{return await context.request!('cloud.host',{method,args:secureCallsite(method,args)}) as T;}catch(error){throw cloudHostFailure(error,method);}};
 const bounded=windowedHost(raw,window),guard={require(){gate.require();if(context.isCancelled())throw Error('cloud_sync_suspended');}};
 const host:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{
  if(['cloud.release','secure.release','file.delete','file.closeText','crypto.closeSealedGzip'].includes(method))return window.cleanup(()=>raw<T>(method,args));
  guard.require();return bounded<T>(method,args);
 };
 const diagnostic=backgroundDiagnostics(raw);let cloudLease=false;
 try{
  if(!await gate.initialize(()=>raw('app.buildInfo',{})))return 'failure';
  const consent=await context.request('kv.get',{key:ONBOARDING_KEY}) as {exists:boolean;value?:unknown};
  if(startupDestination(new OnboardingStore({get:()=>consent.exists?consent.value:undefined,set:()=>{throw Error('consent_required');}}).load())!=='content')return 'success';
  const accounts=new WatchAccountStore({get:async key=>(await readCloudSecure(host,key))??null,set:(key,value)=>host('secure.set',{key,value}),remove:key=>host('secure.delete',{key}),exclusive:work=>withAccountLease(host,work)});
  const stored=await accounts.read();if(!stored)return 'success';
  const network=await host<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>('discovery.networkSnapshot',{});if(!network.active||!network.validated)return 'retry';
  const transport=createCloudTransport(host,guard),account=stored.watchRefreshToken?await new WatchTokenManager(accounts,{backendBaseUrl:stored.backendBaseUrl,transport,appVersion:watchAppVersion}).freshAccount():stored;
  const client=new WatchCloudClient(transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion},{sha256:async()=>{throw Error('unused');}},guard),bootstrap=await client.bootstrap();
  if(!bootstrap.syncV2)return 'success'; // No announcement never licenses v1.
  const payload=context.payload as {manual?:boolean;token?:string}|null;
  const saved=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY}),intent=readManualIntent(saved.value);
  if(payload?.manual&&(!intent||intent.token!==payload.token))return 'success';
  if(intent){const epoch=await cloudStatePort(host).get(manualEpochKey(account));if(intent.scope!==cloudAccountIdentity(account)||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch||intent.version===1&&!epoch)return 'success';}
  if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)return 'busy';cloudLease=true;
  const {db,libraryPorts}=await createBackgroundLibraryPorts(host,async key=>{const v=await context.request!('kv.get',{key}) as {exists:boolean;value?:unknown};return v.exists?v.value:undefined;},guard);
  const library=new SqlLibraryBodyRepository(db,libraryPorts);
  await accounts.ensureLibraryOwner(account,()=>library.hasLocalPrivateContent());
  // The worker keeps one bounded account transaction through crypto/network.
  // Logout/refresh cannot clear or replace the account between a file check and
  // publication. All exits release both native leases in cleanup time.
  return await withAccountLease(host,async()=>{
   const session=async()=>{const now=await accounts.read();if(!now||cloudAccountIdentity(now)!==cloudAccountIdentity(account))throw Error('cloud_account_busy');await accounts.assertLibraryOwner(now);return now;};
   await session();const deviceId=await library.deviceId(),ports=createCloudHostPorts(host,guard),foundation=ports.foundation(account.userId,deviceId,transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion,assertCurrent:async()=>{await session();}}),device=bootstrap.devices.find(d=>d.deviceId===deviceId);
   if(!device||device.revokedAt)return 'retry';
   const ready=await foundation.keys.acceptBootstrap(account.userId,deviceId,bootstrap.keyEnvelopes,bootstrap,device.attestation&&device.attestationKeyVersion?{keyVersion:device.attestationKeyVersion,mac:device.attestation}:undefined);
   if(ready!=='ready')return 'retry';
   const cleanup:CloudHostRequest=(method,args)=>window.cleanup(()=>raw(method,args));
   const opened=await openApplicationSyncV2Core({host,cleanupHost:cleanup,transport,account,legacyDeviceId:deviceId,repository:library,session,keys:foundation.keys,bootstrap:async()=>{await session();return {accountId:accountIdFromUserId(account.userId),syncV2:bootstrap.syncV2,devices:bootstrap.devices,libraryEpoch:bootstrap.libraryEpoch,contentGeneration:bootstrap.contentGeneration};},allowBodies:async()=>!!intent||network.wifi&&network.metered===false});
   try{if(!opened||opened.bodyError())return 'retry';if(intent)await completeManualIntent(host,intent);return 'success';}finally{await opened?.close();}
  });
 }catch(error){if(error instanceof CloudSyncDeadlineError)return 'retry';diagnostic.report(recordFailureDiagnostic(error));return 'retry';}
 finally{if(cloudLease)await window.cleanup(()=>raw('cloud.release',{}));await diagnostic.flush();}
}
