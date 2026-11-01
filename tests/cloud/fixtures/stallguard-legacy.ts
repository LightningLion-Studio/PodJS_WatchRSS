// Frozen guard from app 0692f251, for STALLGUARD baseline reproduction only.
export class LegacySnapshotYieldBudget {
 private started:number|undefined;private yields=0;private workStarted:number|undefined;private io=0;private active=false;
 constructor(private now=Date.now){}
 stalled(active:boolean){this.active=active;this.started=undefined;this.yields=0;this.workStarted=undefined;this.io=0;}
 before(method:string){
  if(!this.active)return;
  // Scope + unchanged secure work bind this attempt to the stalled unit.
  // Reads, temporary writes and decrypts do not certify durable progress.
  if(/^(file\.|crypto\.)/.test(method)&&!['file.delete','crypto.closeSealedGzip'].includes(method)){
   this.workStarted??=this.now();if(this.now()-this.workStarted>=30000||this.io>=256)throw Object.assign(Error('cloud_snapshot_work_timeout'),{code:'cloud_snapshot_work_timeout'});this.io++;
  }
  if(method!=='runtime.delay')return;
  this.started??=this.now();
  if(this.now()-this.started>=30000||this.yields>=1024)
   throw Object.assign(Error('cloud_snapshot_work_timeout'),{code:'cloud_snapshot_work_timeout'});
  this.yields++;
 }
 completed(method:string){
  if(['runtime.delay','log.append','cloud.release','secure.release'].includes(method))return;
  this.started=undefined;this.yields=0;
 }
}
