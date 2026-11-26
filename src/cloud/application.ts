import {createSignal} from 'solid-js';
import {withAccountLease} from '../account/lease';
import {WatchTokenManager} from '../account/token';
import {watchAppVersion} from '../core/app-version';
import {playbackWork} from '../core/playback-work';
import {cloudStatePort} from './state-sql';
import {appLogger} from '../logs/app-logger';
import {CloudVisibility} from './visibility';
import {CloudManualHandoff,manualEpochKey,sameManualIntent} from './manual-handoff';
import {localTransferActivity} from '../sync/local-transfer';
import {cloudAccountIdentity} from './identity';
import {CloudForegroundExecution,CloudSyncBudget,cloudRunHost} from './execution';
import {bookFileWork} from '../sync/library-binary/book-import';
import {NoteAssetFileIndex} from '../notes/asset-files';
import {projectionSql} from '../sync-v2/host';
import {prepareArchivedNoteAsset} from '../notes/archive-restore';
import {prepareArchivedBook} from '../books/archive-restore';
import {hostOperation,delay,onNetworkChange,displayPower,onSqlChanged,fileChunks} from '@podjs/framework/services';
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
import {requestAccountHead,requestHeadPollConfig,WatchHeadPoll} from './head-poll';
import {syncV2Origin} from '../sync-v2/http';
import config from '../../pod.config.json';
import type {CloudSyncResult} from './service';
import type {WatchAccountIdentity} from '../account/store';
let owner:ReturnType<typeof start>|undefined;let approvalPageActive=false;
let nextAccountGeneration=0;
const approvalListeners=new Set<()=>void>(),approverListeners=new Set<()=>void>(),handoffListeners=new Set<()=>void>();
const notifyApproval=()=>{for(const fn of approvalListeners)try{fn();}catch{}};
function start(){
 let handoff:CloudManualHandoff|undefined;
 let identity='',accountGeneration=0;
 const schedule=(ms:number,fn:()=>void)=>{const timer=delay(ms);void timer.result.then(fn).catch(()=>{});return()=>timer.cancel();};
 let headPoll:WatchHeadPoll|undefined;
 let v2Writers=0;
 let prepareAccount=():boolean|Promise<boolean>=>false;
 const visibility=new CloudVisibility(lifecycle());
 const execution=new CloudForegroundExecution(lifecycle()==='active'&&!localTransferActivity.active&&!playbackWork.active);
 let disposed=false,initialized=false,accountReady=false,scheduler:WatchCloudScheduler|undefined,runtime:ReturnType<typeof createCloudRuntime>|undefined,approvals:CloudApprovalController|undefined,pageActive=approvalPageActive,polling=false,cancelPoll=()=>{};
 let approver:CloudApproverController|undefined,cancelApproverPoll=()=>{};
 let syncV2:ReturnType<typeof watchSyncV2Product<import('../ui/sync-v2-view.ts').SyncV2UiPort>>|undefined,syncV2Ready:Parameters<NonNullable<import('./service').CloudSyncPorts['keysReady']>>[0]|undefined;
 const cleanups:(()=>void)[]=[onSqlChanged('watchrss-library',()=>{notifyLibraryChanged('remote');notifyNotesChanged();})];
 function armApprover(){cancelApproverPoll();cancelApproverPoll=()=>{};if(disposed||!pageActive||!approver?.active)return;const timer=delay(5000);cancelApproverPoll=()=>timer.cancel();void timer.result.then(async()=>{if(disposed||!pageActive||!approver?.active)return;await approver.poll();armApprover();}).catch(()=>{});}
 const updateExecution=()=>execution.foreground(visibility.active&&!localTransferActivity.active&&!playbackWork.active);
 const updateVisibility=()=>{updateExecution();approver?.setForeground(visibility.active&&!localTransferActivity.active);armApprover();scheduler?.foreground(initialized&&visibility.active);handoff?.foregroundChanged(visibility.active);};
 cleanups.push(onLifecycleChange(state=>{visibility.lifecycle(state);updateVisibility();}),localTransferActivity.subscribe(active=>{updateExecution();approver?.setForeground(visibility.active&&!active);armApprover();scheduler?.hold(active||playbackWork.active);handoff?.localTransferChanged(active);}));
 cleanups.push(playbackWork.subscribe(active=>{updateExecution();scheduler?.hold(active||localTransferActivity.active);}));
 const arm=()=>{cancelPoll();cancelPoll=()=>{};if(disposed||!approvals?.active||!['pending','code'].includes(approvals.state.phase))return;const timer=delay(1500);cancelPoll=()=>timer.cancel();void timer.result.then(async()=>{if(polling||disposed||!approvals?.active)return;polling=true;try{await approvals.poll();}finally{polling=false;arm();}}).catch(()=>{});};
 const foreground=()=>{approvals?.setForeground(pageActive&&lifecycle()==='active');approver?.setForeground(visibility.active&&!localTransferActivity.active);arm();armApprover();};
 const ready=(async()=>{
  if(!await initializeCloudHost()||disposed)return;
  const guard={require(){cloudGate.require();if(disposed)throw Error('Cloud runtime disposed');}};
  const host=<T>(method:string,args:Record<string,unknown>)=>{if(method!=='cloud.release'&&method!=='secure.release'&&method!=='file.delete'&&method!=='file.closeText'&&method!=='crypto.closeSealedGzip')guard.require();return hostOperation<T>(method,args).result;};
  // 26.4 P6-10: off by default. Off => no keysReady hook, no v2 request, no UI port.
  let heldKeys=new Map<number,Uint8Array>(),v2Tail:Promise<unknown>=Promise.resolve(),v2Current:(()=>void)|undefined;
  const v2Guard={require(){guard.require();if(!v2Current)throw Error('feature_disabled');v2Current();}};
  const v2Exclusive=<T>(work:()=>Promise<T>)=>{
   v2Writers++;
   headPoll?.update();
   const next=v2Tail.then(async()=>{
    const reading=headPoll?.drainRead();
    if(reading)await reading;
    guard.require();
    const current=execution.begin(),budget=new CloudSyncBudget();
    if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)throw Error('cloud_account_busy');
    v2Current=()=>{current();budget.check();};
    try {
     v2Current();
     const result=await work();
     v2Current();
     return result;
    } finally {
     v2Current=undefined;
     await host('cloud.release',{});
    }
   }).finally(()=>{v2Writers--;headPoll?.update();});
   v2Tail=next.catch(()=>{});
   return next;
  };
  const clearV2Keys=()=>{for(const key of heldKeys.values())key.fill(0);heldKeys.clear();};cleanups.push(clearV2Keys);
  syncV2=watchSyncV2Product({enabled:SYNC_V2_PRODUCT.syncV2,drainOnStop:true,announced:async()=>!!syncV2Ready?.syncV2,install:installApplicationSyncV2Ui,open:async lifetime=>{
   const v2Host=cloudRunHost((async<T>(method:string,args:Record<string,unknown>)=>{
    const cleanup=['file.delete','file.closeText','secure.release','cloud.release','crypto.closeSealedGzip'].includes(method);
    if(!cleanup)guard.require();
    // Native cancellation for read/crypto/HTTP waits. SQL and secure mutations
    // settle under their original lease before another account can open.
    const operation=hostOperation<T>(method,args),off=method.startsWith('sql.')||method.startsWith('secure.')||cleanup?()=>{}:lifetime.onCancel(()=>operation.cancel());
    try{return await operation.result;}finally{off();}
   }),()=>v2Guard.require());
   const ready=syncV2Ready,account=await summaryAccountStore.read();
   if(!ready||!account||account.userId!==ready.userId)throw Error('cloud_v2_start_unavailable');
   const {accountBoundCasHost}=await import('../sync-v2/product'),accountHost=accountBoundCasHost(v2Host,account,()=>summaryAccountStore.read());
   const transport=createCloudTransport(accountHost,v2Guard),tokens=new WatchTokenManager(summaryAccountStore,{backendBaseUrl:account.backendBaseUrl,transport});
   const session=async()=>{const current=await tokens.freshAccount();if(cloudAccountIdentity(current)!==cloudAccountIdentity(account))throw Error('cloud_account_busy');await summaryAccountStore.assertLibraryOwner(current);return current;};
   const {openApplicationSyncV2}=await import('../sync-v2/application-open');
   const opened=await v2Exclusive(async()=>openApplicationSyncV2({lifetime,host:accountHost,cleanupHost:<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,transport,account,session,legacyDeviceId:ready.deviceId,keys:{currentKeyVersion:async()=>Math.max(0,...heldKeys.keys()),accountKey:async(_u,v)=>{const key=heldKeys.get(v??Math.max(0,...heldKeys.keys()));return key?new Uint8Array(key):undefined;}},repository:await getLibrarySyncRepository(),prepareArchivedAsset:(key,archive)=>prepareArchivedNoteAsset(new NoteAssetFileIndex(projectionSql(accountHost)),fileChunks,key,archive,()=>v2Guard.require()),prepareArchivedBook:async(book,archive)=>{
    const books=(await getLibrarySyncRepository()).books;
    if(!books)throw Error('book_storage_unavailable');
    const check=()=>v2Guard.require(),work=bookFileWork(fileChunks,hostOperation,check);
    try{return await prepareArchivedBook(books,work.files,book,archive,check);}finally{work.stop();}
   },bodyInstall:work=>withAccountLease(host,async()=>{const current=await summaryAccountStore.read();if(cloudAccountIdentity(current)!==cloudAccountIdentity(account))throw Error('cloud_account_busy');await summaryAccountStore.assertLibraryOwner(current!);return work();}),allowBodies:async()=>{if(await handoff?.authorized(cloudAccountIdentity(account)))return true;const n=await accountHost<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>('discovery.networkSnapshot',{});return n.active&&n.validated&&n.wifi&&n.metered===false;},bootstrap:async()=>{await session();const latest=syncV2Ready;if(!latest||latest.userId!==account.userId||!latest.syncV2)throw Error('feature_disabled');return {accountId:(await import('../sync-v2/signing')).accountIdFromUserId(account.userId),syncV2:latest.syncV2,devices:latest.bootstrap.devices,libraryEpoch:latest.bootstrap.libraryEpoch,contentGeneration:latest.bootstrap.contentGeneration};}}));return opened?leasedSyncV2Session(opened,v2Exclusive):null;
  }});
  const keysReady=SYNC_V2_PRODUCT.syncV2?async(event:NonNullable<typeof syncV2Ready>)=>{
   const expected=await summaryAccountStore.read();if(!expected||expected.userId!==event.userId)throw Error('cloud_operation_superseded');
   if(!event.syncV2){syncV2Ready=undefined;clearV2Keys();await syncV2?.stop();return;}
   const captured=new Map<number,Uint8Array>();try{for(const c of event.bootstrap.keyCommitments){const key=await event.keys.accountKey(event.userId,c.keyVersion);if(key)captured.set(c.keyVersion,key);}const latest=await summaryAccountStore.read();if(disposed||cloudAccountIdentity(latest)!==cloudAccountIdentity(expected)){for(const key of captured.values())key.fill(0);return;}clearV2Keys();heldKeys=captured;syncV2Ready=event;}catch(error){for(const key of captured.values())key.fill(0);throw error;}
  }:undefined;
  const syncV2Round=async(scope=identity)=>{
   const prepared=syncV2Ready;
   const account=await summaryAccountStore.read();
   const current=()=>!disposed&&scope===identity&&syncV2Ready===prepared;
   if(!prepared||!syncV2||!current()||cloudAccountIdentity(account)!==scope)return null;
   const result=await syncV2.sync(JSON.stringify([scope,prepared.bootstrap.libraryEpoch,prepared.bootstrap.contentGeneration,Math.max(0,...heldKeys.keys())]));
   if(!current())throw Error('cloud_operation_superseded');
   if(!result)throw Error('cloud_v2_repo_missing');
   return result;
  };
  runtime=createCloudRuntime(host,getLibrarySyncRepository,guard,summaryAccountStore,()=>{notifyLibraryChanged('remote');notifyNotesChanged();},execution,{onApprovalComplete:()=>scheduler?.approvalCompleted(),approver:(open,crypto)=>new CloudApproverController({open,crypto:createApproverCrypto(crypto)}),recordDiagnostic:value=>appLogger.i('CloudRecords',value),formatDiagnostic:value=>appLogger.i('CloudFormat',value),primaryV2:SYNC_V2_PRODUCT.syncV2,keysReady,syncV2:syncV2Round});approvals=runtime.approvals;approver=runtime.approver;foreground();if(approver)cleanups.push(approver.subscribe(()=>{for(const fn of approverListeners)try{fn();}catch{}armApprover();}));cleanups.push(approvals.subscribe(()=>{notifyApproval();arm();}));
  let accountId='',accountScope='',accountRead=0;
  const pollEligible=()=>{
   if(!initialized||!cloudGate.allowed||!accountReady||!accountId||v2Writers||!scheduler?.headPollIdle||
     !syncV2Ready?.syncV2||!heldKeys.size)return false;
   const status=runtime!.service.status;
   return status.member?.readable===true&&status.phase!=='waiting-approval'&&!status.ownerChoiceRequired&&status.retryable!==false;
  };
  headPoll=new WatchHeadPoll({
   eligible:pollEligible,
   now:Date.now,
   delay:schedule,
   sync:()=>scheduler!.syncFromHead(),
   onPolicyChanged:()=>scheduler?.headPolicyChanged(),
   async read(kind,lifetime){
    const ready=syncV2Ready,scope=identity;
    const check=()=>{
     guard.require();
     lifetime.require();
     if(!pollEligible()||syncV2Ready!==ready||identity!==scope)throw Error('head_poll_suspended');
    };
    check();
    const account=await summaryAccountStore.read();
    check();
    if(!account||cloudAccountIdentity(account)!==scope)return;
    const base=account.backendBaseUrl.replace(/\/+$/,'');
    const origin=syncV2Origin(base,{accountBaseUrl:base,allowLoopback:false});
    const transport=createCloudTransport(async<T>(method:string,args:Record<string,unknown>)=>{
     if(method!=='file.delete')check();
     const task=hostOperation<T>(method,args);
     const off=method==='http.download'?lifetime.onCancel(()=>task.cancel()):undefined;
     try{return await task.result;}finally{off?.();}
    },{require:check},{callTimeoutMs:10_000,maxResponseBytes:kind==='head'?16_384:262_144});
    if(kind==='config')return requestHeadPollConfig(transport,origin,config.versionCode,account.installId);
    // The writer lease keeps the head GET out of a WorkManager writer's round.
    // A foreground writer cancels this request and drains its cleanup first.
    if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)return;
    const head=(token:string)=>requestAccountHead(transport,origin,token,ready!.deviceId);
    try{
     if(!(account.tokenExpiresAtMillis>0&&account.tokenExpiresAtMillis<=Date.now())){
      const result=await head(account.watchDeviceToken);
      if(result.status!==401)return result;
     }
     // Once dispatched, rotation must settle under the account lease even if
     // the foreground ends. The next head GET still obeys the poll lifetime.
     const authTransport=createCloudTransport(
      <T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,
      cloudGate,{callTimeoutMs:10_000,maxResponseBytes:16_384});
     const tokens=new WatchTokenManager(summaryAccountStore,{backendBaseUrl:origin,appVersion:watchAppVersion,
      transport:authTransport});
     const refreshed=await tokens.refreshAccount(account,{beforeDispatch:check});
     check();
     const result=await head(refreshed.watchDeviceToken);
     if(result.status===401){check();await summaryAccountStore.expire(refreshed);}
     return result;
    }
    finally{await host('cloud.release',{});}
   },
  });
  scheduler=new WatchCloudScheduler({
   headPoll,
   prepare:()=>headPoll?.drainRead()?.then(()=>prepareAccount())??prepareAccount(),
   mayHavePendingIntent:()=>!accountReady||!!handoff?.state.mode,
   async sync(requestedManual,requestedMode,run){
    const scope=identity;
    if(!run.current||run.intent&&run.intent.scope!==scope)return false;
    const grant=await handoff?.authorized(scope);
    if(!run.current||identity!==scope||
      run.intent&&!sameManualIntent(grant,run.intent)||requestedManual&&!grant)return false;
    run.bindIntent(grant);
    // Approval retains the initial recent sync when no durable grant exists.
    const manual=!!grant||run.afterApproval,mode=grant?.mode??requestedMode;
    const outcome=await runtime!.service.syncNowResult(manual,mode,scope);
    // Report whether the writer finished for scheduling purposes. Only a
    // current writer may deliver its result or touch a grant.
    if(!run.current||identity!==scope)return false;
    run.publish(outcome);
    const success=outcome.ok;
    // The exact grant read by this run is the only record it can complete.
    try{
     if(success&&grant)await handoff?.completeExecuted(grant);
     if(!run.current||identity!==scope)return success;
     if(success&&approver?.active)void approver.poll();
     if(grant&&outcome.continuationReady)await handoff?.progress(grant);
     if(!run.current||identity!==scope)return success;
     if(outcome.retryable===false&&!syncV2Ready)await scheduler?.setUpgradeRequired(true);
     else if(success||outcome.continuationReady)await scheduler?.setUpgradeRequired(false);
     if(run.current&&identity===scope&&outcome.retryAtMillis)scheduler?.deferUntil(outcome.retryAtMillis,grant?.mode);
    }catch{appLogger.w('CloudSync','Foreground sync follow-up failed');}
    return success;
   },
   now:Date.now,
   delay:schedule,
   scheduleWorker:()=>host<void>('cloud.schedule',{}),cancelWorker:()=>host<void>('cloud.cancel',{}),
  },guard);
  const epochStore=cloudStatePort(host);
  handoff=new CloudManualHandoff(host,async()=>{const account=await summaryAccountStore.read();return account?cloudAccountIdentity(account):undefined;},{
   dispatch:(intent,restored,observe)=>scheduler!.manual(intent.mode,restored,intent,observe),
  },Date.now,async()=>{const account=await summaryAccountStore.read();if(!account)return;return epochStore.get(manualEpochKey(account));});
  cleanups.push(handoff.subscribe(()=>{for(const fn of handoffListeners)try{fn();}catch{}}));
  handoff.foregroundChanged(visibility.active);
  handoff.localTransferChanged(localTransferActivity.active);
  scheduler.hold(localTransferActivity.active||playbackWork.active);
  cleanups.push(connectCloudAccountStatus(()=>cloudGate.allowed&&!disposed?{...runtime!.service.status,accountId,accountScope,accountRevision:accountGeneration}:undefined),runtime.service.subscribe(notifyCloudAccountStatus));
  let accountInitialization:{generation:number;task:Promise<void>}|undefined;
  const initializeAccount=()=>{
   const generation=accountGeneration;
   if(accountInitialization?.generation===generation)return accountInitialization.task;
   const current=()=>!disposed&&generation===accountGeneration;
   const task=(async()=>{
    await syncV2?.stop();
    await headPoll?.drainRead();
    if(!current())return;
    await runtime!.inspectOwner();
    if(!current())return;
    await handoff?.restore(false);
    if(!current())return;
    accountReady=true;
   })().finally(()=>{
    if(accountInitialization?.task===task)accountInitialization=undefined;
   });
   accountInitialization={generation,task};
   return task;
  };
  const account=async(observed?:WatchAccountIdentity|null)=>{
   const read=++accountRead,state=observed===undefined?await summaryAccountStore.read():observed;
   const next=cloudAccountIdentity(state);
   if(disposed||read!==accountRead)return;
   const changed=next!==identity;
   if(changed){
    accountGeneration=++nextAccountGeneration;
    accountReady=false;
    scheduler?.fenceAccount();
    handoff?.accountChanged();
    identity=next;
    accountId=state?.userId??'';
    accountScope=JSON.stringify([state?.backendBaseUrl.replace(/\/+$/,''),state?.userId]);
    runtime!.service.reset();
    approvals?.reset();approver?.reset();
    syncV2Ready=undefined;clearV2Keys();
   }
   const generation=accountGeneration;
   if(!changed){
    scheduler?.wakePending();
    if(!accountReady)await initializeAccount();
    return;
   }
   if(!accountReady)await initializeAccount();
   if(disposed||generation!==accountGeneration)return;
   scheduler?.scheduleAccount();
   if(visibility.active)void handoff?.restore().catch(()=>{});
  };
  prepareAccount=()=>{
   if(disposed)return false;
   if(accountReady)return true;
   return (accountGeneration?initializeAccount():account()).then(()=>accountReady);
  };
  cleanups.push(summaryAccountStore.subscribe(state=>{void account(state).catch(()=>{});}),subscribeLibraryMutations(kind=>{
   if(kind==='local-memo'&&accountId)scheduler?.noteSaved();
   else scheduler?.trigger('library');
  }),services.subscribeChannel(e=>{if(e.kind!=='notes'&&e.origin!=='remote')scheduler?.trigger('channel');}),onNetworkChange(()=>scheduler?.trigger("network")),onLifecycleChange(state=>{foreground();if(state==='active')notifyLibraryChanged('remote');}));
  let displayRevision=0;cleanups.push(displayPower.onChange(state=>{displayRevision++;visibility.display(state);updateVisibility();}));
  const revision=displayRevision,display=await displayPower.state();if(disposed)return;if(revision===displayRevision){visibility.display(display);updateVisibility();}
  await account().catch(()=>{});if(disposed)return;initialized=true;scheduler.foreground(visibility.active);if(pageActive&&approver?.active)void approver.poll();await scheduler.start(true);
 })();void ready.catch(()=>{});
 return {ready,get approvalState(){return approvals?.state??idleApproval();},get approverState(){return approver?.state??idleApprover();},async pollApprover(){await ready;return !disposed&&!!approver&&approver.poll();},async acceptApprover(id:string){await ready;return !disposed&&!!approver&&approver.accept(id);},async confirmApprover(match:boolean){return !disposed&&!!approver&&approver.confirm(match);},async cancelApprover(){return !disposed&&!!approver&&approver.cancel();},setApprovalForeground(active:boolean){const opened=active&&!pageActive;pageActive=active;foreground();if(opened&&approver?.active)void approver.poll();},async requestApproval(){await ready;return !disposed&&!!approvals&&approvals.request();},async confirmApproval(matches:boolean){return !disposed&&!!approvals&&approvals.confirmMatches(matches);},async cancelApproval(){return !disposed&&!!approvals&&approvals.cancel();},resetApproval(){approvals?.reset();approver?.reset();},async reregister(confirmed:boolean){
  await ready;
  if(disposed||!runtime)throw Error('client_upgrade_required');
  const scope=identity,generation=accountGeneration;
  v2Writers++;
  headPoll?.update();
  try{
   await headPoll?.drainRead();
   if(disposed||generation!==accountGeneration)throw Error('cloud_operation_superseded');
   const result=await runtime.reregister(confirmed);
   if(disposed||generation!==accountGeneration)throw Error('cloud_operation_superseded');
   runtime.service.reset();
   void handoff?.manual('recent128',{scope}).catch(()=>{});
   return result;
  }finally{v2Writers--;headPoll?.update();}
 },async ownerResolved(scope:string){
  await ready;
  if(disposed||!runtime||identity!==scope)return;
  const generation=accountGeneration;
  v2Writers++;
  headPoll?.update();
  try{
   await headPoll?.drainRead();
   if(!disposed&&generation===accountGeneration){
    await runtime.inspectOwner();
    if(!disposed&&generation===accountGeneration)await scheduler?.setUpgradeRequired(false);
   }
  }finally{v2Writers--;headPoll?.update();}
 },get handoffState(){return handoff?.state??{phase:'idle' as const};},manual:async(mode:'all'|'recent128'='recent128',scope?:string,retry=false,generation?:number)=>{
  await ready;
  const expected=generation??(accountGeneration||undefined);
  const current=()=>!disposed&&(expected===undefined||expected===accountGeneration)&&(scope===undefined||scope===identity||!accountGeneration);
  if(!current())return;
  if(!accountReady&&!await prepareAccount())return;
  if(!current())return;
  let result:CloudSyncResult|undefined;
  const options={scope,observe:(outcome:CloudSyncResult)=>{result=outcome;}};
  if(retry)await handoff?.restore(true,options);
  else await handoff?.manual(mode,options);
  return result;
 },dispose(){handoff?.localTransferChanged(false);disposed=true;syncV2Ready=undefined;void syncV2?.stop().catch(()=>{});handoff?.dispose();cancelPoll();cancelApproverPoll();approvals?.reset();approver?.reset();scheduler?.dispose();for(const off of cleanups)off();}};
}
export function startApplicationCloudSync(){return owner??=start();}
export function stopApplicationCloudSync(){owner?.dispose();owner=undefined;}
export function manualCloudSync(mode:'all'|'recent128'='recent128',scope?:string,retry=false,generation?:number){cloudGate.require();return owner?.manual(mode,scope,retry,generation)??Promise.resolve(undefined);}
export const applicationCloudApproval={get state(){return owner?.approvalState??idleApproval();},subscribe(fn:()=>void){approvalListeners.add(fn);return()=>{approvalListeners.delete(fn);};},request(){return startApplicationCloudSync().requestApproval();},confirmMatches(matches:boolean){return owner?.confirmApproval(matches)??Promise.resolve(false);},cancel(){return owner?.cancelApproval()??Promise.resolve(false);},setForeground(active:boolean){approvalPageActive=active;owner?.setApprovalForeground(active);}};
export const applicationCloudApprover={get state(){return owner?.approverState??idleApprover();},subscribe(fn:()=>void){approverListeners.add(fn);return()=>{approverListeners.delete(fn);};},poll(){return startApplicationCloudSync().pollApprover();},accept(requestId:string){return startApplicationCloudSync().acceptApprover(requestId);},confirm(match:boolean){return owner?.confirmApprover(match)??Promise.resolve(false);},cancel(){return owner?.cancelApprover()??Promise.resolve(false);},setForeground(active:boolean){applicationCloudApproval.setForeground(active);}};
/** Local confirmation is mandatory; a clear action must supply the complete local-library cleanup. */
export const applicationCloudActions={async logout(){owner?.resetApproval();await summaryAccountStore.clear();},async resolveOwner(choice:'clear'|'merge',confirmed:boolean,clearLocal?:()=>Promise<void>){if(!confirmed)throw Error('explicit_owner_choice_required');const account=await summaryAccountStore.read();if(!account)throw Error('account_missing');await summaryAccountStore.resolveLibraryOwner(account,choice,clearLocal);const scope=cloudAccountIdentity(account);await owner?.ownerResolved(scope);void owner?.manual('recent128',scope).catch(()=>{});},reregister(confirmed:boolean){if(!confirmed)return Promise.reject(Error('device_reregistration_requires_confirmation'));return startApplicationCloudSync().reregister(true);}};

