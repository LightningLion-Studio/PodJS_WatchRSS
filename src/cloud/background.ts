import {idleHost,idleHit,takeIdleCounts,timerSite} from '../diagnostics/idle-counters';
import {sqlRequestSite} from '../diagnostics/sql-sites';
import {secureCallsite} from './secure-callsite';
import {restoreCallsiteTrace} from './restore-callsite';
import {observeCpuWork,pulseCpuWork} from '@podjs/framework/cpu-work';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
import {MANUAL_INTENT_KEY,readManualIntent,manualEpochKey,compareManualIntent,completeManualIntent} from './manual-handoff';
import {backgroundDiagnostics} from './background-diagnostic';
import {cloudAccountIdentity} from './identity';
import {CloudSyncDeadlineError,CLOUD_HOST_CAPABILITY_UNAVAILABLE} from './execution';
import {cloudHostFailure} from './host-capability';
import {recordFailureDiagnostic} from './record-diagnostic';
import {defineBackgroundHandler,type BackgroundOutcome,type BackgroundContext} from '@podjs/framework/background-handler';
import {CloudGate} from './gate';
import {OnboardingStore,ONBOARDING_KEY} from '../onboarding/store';
import {startupDestination} from '../onboarding/state';
import {createCloudRuntime} from './runtime';
import {createBackgroundLibrary} from './background-library';
import type {CloudHostRequest} from './host-ports';
import {cloudStatePort} from './state-sql';
import {SnapshotYieldBudget,SNAPSHOT_GUARD_VERSION} from './snapshot-deferral';
const yieldHosts=new WeakMap<BackgroundContext,CloudHostRequest>();
/** Retry metadata is emitted only after the coordinator certified a new durable
 * unit and a soft deadline. Network errors, suspension and stalled runs do not
 * receive a fast continuation. The next guest revalidates the original grant. */
