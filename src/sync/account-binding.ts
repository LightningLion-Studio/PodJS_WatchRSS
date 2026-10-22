import {stringToUtf8} from '@podjs/framework/bytes';
import type {WatchAccountStore} from '../account/store.ts';
import type {JsonObject} from './protocol.ts';

/** Read-only identity hint for a connected phone. Never return the secure account object. */
export async function watchAccountBinding(store:Pick<WatchAccountStore,'read'>,
 sha256:(bytes:Uint8Array)=>string|Promise<string>):Promise<JsonObject>{
 const account=await store.read();
 if(!account)return {bound:false};
 // SHA-256 of the exact UTF-8 userId; token expiry does not mean the user logged out.
 const userIdHash=await sha256(stringToUtf8(account.userId));
 if(!/^[0-9a-f]{64}$/.test(userIdHash))throw Error('账号摘要校验失败');
 return {bound:true,userIdHash};
}
