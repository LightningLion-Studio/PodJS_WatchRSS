import {cloudAccountIdentity} from './identity';
import {CloudForegroundExecution} from './execution';
import {hostOperation,delay,onNetworkChange} from '@podjs/framework/services';
import {lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import {subscribeLibraryMutations} from '../core/library-mutations';
import {initializeCloudHost} from './host';
import {cloudGate} from './gate';
import {summaryAccountStore} from '../llm/runtime';
import {getLibrarySyncRepository,notifyLibraryChanged,services} from '../services';
import {createCloudRuntime} from './runtime';
import {WatchCloudScheduler} from './scheduler';
import {idleApproval,type CloudApprovalController} from './approval-controller';
import {connectCloudAccountStatus,notifyCloudAccountStatus} from './status';
let owner:ReturnType<typeof start>|undefined;let approvalPageActive=false;
const approvalListeners=new Set<()=>void>();
const notifyApproval=()=>{for(const fn of approvalListeners)try{fn();}catch{}};
function start(){
 const execution=new CloudForegroundExecution(lifecycle()==='active');
 let disposed=false,scheduler:WatchCloudScheduler|undefined,runtime:ReturnType<typeof createCloudRuntime>|undefined,approvals:CloudApprovalController|undefined,pageActive=approvalPageActive,polling=false,cancelPoll=()=>{};
 const cleanups:(()=>void)[]=[];
 cleanups.push(onLifecycleChange(state=>execution.foreground(state==='active')));
 const arm=()=>{cancelPoll();cancelPoll=()=>{};if(disposed||!approvals?.active||!['pending','code'].includes(approvals.state.phase))return;const timer=delay(1500);cancelPoll=()=>timer.cancel();void timer.result.then(async()=>{if(polling||disposed||!approvals?.active)return;polling=true;try{await approvals.poll();}finally{polling=false;arm();}}).catch(()=>{});};
 const foreground=()=>{approvals?.setForeground(pageActive&&lifecycle()==='active');arm();};
 const ready=(async()=>{
  if(!await initializeCloudHost()||disposed)return;
  const guard={require(){cloudGate.require();if(disposed)throw Error('Cloud runtime disposed');}};
  const host=<T>(method:string,args:Record<string,unknown>)=>{if(method!=='cloud.release'&&method!=='secure.release'&&method!=='file.delete')guard.require();return hostOperation<T>(method,args).result;};
  runtime=createCloudRuntime(host,getLibrarySyncRepository,guard,summaryAccountStore,notifyLibraryChanged,execution);approvals=runtime.approvals;foreground();cleanups.push(approvals.subscribe(()=>{notifyApproval();arm();}));
  scheduler=new WatchCloudScheduler({sync:async(manual,mode)=>{const result=await runtime!.service.syncNow(manual,mode);if(runtime!.service.status.retryable===false)await scheduler?.setUpgradeRequired(true);else if(result)await scheduler?.setUpgradeRequired(false);const retry=runtime!.service.status.retryAtMillis;if(retry)scheduler?.deferUntil(retry);return result;},now:Date.now,delay:(ms,fn)=>{const timer=delay(ms);void timer.result.then(fn).catch(()=>{});return()=>timer.cancel();},scheduleWorker:()=>host<void>('cloud.schedule',{}),cancelWorker:()=>host<void>('cloud.cancel',{})},guard);
  let identity='',accountId='',accountScope='';
  cleanups.push(connectCloudAccountStatus(()=>cloudGate.allowed&&!disposed?{...runtime!.service.status,accountId,accountScope}:undefined),runtime.service.subscribe(notifyCloudAccountStatus));
  const account=async()=>{const state=await summaryAccountStore.read(),next=cloudAccountIdentity(state);if(disposed||next===identity)return;identity=next;accountId=state?.userId??'';accountScope=JSON.stringify([state?.backendBaseUrl.replace(/\/+$/,''),state?.userId]);runtime!.service.reset();approvals?.reset();scheduler?.accountChanged();};
  cleanups.push(summaryAccountStore.subscribe(()=>{void account().catch(()=>{});}),subscribeLibraryMutations(()=>scheduler?.trigger()),services.subscribeChannel(e=>{if(e.kind!=='notes')scheduler?.trigger();}),onNetworkChange(()=>scheduler?.trigger()),onLifecycleChange(state=>{scheduler?.foreground(state==='active');foreground();}));
  await account();if(!disposed)scheduler.foreground(lifecycle()==='active');await scheduler.start(true);
 })();void ready.catch(()=>{});
 return {ready,get approvalState(){return approvals?.state??idleApproval();},setApprovalForeground(active:boolean){pageActive=active;foreground();},async requestApproval(){await ready;return !disposed&&!!approvals&&approvals.request();},async confirmApproval(matches:boolean){return !disposed&&!!approvals&&approvals.confirmMatches(matches);},async cancelApproval(){return !disposed&&!!approvals&&approvals.cancel();},resetApproval(){approvals?.reset();},async reregister(confirmed:boolean){await ready;if(disposed||!runtime)throw Error('client_upgrade_required');const result=await runtime.reregister(confirmed);runtime.service.reset();void scheduler?.manual().catch(()=>{});return result;},manual:(mode:'all'|'recent128'='recent128')=>scheduler?.manual(mode)??Promise.resolve(false),dispose(){disposed=true;cancelPoll();approvals?.reset();scheduler?.dispose();for(const off of cleanups)off();}};
}
export function startApplicationCloudSync(){return owner??=start();}
export function stopApplicationCloudSync(){owner?.dispose();owner=undefined;}
export function manualCloudSync(mode:'all'|'recent128'='recent128'){cloudGate.require();return owner?.manual(mode)??Promise.resolve(false);}
export const applicationCloudApproval={get state(){return owner?.approvalState??idleApproval();},subscribe(fn:()=>void){approvalListeners.add(fn);return()=>{approvalListeners.delete(fn);};},request(){return startApplicationCloudSync().requestApproval();},confirmMatches(matches:boolean){return owner?.confirmApproval(matches)??Promise.resolve(false);},cancel(){return owner?.cancelApproval()??Promise.resolve(false);},setForeground(active:boolean){approvalPageActive=active;owner?.setApprovalForeground(active);}};
/** Local confirmation is mandatory; a clear action must supply the complete local-library cleanup. */
export const applicationCloudActions={async logout(){owner?.resetApproval();await summaryAccountStore.clear();},async resolveOwner(choice:'clear'|'merge',confirmed:boolean,clearLocal?:()=>Promise<void>){if(!confirmed)throw Error('explicit_owner_choice_required');const account=await summaryAccountStore.read();if(!account)throw Error('account_missing');await summaryAccountStore.resolveLibraryOwner(account,choice,clearLocal);void owner?.manual().catch(()=>{});},reregister(confirmed:boolean){if(!confirmed)return Promise.reject(Error('device_reregistration_requires_confirmation'));return startApplicationCloudSync().reregister(true);}};
