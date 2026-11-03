import {createP256,validateP256PublicKey} from '@podjs/framework/p256';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {lengthPrefix,unhex} from '@podjs/framework/crypto';
import {transcript,type ApprovalTranscript,type V2Crypto} from './v2';
import {utf8Encode,type CloudKeyEnvelope} from './types';

export interface ApprovalSigner {publicKeySpki:string;sign(t:ApprovalTranscript,payload:string):Promise<string>;dispose():void}
export interface ApproverCrypto {
 validateSpki(spki:string):void;
 signer():Promise<ApprovalSigner>;
 wrap(key:Uint8Array,userId:string,deviceId:string,spki:string,keyVersion:number):Promise<CloudKeyEnvelope>;
}
/** Approval-v2 framing and device-envelope adapter. Generic P-256 belongs to the framework. */
export function createApproverCrypto(c:Pick<V2Crypto,'random'|'sha256'> & {
 hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
 encrypt(key:Uint8Array,aad:Uint8Array,input:Uint8Array):Promise<{nonce:Uint8Array;ciphertext:Uint8Array}>;
}):ApproverCrypto {
 const p256=createP256({random:c.random,sha256:async bytes=>unhex(await c.sha256(bytes))});
 return {
  validateSpki:spki=>validateP256PublicKey(base64ToBytes(spki)),
  async signer(){const pair=await p256.generateKeyPair();return {publicKeySpki:bytesToBase64(pair.publicKeySpki),sign:async(t,payload)=>bytesToBase64(await pair.sign(lengthPrefix('watchrss/approval-deliver/v2',unhex(await c.sha256(transcript(t))),payload))),dispose:()=>pair.dispose()};},
  async wrap(key,userId,deviceId,spki,keyVersion){
   if(key.length!==32)throw Error('invalid_account_key');
   const ephemeral=await p256.generateKeyPair();let shared:Uint8Array|undefined,wrapping:Uint8Array|undefined;
   try{const secret=ephemeral.deriveSecret(base64ToBytes(spki));shared=secret;wrapping=await c.hkdf(secret,unhex(await c.sha256(utf8Encode(userId))),utf8Encode(`watchrss/device-envelope/v${keyVersion}/${deviceId}`));
    const encrypted=await c.encrypt(wrapping,utf8Encode(`watchrss-account-key:${userId}:${keyVersion}:${deviceId}`),key);
    return {algorithm:'P-256+HKDF-SHA256+A256GCM',keyVersion,wrappedKeyBase64:bytesToBase64(encrypted.ciphertext),nonceBase64:bytesToBase64(encrypted.nonce),ephemeralPublicKeySpki:bytesToBase64(ephemeral.publicKeySpki)};
   }finally{ephemeral.dispose();shared?.fill(0);wrapping?.fill(0);}
  },
 };
}
