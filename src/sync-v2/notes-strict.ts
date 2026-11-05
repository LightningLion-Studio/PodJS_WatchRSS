/** Portable schema adapters for the rc6c note planner. */
import {exact,checkD64,uint,oid} from './protocol';
import {unhex} from '@podjs/framework/crypto';
import {unb64} from './wire';
export {exact,uint};
export const d64=(v:any)=>BigInt(checkD64(v));
export const nextD64=(v:any)=>{const n=d64(v);if(n===18446744073709551615n)throw Error('counter_exhausted');return String(n+1n);};
export const objectOid=(v:any,t:string)=>oid(v,t);
export function hexBytes(v:any,n:number){if(typeof v!=='string'||v.length!==n*2)throw Error('invalid_schema');return unhex(v);}
export const base64url=unb64;
export function capture(v:any){try{exact(v,['stateVersion','accountOid','accountRevision','generation','localChangeRevision'],true);if(!Object.isFrozen(v))throw Error();for(const k of ['stateVersion','accountRevision','generation','localChangeRevision'])checkD64(v[k]);oid(v.accountOid,'commit');}catch{throw Error('choice_stale');}}
