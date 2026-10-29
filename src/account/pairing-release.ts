import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {utf8Encode} from '../cloud/types';
import {WatchLoginExpiredError} from './token';
import type {WatchAccountState} from './types';
import type {PairingReplacementReceipt} from '../onboarding/watch-setup';
export const RELEASE_ALGORITHM='P256-ECDH-HKDF-SHA256-A256GCM-HMAC-SHA256-v1';
export interface PairingReleaseTarget {userId:string;deviceId:string;installId:string;sessionId:string;check():void}
export interface PossessionProofArgs {keyIdSha256:string;recipientSpkiSha256:string;publicKeySpki:string;saltBase64:string;infoBase64:string;nonceBase64:string;ciphertextBase64:string;aadBase64:string;dataBase64:string}
const fail=(code='pairing_release_challenge_invalid'):never=>{throw Error(code);};
const hex=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)?Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16)):fail();
const canonical64=(s:unknown,size?:number)=>{if(typeof s!=='string'||s.length>8192||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))return fail();let b:Uint8Array;try{b=base64ToBytes(s);}catch{return fail();}if(bytesToBase64(b)!==s||size!==undefined&&b.length!==size)return fail();return b;};
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const concat=(a:Uint8Array,b:Uint8Array)=>{const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
/** Decode/compare every authenticated transcript field. Opaque server bindings
 * stay opaque; they never become a new identity or an old-account disclosure. */
export async function possessionChallenge(value:any,target:PairingReleaseTarget,now:number,sha256:(bytes:Uint8Array)=>Promise<string>):Promise<{challengeId:string;expiresAtMillis:number;args:PossessionProofArgs}>{
 target.check();if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const fields=['challengeId','algorithm','expiresAtMillis','deviceId','installId','targetUserId','recipientKeyIdSha256','recipientSpkiSha256','ephemeralPublicKeySpki','saltBase64','nonceBase64','wrappedSecretBase64','transcriptBase64'];
 if(Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))||value.algorithm!==RELEASE_ALGORITHM||typeof value.challengeId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.challengeId)||value.deviceId!==target.deviceId||value.installId!==target.installId||value.targetUserId!==target.userId||!Number.isSafeInteger(value.expiresAtMillis)||value.expiresAtMillis<=now||value.expiresAtMillis>now+60000)return fail();
 const id=hex(value.recipientKeyIdSha256),spkiHash=hex(value.recipientSpkiSha256),spki=canonical64(value.ephemeralPublicKeySpki,91),salt=canonical64(value.saltBase64,32),nonce=canonical64(value.nonceBase64,12);canonical64(value.wrappedSecretBase64,48);
 // Canonical uncompressed P-256 SPKI; the native crypto provider validates the point.
 const prefix=Uint8Array.from([48,89,48,19,6,7,42,134,72,206,61,2,1,6,8,42,134,72,206,61,3,1,7,3,66,0,4]);if(!equal(spki.slice(0,prefix.length),prefix))return fail();
 const transcript=canonical64(value.transcriptBase64);if(transcript.length>4096)return fail();
 const decoded:Uint8Array[]=[];let offset=0;const view=new DataView(transcript.buffer,transcript.byteOffset,transcript.byteLength);
 while(offset<transcript.length){if(offset+4>transcript.length)return fail();const n=view.getUint32(offset);offset+=4;if(n>4096||offset+n>transcript.length)return fail();decoded.push(transcript.slice(offset,offset+n));offset+=n;}
 if(decoded.length!==14||[6,7].some(i=>decoded[i]!.length!==32||decoded[i]!.every(b=>b===0)))return fail();
 const expected=[utf8Encode('watchrss/pairing-ownership-release/v1'),utf8Encode(value.challengeId),utf8Encode(target.sessionId),utf8Encode(target.deviceId),utf8Encode(target.installId),utf8Encode(target.userId),decoded[6]!,decoded[7]!,id,spkiHash,spki,salt,nonce,utf8Encode(String(value.expiresAtMillis))];
 if(expected.some((b,i)=>!equal(b,decoded[i]!)))return fail();
 const h=hex(await sha256(transcript));target.check();
 return{challengeId:value.challengeId,expiresAtMillis:value.expiresAtMillis,args:{keyIdSha256:value.recipientKeyIdSha256,recipientSpkiSha256:value.recipientSpkiSha256,publicKeySpki:value.ephemeralPublicKeySpki,saltBase64:value.saltBase64,nonceBase64:value.nonceBase64,ciphertextBase64:value.wrappedSecretBase64,infoBase64:bytesToBase64(concat(utf8Encode('watchrss/pairing-ownership-release-wrap/v1'),h)),aadBase64:bytesToBase64(concat(utf8Encode('watchrss/pairing-ownership-release-aad/v1'),h)),dataBase64:bytesToBase64(concat(utf8Encode('watchrss/pairing-ownership-release-proof/v1'),h))}};
}
export interface PairingProofState {binding?:string;pending?:{challengeId:string;expiresAtMillis:number;proofBase64:string};complete?:boolean}
export async function releaseByPossession(target:PairingReleaseTarget,ports:{now():number;sha256(bytes:Uint8Array):Promise<string>;rpc(path:string,body:Record<string,unknown>):Promise<{status:number;body:any}>;proof(args:PossessionProofArgs):Promise<{proofBase64:string}>},state:PairingProofState={}){
 const request=async(path:string,body:Record<string,unknown>)=>{target.check();const r=await ports.rpc(path,body);target.check();if(r.status<200||r.status>=300){const code=typeof r.body?.code==='string'&&/^pairing_release_[a-z_]{1,64}$/.test(r.body.code)?r.body.code:'pairing_release_http';return fail(code);}return r.body;};
 const binding=JSON.stringify([target.sessionId,target.userId,target.deviceId,target.installId]);target.check();
 if(state.binding&&state.binding!==binding)return fail('pairing_release_binding_changed');state.binding=binding;if(state.complete)return;
 if(!state.pending){
 const response=await request('ownership/challenge',{deviceId:target.deviceId,installId:target.installId,targetUserId:target.userId});
 const c=await possessionChallenge(response,target,ports.now(),ports.sha256);target.check();if(ports.now()>=c.expiresAtMillis)return fail('pairing_release_challenge_expired');
 let proof:{proofBase64:string};try{proof=await ports.proof(c.args);}catch{target.check();return fail('pairing_release_proof_unavailable');}target.check();canonical64(proof.proofBase64,32);if(ports.now()>=c.expiresAtMillis)return fail('pairing_release_challenge_expired');
 state.pending={challengeId:c.challengeId,expiresAtMillis:c.expiresAtMillis,proofBase64:proof.proofBase64};
 }
 const c=state.pending;if(ports.now()>=c.expiresAtMillis){state.pending=undefined;return fail('pairing_release_challenge_expired');}
 // Uncertain HTTP delivery retries the same challenge and proof, never a fresh release.
 const receipt=await request('ownership/release',{challengeId:c.challengeId,proofBase64:c.proofBase64});
 if(receipt.sessionId!==target.sessionId||receipt.challengeId!==c.challengeId||receipt.deviceId!==target.deviceId||receipt.installId!==target.installId||receipt.targetUserId!==target.userId||receipt.ownershipReleased!==true)return fail('pairing_release_unverified');
 state.complete=true;state.pending=undefined;
}
export class PairingReplacementError extends Error {
 constructor(readonly code:string,readonly released:boolean,readonly cleared:boolean,readonly retryable:boolean){super(code);}
}
export interface PairingReplacementPorts {
 read():Promise<WatchAccountState|null>;
 releaseStored(expected:WatchAccountState|null,release:(current:WatchAccountState|null,saveFresh:(state:WatchAccountState)=>Promise<void>)=>Promise<void>):Promise<void>;
 normal(account:WatchAccountState,saveFresh:(state:WatchAccountState)=>Promise<void>):Promise<void>;
 possession(target:PairingReleaseTarget):Promise<void>;
 clearAndSetOwner(target:PairingReleaseTarget):Promise<void>;
 progress(phase:'releasing'|'clearing'):void;
}
/** Explicit SAS+wipe consent is enforced by WatchSetupHandler before calling.
 * A failed/cancelled remote transaction never means "ownership released". */
