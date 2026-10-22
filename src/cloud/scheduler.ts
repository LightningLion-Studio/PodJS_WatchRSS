import {cloudDisabled,type CloudGuard} from './guard';
export const CLOUD_INTERVAL=5*60*1000;
export interface CloudSchedulerPorts {sync(manual:boolean,mode?:'all'|'recent128'):Promise<boolean>;now():number;delay(ms:number,callback:()=>void):()=>void;scheduleWorker():Promise<void>;cancelWorker():Promise<void>}
/** One coalesced trailing request; account/network/library bursts cannot make a
 * hot sync loop. Foreground ownership is independent of the 6-hour OS worker. */
export class WatchCloudScheduler {
 private retryAt=0;private last=-Infinity;private active=false;private disposed=false;private dirty=false;private running:Promise<boolean>|undefined;private cancelTimer?:()=>void;
 constructor(private ports:CloudSchedulerPorts,private guard:CloudGuard=cloudDisabled){}
 async start(enabled:boolean){if(!enabled){await this.ports.cancelWorker();return;}this.guard.require();await this.ports.scheduleWorker();}
 foreground(active:boolean){this.guard.require();this.active=active;if(active)this.trigger();else{this.cancelTimer?.();this.cancelTimer=undefined;}}
 trigger(){this.guard.require();if(this.disposed)return;this.dirty=true;this.pump();}
 deferUntil(at:number){if(!Number.isFinite(at))return;this.retryAt=at;this.dirty=true;this.cancelTimer?.();this.cancelTimer=undefined;this.pump();}
 private pump(){if(this.disposed||!this.active||!this.dirty||this.running||this.cancelTimer)return;const remaining=this.retryAt?this.retryAt-this.ports.now():CLOUD_INTERVAL-(this.ports.now()-this.last);
  if(remaining>0){this.cancelTimer=this.ports.delay(remaining,()=>{this.cancelTimer=undefined;this.pump();});return;}
  void this.run(false);
 }
 private run(manual:boolean,mode:'all'|'recent128'='recent128'){this.guard.require();this.dirty=false;this.retryAt=0;this.last=this.ports.now();const task=this.ports.sync(manual,mode);this.running=task;
  void task.finally(()=>{if(this.running===task)this.running=undefined;this.pump();}).catch(()=>{});return task;
 }
 async manual(mode:'all'|'recent128'='recent128'){this.guard.require();if(this.disposed)return false;this.cancelTimer?.();this.cancelTimer=undefined;await this.running;return this.run(true,mode);}
 accountChanged(){this.guard.require();this.cancelTimer?.();this.cancelTimer=undefined;this.last=-Infinity;this.retryAt=0;this.trigger();}
 dispose(){this.disposed=true;this.cancelTimer?.();this.cancelTimer=undefined;}
}
