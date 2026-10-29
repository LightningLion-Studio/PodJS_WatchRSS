import {MANUAL_INTENT_KEY,readManualIntent,manualEpochKey,compareManualIntent,completeManualIntent} from './manual-handoff';
import {backgroundDiagnostics} from './background-diagnostic';
import {cloudAccountIdentity} from './identity';
import {CloudSyncDeadlineError} from './execution';
import {defineBackgroundHandler} from '@podjs/framework/background-handler';
import {CloudGate} from './gate';
import {OnboardingStore,ONBOARDING_KEY} from '../onboarding/store';
import {startupDestination} from '../onboarding/state';
import {createCloudRuntime} from './runtime';
import {createBackgroundLibrary} from './background-library';
import type {CloudHostRequest} from './host-ports';
export default defineBackgroundHandler(async context=>{
 if(!context.request)return 'failure';
 const gate=new CloudGate();
 const raw:CloudHostRequest=(method,args)=>context.request!('cloud.host',{method,args}) as Promise<any>;
 // This is the same app.buildInfo host method used by application.buildInfo().
 if(!await gate.initialize(()=>raw('app.buildInfo',{})))return 'success';
 // Headless workers cannot show consent. Check the same persisted versions as StartupGate.
 const consent=await context.request('kv.get',{key:ONBOARDING_KEY}) as {exists:boolean;value?:unknown};
 const onboarding=new OnboardingStore({get:()=>consent.exists?consent.value:undefined,set:()=>{throw Error('Worker cannot accept consent');}});
 if(startupDestination(onboarding.load())!=='content')return 'success';
 const guard={require(){gate.require();if(context.isCancelled())throw Error('Cloud worker cancelled');}};
 const host:CloudHostRequest=(method,args)=>{if(method!=='cloud.release'&&method!=='secure.release'&&method!=='file.delete')guard.require();return raw(method,args);};
 const diagnostic=backgroundDiagnostics(raw);
 let library:ReturnType<typeof createBackgroundLibrary>|undefined;
 // The host deadline is absolute Unix ms. Leave time for the normal
 // checkpoint/release path before the native guest's hard interrupt.
 const execution={remainingMillis:()=>Math.max(0,context.deadlineMs-10000-Date.now()),begin(){const check=()=>{if(Date.now()>=context.deadlineMs-10000)throw new CloudSyncDeadlineError();};check();return check;}};
 const runtime=createCloudRuntime(host,()=>library??=createBackgroundLibrary(host,async key=>{const r=await context.request!('kv.get',{key}) as {exists:boolean;value?:unknown};return r.exists?r.value:undefined;},guard),guard,undefined,undefined,execution,{recordDiagnostic:diagnostic.report,formatDiagnostic:diagnostic.report});
 const account=await runtime.accounts.read();if(!account)return 'success';
 const payload=context.payload as {manual?:boolean;token?:string}|null;
 let intent:ReturnType<typeof readManualIntent>;
 // Periodic work may win the writer lease before the dedicated manual job.
 // Honor a live manual grant's exact mode in either entry path.
 {const stored=await host<{exists:boolean;value?:string}>('secure.get',{key:MANUAL_INTENT_KEY});intent=readManualIntent(stored.value);
  if(payload?.manual&&(!intent||intent.token!==payload.token))return 'success';
  if(intent){
  const epoch=await host<{exists:boolean;value?:string}>('secure.get',{key:manualEpochKey(account)});
  if(intent.scope!==cloudAccountIdentity(account)||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch.value||intent.version===1&&!epoch.value){await completeManualIntent(host,intent);return 'success';}
  if(intent.version===1||intent.epoch===null&&epoch.value){intent={...intent,version:2,epoch:epoch.value??null};if(!await compareManualIntent(host,stored.value,JSON.stringify(intent)))return 'success';}
  }
 }
 let success:boolean;try{success=await runtime.service.syncNow(!!intent,intent?.mode);}finally{await diagnostic.flush();}
 if(success&&intent)await completeManualIntent(host,intent);
 return success||runtime.service.status.retryable===false?'success':'retry';
});
