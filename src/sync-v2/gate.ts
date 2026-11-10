/** P1 is an explicit local-only experiment. Nothing starts on import. */
export const P1_CLOSED_GATES=Object.freeze({cloudWrite:false,repoInit:false,segments:false,rotate:false,accountApply:false,localObjects:false,gc:false,cleanup:false});
export class ProjectionGate {
 constructor(private enabled=false){}
 private closers:Array<()=>Promise<void>>=[];
 onClose(close:()=>Promise<void>){this.closers.push(close);}
 /** Disable immediately in memory; await the returned promise for durable stop. */
 close(){this.enabled=false;const stopped=Promise.all(this.closers.map(close=>close())).then(()=>{});void stopped.catch(()=>{});return stopped;}
 get isEnabled(){return this.enabled;}
 require(){if(!this.enabled)throw Error('feature_disabled');}
}
/** 26.4 P6-10 product switch, same frozen-table home as the P1/P2 gates.
 * Off (default) or no bootstrap announcement: no runtime, no v2 request,
 * no local write, no UI port. */
export const SYNC_V2_PRODUCT=Object.freeze({syncV2:false});
