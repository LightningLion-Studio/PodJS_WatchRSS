import {FailClosedGate} from '@podjs/framework/build-gate';
/** Cloud sync is a product feature in both build types. An initialized host
 * identity is still required; account, membership and keys are checked by the service. */
export class CloudGate extends FailClosedGate {
 constructor(){super(value=>!!value&&typeof value==='object'&&typeof (value as {debugBuild?:unknown}).debugBuild==='boolean');}
 require(){if(!this.allowed)throw Error('Cloud sync host unavailable');}
}
export const cloudGate=new CloudGate();
