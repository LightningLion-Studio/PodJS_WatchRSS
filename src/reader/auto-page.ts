/** Foreground reading time only. Returning from controls/background starts a fresh interval. */
export class AutoPageClock {
 private since:number|undefined;
 private seconds:number|undefined;
 reset(){this.since=undefined;}
 tick(now:number,enabled:boolean,seconds:number):boolean {
  if(!enabled||!Number.isFinite(now)||!Number.isFinite(seconds)||seconds<=0){this.reset();return false;}
  if(this.since===undefined||this.seconds!==seconds||now<this.since){this.since=now;this.seconds=seconds;return false;}
  if(now-this.since<seconds*1000)return false;
  this.since=now;return true;
 }
}
