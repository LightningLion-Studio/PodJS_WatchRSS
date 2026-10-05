import type {LibrarySessionOptions,SessionActionResult} from './session.ts';
export interface ForegroundSyncFacts {resumed:boolean;interactive:boolean;exclusive:boolean;permission:boolean;enabled:boolean}
export interface ForegroundTimer {result:Promise<unknown>;cancel():void}
export interface ForegroundListener {
 start(options:LibrarySessionOptions & {onPeer?:(peer:{remoteName:string|null;remoteAddress:string})=>void}):Promise<SessionActionResult[]>;
 stop():void;
}
export interface ForegroundSyncPorts {
 createListener():ForegroundListener;
 delay(milliseconds:number):ForegroundTimer;
 keepScreenOn(active:boolean):void;
 acquireMedia(owner:string):void;
 releaseMedia(owner:string):void;
 onError?(error:unknown):void;
}
const OWNER='rfcomm-bootstrap';
const empty:ForegroundSyncFacts={resumed:false,interactive:false,exclusive:false,permission:false,enabled:false};
/** Native foreground listener policy. A paused transfer retains its session;
 * idle listeners stop after 2.5 seconds, failures retry after 500 ms, and the
 * media lease bridges subsequent IP ownership for 30 seconds. */
export class ForegroundSyncController {
 private facts={...empty};private desired=false;private disposed=false;private transferring=false;
 private listener:ForegroundListener|undefined;private listenerStopped=false;private job:Promise<void>|undefined;
 private stopTimer:ForegroundTimer|undefined;private releaseTimer:ForegroundTimer|undefined;private retryTimer:ForegroundTimer|undefined;
 private mediaOwned=false;
 constructor(private readonly ports:ForegroundSyncPorts,private readonly options:LibrarySessionOptions={}){}
 update(facts:ForegroundSyncFacts){
  if(this.disposed)return;this.facts={...facts};
  if(this.eligible()){this.desired=true;this.stopTimer?.cancel();this.stopTimer=undefined;this.ensure();}
  else this.scheduleStop();
 }
 private eligible(){const f=this.facts;return f.resumed&&f.interactive&&!f.exclusive&&f.permission&&f.enabled;}
 private ensure(){if(this.job||this.disposed)return;const job=this.loop();this.job=job;void job.then(()=>{if(this.job===job)this.job=undefined;if(this.desired&&!this.disposed)this.ensure();},error=>{if(this.job===job)this.job=undefined;this.desired=false;this.report(error);});}
 private report(error:unknown){try{this.ports.onError?.(error);}catch{}}
 private scheduleStop(){
  if(this.transferring||this.stopTimer||this.disposed)return;
  const timer=this.ports.delay(2500);this.stopTimer=timer;
  void timer.result.then(()=>{
   if(this.stopTimer!==timer)return;this.stopTimer=undefined;
   if(this.eligible()||this.transferring||this.disposed)return;
   this.desired=false;this.listenerStopped=true;this.listener?.stop();this.retryTimer?.cancel();
  },()=>{});
 }
 private transfer(active:boolean){
  this.transferring=active;this.ports.keepScreenOn(active);
  if(!active&&!this.eligible())this.scheduleStop();
 }
 private acquire(){this.releaseTimer?.cancel();this.releaseTimer=undefined;this.ports.acquireMedia(OWNER);this.mediaOwned=true;}
 private releaseLater(){
  if(!this.mediaOwned)return;this.releaseTimer?.cancel();
  const timer=this.ports.delay(30000);this.releaseTimer=timer;
  void timer.result.then(()=>{if(this.releaseTimer!==timer)return;this.releaseTimer=undefined;this.release();},()=>{});
 }
 private release(){if(!this.mediaOwned)return;this.mediaOwned=false;this.ports.releaseMedia(OWNER);}
 private async loop(){
  while(this.desired&&!this.disposed){
   this.transfer(false);this.listenerStopped=false;const listener=this.ports.createListener();this.listener=listener;let failure:unknown;
   try{await listener.start({...this.options,onPeer:()=>{if(this.disposed)return;this.acquire();this.transfer(true);}});}
   catch(error){failure=error;}
   finally{if(this.listener===listener)this.listener=undefined;this.transfer(false);if(!this.disposed)this.releaseLater();}
   if(failure&&!this.listenerStopped&&this.desired&&!this.disposed){
    this.report(failure);const timer=this.ports.delay(500);this.retryTimer=timer;
    try{await timer.result;}catch{}finally{if(this.retryTimer===timer)this.retryTimer=undefined;}
   }
   if(!this.eligible())this.scheduleStop();
  }
 }
 async quiesce(){
  this.desired=false;this.stopTimer?.cancel();this.stopTimer=undefined;this.retryTimer?.cancel();this.listenerStopped=true;this.listener?.stop();await this.job;
 }
 async dispose(){
  if(this.disposed){await this.job;return;}
  this.disposed=true;this.desired=false;this.stopTimer?.cancel();this.stopTimer=undefined;this.releaseTimer?.cancel();this.releaseTimer=undefined;this.retryTimer?.cancel();this.retryTimer=undefined;
  this.listenerStopped=true;this.listener?.stop();this.transfer(false);this.release();await this.job;
 }
}
