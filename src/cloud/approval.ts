import {bytesToBase64} from '@podjs/framework/bytes';
import {approvalCode,approvalCommitment,canonicalSpki,verifyDelivery,type V2Crypto,type ApprovalTranscript} from './v2';
import type {WatchCloudClient} from './client';
import type {WatchCloudKeyManager} from './keys';
import type {CloudTrust} from './types';
const serverExpired=(e:unknown)=>/^(?:Error: )?(?:Cloud HTTP 409 )?approval_expired$/.test(String(e));
export type ApprovalStatus={phase:'idle'|'pending'|'code'|'committing'|'complete'|'cancelled'|'expired'|'error';code?:string;confirmed?:boolean;message?:string};
/** Requester polling pauses in background; nonce and pinned identity stay in this instance until terminal state. */
export class WatchCloudApproval {
 status:ApprovalStatus={phase:'idle'};private nonce='';private id='';private expires=0;private transcript?:ApprovalTranscript;private confirmed=false;private stopped=false;private busy=false;private foreground=true;private committing=false;
 constructor(private p:{userId:string;deviceId:string;trust:CloudTrust;crypto:V2Crypto;keys:Pick<WatchCloudKeyManager,'publicKeySpki'|'acceptDelivery'>;client:Pick<WatchCloudClient,'approvalCreate'|'approvalGet'|'approvalReveal'|'approvalCancel'|'bootstrap'>;assertCurrent():Promise<void>;now():number;changed?(s:ApprovalStatus):void}){}
 private set(s:ApprovalStatus){this.status=s;this.p.changed?.(s);}
 private async check(){await this.p.assertCurrent();if(this.stopped)throw Error('approval_cancelled');}
 async start(){if(this.status.phase!=='idle')throw Error('approval_already_started');try{await this.check();this.nonce=bytesToBase64(await this.p.crypto.random(32));const publicKeySpki=await this.p.keys.publicKeySpki(this.p.userId,this.p.deviceId);const result=await this.p.client.approvalCreate(this.p.deviceId,await approvalCommitment(this.p.crypto,publicKeySpki,this.nonce));await this.check();if(!result.requestId||!Number.isFinite(result.expiresAt)||result.expiresAt<=0)throw Error('invalid_approval');this.id=result.requestId;this.expires=result.expiresAt;this.set({phase:'pending'});}catch(e){this.fail(e);throw e;}}
 private fail(e:unknown){this.nonce='';this.transcript=undefined;this.stopped=true;if(serverExpired(e)){this.set({phase:'expired'});return;}if(this.status.phase!=='expired'&&this.status.phase!=='cancelled')this.set({phase:'error',message:'授权验证失败，请重新发起'});}
 /** Display only. Server status / approval_expired is the expiry authority (R23). */
 get expiresAt(){return this.expires;}
 setForeground(active:boolean){this.foreground=active;}
 async poll(){if(!this.foreground||this.busy||this.stopped||!this.id)return;this.busy=true;try{
  await this.check();if(!this.foreground)return;const r=await this.p.client.approvalGet(this.id);await this.check();if(!this.foreground)return;
  const spki=await this.p.keys.publicKeySpki(this.p.userId,this.p.deviceId);
  if(r.requestId!==this.id||r.deviceId!==this.p.deviceId||canonicalSpki(r.publicKeySpki)!==canonicalSpki(spki)||r.commitment!==await approvalCommitment(this.p.crypto,spki,this.nonce)||r.expiresAt!==this.expires)throw Error('approval_identity_changed');
  if(r.status==='expired'||r.status==='cancelled'){this.stopped=true;this.nonce='';this.transcript=undefined;this.set({phase:r.status});return;}
  if(r.status==='pending')return;
  if(!['accepted','revealed','delivered'].includes(r.status))throw Error('invalid_approval_state');
  if(!this.transcript&&r.status!=='accepted')throw Error('approval_reveal_required');
  const t:ApprovalTranscript={userId:this.p.userId,libraryEpoch:this.p.trust.libraryEpoch,requestId:this.id,deviceId:this.p.deviceId,publicKeySpki:spki,approverDeviceId:r.approverDeviceId,approverSpki:canonicalSpki(r.approverSpki),requesterNonce:this.nonce,approverNonce:r.approverNonce};
  if(this.transcript&&JSON.stringify(this.transcript)!==JSON.stringify(t))throw Error('approval_approver_changed');this.transcript=t;
  if(!this.foreground)return;
  if(r.status==='accepted'){await this.p.client.approvalReveal(this.id,this.nonce);await this.check();if(!this.foreground)return;}
  if(r.requesterNonce&&r.requesterNonce!==this.nonce)throw Error('approval_nonce_changed');
  this.set({phase:'code',code:await approvalCode(this.p.crypto,t),confirmed:this.confirmed});
  if(r.status!=='delivered'||!this.confirmed)return;
  if(typeof r.payload!=='string'||!await verifyDelivery(this.p.crypto,t,r.payload,r.signature))throw Error('approval_signature_invalid');
  if(!this.foreground)return;const payload=JSON.parse(r.payload),bootstrap=await this.p.client.bootstrap();await this.check();if(!this.foreground)return;if(bootstrap.libraryEpoch!==t.libraryEpoch)throw Error('library_epoch_mismatch');
  if(!Array.isArray(payload.envelopes)||new Set(payload.envelopes.map((x:any)=>x.keyVersion)).size!==payload.envelopes.length)throw Error('invalid_approval_payload');
  const envelopes=payload.envelopes.map((x:any)=>{if(x.keyVersion!==x.envelope?.keyVersion)throw Error('invalid_approval_payload');return x.envelope;});
  await this.check();if(!this.foreground)return;
  if(await this.p.keys.acceptDelivery(this.p.userId,this.p.deviceId,envelopes,bootstrap,payload.attestation,()=>{if(this.stopped||!this.confirmed)throw Error('approval_cancelled');this.committing=true;this.set({phase:'committing'});})!=='ready')throw Error('waiting_approval');await this.check();this.nonce='';this.transcript=undefined;this.stopped=true;this.set({phase:'complete'});
 }catch(e){
  // An in-flight transport can fail after onHide. Keep the requester intact for foreground retry.
  if(!this.foreground&&!this.stopped&&!serverExpired(e)){try{await this.check();return;}catch(current){this.fail(current);throw current;}}
  this.fail(e);throw e;
 }finally{this.committing=false;this.busy=false;}}
 async confirmCode(matches:boolean){if(this.committing)throw Error('approval_commit_started');if(!matches){if(this.status.phase!=='code')throw Error('approval_code_not_ready');await this.cancel();return;}await this.check();if(this.status.phase!=='code')throw Error('approval_code_not_ready');this.confirmed=true;this.set({...this.status,confirmed:true});await this.poll();}
 async cancel(){if(this.committing)throw Error('approval_commit_started');if(this.stopped)return;this.stopped=true;this.nonce='';this.transcript=undefined;this.set({phase:'cancelled'});if(this.id)await this.p.client.approvalCancel(this.id);}
 dispose(){if(this.committing)return;this.stopped=true;this.nonce='';this.transcript=undefined;}
}
