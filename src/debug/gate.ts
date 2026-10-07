import {FailClosedGate} from '@podjs/framework/build-gate';
/** Fail closed: no application version, env variable, KV or route can enable debug. */
export class DebugGate extends FailClosedGate {
 constructor(){super(value=>!!value&&typeof value==='object'&&(value as {debugBuild?:unknown}).debugBuild===true);}
 require(){if(!this.allowed)throw new Error('Debug tools unavailable in this build');}
}
