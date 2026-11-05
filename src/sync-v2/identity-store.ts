import {hex,unhex} from '@podjs/framework/crypto';
import {canonical,digest,hexId,type Scope} from './protocol';
import {verifyDescriptor,descriptorOid,deliveryRequest,receiveIdentity,recoverIdentity,idCommitment,type IdentityCrypto,type WatchRecipient} from './identity';
export interface IdentityStorage {
 get(key:string):Promise<string|undefined|null>;
 compareAndSet(key:string,expected:string|null,value:string):Promise<boolean>;
}
/** One secure CAS record contains either the entire pending request or the
 * complete installed identity. No split install/pin/delete sequence exists. */
export class WatchIdentityStore {
 private readonly slot:string;
 constructor(private readonly secure:IdentityStorage,private readonly random:(count:number)=>Promise<Uint8Array>,private readonly crypto:IdentityCrypto,private readonly member:()=>Promise<WatchRecipient>,private readonly scope:Scope,accountId:string){this.slot='watchrss.syncv2.identity.'+digest({accountId,scope});}
 async begin(descriptor:any,root:Uint8Array,now:number){
  const member=await this.member();if(!member.authorized||member.platform!=='watch')throw Error('authentication_required');
  const pin=await verifyDescriptor(descriptor,root,member.accountId,this.scope,this.crypto),saved=await this.secure.get(this.slot);
  if(saved){const record=JSON.parse(saved);if(record.descriptorPin!==pin||record.idKeyCommitment!==descriptor.body.idKeyCommitment)throw Error('identity_conflict');return record;}
  const requestId=hex(await this.random(16)),challenge=hex(await this.random(32));hexId(requestId,32);hexId(challenge,64);
  const request=deliveryRequest({version:2,accountId:member.accountId,scope:this.scope,descriptorOid:pin,recipientDeviceId:member.deviceId,recipientPlatform:'watch',requestId,challenge,wrappingKeyVersion:descriptor.body.wrappingKeyVersion,expiresAtMillis:now+300000},root);
  const record={status:'pending',descriptorPin:pin,idKeyCommitment:descriptor.body.idKeyCommitment,request};
  if(!await this.secure.compareAndSet(this.slot,null,canonical(record)))throw Error('choice_stale');return record;
 }
 async installDelivery(value:any,descriptor:any,root:Uint8Array,now:number){
  const member=await this.member(),saved=await this.secure.get(this.slot);if(!saved)throw Error('identity_request_missing');const record=JSON.parse(saved);if(record.status==='installed')return this.installed(descriptor);
  if(record.status!=='pending'||record.descriptorPin!==descriptorOid(descriptor))throw Error('identity_conflict');
  const key=await receiveIdentity(value,record.request,descriptor,root,now,member,this.crypto);
  try{const current=await this.member();if(canonical(current)!==canonical(member)||!current.authorized)throw Error('authentication_required');const installed={status:'installed',descriptorPin:record.descriptorPin,idKeyCommitment:record.idKeyCommitment,idKeyHex:hex(key),scope:this.scope};if(!await this.secure.compareAndSet(this.slot,saved,canonical(installed)))throw Error('choice_stale');return installed;}finally{key.fill(0);}
 }
 async installRecovery(capsule:any,descriptor:any,root:Uint8Array,pin:string){
  const member=await this.member(),saved=await this.secure.get(this.slot);if(saved){const record=JSON.parse(saved);if(record.descriptorPin!==pin||record.idKeyCommitment!==descriptor.body.idKeyCommitment)throw Error('identity_conflict');}
  const key=await recoverIdentity(capsule,descriptor,root,member,this.scope,pin,this.crypto);
  try{const current=await this.member();if(canonical(current)!==canonical(member)||!current.authorized)throw Error('authentication_required');const record={status:'installed',descriptorPin:pin,idKeyCommitment:descriptor.body.idKeyCommitment,idKeyHex:hex(key),scope:this.scope};if(!await this.secure.compareAndSet(this.slot,saved??null,canonical(record)))throw Error('choice_stale');return record;}finally{key.fill(0);}
 }
 async installed(descriptor:any){const member=await this.member();if(!member.authorized||member.platform!=='watch'||member.accountId!==descriptor.body.accountId)throw Error('authentication_required');const saved=await this.secure.get(this.slot);if(!saved)throw Error('identity_not_installed');const record=JSON.parse(saved);if(record.status!=='installed'||record.descriptorPin!==descriptorOid(descriptor)||record.idKeyCommitment!==descriptor.body.idKeyCommitment||canonical(record.scope)!==canonical(this.scope)||idCommitment(unhex(record.idKeyHex))!==record.idKeyCommitment)throw Error('identity_conflict');return record;}
}