export function cloudBackgroundOutcome(success:boolean,authorized:boolean,status:{errorCode?:string;retryable?:boolean;continuationReady?:boolean;yieldedToWriter?:boolean}):BackgroundOutcome{
 if(!success&&status.yieldedToWriter)return 'busy';
 if(!success&&status.errorCode===CLOUD_HOST_CAPABILITY_UNAVAILABLE)return 'failure';
 if(!success&&['cloud_snapshot_progress_stalled','cloud_snapshot_work_timeout'].includes(status.errorCode??''))return {status:'retry',retryClass:'bounded'};
 if(!success&&authorized&&status.continuationReady)return {status:'retry',progress:true};
 return success||status.retryable===false?'success':'retry';
}
export default defineBackgroundHandler(async context=>{
 if(!context.request)return 'failure';
 const gate=new CloudGate();
 const yieldBudget=new SnapshotYieldBudget();
 const callsites=restoreCallsiteTrace();
 let rejected:unknown;let buildIdentity='unknown';
 let idleLast=Date.now();
 const request:CloudHostRequest=async(method,args)=>{try{
  idleHost(method);const now=Date.now();if(now-idleLast>=30000){const elapsedMs=Math.min(300000,now-idleLast);idleLast=now;const counts=takeIdleCounts();try{await context.request!('cloud.host',{method:'log.append',args:{path:'app_log.txt',text:JSON.stringify({event:'idle-counters',version:2,elapsedMs,counts})+'\n',maxBytes:5*1024*1024}});}catch{}}
  if(method.startsWith('sql.'))args={...args,diagnosticSite:sqlRequestSite(args)};
  if(method==='runtime.delay'){pulseCpuWork();await diagnostic.flushCpu();}yieldBudget.before(method,args);callsites.observe(args);const value=await context.request!('cloud.host',{method,args:secureCallsite(method,args)});yieldBudget.completed(method,args);idleHit(105);if(method==='runtime.delay')idleHit(70+timerSite(args.milliseconds));if(method==='app.buildInfo'&&value&&typeof (value as {buildIdentity?:unknown}).buildIdentity==='string')buildIdentity=(value as {buildIdentity:string}).buildIdentity;return value as any;}catch(error){const failure=cloudHostFailure(error,method);if((failure as {code?:unknown})?.code===CLOUD_HOST_CAPABILITY_UNAVAILABLE)rejected=failure;throw failure;}};
 const diagnostic=backgroundDiagnostics(request);
 const stopCpu=observeCpuWork(diagnostic.cpu);
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>new CloudSyncDeadlineError(),report:metric=>diagnostic.report(JSON.stringify(metric))});
 const bounded=windowedHost(request,window);let running=false;
 const raw:CloudHostRequest=(method,args)=>(running?bounded:request)(method,args);
 try{
 // This is the same app.buildInfo host method used by application.buildInfo().
 if(!await gate.initialize(()=>raw('app.buildInfo',{}))){if(rejected)throw rejected;return 'success';}
 // Headless workers cannot show consent. Check the same persisted versions as StartupGate.
 const consent=await context.request('kv.get',{key:ONBOARDING_KEY}) as {exists:boolean;value?:unknown};
 const onboarding=new OnboardingStore({get:()=>consent.exists?consent.value:undefined,set:()=>{throw Error('Worker cannot accept consent');}});
 if(startupDestination(onboarding.load())!=='content')return 'success';
 const guard={require(){gate.require();if(context.isCancelled())throw Error('Cloud worker cancelled');}};
 const host:CloudHostRequest=(method,args)=>{if(method!=='cloud.release'&&method!=='secure.release'&&method!=='file.delete'&&method!=='file.closeText'&&method!=='crypto.closeSealedGzip')guard.require();return raw(method,args);};
 yieldHosts.set(context,host);
 let library:ReturnType<typeof createBackgroundLibrary>|undefined;
 // The host deadline is absolute Unix ms. Leave time for the normal
 // checkpoint/release path before the native guest's hard interrupt.
 const execution={finishRequest:(async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{if(!['secure.get','secure.compareAndSet','sql.query','sql.execute','sql.transaction'].includes(method))throw Error('invalid_window_finalizer');return window.cleanup(()=>request<T>(method,args));}) as CloudHostRequest,remainingMillis:()=>window.remainingMillis(),begin(){const check=()=>{if(window.remainingMillis()<=0||Date.now()>=context.deadlineMs-10000)throw new CloudSyncDeadlineError();};check();return check;}};
 const runtime=createCloudRuntime(host,()=>library??=createBackgroundLibrary(host,async key=>{const r=await context.request!('kv.get',{key}) as {exists:boolean;value?:unknown};return r.exists?r.value:undefined;},guard),guard,undefined,async()=>{try{await host('sql.notify',{topic:'watchrss-library'});}catch{/* Data is committed. Foreground resume refreshes if the worker deadline prevents notification. */}},execution,{restoreReceipt:id=>callsites.receipt(id),restoreGuardVersion:SNAPSHOT_GUARD_VERSION+':'+buildIdentity,restoreStalled:value=>yieldBudget.stalled(value),recordDiagnostic:diagnostic.report,formatDiagnostic:diagnostic.report});
 const account=await runtime.accounts.read();if(!account)return 'success';
 const payload=context.payload as {manual?:boolean;token?:string}|null;
 let intent:ReturnType<typeof readManualIntent>;
 // Periodic work may win the writer lease before the dedicated manual job.
 // Honor a live manual grant's exact mode in either entry path.
 {const stored=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});intent=readManualIntent(stored.value);
  if(payload?.manual&&(!intent||intent.token!==payload.token))return 'success';
  if(intent){
  if(intent.scope!==cloudAccountIdentity(account)){await completeManualIntent(host,intent);return 'success';}
  const epoch={value:await cloudStatePort(host).get(manualEpochKey(account))};
  if(intent.scope!==cloudAccountIdentity(account)||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch.value||intent.version===1&&!epoch.value){await completeManualIntent(host,intent);return 'success';}
  if(intent.version===1||intent.epoch===null&&epoch.value){intent={...intent,version:2,epoch:epoch.value??null};if(!await compareManualIntent(host,stored.value,JSON.stringify(intent)))return 'success';}
  }
 }
 running=window.remainingMillis()>1000;
 const success=await runtime.service.syncNow(!!intent,intent?.mode);
 if(success&&intent)await completeManualIntent(host,intent);
 // A deterministic missing host capability needs a fixed package, not a false
 // successful restore or an unbounded retry of the same manual grant.
 return cloudBackgroundOutcome(success,!!intent,runtime.service.status);
 }catch(error){if(error instanceof CloudSyncDeadlineError)return 'retry';if((error as {code?:unknown})?.code!==CLOUD_HOST_CAPABILITY_UNAVAILABLE)throw error;diagnostic.report(recordFailureDiagnostic(error));return 'failure';}
 finally{stopCpu();try{await diagnostic.flush();if(running)try{await request('log.append',{path:'app_log.txt',text:' [I] CloudRestore '+JSON.stringify(callsites.summary())+'\n',maxBytes:5*1024*1024});}catch{/* Diagnostics cannot change restore outcome. */}}finally{yieldHosts.delete(context);}}
},{yieldTurn:async context=>{
 if(context.isCancelled())throw Error('Cloud worker cancelled');
 if(Date.now()>=context.deadlineMs-10000)throw new CloudSyncDeadlineError();
 try{const host=yieldHosts.get(context);if(host)await host('runtime.delay',{milliseconds:1});else await context.request!('cloud.host',{method:'runtime.delay',args:{milliseconds:1}});}catch(error){throw cloudHostFailure(error,'runtime.delay');}
}});
