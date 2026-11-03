import {bytesToBase64} from '@podjs/framework/bytes';
import type {WatchCloudClient} from './client';
import type {WatchCloudKeyManager} from './keys';
import type {CloudBootstrap} from './types';
import {approvalCode,approvalCommitment,attest,canonicalSpki,validateTrust,type ApprovalTranscript,type V2Crypto} from './v2';
import type {ApprovalSigner,ApproverCrypto} from './approver-crypto';
import {CloudRequestError} from './client';

export interface PendingApproval {
 requestId:string;deviceId:string;displayName:string;publicKeySpki:string;commitment:string;expiresAt:number;
}
export interface ApproverSession {
 scope:string;userId:string;deviceId:string;trust:CloudBootstrap;crypto:V2Crypto;
 keys:Pick<WatchCloudKeyManager,'accountKey'>;
 client:Pick<WatchCloudClient,'approvalPending'|'approvalAccept'|'approvalDeliver'|'approvalGet'|'approvalCancel'>;
 assertCurrent():Promise<void>;
}
export type ApproverPhase='idle'|'requested'|'accepting'|'waiting'|'code'|'delivering'|'complete'|'cancelled'|'expired'|'error'|'unsupported';
export interface ApproverDisplay {phase:ApproverPhase;requestId?:string;requesterLabel?:string;code?:string;expiresAt?:number}

/** One approver transaction. Nonces, signer and transcript never enter display state.
 * Each operation gets a fresh foreground/account-fenced session, including after resume. */
