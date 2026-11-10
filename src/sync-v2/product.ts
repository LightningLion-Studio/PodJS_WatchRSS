/** 26.1 P6 product adapters: account content key, K_id receive through the
 * recovery capsule, and K_id custody next to the account keys. The watch only
 * receives; it never creates a repo or generates a replacement K_id. */
import {sha256Hex} from '@podjs/framework/crypto';
import type {HttpTransport} from '../cloud/types';
import {canonical,exact,oid,validateScope,type Scope} from './protocol';
import {parseNetwork,SyncV2Error} from './http';
import {descriptorOid,type IdentityCrypto,type WatchRecipient} from './identity';
import {WatchIdentityStore,type IdentityStorage} from './identity-store';

/** The subset of WatchCloudKeyManager the v2 runtime needs (src/cloud/keys.ts). */
export interface AccountKeyring {currentKeyVersion(userId:string):Promise<number>;accountKey(userId:string,version?:number):Promise<Uint8Array|undefined>}
/** P6-1: K_content[v] is the existing account key of version v. New writes use
 * the highest authenticated version; a missing version is `key_unavailable`. */
export function accountContentKey(keys:AccountKeyring,userId:string){
 const at=async(version:number)=>{if(!Number.isSafeInteger(version)||version<1)throw new SyncV2Error('key_unavailable');const key=await keys.accountKey(userId,version);if(!key||key.length!==32)throw new SyncV2Error('key_unavailable');return {key,version};};
 return {current:async()=>at(await keys.currentKeyVersion(userId)),at};
}
/** P6-5: K_id lives under the account-key secure prefix, so the existing
 * account-key clear (logout/switch, `WatchCloudKeyManager.clear`) removes it. */
export function accountScopedStorage(secure:IdentityStorage,accountKeyPrefix:string):IdentityStorage{
 if(!/^watchrss\.cloud\.keys\.[a-f0-9]{64}\.$/.test(accountKeyPrefix))throw Error('secure_store_corrupt');
 return {get:key=>secure.get(accountKeyPrefix+'syncv2.'+key),compareAndSet:(key,expected,value)=>secure.compareAndSet(accountKeyPrefix+'syncv2.'+key,expected,value)};
}
/** Same prefix WatchCloudKeyManager uses: sha256(JSON([backendBase,userId])). */
export function accountKeyPrefix(backendBaseUrl:string,userId:string){if(!userId)throw Error('account_missing');return 'watchrss.cloud.keys.'+sha256Hex(new TextEncoder().encode(JSON.stringify([backendBaseUrl.replace(/\/+$/,''),userId])))+'.';}

/** Adapts the framework v2 crypto port (SEC1 keys, nonce-first AEAD) to 18.1. */
export function identityCryptoPort(v2:{hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;decrypt(key:Uint8Array,nonce:Uint8Array,input:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;verify(publicKey:Uint8Array,input:Uint8Array,signature:Uint8Array):Promise<boolean>}):IdentityCrypto{
 return {hkdf:(k,s,i)=>v2.hkdf(k,s,i),decrypt:(k,aad,nonce,c)=>v2.decrypt(k,nonce,c,aad),verify:(spki,m,s)=>{if(spki.length<65)return Promise.resolve(false);return v2.verify(spki.subarray(spki.length-65),m,s);}};
}

export type RepoIdentityFetch={scope:Scope;descriptor:any;descriptorOid:string;capsule:any};
/** P6-4: GET /repo/descriptor and its immutable recovery capsule. The server
 * derives scope for these two reads; every byte is checked here and the K_wrap
 * proof/signature/AEAD are verified later by WatchIdentityStore. Returns null
 * when the account has no repo yet (the watch waits for phone/mini). */
export async function fetchRepoIdentity(transport:HttpTransport,origin:string,session:{accessToken:string;legacyDeviceId:string}):Promise<RepoIdentityFetch|null>{
 if(!session.accessToken||!session.legacyDeviceId)throw Error('authorization_required');
 const prefix=origin+'/functions/v1/sync/v2',headers={Authorization:'Bearer '+session.accessToken,'x-watchrss-cloud-device-id':session.legacyDeviceId};
 const get=(path:string)=>transport.request({method:'GET',url:prefix+path,headers,timeoutMs:10000,readTimeoutMs:10000,acceptHttpErrors:true});
 const r=await get('/repo/descriptor');if(r.status>=300&&r.status<400)throw new SyncV2Error('transport_error');if(r.body.length>16384)throw Error('object_too_large');
 const value=parseNetwork(r.body);if(r.status>=400){const code=value?.error?.code;if(code==='object_missing')return null;throw new SyncV2Error(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?code:'transport_error');}
 exact(value,['version','scope','descriptorOid','descriptor','recoveryOid']);if(value.version!==2)throw new SyncV2Error('upgrade_required');validateScope(value.scope);oid(value.descriptorOid,'repo-descriptor');oid(value.recoveryOid,'id-key-recovery');
 if(descriptorOid(value.descriptor)!==value.descriptorOid||canonical(value.descriptor?.body?.scope)!==canonical(value.scope))throw Error('authentication_required');
 const c=await get('/repo/id-key-recovery/'+encodeURIComponent(value.recoveryOid));if(c.status!==200)throw new SyncV2Error(c.status===404?'object_missing':'transport_error');
 if(c.body.length>8192||'id-key-recovery:sha256:'+sha256Hex(c.body)!==value.recoveryOid)throw Error('hash_mismatch');
 return {scope:value.scope,descriptor:value.descriptor,descriptorOid:value.descriptorOid,capsule:parseNetwork(c.body)};
}
/** P6-4/P6-5: install (or re-confirm) K_id from the capsule with every 18.1
 * check. A known pin that differs stops with `identity_conflict`. */
export async function receiveRepoIdentity(options:{fetched:RepoIdentityFetch;storage:IdentityStorage;crypto:IdentityCrypto;random:(n:number)=>Promise<Uint8Array>;member:()=>Promise<WatchRecipient>;accountId:string;root:(version:number)=>Promise<Uint8Array>}){
 const {fetched}=options,store=new WatchIdentityStore(options.storage,options.random,options.crypto,options.member,fetched.scope,options.accountId);
 try{return await store.installed(fetched.descriptor);}catch(error){if((error as Error)?.message!=='identity_not_installed')throw error;}
 const root=await options.root(fetched.descriptor.body.wrappingKeyVersion);
 return store.installRecovery(fetched.capsule,fetched.descriptor,root,fetched.descriptorOid);
}
