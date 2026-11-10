import {cloudStatePort} from './state-sql';
import {appLogger} from '../logs/app-logger';
import {CloudVisibility} from './visibility';
import {CloudManualHandoff,manualEpochKey} from './manual-handoff';
import {localTransferActivity} from '../sync/local-transfer';
import {cloudAccountIdentity} from './identity';
import {CloudForegroundExecution,CloudSyncBudget,cloudRunHost} from './execution';
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
import {SYNC_V2_PRODUCT} from '../sync-v2/gate';
import {watchSyncV2Product,leasedSyncV2Session} from '../sync-v2/product-start';
import {createCloudTransport} from './transport';
let owner:ReturnType<typeof start>|undefined;let approvalPageActive=false;
const approvalListeners=new Set<()=>void>(),approverListeners=new Set<()=>void>(),handoffListeners=new Set<()=>void>();
const notifyApproval=()=>{for(const fn of approvalListeners)try{fn();}catch{}};
function start(){
 let handoff:CloudManualHandoff|undefined;
 const visibility=new CloudVisibility(lifecycle());
 const execution=new CloudForegroundExecution(lifecycle()==='active'&&!localTransferActivity.active);
 let disposed=false,initialized=false,scheduler:WatchCloudScheduler|undefined,runtime:ReturnType<typeof createCloudRuntime>|undefined,approvals:CloudApprovalController|undefined,pageActive=approvalPageActive,polling=false,cancelPoll=()=>{};
 let approver:CloudApproverController|undefined,cancelApproverPoll=()=>{};
 let syncV2:ReturnType<typeof watchSyncV2Product<import('../ui/sync-v2-view.ts').SyncV2UiPort>>|undefined,syncV2Ready:Parameters<NonNullable<import('./service').CloudSyncPorts['keysReady']>>[0]|undefined;
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
  // 26.4 P6-10: off by default. Off => no keysReady hook, no v2 request, no UI port.
  let heldKeys=new Map<number,Uint8Array>(),v2Tail:Promise<unknown>=Promise.resolve(),v2Current:(()=>void)|undefined;
  const v2Guard={require(){guard.require();if(!v2Current)throw Error('feature_disabled');v2Current();}},v2Host=cloudRunHost(host,()=>v2Guard.require());
  const v2Exclusive=<T>(work:()=>Promise<T>)=>{const next=v2Tail.then(async()=>{guard.require();const current=execution.begin(),budget=new CloudSyncBudget();if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)throw Error('cloud_account_busy');v2Current=()=>{current();budget.check();};try{v2Current();return await work();}finally{v2Current=undefined;await host('cloud.release',{});}});v2Tail=next.catch(()=>{});return next;};
  const clearV2Keys=()=>{for(const key of heldKeys.values())key.fill(0);heldKeys.clear();};cleanups.push(clearV2Keys);
  syncV2=watchSyncV2Product({enabled:SYNC_V2_PRODUCT.syncV2,drainOnStop:true,announced:async()=>!!syncV2Ready?.syncV2,install:installApplicationSyncV2Ui,open:async()=>{
   const ready=syncV2Ready,account=await summaryAccountStore.read();if(!ready||!account||account.userId!==ready.userId)return null;
   const {accountBoundCasHost}=await import('../sync-v2/product'),accountHost=accountBoundCasHost(v2Host,account,()=>summaryAccountStore.read());
   const transport=createCloudTransport(accountHost,v2Guard),tokens=new (await import('../account/token')).WatchTokenManager(summaryAccountStore,{backendBaseUrl:account.backendBaseUrl,transport});
   const session=async()=>{const current=await tokens.freshAccount();if(cloudAccountIdentity(current)!==cloudAccountIdentity(account))throw Error('cloud_account_busy');await summaryAccountStore.assertLibraryOwner(current);return current;};
   const {openApplicationSyncV2}=await import('../sync-v2/application-open');
   const opened=await v2Exclusive(async()=>openApplicationSyncV2({host:accountHost,cleanupHost:<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,transport,account,session,legacyDeviceId:ready.deviceId,keys:{currentKeyVersion:async()=>Math.max(0,...heldKeys.keys()),accountKey:async(_u,v)=>{const key=heldKeys.get(v??Math.max(0,...heldKeys.keys()));return key?new Uint8Array(key):undefined;}},repository:await getLibrarySyncRepository(),bootstrap:async()=>{await session();const latest=syncV2Ready;if(!latest||latest.userId!==account.userId||!latest.syncV2)throw Error('feature_disabled');return {accountId:(await import('../sync-v2/signing')).accountIdFromUserId(account.userId),syncV2:latest.syncV2,devices:latest.bootstrap.devices};}}));return opened?leasedSyncV2Session(opened,v2Exclusive):null;
  }});
  const keysReady=SYNC_V2_PRODUCT.syncV2?async(event:NonNullable<typeof syncV2Ready>)=>{
   const expected=await summaryAccountStore.read();if(!expected||expected.userId!==event.userId)return;
   if(!event.syncV2){syncV2Ready=undefined;await syncV2?.stop();clearV2Keys();return;}
   const captured=new Map<number,Uint8Array>();try{for(const c of event.bootstrap.keyCommitments){const key=await event.keys.accountKey(event.userId,c.keyVersion);if(key)captured.set(c.keyVersion,key);}const latest=await summaryAccountStore.read();if(disposed||cloudAccountIdentity(latest)!==cloudAccountIdentity(expected)){for(const key of captured.values())key.fill(0);return;}clearV2Keys();heldKeys=captured;syncV2Ready=event;}catch(error){for(const key of captured.values())key.fill(0);throw error;}
  }:undefined;
  runtime=createCloudRuntime(host,getLibrarySyncRepository,guard,summaryAccountStore,()=>{notifyLibraryChanged('remote');notifyNotesChanged();},execution,{approver:(open,crypto)=>new CloudApproverController({open,crypto:createApproverCrypto(crypto)}),recordDiagnostic:value=>appLogger.i('CloudRecords',value),formatDiagnostic:value=>appLogger.i('CloudFormat',value),keysReady});approvals=runtime.approvals;approver=runtime.approver;foreground();if(approver)cleanups.push(approver.subscribe(()=>{for(const fn of approverListeners)try{fn();}catch{}armApprover();}));cleanups.push(approvals.subscribe(()=>{notifyApproval();arm();}));
  scheduler=new WatchCloudScheduler({sync:async(requestedManual,requestedMode)=>{const grant=await handoff?.authorized();if(requestedManual&&!grant)return false;const manual=!!grant,mode=grant?.mode??requestedMode;const complete=manual?handoff?.captureCompletion():undefined;const result=await runtime!.service.syncNow(manual,mode);if(syncV2Ready&&!disposed){const a=await summaryAccountStore.read();if(a)try{await syncV2?.start(JSON.stringify([cloudAccountIdentity(a),syncV2Ready.bootstrap.libraryEpoch,syncV2Ready.bootstrap.contentGeneration,Math.max(0,...heldKeys.keys())]));}catch(error){appLogger.i('SyncV2',String((error as Error)?.message??error));}}await complete?.(result);if(result&&approver?.active)void approver.poll();if(grant&&runtime!.service.status.continuationReady)await handoff?.progress(grant);if(runtime!.service.status.retryable===false)await scheduler?.setUpgradeRequired(true);else if(result||runtime!.service.status.continuationReady)await scheduler?.setUpgradeRequired(false);const retry=runtime!.service.status.retryAtMillis;if(retry)scheduler?.deferUntil(retry,manual?mode:undefined);return result;},now:Date.now,delay:(ms,fn)=>{const timer=delay(ms);void timer.result.then(fn).catch(()=>{});return()=>timer.cancel();},scheduleWorker:()=>host<void>('cloud.schedule',{}),cancelWorker:()=>host<void>('cloud.cancel',{})},guard);
  const epochStore=cloudStatePort(host);
  handoff=new CloudManualHandoff(host,async()=>{const account=await summaryAccountStore.read();return account?cloudAccountIdentity(account):undefined;},(mode,restored)=>scheduler!.manual(mode,restored),Date.now,async()=>{const account=await summaryAccountStore.read();if(!account)return;return epochStore.get(manualEpochKey(account));});
  cleanups.push(handoff.subscribe(()=>{for(const fn of handoffListeners)try{fn();}catch{}}));
  handoff.foregroundChanged(visibility.active);handoff.localTransferChanged(localTransferActivity.active);
  scheduler.hold(localTransferActivity.active);
  let identity='',accountId='',accountScope='';
  cleanups.push(connectCloudAccountStatus(()=>cloudGate.allowed&&!disposed?{...runtime!.service.status,accountId,accountScope}:undefined),runtime.service.subscribe(notifyCloudAccountStatus));
  const account=async()=>{const state=await summaryAccountStore.read(),next=cloudAccountIdentity(state);if(disposed||next===identity)return;handoff?.accountChanged();identity=next;syncV2Ready=undefined;await syncV2?.stop();clearV2Keys();accountId=state?.userId??'';accountScope=JSON.stringify([state?.backendBaseUrl.replace(/\/+$/,''),state?.userId]);runtime!.service.reset();approvals?.reset();approver?.reset();await runtime!.inspectOwner();if(disposed||identity!==next)return;await handoff?.restore(false);if(disposed||identity!==next)return;scheduler?.accountChanged();if(visibility.active)void handoff?.restore().catch(()=>{});};
  cleanups.push(summaryAccountStore.subscribe(()=>{void account().catch(()=>{});}),subscribeLibraryMutations(()=>scheduler?.trigger("library")),services.subscribeChannel(e=>{if(e.kind!=='notes'&&e.origin!=='remote')scheduler?.trigger('channel');}),onNetworkChange(()=>scheduler?.trigger("network")),onLifecycleChange(state=>{foreground();if(state==='active')notifyLibraryChanged('remote');}));
  let displayRevision=0;cleanups.push(displayPower.onChange(state=>{displayRevision++;visibility.display(state);updateVisibility();}));
  const revision=displayRevision,display=await displayPower.state();if(disposed)return;if(revision===displayRevision){visibility.display(display);updateVisibility();}
  await account();if(disposed)return;initialized=true;scheduler.foreground(visibility.active);if(pageActive&&approver?.active)void approver.poll();await scheduler.start(true);
 })();void ready.catch(()=>{});
 return {ready,get approvalState(){return approvals?.state??idleApproval();},get approverState(){return approver?.state??idleApprover();},async pollApprover(){await ready;return !disposed&&!!approver&&approver.poll();},async acceptApprover(id:string){await ready;return !disposed&&!!approver&&approver.accept(id);},async confirmApprover(match:boolean){return !disposed&&!!approver&&approver.confirm(match);},async cancelApprover(){return !disposed&&!!approver&&approver.cancel();},setApprovalForeground(active:boolean){const opened=active&&!pageActive;pageActive=active;foreground();if(opened&&approver?.active)void approver.poll();},async requestApproval(){await ready;return !disposed&&!!approvals&&approvals.request();},async confirmApproval(matches:boolean){return !disposed&&!!approvals&&approvals.confirmMatches(matches);},async cancelApproval(){return !disposed&&!!approvals&&approvals.cancel();},resetApproval(){approvals?.reset();approver?.reset();},async reregister(confirmed:boolean){await ready;if(disposed||!runtime)throw Error('client_upgrade_required');const result=await runtime.reregister(confirmed);runtime.service.reset();void handoff?.manual().catch(()=>{});return result;},async ownerResolved(){await ready;if(!disposed&&runtime){await runtime.inspectOwner();await scheduler?.setUpgradeRequired(false);}},get handoffState(){return handoff?.state??{phase:'idle' as const};},manual:async(mode:'all'|'recent128'='recent128')=>{await ready;return handoff?.manual(mode)??false;},dispose(){handoff?.localTransferChanged(false);disposed=true;syncV2Ready=undefined;void syncV2?.stop().catch(()=>{});handoff?.dispose();cancelPoll();cancelApproverPoll();approvals?.reset();approver?.reset();scheduler?.dispose();for(const off of cleanups)off();}};
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

/** Sync v2 UI port. Undefined until the runtime is wired (write gates closed today), so 云同步 shows no Sync v2 notices. */
let syncV2Ui:import('../ui/sync-v2-view.ts').SyncV2UiPort|undefined,syncV2OwnDeviceId:string|null=null;
/** Every snapshot refreshes the cached v2 signing deviceId (26.1 P6-7). */
export function installApplicationSyncV2Ui(port:import('../ui/sync-v2-view.ts').SyncV2UiPort|undefined){syncV2OwnDeviceId=null;if(!port){syncV2Ui=undefined;return;}const snapshot=port.snapshot.bind(port);syncV2Ui=Object.assign(Object.create(port),{async snapshot(){const value=await snapshot();if(syncV2Ui===wrapped)syncV2OwnDeviceId=value.ownDeviceId??null;return value;}});const wrapped=syncV2Ui!;void wrapped.snapshot().catch(()=>{});}
export function applicationSyncV2Ui(){return syncV2Ui;}
export function applicationSyncV2OwnDeviceId(){return syncV2OwnDeviceId;}
