/** 26.2 P6-6 trusted time. Source: issuedAtMillis of the latest verified
 * checkpoint, advanced by the local monotonic clock. Memory only: a process
 * restart or 24 h without a fresh checkpoint means no trusted time. */
const ROLLBACK_MILLIS=300000,STALE_MILLIS=86400000;
export class TrustedClock {
 private base:{issuedAt:number;at:number}|null=null;
 constructor(private readonly monotonic:()=>number=()=>globalThis.performance?.now?.()??Date.now()){}
 /** Returns false when the checkpoint is rejected as a clock source. */
 observe(issuedAtMillis:number){
  if(!Number.isSafeInteger(issuedAtMillis)||issuedAtMillis<0)return false;
  const current=this.now();if(current!==null&&issuedAtMillis<current-ROLLBACK_MILLIS)return false;
  this.base={issuedAt:Math.max(issuedAtMillis,current??0),at:this.monotonic()};return true;
 }
 now():number|null{
  if(!this.base)return null;const elapsed=this.monotonic()-this.base.at;
  if(!(elapsed>=0)||elapsed>STALE_MILLIS)return null;return Math.floor(this.base.issuedAt+elapsed);
 }
 clear(){this.base=null;}
}
/** Actions that need trusted time fail with this code; pull/apply continue. */
export function requireTrustedNow(clock:TrustedClock){const n=clock.now();if(n===null)throw Error('trusted_time_unavailable');return n;}
