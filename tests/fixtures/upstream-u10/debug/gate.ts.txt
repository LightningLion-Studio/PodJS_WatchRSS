/** Fail closed: no application version, env variable, KV or route can enable debug. */
export class DebugGate {
 private enabled=false;
 private pending?:Promise<boolean>;
 get allowed(){return this.enabled;}
 initialize(read:()=>Promise<unknown>):Promise<boolean>{
  return this.pending??=Promise.resolve().then(read).then(value=>this.enabled=!!value&&typeof value==='object'&&(value as {debugBuild?:unknown}).debugBuild===true,()=>false);
 }
 require(){if(!this.enabled)throw new Error('Debug tools unavailable in this build');}
}
