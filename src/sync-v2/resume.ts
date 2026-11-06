import {uint} from './protocol';
/** Nonzero remote offsets require a verified scoped signed prefix receipt. A reserve replay
 * is an appointment identity, never a prefix witness. Keep the local high-water
 * mark when the server requires one-frame repair. */
export function checkedResumeOffset(confirmed:number,remote:number,total:number){
 uint(total,266264);uint(confirmed,total);uint(remote,total);
 if(remote<total&&remote%65536)throw Error('invalid_schema');
 if(remote<Math.max(0,confirmed-65536))throw Error('offset_conflict');
 return remote;
}
