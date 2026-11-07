/** C25: existing repo only. No repo creation, key delivery or pairing mutation. */
import {hkdfSha256Bytes,hmacSha256Bytes,lengthPrefixFields,equalAuthenticationTag} from '@podjs/framework/crypto';
import {bytes,jsonBytes,exact,hexId,canonical,validateScope,type Scope} from './protocol';
import {b64,unb64,features} from './wire';
export const LOCAL_PROOF_DOMAIN='wrss.sync.v2/local-proof';
export type LocalHello={scope:Scope;deviceId:string;nonce:string;features:string[]};
export function checkedFeatures(v:any):string[]{features(v);return v;}
export function localHello(value:any):LocalHello{exact(value,['scope','deviceId','nonce','features']);validateScope(value.scope);hexId(value.deviceId,32);hexId(value.nonce,32);checkedFeatures(value.features);return JSON.parse(canonical(value));}
export function localProof(repoKey:Uint8Array,scope:Scope,sessionId:string,self:string,peer:string,selfNonce:string,peerNonce:string){
 validateScope(scope);for(const v of [sessionId,self,peer,selfNonce,peerNonce])hexId(v,32);if(repoKey.length!==32||self===peer||selfNonce===peerNonce)throw Error('proof_invalid');
 const key=hkdfSha256Bytes(repoKey,new Uint8Array(),bytes(LOCAL_PROOF_DOMAIN));
 try{return b64(hmacSha256Bytes(key,lengthPrefixFields([bytes(LOCAL_PROOF_DOMAIN),jsonBytes(scope),bytes(sessionId),bytes(self),bytes(peer),bytes(selfNonce),bytes(peerNonce)])));}finally{key.fill(0);}
}
export type MemberStatus='active'|'unknown'|'revoked';
/** Production verification and the shared vector adapter use this same entry.
 * Member status must come from the latest verified local account membership. */
export function verifyLocalProof(repoKey:Uint8Array,input:{scope:Scope;expectedScope:Scope;sessionId:string;selfDeviceId:string;peerDeviceId:string;selfNonce:string;peerNonce:string;proofBase64:string;memberStatus:MemberStatus;requiredFeatures:string[];supportedFeatures:string[];seenNonces:readonly string[]}){
 validateScope(input.scope);validateScope(input.expectedScope);if(canonical(input.scope)!==canonical(input.expectedScope))throw Error('scope_mismatch');
 if(input.memberStatus==='revoked')throw Error('member_revoked');if(input.memberStatus!=='active')throw Error('member_unknown');
 const required=checkedFeatures(input.requiredFeatures),supported=checkedFeatures(input.supportedFeatures);if(required.some(f=>!supported.includes(f)))throw Error('feature_missing');
 if(input.seenNonces.includes(input.selfNonce))throw Error('proof_invalid');
 let received:Uint8Array;try{received=unb64(input.proofBase64,32);}catch{throw Error('proof_invalid');}
 const expected=unb64(localProof(repoKey,input.scope,input.sessionId,input.selfDeviceId,input.peerDeviceId,input.selfNonce,input.peerNonce),32);
 if(!equalAuthenticationTag(expected,received))throw Error('proof_invalid');return true;
}
export class LocalProofSession {
 private remote?:LocalHello;private proven=false;private closed=false;private busy=false;
 private readonly seen=new Set<string>();readonly hello:LocalHello;
 constructor(readonly sessionId:string,private readonly repoKey:Uint8Array,hello:LocalHello,private readonly member:(id:string)=>Promise<MemberStatus>,private readonly authenticated:()=>boolean){hexId(sessionId,32);this.hello=localHello(hello);this.seen.add(hello.nonce);}
 get verified(){return !this.closed&&this.proven&&this.authenticated();}
 get peerDeviceId(){if(!this.verified||!this.remote)throw Error('proof_invalid');return this.remote.deviceId;}
 get peerFeatures(){if(!this.verified||!this.remote)throw Error('proof_invalid');return [...this.remote.features];}
 async negotiate(value:unknown){
  if(this.closed||this.remote||this.busy||!this.authenticated()){this.close();throw Error('proof_invalid');}this.busy=true;
  try{const remote=localHello(value);if(canonical(remote.scope)!==canonical(this.hello.scope))throw Error('scope_mismatch');if(remote.deviceId===this.hello.deviceId||this.seen.has(remote.nonce))throw Error('proof_invalid');
   const status=await this.member(remote.deviceId);if(!this.authenticated()||this.closed)throw Error('proof_invalid');if(status!=='active')throw Error(status==='revoked'?'member_revoked':'member_unknown');
   this.seen.add(remote.nonce);this.remote=remote;return this.hello;
  }catch(e){this.close();throw e;}finally{this.busy=false;}
 }
 proof(){if(!this.remote||this.closed||!this.authenticated())throw Error('proof_invalid');return localProof(this.repoKey,this.hello.scope,this.sessionId,this.hello.deviceId,this.remote.deviceId,this.hello.nonce,this.remote.nonce);}
 async verify(proof:string,required:string[]){
  if(!this.remote||this.closed||this.proven||this.busy||!this.authenticated()){this.close();throw Error('proof_invalid');}this.busy=true;
  try{const r=this.remote,status=await this.member(r.deviceId);if(this.closed||!this.authenticated())throw Error('proof_invalid');verifyLocalProof(this.repoKey,{scope:r.scope,expectedScope:this.hello.scope,sessionId:this.sessionId,selfDeviceId:r.deviceId,peerDeviceId:this.hello.deviceId,selfNonce:r.nonce,peerNonce:this.hello.nonce,proofBase64:proof,memberStatus:status,requiredFeatures:required,supportedFeatures:r.features,seenNonces:[]});this.proven=true;
  }catch(e){this.close();throw e;}finally{this.busy=false;}
 }
 close(){this.closed=true;this.proven=false;this.remote=undefined;}
}