/** UI hook: OS scheduling is best effort; queued does not claim worker completion. */
export const applicationCloudHandoff={subscribe(fn:()=>void){handoffListeners.add(fn);return()=>{handoffListeners.delete(fn);};},get state(){return owner?.handoffState??{phase:'idle' as const};},async workerState(){cloudGate.require();return hostOperation<{state:string}>('cloud.workState',{}).result;}};

/** Sync v2 UI port. Undefined until the runtime is wired (write gates closed today), so 云同步 shows no Sync v2 notices. */
const [syncV2Ui,setSyncV2Ui]=createSignal<import('../ui/sync-v2-view.ts').SyncV2UiPort>();
let syncV2OwnDeviceId:string|null=null;
/** Every snapshot refreshes the cached v2 signing deviceId (26.1 P6-7). */
export function installApplicationSyncV2Ui(port:import('../ui/sync-v2-view.ts').SyncV2UiPort|undefined){
 syncV2OwnDeviceId=null;
 if(!port){setSyncV2Ui(undefined);return;}
 const snapshot=port.snapshot.bind(port);
 const wrapped:typeof port=Object.assign(Object.create(port),{async snapshot(){
  const value=await snapshot();
  if(syncV2Ui()===wrapped)syncV2OwnDeviceId=value.ownDeviceId??null;
  return value;
 }});
 setSyncV2Ui(wrapped);
 void wrapped.snapshot().catch(()=>{});
}
export function applicationSyncV2Ui(){return syncV2Ui();}
export function applicationSyncV2OwnDeviceId(){return syncV2OwnDeviceId;}
