/** P1 is an explicit local-only experiment. Nothing starts on import. */
export const P1_CLOSED_GATES=Object.freeze({cloudWrite:false,repoInit:false,segments:false,rotate:false,accountApply:false,localObjects:false,gc:false,cleanup:false});
export class ProjectionGate {
 constructor(private enabled=false){}
 close(){this.enabled=false;}
 get isEnabled(){return this.enabled;}
 require(){if(!this.enabled)throw Error('feature_disabled');}
}
