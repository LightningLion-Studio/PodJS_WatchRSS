/** Closed reasons only. These errors retain the current checkpoint and grant. */
export const SNAPSHOT_DEFER_CODES=[
 'cloud_snapshot_object_missing','cloud_snapshot_object_unauthorized',
 'cloud_snapshot_object_timeout','cloud_snapshot_object_rate_limited',
 'cloud_snapshot_object_redirect','cloud_snapshot_object_integrity',
 'cloud_snapshot_download_failed','cloud_snapshot_work_timeout',
] as const;
export type SnapshotDeferralCode=typeof SNAPSHOT_DEFER_CODES[number];
export function snapshotDeferred(error:unknown):boolean {
 const value=error as {code?:unknown;message?:unknown}|null;
 return SNAPSHOT_DEFER_CODES.some(code=>value?.code===code||value?.message===code);
}
export function rethrowSnapshotDeferred(error:unknown):void {if(snapshotDeferred(error))throw error;}

/** A headless codec yield is a host roundtrip, not evidence of durable progress.
 * After two persisted zero-progress restore windows, bound an uninterrupted
 * yield-only burst, including pure codec scheduling. Ordinary first attempts
 * retain the full window; a new durable receipt disables this guard.
 * Completed IO resets only the yield burst; a separate budget caps repeated
 * non-durable IO after the same scope/work stalls. Only a secure receipt
 * disables that budget. diagnostics and releases cannot reset it.
 * The sample cap also bounds frozen/regressing clocks. No writes race a timer. */
export class SnapshotYieldBudget {
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
