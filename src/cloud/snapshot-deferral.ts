import {RepeatedWorkGuard,REPEATED_WORK_VERSION} from '@podjs/framework/work-window';
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

/** Local guard semantics only. Never change the journal/projection scope to
 * reset a diagnostic: authenticated restore receipts must survive upgrades. */
export const SNAPSHOT_GUARD_VERSION='snapshot-replay-v2:'+REPEATED_WORK_VERSION;

/** Track completed expensive calls with immutable input/part identities.
 * Different chunks/offsets, secure reads and CPU yields get the full window.
 * No temporary-file count or elapsed time can starve the first durable receipt.
 * A new receipt changes the frontier and clears all in-memory replay evidence.
 */
export class SnapshotYieldBudget {
 private guard=new RepeatedWorkGuard({repeated:()=>Object.assign(Error('cloud_snapshot_work_timeout'),{code:'cloud_snapshot_work_timeout'})});
 stalled(active:boolean){this.guard.reset(active);}
 private identity(method:string,args:Record<string,unknown>):string|undefined {
  // AAD + nonce identify the authenticated input, independent of fresh temp
  // names. Never persist/log keys, content, URLs or these local identities.
  if(method==='crypto.largeAesGcmDecrypt'&&typeof args.aadBase64==='string'&&typeof args.nonceBase64==='string')return JSON.stringify([method,args.aadBase64,args.nonceBase64]);
  if(method==='crypto.gunzipSealedParts'&&typeof args.outputPrefix==='string'&&Number.isSafeInteger(args.offset))return JSON.stringify([method,args.outputPrefix,args.offset]);
  return undefined;
 }
 before(method:string,args:Record<string,unknown>={}){this.guard.before(this.identity(method,args));}
 completed(method:string,args:Record<string,unknown>={}){this.guard.complete(this.identity(method,args));}
}
