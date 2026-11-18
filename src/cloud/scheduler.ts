import {sameManualIntent,type ManualIntent} from './manual-handoff';
import type {CloudSyncResult} from './service';
import {idleHit} from '../diagnostics/idle-counters';
import {cloudDisabled,type CloudGuard} from './guard';
export const CLOUD_INTERVAL=5*60*1000;
export type CloudResultObserver=(result:CloudSyncResult)=>void;
export interface CloudScheduledRun {
 readonly current:boolean;
 readonly intent:ManualIntent|undefined;
 bindIntent(intent:ManualIntent|undefined):void;
 publish(result:CloudSyncResult):void;
}
export interface CloudSchedulerPorts {prepare?():boolean|Promise<boolean>;sync(manual:boolean,mode:'all'|'recent128',run:CloudScheduledRun):Promise<boolean>;now():number;delay(ms:number,callback:()=>void):()=>void;scheduleWorker():Promise<void>;cancelWorker():Promise<void>}
/** One coalesced trailing request; account/network/library bursts cannot make a
 * hot sync loop. Foreground ownership is independent of the 6-hour OS worker. */
export class WatchCloudScheduler {
 private accountRevision=0;private scheduleRevision=0;private held=false;private pendingManual:'all'|'recent128'|undefined;private runState:{held:boolean;accountRevision:number;intent?:ManualIntent;result?:CloudSyncResult}|undefined;
 private upgradeRequired=false;
 private retryAt=0;private last=-Infinity;private active=false;private disposed=false;private dirty=false;private running:Promise<boolean>|undefined;private cancelTimer?:()=>void;
 constructor(private ports:CloudSchedulerPorts,private guard:CloudGuard=cloudDisabled){}
 async setUpgradeRequired(required:boolean){this.guard.require();if(this.upgradeRequired===required)return;this.upgradeRequired=required;if(required){this.cancelTimer?.();this.cancelTimer=undefined;this.dirty=false;await this.ports.cancelWorker();}else await this.ports.scheduleWorker();}
 async start(enabled:boolean){if(!enabled){await this.ports.cancelWorker();return;}this.guard.require();await this.ports.scheduleWorker();}
 foreground(active:boolean){this.guard.require();if(this.active===active)return;this.active=active;if(active)this.trigger("foreground");else{this.cancelTimer?.();this.cancelTimer=undefined;}}
 hold(held:boolean){this.guard.require();if(this.held===held)return;this.held=held;if(held){this.cancelTimer?.();this.cancelTimer=undefined;if(this.runState)this.runState.held=true;}else this.pump();}
 trigger(reason:"foreground"|"account"|"library"|"channel"|"network"="library"){idleHit({foreground:65,account:66,library:67,channel:68,network:69}[reason]);this.guard.require();if(this.disposed||this.upgradeRequired)return;this.dirty=true;this.pump();}
 deferUntil(at:number,manualMode?:'all'|'recent128'){if(!Number.isFinite(at))return;idleHit(70);this.retryAt=at;if(manualMode)this.pendingManual=this.pendingManual==='all'||manualMode==='all'?'all':'recent128';this.dirty=true;this.cancelTimer?.();this.cancelTimer=undefined;this.pump();}
 private pump(){if(this.disposed||this.upgradeRequired||this.held||!this.active||(!this.dirty&&!this.pendingManual)||this.running||this.cancelTimer)return;const remaining=this.retryAt?this.retryAt-this.ports.now():this.pendingManual?0:CLOUD_INTERVAL-(this.ports.now()-this.last);
  if(remaining>0){this.cancelTimer=this.ports.delay(remaining,()=>{this.cancelTimer=undefined;this.pump();});return;}
  if(this.pendingManual){const mode=this.pendingManual;this.pendingManual=undefined;void this.run(true,mode);return;}void this.run(false);
 }
 private run(manual:boolean,mode:'all'|'recent128'='recent128',intent?:ManualIntent){
  idleHit(42);this.guard.require();this.dirty=false;this.retryAt=0;this.last=this.ports.now();
  const scheduleRevision=this.scheduleRevision;
  const state:NonNullable<typeof this.runState>={held:false,accountRevision:this.accountRevision,intent};
  this.runState=state;
  const current=()=>!this.disposed&&state.accountRevision===this.accountRevision;
  const context:CloudScheduledRun={
   get current(){return current();},
   get intent(){return state.intent;},
   bindIntent(grant){state.intent=grant;},
   publish(result){if(current())state.result=result;},
  };
  const resume=()=>{
   // A suspended writer can wake the next dispatch until the schedule is reset.
   // Only a current writer may carry its mode forward. A new grant is read at dispatch.
   if(!state.held||this.disposed||scheduleRevision!==this.scheduleRevision)return;
   this.dirty=true;this.last=-Infinity;
   if(manual)this.pendingManual=this.pendingManual==='all'||current()&&mode==='all'?'all':'recent128';
  };
  const dispatch=()=>{
   if(!current()||state.held||!manual&&(!this.active||this.upgradeRequired))return Promise.resolve(false);
   return this.ports.sync(manual,mode,context);
  };
  const ready=this.ports.prepare?.()??true;
  const task=(typeof ready==='boolean'?(ready?dispatch():Promise.resolve(false)):ready.then(ok=>ok&&dispatch())).then(success=>{
   idleHit(success?85:86);if(!success)resume();return success;
  },error=>{idleHit(87);resume();throw error;}).finally(()=>{
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
  this.cancelTimer?.();this.cancelTimer=undefined;
  if(this.held){this.pendingManual=this.pendingManual==='all'||mode==='all'?'all':'recent128';return false;}
  const next=this.pendingManual==='all'||mode==='all'?'all':'recent128';this.pendingManual=undefined;
  const {task,state}=this.run(true,next,intent);
  return deliver(task,state);
 }
 /** Fence old results immediately, while keeping wakeups from the existing schedule. */
 fenceAccount(){this.guard.require();this.accountRevision++;}
 accountChanged(){this.fenceAccount();this.scheduleAccount();}
 scheduleAccount(){this.guard.require();this.scheduleRevision++;this.pendingManual=undefined;void this.setUpgradeRequired(false).catch(()=>{});this.cancelTimer?.();this.cancelTimer=undefined;this.last=-Infinity;this.retryAt=0;this.trigger("account");}
 dispose(){this.disposed=true;this.cancelTimer?.();this.cancelTimer=undefined;}
}
