import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {utf8Encode,type CloudKeyEnvelope,type StoredCloudKeyEnvelope} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface CloudStringStore {get(key:string):Promise<string|undefined>;set(key:string,value:string):Promise<void>;}
export interface DeviceKeyHost {
 publicKey(keyId:string):Promise<string>;
 unwrap(args:{keyId:string;publicKeySpki:string;saltBase64:string;infoBase64:string;nonceBase64:string;ciphertextBase64:string;aadBase64:string}):Promise<Uint8Array>;
 sha256(input:Uint8Array):Promise<string>;
}
/** Device private key never enters JS. Versioned account keys use encrypted host storage. */
export class WatchCloudKeyManager {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private host:DeviceKeyHost,private secure:CloudStringStore,private guard:CloudGuard=cloudDisabled){}
 private async name(userId:string){if(!userId)throw Error('缺少账号');return `watchrss.cloud.keys.${await this.host.sha256(utf8Encode(userId))}`;}
 private keyId(userId:string,deviceId:string){if(!userId||!deviceId)throw Error('缺少设备身份');return JSON.stringify(['watchrss-cloud',userId,deviceId]);}
 private async read(userId:string):Promise<Record<string,string>> {const raw=await this.secure.get(await this.name(userId));if(!raw)return {};const keys=JSON.parse(raw);if(!keys||typeof keys!=='object'||Array.isArray(keys)||Object.entries(keys).some(([v,k])=>!/^\d+$/.test(v)||Number(v)<=0||!Number.isSafeInteger(Number(v))||typeof k!=='string'||base64ToBytes(k).length!==32))throw Error('账号密钥存储损坏');return keys;}
 async keyVersions(userId:string){this.guard.require();return Object.keys(await this.read(userId)).map(Number).sort((a,b)=>a-b);}
 async currentKeyVersion(userId:string){this.guard.require();return (await this.keyVersions(userId)).at(-1)??1;}
 async accountKey(userId:string,version?:number){this.guard.require();const keys=await this.read(userId),v=version??Math.max(1,...Object.keys(keys).map(Number));return keys[v]?base64ToBytes(keys[v]):undefined;}
 async publicKeySpki(userId:string,deviceId:string){this.guard.require();return this.host.publicKey(this.keyId(userId,deviceId));}
 async acceptEnvelope(userId:string,deviceId:string,envelope:CloudKeyEnvelope):Promise<void>{
  this.guard.require();
  const task=this.tail.then(async()=>{
   this.guard.require();
   if(envelope.algorithm!=='P-256+HKDF-SHA256+A256GCM'||!Number.isSafeInteger(envelope.keyVersion)||envelope.keyVersion<=0||!envelope.ephemeralPublicKeySpki||base64ToBytes(envelope.nonceBase64).length!==12||base64ToBytes(envelope.wrappedKeyBase64).length!==48)throw Error('无效设备密钥信封');
   const hash=await this.host.sha256(utf8Encode(userId));
   const salt=Uint8Array.from(hash.match(/../g)!.map(v=>parseInt(v,16)));
   const key=await this.host.unwrap({keyId:this.keyId(userId,deviceId),publicKeySpki:envelope.ephemeralPublicKeySpki,saltBase64:bytesToBase64(salt),infoBase64:bytesToBase64(utf8Encode(`watchrss/device-envelope/v${envelope.keyVersion}/${deviceId}`)),nonceBase64:envelope.nonceBase64,ciphertextBase64:envelope.wrappedKeyBase64,aadBase64:bytesToBase64(utf8Encode(`watchrss-account-key:${userId}:${envelope.keyVersion}:${deviceId}`))});
   try{if(key.length!==32)throw Error('无效账号密钥');const keys=await this.read(userId);if(keys[envelope.keyVersion]&&bytesToBase64(base64ToBytes(keys[envelope.keyVersion]))!==bytesToBase64(key))throw Error('同版本账号密钥冲突');keys[envelope.keyVersion]=bytesToBase64(key);await this.secure.set(await this.name(userId),JSON.stringify(keys));}finally{key.fill(0);}
  });this.tail=task.catch(()=>{});return task;
 }
 async acceptBootstrap(userId:string,deviceId:string,envelopes:StoredCloudKeyEnvelope[]):Promise<'ready'|'waiting-approval'>{
  this.guard.require();for(const item of [...envelopes].sort((a,b)=>a.envelope.keyVersion-b.envelope.keyVersion)){
   if(item.recipientType==='device'&&item.recipientDeviceId===deviceId&&!(await this.accountKey(userId,item.envelope.keyVersion)))await this.acceptEnvelope(userId,deviceId,item.envelope);
  }return (await this.keyVersions(userId)).length?'ready':'waiting-approval';
 }
}
