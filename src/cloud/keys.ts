import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {utf8Encode,type CloudKeyEnvelope,type StoredCloudKeyEnvelope,type CloudTrust} from './types';
import {commit,rotation,attest,validateTrust,type V2Crypto} from './v2';
import {cloudDisabled,type CloudGuard} from './guard';
export interface CloudStringStore {keys?(prefixes:string[]):Promise<string[]>;compareAndSet?(key:string,expected:string|undefined,value:string|undefined):Promise<boolean>;get(key:string):Promise<string|undefined>;set(key:string,value:string):Promise<void>;update?(values:Record<string,string|null>,removePrefixes?:string[]):Promise<void>;}
export interface DeviceKeyHost {
 publicKey(keyId:string):Promise<string>;
 unwrap(args:{keyId:string;publicKeySpki:string;saltBase64:string;infoBase64:string;nonceBase64:string;ciphertextBase64:string;aadBase64:string}):Promise<Uint8Array>;
 sha256(input:Uint8Array):Promise<string>;
 hmac?(key:Uint8Array,input:Uint8Array):Promise<string>;
}
/** Each version has a separate secure.update slot: independent manager instances cannot lose versions. */
export class WatchCloudKeyManager {
 private verifiedUser='';private trust?:CloudTrust;private tail:Promise<unknown>=Promise.resolve();private verified=new Map<number,string>();
 constructor(private host:DeviceKeyHost,private secure:CloudStringStore,private guard:CloudGuard=cloudDisabled,private backendBaseUrl=''){}
 private async prefix(userId:string){if(!userId)throw Error('缺少账号');return `watchrss.cloud.keys.${await this.host.sha256(utf8Encode(JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),userId])))}.`;}
 private keyId(userId:string,deviceId:string){if(!userId||!deviceId)throw Error('缺少设备身份');return JSON.stringify(['watchrss-cloud',userId,deviceId]);}
 private crypto(){if(!this.host.hmac)throw Error('client_upgrade_required');return {sha256:this.host.sha256,hmac:this.host.hmac};}
 private async legacyName(userId:string){return `watchrss.cloud.keys.${await this.host.sha256(utf8Encode(userId))}`;}
 private async legacy(userId:string):Promise<Record<string,string>>{const raw=await this.secure.get(await this.legacyName(userId));if(!raw)return {};const keys=JSON.parse(raw);if(!keys||typeof keys!=='object'||Array.isArray(keys)||Object.entries(keys).some(([v,k])=>!Number.isSafeInteger(Number(v))||Number(v)<1||typeof k!=='string'||base64ToBytes(k).length!==32))throw Error('账号密钥存储损坏');return keys;}
 /** Watches never publish commitments. Existing legacy keys may upgrade only after server commitments verify. */
 async prepareLegacyUpgrade(userId:string,deviceId:string,trust:CloudTrust){
  this.guard.require();const commitments=validateTrust(trust);if(!commitments.length)return undefined;
  const legacy=await this.legacy(userId),held=new Map<number,Uint8Array>();
  try{for(const c of commitments){if(!legacy[c.keyVersion])continue;const key=base64ToBytes(legacy[c.keyVersion]);held.set(c.keyVersion,key);if(await commit(this.crypto(),key,userId,trust.libraryEpoch,c.keyVersion)!==c.commitment){await this.clear(userId);throw Error('library_epoch_mismatch');}}
   for(let i=1;i<commitments.length;i++){const c=commitments[i],key=held.get(c.keyVersion);if(key){const previous=held.get(commitments[i-1].keyVersion);if(!previous||await rotation(this.crypto(),previous,userId,trust.libraryEpoch,c.keyVersion,c.commitment)!==c.rotationProof)throw Error('rotation_proof_invalid');}}
   if(!held.size)return undefined;const keyVersion=Math.max(...held.keys());return{keyVersion,attestation:{keyVersion,mac:await attest(this.crypto(),held.get(keyVersion)!,userId,trust.libraryEpoch,deviceId,await this.publicKeySpki(userId,deviceId))}};
  }finally{for(const key of held.values())key.fill(0);}
 }
 async clear(userId:string){this.guard.require();this.verified.clear();this.verifiedUser='';this.trust=undefined;if(!this.secure.update)throw Error('client_upgrade_required');await this.secure.update({},[await this.prefix(userId),`watchrss.cloud.keys.${await this.host.sha256(utf8Encode(userId))}`]);}
 async keyVersions(userId:string){this.guard.require();return (userId===this.verifiedUser?[...this.verified.keys()]:[]).sort((a,b)=>a-b);}
 async currentKeyVersion(userId:string){this.guard.require();return (await this.keyVersions(userId)).at(-1)??0;}
 async accountKey(userId:string,version?:number){this.guard.require();const v=version??await this.currentKeyVersion(userId),expected=this.verified.get(v);if(userId!==this.verifiedUser||!expected||!this.trust)return undefined;const raw=await this.secure.get(`${await this.prefix(userId)}${this.trust.libraryEpoch}.${v}`);if(!raw)return undefined;const key=base64ToBytes(raw);if(key.length!==32||await commit(this.crypto(),key,userId,this.trust.libraryEpoch,v)!==expected){key.fill(0);await this.clear(userId);throw Error('library_epoch_mismatch');}return key;}
 async publicKeySpki(userId:string,deviceId:string){this.guard.require();return this.host.publicKey(this.keyId(userId,deviceId));}
 private async unwrap(userId:string,deviceId:string,e:CloudKeyEnvelope){
  if(e.algorithm!=='P-256+HKDF-SHA256+A256GCM'||!Number.isSafeInteger(e.keyVersion)||e.keyVersion<=0||!e.ephemeralPublicKeySpki||base64ToBytes(e.nonceBase64).length!==12||base64ToBytes(e.wrappedKeyBase64).length!==48)throw Error('无效设备密钥信封');
  const hash=await this.host.sha256(utf8Encode(userId));
  return this.host.unwrap({keyId:this.keyId(userId,deviceId),publicKeySpki:e.ephemeralPublicKeySpki,saltBase64:bytesToBase64(Uint8Array.from(hash.match(/../g)!,v=>parseInt(v,16))),infoBase64:bytesToBase64(utf8Encode(`watchrss/device-envelope/v${e.keyVersion}/${deviceId}`)),nonceBase64:e.nonceBase64,ciphertextBase64:e.wrappedKeyBase64,aadBase64:bytesToBase64(utf8Encode(`watchrss-account-key:${userId}:${e.keyVersion}:${deviceId}`))});
 }
 /** QR/approval must pass ALL envelopes as a batch. Nothing is persisted until the entire chain and attestation pass. */
 async acceptDelivery(userId:string,deviceId:string,envelopes:CloudKeyEnvelope[],trust:CloudTrust,attestation:{keyVersion:number;mac:string},beforeCommit?:()=>void){
  this.guard.require();if(new Set(envelopes.map(e=>e.keyVersion)).size!==envelopes.length)throw Error('duplicate_key_version');
  return this.acceptBootstrap(userId,deviceId,envelopes.map((envelope,i)=>({id:String(i),recipientType:'device',recipientDeviceId:deviceId,envelope})),trust,attestation,true,beforeCommit);
 }
 async acceptEnvelope(userId:string,deviceId:string,envelope:CloudKeyEnvelope):Promise<void>{this.guard.require();throw Error('client_upgrade_required: use authenticated batch delivery');}
 async acceptBootstrap(userId:string,deviceId:string,envelopes:StoredCloudKeyEnvelope[],trust?:CloudTrust,attestation?:{keyVersion:number;mac:string},requireAll=false,beforeCommit?:()=>void):Promise<'ready'|'waiting-approval'>{
  this.guard.require();const task=this.tail.then(async()=>{
   this.guard.require();const commitments=validateTrust(trust!);const t=trust!;
   if(this.trust&&this.trust.libraryEpoch!==t.libraryEpoch)await this.clear(userId);
   const retained=new Map<number,string>(),savedVersions=new Set<number>();
   this.verified.clear();this.verifiedUser='';this.trust=t;const prefix=await this.prefix(userId),pending=new Map<number,Uint8Array>();let invalidated=false;
   const validateKey=async(i:number)=>{const c=commitments[i],k=pending.get(c.keyVersion)!;if(k.length!==32||await commit(this.crypto(),k,userId,t.libraryEpoch,c.keyVersion)!==c.commitment){invalidated=true;await this.clear(userId);throw Error('library_epoch_mismatch');}if(i>0){const prev=pending.get(commitments[i-1].keyVersion);if(!prev||await rotation(this.crypto(),prev,userId,t.libraryEpoch,c.keyVersion,c.commitment)!==c.rotationProof)throw Error('rotation_proof_invalid');}};
   try{
    if(!this.secure.update)throw Error('client_upgrade_required');
    // Remove the former write-only marker. Failed candidates stay on the server for the next bootstrap.
    if(await this.secure.get(prefix+'quarantine')!==undefined)await this.secure.update({[prefix+'quarantine']:null});
    const legacy=await this.legacy(userId);
    for(const c of commitments){const saved=await this.secure.get(`${prefix}${t.libraryEpoch}.${c.keyVersion}`);if(saved) savedVersions.add(c.keyVersion);if(saved??legacy[c.keyVersion])pending.set(c.keyVersion,base64ToBytes(saved??legacy[c.keyVersion]));}
    // Scoped slots were published only after authenticated validation. Recheck their prefix even after restart.
    // A bad/new/missing higher version cannot disable the still-valid old prefix.
    for(let i=0;i<commitments.length;i++){const c=commitments[i];if(!savedVersions.has(c.keyVersion)||!pending.has(c.keyVersion))break;await validateKey(i);retained.set(c.keyVersion,c.commitment);}
    // A fresh device must authenticate its anchor through confirmed approval/QR, never anonymous bootstrap envelopes.
    if(!requireAll&&(!commitments.length||!pending.has(commitments[0].keyVersion)))return 'waiting-approval' as const;
    if(requireAll&&commitments.some(c=>!envelopes.some(item=>item.recipientType==='device'&&item.recipientDeviceId===deviceId&&item.envelope.keyVersion===c.keyVersion)))throw Error('missing_key_version');
    for(const item of envelopes){if(item.recipientType!=='device'||item.recipientDeviceId!==deviceId)continue;const v=item.envelope.keyVersion;if(!commitments.some(c=>c.keyVersion===v))throw Error('uncommitted_key');if(!pending.has(v))pending.set(v,await this.unwrap(userId,deviceId,item.envelope));}
    for(let i=0;i<commitments.length;i++){
     const c=commitments[i],k=pending.get(c.keyVersion);if(!k){if(requireAll)throw Error('missing_key_version');continue;}
     await validateKey(i);
    }
    if(!pending.size)return 'waiting-approval' as const;
    const highest=Math.max(...pending.keys()),attested=attestation&&pending.get(attestation.keyVersion);if(!attestation||!attested||(requireAll&&attestation.keyVersion!==highest)||await attest(this.crypto(),attested,userId,t.libraryEpoch,deviceId,await this.publicKeySpki(userId,deviceId))!==attestation.mac)throw Error('device_attestation_invalid');
    if(!this.secure.update)throw Error('client_upgrade_required');
    const legacyName=await this.legacyName(userId),legacyPresent=await this.secure.get(legacyName)!==undefined;
    const values={...Object.fromEntries([...pending].filter(([v])=>!savedVersions.has(v)).map(([v,k])=>[`${prefix}${t.libraryEpoch}.${v}`,bytesToBase64(k)])),...(legacyPresent?{[legacyName]:null}:{})};
    // Last synchronous authorization check. No await between this boundary and submitting the atomic batch.
    beforeCommit?.();
    if(Object.keys(values).length)await this.secure.update(values);
    this.verifiedUser=userId;for(const c of commitments)if(pending.has(c.keyVersion))this.verified.set(c.keyVersion,c.commitment);
    return 'ready' as const;
   }catch(error){if(!invalidated){this.verified=retained;this.verifiedUser=retained.size?userId:'';}throw error;}finally{for(const key of pending.values())key.fill(0);}
  });this.tail=task.catch(()=>{});return task;
 }
}