export async function replacePairingAccount(target:PairingReleaseTarget,p:PairingReplacementPorts):Promise<PairingReplacementReceipt>{
 let released=false,cleared=false;
 try {
  target.check();const old=await p.read();target.check();p.progress('releasing');
  await p.releaseStored(old,async(current,saveFresh)=>{
   target.check();
   if(current){try{await p.normal(current,async fresh=>{target.check();await saveFresh(fresh);target.check();});}catch(e){target.check();if((e as any)?.code==='device_revoked')throw Error('pairing_device_revoked');if(!(e instanceof WatchLoginExpiredError)&&![401,403].includes((e as any)?.status))throw Error('pairing_release_failed');await p.possession(target);}}
   else await p.possession(target);
   released=true;target.check();
  });target.check();p.progress('clearing');await p.clearAndSetOwner(target);cleared=true;target.check();return{released:true,cleared:true};
 }catch(error){
  const reason=(error as Error)?.message,clear=(error as any)?.code;
  const code=typeof reason==='string'&&/^pairing_[a-z_]+$/.test(reason)?reason:typeof clear==='string'&&/^clear_library_(cancelled|timeout|busy|database|files|changed|cleanup)$/.test(clear)?'pairing_'+clear:'pairing_replacement_failed';
  throw new PairingReplacementError(code,released,cleared,!['pairing_device_revoked','pairing_release_proof_unavailable','pairing_identity_changed'].includes(code));
 }
}
