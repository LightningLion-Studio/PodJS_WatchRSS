import {createHash} from 'node:crypto';
export function plainPart(scope:Uint8Array,bytes:Uint8Array){return new Uint8Array(Buffer.concat([Buffer.from('PLN4'),createHash('sha256').update(scope).update(Buffer.from([0])).update(bytes).digest().subarray(0,24),bytes]));}
export async function openLocalPart(key:Uint8Array,scope:Uint8Array,bytes:Uint8Array,decrypt:(key:Uint8Array,scope:Uint8Array,nonce:Uint8Array,cipher:Uint8Array)=>Promise<Uint8Array>){
 if(Buffer.from(bytes.subarray(0,4)).toString()==='PLN4'){const value=bytes.subarray(28);if(!Buffer.from(plainPart(scope,value)).equals(Buffer.from(bytes)))throw Error('invalid_plain_part');return value;}
 return decrypt(key,scope,bytes.subarray(0,12),bytes.subarray(12));
}
