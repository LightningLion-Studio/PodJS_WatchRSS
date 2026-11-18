import {sameManualIntent,type ManualIntent} from './manual-handoff';
import type {CloudSyncResult} from './service';
import {idleHit} from '../diagnostics/idle-counters';
import {cloudDisabled,type CloudGuard} from './guard';
export const CLOUD_INTERVAL=5*60*1000;
export type CloudResultObserver=(result:CloudSyncResult)=>void;
export interface CloudScheduledRun {
 readonly current:boolean;
 readonly intent:ManualIntent|undefined;
 readonly afterApproval:boolean;
 bindIntent(intent:ManualIntent|undefined):void;
 publish(result:CloudSyncResult):void;
}
export interface CloudSchedulerPorts {prepare?():boolean|Promise<boolean>;mayHavePendingIntent?():boolean;sync(manual:boolean,mode:'all'|'recent128',run:CloudScheduledRun):Promise<boolean>;now():number;delay(ms:number,callback:()=>void):()=>void;scheduleWorker():Promise<void>;cancelWorker():Promise<void>}
/** One coalesced trailing request; account/network/library bursts cannot make a
 * hot sync loop. Foreground ownership is independent of the 6-hour OS worker. */
export class WatchCloudScheduler {
 private accountRevision=0;private scheduleRevision=0;private held=false;private pendingManual:'all'|'recent128'|undefined;private runState:{held:boolean;accountRevision:number;intent?:ManualIntent;result?:CloudSyncResult}|undefined;
 private upgradeRequired=false;private approvalPending?:{immediate:boolean};
 private wakeRequested=false;private retryOnWake?:{mode?:'all'|'recent128'};
 private retryAt?:number;private last=-Infinity;private active=false;private disposed=false;private dirty=false;private running:Promise<boolean>|undefined;private cancelTimer?:()=>void;
 constructor(private ports:CloudSchedulerPorts,private guard:CloudGuard=cloudDisabled){}
 async setUpgradeRequired(required:boolean){this.guard.require();if(this.upgradeRequired===required)return;this.upgradeRequired=required;if(required){this.cancelTimer?.();this.cancelTimer=undefined;this.dirty=false;await this.ports.cancelWorker();}else await this.ports.scheduleWorker();}
 async start(enabled:boolean){if(!enabled){await this.ports.cancelWorker();return;}this.guard.require();await this.ports.scheduleWorker();}
 foreground(active:boolean){this.guard.require();if(this.active===active)return;this.active=active;if(active)this.trigger("foreground");else{this.cancelTimer?.();this.cancelTimer=undefined;}}
 hold(held:boolean){this.guard.require();if(this.held===held)return;this.held=held;if(held){this.cancelTimer?.();this.cancelTimer=undefined;if(this.runState)this.runState.held=true;}else this.wakePending();}
 trigger(reason:"foreground"|"account"|"library"|"channel"|"network"="library"){idleHit({foreground:65,account:66,library:67,channel:68,network:69}[reason]);this.guard.require();if(this.disposed||this.upgradeRequired)return;this.dirty=true;this.wakePending();}
 wakePending(){this.guard.require();if(this.disposed)return;this.wakeRequested=true;this.pump();}
 approvalCompleted(){
  this.guard.require();
  if(this.disposed)return;
  this.approvalPending={immediate:true};
  this.cancelTimer?.();this.cancelTimer=undefined;
  this.wakePending();
 }
 deferUntil(at:number,manualMode?:'all'|'recent128'){if(!Number.isFinite(at))return;idleHit(70);this.retryAt=at;if(manualMode)this.pendingManual=this.pendingManual==='all'||manualMode==='all'?'all':'recent128';this.dirty=true;this.cancelTimer?.();this.cancelTimer=undefined;this.wakePending();}
 private pump(){if(this.disposed||this.upgradeRequired||this.held||!this.active||this.runState||this.cancelTimer)return;
  // Only an external wake may retry work parked before dispatch. A writer's
  // finalizer drains queued work, but does not repeat its own preparation.
  const wake=this.wakeRequested;
  this.wakeRequested=false;
  const approval=this.approvalPending;
  const retry=wake?this.retryOnWake:undefined;
  const manual=this.pendingManual??retry?.mode;
  const checkIntent=wake&&!this.dirty&&!retry&&!manual&&this.ports.mayHavePendingIntent?.();
  if(!approval?.immediate&&!(wake&&approval)&&!this.dirty&&!manual&&!retry&&!checkIntent)return;
  // Finding a durable grant or a parked retry does not make it eligible early.
  const bypassInterval=approval?.immediate||this.pendingManual!==undefined;
  const eligibleAt=this.retryAt??(bypassInterval?-Infinity:this.last+CLOUD_INTERVAL);
  const remaining=eligibleAt-this.ports.now();
  if(remaining>0){this.cancelTimer=this.ports.delay(remaining,()=>{this.cancelTimer=undefined;this.wakePending();});return;}
  this.pendingManual=undefined;
  if(approval){
   // A failed preparation leaves the request queued for the next wake.
   approval.immediate=false;
   void this.run(false,'recent128',undefined,true);
   return;
  }
  void this.run(!!(manual||checkIntent),manual);
 }
 private run(manual:boolean,mode:'all'|'recent128'='recent128',intent?:ManualIntent,afterApproval=false){
  idleHit(42);this.guard.require();this.dirty=false;this.retryOnWake=undefined;this.retryAt=undefined;
  let attemptedAt=this.last=this.ports.now();
  const scheduleRevision=this.scheduleRevision;
  const state:NonNullable<typeof this.runState>={held:false,accountRevision:this.accountRevision,intent};
  this.runState=state;
  const current=()=>!this.disposed&&state.accountRevision===this.accountRevision;
  let approvalAtStart:typeof this.approvalPending,started=false;
  const context:CloudScheduledRun={
   get current(){return current();},
   get intent(){return state.intent;},
   afterApproval,
   bindIntent:grant=>{
    state.intent=grant;
    started=true;
    if(!current())return;
    attemptedAt=this.last=this.ports.now();
    if(!afterApproval&&!grant)return;
    // The app binds the verified grant immediately before calling the service.
    // Either grant mode covers recent128. An automatic metadata sync may not.
    approvalAtStart=this.approvalPending;
    if(afterApproval)this.approvalPending=undefined;
   },
   publish(result){if(current())state.result=result;},
  };
  const resume=()=>{
   // A suspended writer can wake the next dispatch until the schedule is reset.
   // Only a current writer may carry its mode forward. A new grant is read at dispatch.
   if(!state.held||this.disposed||scheduleRevision!==this.scheduleRevision)return;
   this.dirty=true;this.last=-Infinity;
   if(afterApproval&&approvalAtStart&&current())this.approvalPending??={immediate:true};
   if(manual)this.pendingManual=this.pendingManual==='all'||current()&&mode==='all'?'all':'recent128';
  };
  let dispatched=false;
  const dispatch=()=>{
   if(!current()||state.held||!manual&&(!this.active||this.upgradeRequired))return Promise.resolve(false);
   dispatched=true;
   attemptedAt=this.last=this.ports.now();
   return this.ports.sync(manual,mode,context);
  };
  const failed=(rejected=false)=>{
   // Honor the service result's deadline, including one due at the start time.
   // A wake alone cannot reuse an old deadline to bypass the interval.
   if(current()&&!state.held&&this.retryAt!==undefined&&this.retryAt<=attemptedAt&&this.retryAt!==state.result?.retryAtMillis)this.retryAt=attemptedAt+CLOUD_INTERVAL;
   if((!dispatched||rejected&&!started)&&!afterApproval&&current())this.retryOnWake={mode:manual?mode:undefined};
   resume();
  };
  let work:Promise<boolean>;
  try{
   const ready=this.ports.prepare?.()??true;
   work=typeof ready==='boolean'?(ready?dispatch():Promise.resolve(false)):ready.then(ok=>ok&&dispatch());
  }catch(error){work=Promise.reject(error);}
  const task=work.then(success=>{
   idleHit(success?85:86);
   if(!success)failed();
   else if(approvalAtStart&&current()&&this.approvalPending===approvalAtStart)this.approvalPending=undefined;
   return success;
  },error=>{idleHit(87);failed(true);throw error;}).finally(()=>{
   this.running=undefined;this.runState=undefined;
   void Promise.resolve().then(()=>this.pump()).catch(()=>{});
  });
  this.running=task;
  void task.catch(()=>{});
  return {task,state};
 }
 async manual(mode:'all'|'recent128'='recent128',restored=false,intent?:ManualIntent,observe?:CloudResultObserver){
  this.guard.require();
  const revision=this.accountRevision;
  if(this.disposed||restored&&this.upgradeRequired)return false;
  const deliver=async(task:Promise<boolean>,state:NonNullable<typeof this.runState>)=>{
   const success=await task;
   if(this.disposed||revision!==this.accountRevision)return false;
   if(state.result)observe?.(state.result);
   return success;
  };
  if(restored&&this.running&&this.runState){
   const state=this.runState;
   if(state.accountRevision!==revision||intent&&!sameManualIntent(state.intent,intent))return false;
   return deliver(this.running,state);
  }
  while(this.running){
   // Wait for the writer slot. The preceding run cannot decide this request.
   await this.running.catch(()=>{});
   if(this.disposed||revision!==this.accountRevision)return false;
  }
  if(this.disposed||revision!==this.accountRevision)return false;
  if(restored&&this.retryAt!==undefined&&this.ports.now()<this.retryAt){
   this.pendingManual=this.pendingManual==='all'||mode==='all'?'all':'recent128';
   this.wakePending();
   return false;
  }
  this.cancelTimer?.();this.cancelTimer=undefined;
  if(this.held){this.pendingManual=this.pendingManual==='all'||mode==='all'?'all':'recent128';return false;}
  const next=this.pendingManual==='all'||mode==='all'?'all':'recent128';this.pendingManual=undefined;
  const {task,state}=this.run(true,next,intent);
  return deliver(task,state);
 }
 /** Fence old results immediately, while keeping wakeups from the existing schedule. */
 fenceAccount(){this.guard.require();this.accountRevision++;this.approvalPending=undefined;this.retryOnWake=undefined;}
 accountChanged(){this.fenceAccount();this.scheduleAccount();}
 scheduleAccount(){this.guard.require();this.scheduleRevision++;this.pendingManual=undefined;void this.setUpgradeRequired(false).catch(()=>{});this.cancelTimer?.();this.cancelTimer=undefined;this.last=-Infinity;this.retryAt=undefined;this.trigger("account");}
 dispose(){this.disposed=true;this.cancelTimer?.();this.cancelTimer=undefined;}
}
