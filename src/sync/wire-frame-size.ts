import {encodeUtf8} from '@podjs/framework/bytes';
const lengths=new WeakMap<object,number>();
/** Transport metadata stays out of the frozen JSON field set. */
export function withFrameBytes<T extends object>(value:T,bytes:number):T {lengths.set(value,bytes);return value;}
export function frameBytes(value:object):number {return lengths.get(value)??encodeUtf8(JSON.stringify(value),'strict').length;}
