/** 26.4 P6-10 application opener. Runs only when SYNC_V2_PRODUCT.syncV2 is on,
 * the bootstrap announces syncV2 and the v1 account keys are ready. */
import {createSyncV2Crypto} from '@podjs/framework/crypto';
import {readCloudSecure} from '../cloud/secure-read';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {HttpTransport} from '../cloud/types';
import {accountIdFromUserId} from './signing';
import {syncV2Origin} from './http';
import {accountContentKey,accountKeyPrefix,accountScopedStorage,fetchRepoIdentity,identityCryptoPort,receiveRepoIdentity,type AccountKeyring} from './product';

export interface ApplicationSyncV2Account {userId:string;backendBaseUrl:string;watchDeviceToken:string}
/** Receiver K_id step of the opener (P6-4/P6-5). Returns the installed record,
 * or null while the account has no repo yet (phone/mini creates it). */
export async function receiveApplicationIdentity(options:{host:CloudHostRequest;transport:HttpTransport;account:ApplicationSyncV2Account;legacyDeviceId:string;keys:AccountKeyring;allowLoopback?:boolean}){
 const {account}=options,base=account.backendBaseUrl.replace(/\/+$/,''),origin=syncV2Origin(base,{accountBaseUrl:base,allowLoopback:options.allowLoopback===true});
 const fetched=await fetchRepoIdentity(options.transport,origin,{accessToken:account.watchDeviceToken,legacyDeviceId:options.legacyDeviceId});if(!fetched)return null;
 const crypto=createSyncV2Crypto(options.host),accountId=accountIdFromUserId(account.userId),content=accountContentKey(options.keys,account.userId);
 const secure={get:(key:string)=>readCloudSecure(options.host,key),async compareAndSet(key:string,expected:string|null,value:string){const r=await options.host<{updated:boolean}>('secure.compareAndSet',{key,expected,value});if(typeof r.updated!=='boolean')throw Error('secure_store_corrupt');return r.updated;}};
 // The 18.1 recipient deviceId is H32; the v1 device UUID maps exactly like accountIdFromUserId.
 const deviceId=accountIdFromUserId(options.legacyDeviceId);
 const installed=await receiveRepoIdentity({fetched,storage:accountScopedStorage(secure,accountKeyPrefix(base,account.userId)),crypto:identityCryptoPort(crypto),random:n=>crypto.random(n),member:async()=>({authorized:true,accountId,deviceId,platform:'watch'}),accountId,root:async version=>(await content.at(version)).key});
 return {fetched,installed,origin};
}
