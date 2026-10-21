import {lengthPrefix,unhex,decimalCode} from '@podjs/framework/crypto';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import type {KeyCommitment,CloudTrust} from './types';
export interface V2Crypto {sha256(b:Uint8Array):Promise<string>;hmac(key:Uint8Array,b:Uint8Array):Promise<string>;verify(spki:Uint8Array,b:Uint8Array,sig:Uint8Array):Promise<boolean>;random(n:number):Promise<Uint8Array>}
export const commit=(c:Pick<V2Crypto,'hmac'>,k:Uint8Array,u:string,e:string,v:number)=>c.hmac(k,lengthPrefix('watchrss/key-commit/v2',u,e,v));
export const rotation=(c:Pick<V2Crypto,'hmac'>,k:Uint8Array,u:string,e:string,v:number,m:string)=>c.hmac(k,lengthPrefix('watchrss/key-rotate/v2',u,e,v,m));
export async function attest(c:Pick<V2Crypto,'hmac'|'sha256'>,k:Uint8Array,u:string,e:string,d:string,spki:string){return c.hmac(k,lengthPrefix('watchrss/device-attest/v2',u,e,d,unhex(await c.sha256(base64ToBytes(spki)))));}
export function validateTrust(t:CloudTrust){
 if(!t||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t.libraryEpoch)||!Number.isSafeInteger(t.keyVersionFloor)||t.keyVersionFloor<0||!Array.isArray(t.keyCommitments))throw Error('client_upgrade_required');
 const a=[...t.keyCommitments].sort((a,b)=>a.keyVersion-b.keyVersion);
 a.forEach((x,i)=>{if(!Number.isSafeInteger(x.keyVersion)||x.keyVersion<=t.keyVersionFloor||!/^[0-9a-f]{64}$/.test(x.commitment)|| (i===0?x.rotationProof!==null:x.keyVersion!==a[i-1].keyVersion+1||typeof x.rotationProof!=='string'||!/^[0-9a-f]{64}$/.test(x.rotationProof)))throw Error('invalid_key_commitment');});return a;
}
export interface ApprovalTranscript {userId:string;libraryEpoch:string;requestId:string;deviceId:string;publicKeySpki:string;approverDeviceId:string;approverSpki:string;requesterNonce:string;approverNonce:string}
export function transcript(t:ApprovalTranscript){const n=base64ToBytes(t.requesterNonce),o=base64ToBytes(t.approverNonce);if(n.length!==32||o.length!==32||!t.requestId||!t.approverDeviceId)throw Error('invalid_approval');return lengthPrefix('watchrss/approval/v2',t.userId,t.libraryEpoch,t.requestId,t.deviceId,base64ToBytes(t.publicKeySpki),t.approverDeviceId,base64ToBytes(t.approverSpki),n,o);}
export const approvalCommitment=(c:Pick<V2Crypto,'sha256'>,spki:string,nonce:string)=>c.sha256(lengthPrefix('watchrss/approval-commit/v2',base64ToBytes(spki),base64ToBytes(nonce)));
export async function approvalCode(c:Pick<V2Crypto,'sha256'>,t:ApprovalTranscript){return decimalCode(unhex(await c.sha256(transcript(t))));}
export async function verifyDelivery(c:Pick<V2Crypto,'sha256'|'verify'>,t:ApprovalTranscript,payload:string,signature:string){return c.verify(base64ToBytes(t.approverSpki),lengthPrefix('watchrss/approval-deliver/v2',unhex(await c.sha256(transcript(t))),payload),base64ToBytes(signature));}

export const canonicalSpki=(s:string)=>bytesToBase64(base64ToBytes(s));
export async function pairingSas(c:Pick<V2Crypto,'hmac'>,secret:Uint8Array,sessionId:string,userId:string){if(secret.length!==32||!sessionId||!userId)throw Error('invalid_pairing_identity');return decimalCode(unhex(await c.hmac(secret,lengthPrefix('watchrss/pairing-sas/v2',sessionId,userId))));}
