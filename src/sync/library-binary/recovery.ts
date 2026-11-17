import {fail,type Envelope} from './wire';

/** Logical-task lifetime, shared across route handoffs, epochs and replans. */
export class RecoveryRules {
 private searchFailures=0;private disconnects:number[]=[];
 private interval:{connectionId:string;reconnected:boolean;progress:boolean}|null=null;
 private noProgress=0;private seen=new Set<string>();private stopped=false;
 recoveryRoundFailed():boolean {if(this.stopped)return false;this.searchFailures++;if(this.searchFailures>=3)this.stopped=true;return !this.stopped;}
 accountReady(connectionId:string,reconnected:boolean):void {
  if(this.stopped)fail('AUTH_REVOKED');this.searchFailures=0;this.interval={connectionId,reconnected,progress:false};
 }
 /** Key must encode semantic content/version, independent of jobId and epoch. */
 confirm(kind:'STAGED'|'APPLIED'|'COMPLETE'|'BUSINESS_PHASE',semanticKey:string):boolean {
  if(this.stopped||!this.interval||!semanticKey)return false;
  const key=kind+':'+semanticKey;if(this.seen.has(key))return false;this.seen.add(key);this.interval.progress=true;this.noProgress=0;return true;
 }
 ioFailure(connectionId:string,at:number,cause:'closed'|'reset'|'EOF'|'SocketTimeout'):boolean {
  if(!['closed','reset','EOF','SocketTimeout'].includes(cause))fail();
  if(this.stopped||this.interval?.connectionId!==connectionId)return false;
  this.disconnects=this.disconnects.filter(t=>t>=at-10000);this.disconnects.push(at);
  if(this.interval.reconnected)this.noProgress=this.interval.progress?0:this.noProgress+1;
  this.interval=null;if(this.disconnects.length>=3||this.noProgress>=3)this.stopped=true;return !this.stopped;
 }
 /** Handoff/normal completion is not an I/O failure and preserves all counters. */
 detach(connectionId:string):void {if(this.interval?.connectionId===connectionId)this.interval=null;}
 stop():void {this.stopped=true;this.interval=null;}
 get snapshot(){return {searchFailures:this.searchFailures,disconnects:[...this.disconnects],noProgress:this.noProgress,stopped:this.stopped};}
}

/** Monotonic time inputs; no wall-clock, task-total timeout, or timer side effects. */
export class WorkTimers {
 private heartbeat:{id:string;digest:string;jobId:string|null;planDigest:string|null;epoch:number|null;started:number}|null=null;
 private lastHeartbeat:number;private lastLocalUnit:number;
 constructor(now:number){this.lastHeartbeat=now;this.lastLocalUnit=now;}
 heartbeatDue(now:number,authenticated:boolean,beginAuthorized:boolean):boolean {return authenticated&&beginAuthorized&&this.heartbeat===null&&now-this.lastHeartbeat>=10000;}
 /** Called when heartbeat write starts, not when it finishes. */
 heartbeatWriteStarted(e:Envelope,now:number):void {
  if(this.heartbeat||e.type!=='request'||e.phase!=='missing'||e.payload?.limit!==0||e.payload.afterObjectId!==null||e.payload.afterChunkIndex!==null)fail();
  this.heartbeat={id:e.requestId,digest:e.requestDigest,jobId:e.jobId,planDigest:e.planDigest,epoch:e.epoch,started:now};this.lastHeartbeat=now;
 }
 heartbeatReply(e:Envelope,now:number):boolean {
  const h=this.heartbeat;if(!h||e.type!=='response'||e.phase!=='missing'||e.requestId!==h.id||e.requestDigest!==h.digest||e.jobId!==h.jobId||e.planDigest!==h.planDigest||e.epoch!==h.epoch)return false;
  if(now-h.started>=30000)fail('SocketTimeout');this.heartbeat=null;return true;
 }
 heartbeatExpired(now:number):boolean {return this.heartbeat!==null&&now-this.heartbeat.started>=30000;}
 /** Only bounded real bytes/hash/index/import/transaction work units call this. */
 localWorkUnit(now:number):void {this.lastLocalUnit=now;}
 localStalled(now:number):boolean {return now-this.lastLocalUnit>=30000;}
 resetEpoch(now:number):void {this.heartbeat=null;this.lastHeartbeat=now;this.lastLocalUnit=now;}
}
export class NetworkWait {
 private lastByte:number;private frameStarted:number|null=null;private mode:'WAIT_NETWORK'|'WAIT_LOCAL'|'WAIT_REMOTE_WORK'='WAIT_NETWORK';
 constructor(now:number){this.lastByte=now;}
 wait(mode:'WAIT_NETWORK'|'WAIT_LOCAL'|'WAIT_REMOTE_WORK',now:number):void {this.mode=mode;this.lastByte=now;}
 /** Stale/duplicate ACK bytes must not call validBytes. */
 validBytes(now:number,frameComplete:boolean):void {this.lastByte=now;if(this.frameStarted===null)this.frameStarted=now;if(frameComplete)this.frameStarted=null;}
 expired(now:number):boolean {return this.frameStarted!==null&&now-this.frameStarted>=60000||this.mode==='WAIT_NETWORK'&&now-this.lastByte>=30000;}
}
