import {cloudStatePort} from './state-sql';
import {appLogger} from '../logs/app-logger';
import {CloudVisibility} from './visibility';
import {CloudManualHandoff,manualEpochKey} from './manual-handoff';
import {localTransferActivity} from '../sync/local-transfer';
import {cloudAccountIdentity} from './identity';
import {CloudForegroundExecution} from './execution';
import {hostOperation,delay,onNetworkChange,displayPower,onSqlChanged} from '@podjs/framework/services';
import {lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import {subscribeLibraryMutations} from '../core/library-mutations';
import {initializeCloudHost} from './host';
import {cloudGate} from './gate';
import {summaryAccountStore} from '../llm/runtime';
import {getLibrarySyncRepository,notifyLibraryChanged,notifyNotesChanged,services} from '../services';
import {createCloudRuntime} from './runtime';
import {WatchCloudScheduler} from './scheduler';
import {idleApproval,type CloudApprovalController} from './approval-controller';
import {idleApprover,CloudApproverController} from './approver-controller';
import {createApproverCrypto} from './approver-crypto';
import {connectCloudAccountStatus,notifyCloudAccountStatus} from './status';
let owner:ReturnType<typeof start>|undefined;let approvalPageActive=false;
const approvalListeners=new Set<()=>void>(),approverListeners=new Set<()=>void>(),handoffListeners=new Set<()=>void>();
const notifyApproval=()=>{for(const fn of approvalListeners)try{fn();}catch{}};
function start(){
 let handoff:CloudManualHandoff|undefined;
 const visibility=new CloudVisibility(lifecycle());
 const execution=new CloudForegroundExecution(lifecycle()==='active'&&!localTransferActivity.active);
 let disposed=false,initialized=false,scheduler:WatchCloudScheduler|undefined,runtime:ReturnType<typeof createCloudRuntime>|undefined,approvals:CloudApprovalController|undefined,pageActive=approvalPageActive,polling=false,cancelPoll=()=>{};
 let approver:CloudApproverController|undefined,cancelApproverPoll=()=>{};
 const cleanups:(()=>void)[]=[onSqlChanged('watchrss-library',()=>{notifyLibraryChanged('remote');notifyNotesChanged();})];
 function armApprover(){cancelApproverPoll();cancelApproverPoll=()=>{};if(disposed||!pageActive||!approver?.active)return;const timer=delay(5000);cancelApproverPoll=()=>timer.cancel();void timer.result.then(async()=>{if(disposed||!pageActive||!approver?.active)return;await approver.poll();armApprover();}).catch(()=>{});}
 const updateExecution=()=>execution.foreground(visibility.active&&!localTransferActivity.active);
 const updateVisibility=()=>{updateExecution();approver?.setForeground(visibility.active&&!localTransferActivity.active);armApprover();scheduler?.foreground(initialized&&visibility.active);handoff?.foregroundChanged(visibility.active);};
 cleanups.push(onLifecycleChange(state=>{visibility.lifecycle(state);updateVisibility();}),localTransferActivity.subscribe(active=>{updateExecution();approver?.setForeground(visibility.active&&!active);armApprover();scheduler?.hold(active);handoff?.localTransferChanged(active);}));
 const arm=()=>{cancelPoll();cancelPoll=()=>{};if(disposed||!approvals?.active||!['pending','code'].includes(approvals.state.phase))return;const timer=delay(1500);cancelPoll=()=>timer.cancel();void timer.result.then(async()=>{if(polling||disposed||!approvals?.active)return;polling=true;try{await approvals.poll();}finally{polling=false;arm();}}).catch(()=>{});};
 const foreground=()=>{approvals?.setForeground(pageActive&&lifecycle()==='active');approver?.setForeground(visibility.active&&!localTransferActivity.active);arm();armApprover();};
 const ready=(async()=>{
  if(!await initializeCloudHost()||disposed)return;
  const guard={require(){cloudGate.require();if(disposed)throw Error('Cloud runtime disposed');}};
  const host=<T>(method:string,args:Record<string,unknown>)=>{if(method!=='cloud.release'&&method!=='secure.release'&&method!=='file.delete')guard.require();return hostOperation<T>(method,args).result;};
  runtime=createCloudRuntime(host,getLibrarySyncRepository,guard,summaryAccountStore,()=>{notifyLibraryChanged('remote');notifyNotesChanged();},execution,{approver:(open,crypto)=>new CloudApproverController({open,crypto:createApproverCrypto(crypto)}),recordDiagnostic:value=>appLogger.i('CloudRecords',value),formatDiagnostic:value=>appLogger.i('CloudFormat',value)});approvals=runtime.approvals;approver=runtime.approver;foreground();if(approver)cleanups.push(approver.subscribe(()=>{for(const fn of approverListeners)try{fn();}catch{}armApprover();}));cleanups.push(approvals.subscribe(()=>{notifyApproval();arm();}));
  scheduler=new WatchCloudScheduler({sync:async(requestedManual,requestedMode)=>{const grant=await handoff?.authorized();if(requestedManual&&!grant)return false;const manual=!!grant,mode=grant?.mode??requestedMode;const complete=manual?handoff?.captureCompletion():undefined;const result=await runtime!.service.syncNow(manual,mode);await complete?.(result);if(result&&approver?.active)void approver.poll();if(grant&&runtime!.service.status.continuationReady)await handoff?.progress(grant);if(runtime!.service.status.retryable===false)await scheduler?.setUpgradeRequired(true);else if(result||runtime!.service.status.continuationReady)await scheduler?.setUpgradeRequired(false);const retry=runtime!.service.status.retryAtMillis;if(retry)scheduler?.deferUntil(retry,manual?mode:undefined);return result;},now:Date.now,delay:(ms,fn)=>{const timer=delay(ms);void timer.result.then(fn).catch(()=>{});return()=>timer.cancel();},scheduleWorker:()=>host<void>('cloud.schedule',{}),cancelWorker:()=>host<void>('cloud.cancel',{})},guard);
  const epochStore=cloudStatePort(host);
  handoff=new CloudManualHandoff(host,async()=>{const account=await summaryAccountStore.read();return account?cloudAccountIdentity(account):undefined;},mode=>scheduler!.manual(mode),Date.now,async()=>{const account=await summaryAccountStore.read();if(!account)return;return epochStore.get(manualEpochKey(account));});
  cleanups.push(handoff.subscribe(()=>{for(const fn of handoffListeners)try{fn();}catch{}}));
  handoff.foregroundChanged(visibility.active);handoff.localTransferChanged(localTransferActivity.active);
  scheduler.hold(localTransferActivity.active);
  let identity='',accountId='',accountScope='';
  cleanups.push(connectCloudAccountStatus(()=>cloudGate.allowed&&!disposed?{...runtime!.service.status,accountId,accountScope}:undefined),runtime.service.subscribe(notifyCloudAccountStatus));
  const account=async()=>{const state=await summaryAccountStore.read(),next=cloudAccountIdentity(state);if(disposed||next===identity)return;handoff?.accountChanged();identity=next;accountId=state?.userId??'';accountScope=JSON.stringify([state?.backendBaseUrl.replace(/\/+$/,''),state?.userId]);runtime!.service.reset();approvals?.reset();approver?.reset();await runtime!.inspectOwner();if(disposed||identity!==next)return;await handoff?.restore(false);if(disposed||identity!==next)return;scheduler?.accountChanged();if(visibility.active)void handoff?.restore().catch(()=>{});};
  cleanups.push(summaryAccountStore.subscribe(()=>{void account().catch(()=>{});}),subscribeLibraryMutations(()=>scheduler?.trigger("library")),services.subscribeChannel(e=>{if(e.kind!=='notes'&&e.origin!=='remote')scheduler?.trigger('channel');}),onNetworkChange(()=>scheduler?.trigger("network")),onLifecycleChange(state=>{foreground();if(state==='active')notifyLibraryChanged('remote');}));
  let displayRevision=0;cleanups.push(displayPower.onChange(state=>{displayRevision++;visibility.display(state);updateVisibility();}));
  const revision=displayRevision,display=await displayPower.state();if(disposed)return;if(revision===displayRevision){visibility.display(display);updateVisibility();}
  await account();if(disposed)return;initialized=true;scheduler.foreground(visibility.active);if(pageActive&&approver?.active)void approver.poll();await scheduler.start(true);
 })();void ready.catch(()=>{});
 return {ready,get approvalState(){return approvals?.state??idleApproval();},get approverState(){return approver?.state??idleApprover();},async pollApprover(){await ready;return !disposed&&!!approver&&approver.poll();},async acceptApprover(id:string){await ready;return !disposed&&!!approver&&approver.accept(id);},async confirmApprover(match:boolean){return !disposed&&!!approver&&approver.confirm(match);},async cancelApprover(){return !disposed&&!!approver&&approver.cancel();},setApprovalForeground(active:boolean){const opened=active&&!pageActive;pageActive=active;foreground();if(opened&&approver?.active)void approver.poll();},async requestApproval(){await ready;return !disposed&&!!approvals&&approvals.request();},async confirmApproval(matches:boolean){return !disposed&&!!approvals&&approvals.confirmMatches(matches);},async cancelApproval(){return !disposed&&!!approvals&&approvals.cancel();},resetApproval(){approvals?.reset();approver?.reset();},async reregister(confirmed:boolean){await ready;if(disposed||!runtime)throw Error('client_upgrade_required');const result=await runtime.reregister(confirmed);runtime.service.reset();void handoff?.manual().catch(()=>{});return result;},async ownerResolved(){await ready;if(!disposed&&runtime){await runtime.inspectOwner();await scheduler?.setUpgradeRequired(false);}},get handoffState(){return handoff?.state??{phase:'idle' as const};},manual:async(mode:'all'|'recent128'='recent128')=>{await ready;return handoff?.manual(mode)??false;},dispose(){handoff?.localTransferChanged(false);disposed=true;handoff?.dispose();cancelPoll();cancelApproverPoll();approvals?.reset();approver?.reset();scheduler?.dispose();for(const off of cleanups)off();}};
}
export function startApplicationCloudSync(){return owner??=start();}
export function stopApplicationCloudSync(){owner?.dispose();owner=undefined;}
export function manualCloudSync(mode:'all'|'recent128'='recent128'){cloudGate.require();return owner?.manual(mode)??Promise.resolve(false);}
export const applicationCloudApproval={get state(){return owner?.approvalState??idleApproval();},subscribe(fn:()=>void){approvalListeners.add(fn);return()=>{approvalListeners.delete(fn);};},request(){return startApplicationCloudSync().requestApproval();},confirmMatches(matches:boolean){return owner?.confirmApproval(matches)??Promise.resolve(false);},cancel(){return owner?.cancelApproval()??Promise.resolve(false);},setForeground(active:boolean){approvalPageActive=active;owner?.setApprovalForeground(active);}};
export const applicationCloudApprover={get state(){return owner?.approverState??idleApprover();},subscribe(fn:()=>void){approverListeners.add(fn);return()=>{approverListeners.delete(fn);};},poll(){return startApplicationCloudSync().pollApprover();},accept(requestId:string){return startApplicationCloudSync().acceptApprover(requestId);},confirm(match:boolean){return owner?.confirmApprover(match)??Promise.resolve(false);},cancel(){return owner?.cancelApprover()??Promise.resolve(false);},setForeground(active:boolean){applicationCloudApproval.setForeground(active);}};
/** Local confirmation is mandatory; a clear action must supply the complete local-library cleanup. */
export const applicationCloudActions={async logout(){owner?.resetApproval();await summaryAccountStore.clear();},async resolveOwner(choice:'clear'|'merge',confirmed:boolean,clearLocal?:()=>Promise<void>){if(!confirmed)throw Error('explicit_owner_choice_required');const account=await summaryAccountStore.read();if(!account)throw Error('account_missing');await summaryAccountStore.resolveLibraryOwner(account,choice,clearLocal);await owner?.ownerResolved();void owner?.manual().catch(()=>{});},reregister(confirmed:boolean){if(!confirmed)return Promise.reject(Error('device_reregistration_requires_confirmation'));return startApplicationCloudSync().reregister(true);}};

/** UI hook: OS scheduling is best effort; queued does not claim worker completion. */
export const applicationCloudHandoff={subscribe(fn:()=>void){handoffListeners.add(fn);return()=>{handoffListeners.delete(fn);};},get state(){return owner?.handoffState??{phase:'idle' as const};},async workerState(){cloudGate.require();return hostOperation<{state:string}>('cloud.workState',{}).result;}};