export class WatchCloudApprover {
 private signer?:ApprovalSigner;private nonce='';private pinned?:ApprovalTranscript;private stopped=false;private delivering=false;
 private sent?:{payload:string;signature:string};
 readonly scope:string;readonly epoch:string;readonly deviceId:string;
 constructor(private target:PendingApproval,s:ApproverSession,private crypto:ApproverCrypto,private changed:(state:ApproverDisplay)=>void){this.scope=s.scope;this.epoch=s.trust.libraryEpoch;this.deviceId=s.deviceId;}
 private display(phase:ApproverPhase,code?:string){this.changed({phase,requestId:this.target.requestId,requesterLabel:this.target.displayName||'新设备',expiresAt:this.target.expiresAt,...(code?{code}:{})});}
 private async check(s:ApproverSession){await s.assertCurrent();if(this.stopped)throw Error('approval_cancelled');if(s.scope!==this.scope||s.trust.libraryEpoch!==this.epoch||s.deviceId!==this.deviceId)throw Error('cloud_account_changed');}
 async accept(s:ApproverSession){
  try{
  this.display('accepting');await this.check(s);
  if(this.target.deviceId===s.deviceId||this.target.deviceId.startsWith('reader-migration-'))throw Error('approval_device_mismatch');
  this.crypto.validateSpki(this.target.publicKeySpki);
  const signer=await this.crypto.signer();if(this.stopped){signer.dispose();throw Error('approval_cancelled');}this.signer=signer;await this.check(s);
  const nonce=await s.crypto.random(32);try{if(nonce.length!==32)throw Error('invalid_approval');this.nonce=bytesToBase64(nonce);}finally{nonce.fill(0);}
  await this.check(s);
  await s.client.approvalAccept(this.target.requestId,s.deviceId,this.signer.publicKeySpki,this.nonce);await this.check(s);this.display('waiting');
  }finally{if(this.stopped)this.dispose();}
 }
 private async read(s:ApproverSession){
  await this.check(s);const row=await s.client.approvalGet(this.target.requestId);await this.check(s);
  if(row.requestId!==this.target.requestId||row.deviceId!==this.target.deviceId||row.commitment!==this.target.commitment||row.expiresAt!==this.target.expiresAt||canonicalSpki(row.publicKeySpki)!==canonicalSpki(this.target.publicKeySpki))throw Error('approval_identity_changed');
  if(row.status==='expired'||row.status==='cancelled'){this.dispose();this.display(row.status);return;}
  if(!['accepted','revealed','delivered'].includes(row.status)||row.approverDeviceId!==s.deviceId||canonicalSpki(row.approverSpki)!==this.signer?.publicKeySpki||row.approverNonce!==this.nonce)throw Error('approval_transcript_changed');
  if(row.status==='delivered'){
   if(!this.sent||row.payload!==this.sent.payload||row.signature!==this.sent.signature)throw Error('approval_unexpected_delivery');
   this.dispose();this.display('complete');return;
  }
  if(row.status==='accepted'){if(this.pinned)throw Error('approval_transcript_changed');return;}
  if(typeof row.requesterNonce!=='string'||await approvalCommitment(s.crypto,this.target.publicKeySpki,row.requesterNonce)!==this.target.commitment)throw Error('approval_commitment_mismatch');
  const t:ApprovalTranscript={userId:s.userId,libraryEpoch:this.epoch,requestId:this.target.requestId,deviceId:this.target.deviceId,publicKeySpki:canonicalSpki(this.target.publicKeySpki),approverDeviceId:s.deviceId,approverSpki:this.signer!.publicKeySpki,requesterNonce:row.requesterNonce,approverNonce:this.nonce};
  if(this.pinned&&JSON.stringify(this.pinned)!==JSON.stringify(t))throw Error('approval_transcript_changed');
  const code=await approvalCode(s.crypto,t);await this.check(s);this.pinned=t;return code;
 }
 async poll(s:ApproverSession){const code=await this.read(s);if(code)this.display('code',code);}
 async confirm(s:ApproverSession){
  if(!this.pinned)throw Error('approval_code_not_ready');
  const shown=JSON.stringify(this.pinned),code=await this.read(s);if(this.stopped)return;if(!code||JSON.stringify(this.pinned)!==shown)throw Error('approval_transcript_changed');
  const commitments=validateTrust(s.trust);if(!commitments.length)throw Error('cloud_key_version_missing');
  const envelopes=[];let mac='';const highest=commitments.at(-1)!.keyVersion;
  for(const {keyVersion} of commitments){
   await this.check(s);const key=await s.keys.accountKey(s.userId,keyVersion);
   if(!key)throw Error('cloud_key_version_missing');
   try{await this.check(s);const envelope=await this.crypto.wrap(key,s.userId,this.target.deviceId,this.target.publicKeySpki,keyVersion);await this.check(s);
    envelopes.push({keyVersion,envelope:{...envelope,recipientType:'device',recipientDeviceId:this.target.deviceId,createdByDeviceId:s.deviceId}});
    if(keyVersion===highest)mac=await attest(s.crypto,key,s.userId,this.epoch,this.target.deviceId,this.target.publicKeySpki);
   }finally{key.fill(0);}
  }
  await this.check(s);const payload=JSON.stringify({envelopes,attestation:{keyVersion:highest,mac}}),signature=await this.signer!.sign(this.pinned!,payload);
  await this.check(s);this.delivering=true;this.sent={payload,signature};this.display('delivering');
  // No await between the final fence and starting the delivery request.
  try{
   try{await s.client.approvalDeliver(this.target.requestId,payload,signature);}
   catch(error){if(error instanceof CloudRequestError&&error.status!==409&&error.status<500)throw error;await this.check(s);await this.read(s);if(this.stopped)return;throw error;}
   await this.check(s);this.dispose();this.display('complete');
  }finally{this.delivering=false;}
 }
 async cancel(s?:ApproverSession){
  if(this.delivering)throw Error('approval_commit_started');
  this.dispose();
  if(s&&s.scope===this.scope&&s.trust.libraryEpoch===this.epoch&&s.deviceId===this.deviceId){await s.assertCurrent();await s.client.approvalCancel(this.target.requestId);}
 }
 dispose(){this.stopped=true;this.nonce='';this.pinned=undefined;this.sent=undefined;this.signer?.dispose();this.signer=undefined;}
}
