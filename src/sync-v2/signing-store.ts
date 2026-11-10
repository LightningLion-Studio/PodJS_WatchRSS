/** Durable fixed author identity. Native signing keys never leave AndroidKeyStore. */
import {canonical,digest,hexId,exact,type Scope} from './protocol';
import {hex} from '@podjs/framework/crypto';
import {signingAlias,signingRegistration,verifyBinding,type SigningPort} from './signing';
import type {EnvelopeCrypto} from './sealed';
import type {IdentityStorage} from './identity-store';
import {b64} from './wire';
import {SyncV2Http} from './http';
export class SigningStateUnavailable extends Error {constructor(){super('signing_state_unavailable');}}
export class WatchSigningIdentity {
 private slot:string;
 constructor(private readonly secure:IdentityStorage,private readonly crypto:SigningPort&EnvelopeCrypto,private readonly accountId:string,private readonly scope:Scope,private readonly idKey:Uint8Array){this.slot='watchrss.syncv2.signer.'+digest({accountId,scope});}
 private async load():Promise<{deviceId:string;keyId:string;registration:any;registered:boolean}|null>{
  try{
   const old=await this.secure.get(this.slot);if(old===null||old===undefined)return null;
   const record=JSON.parse(old);exact(record,['deviceId','keyId','registration','registered']);hexId(record.deviceId,32);hexId(record.keyId,32);
   if(typeof record.registered!=='boolean'||record.registered&&record.registration===null)throw Error('secure_store_corrupt');
   if(record.registration!==null){const r=record.registration;exact(r,['body','bindingProof','possessionSignature']);if(r.body.deviceId!==record.deviceId||r.body.keyId!==record.keyId)throw Error('secure_store_corrupt');await verifyBinding(this.crypto,this.idKey,this.scope,r,async()=>{});}
   return record;
  }catch(error){if(['feature_disabled','cloud_account_busy','cloud_sync_suspended'].includes((error as Error).message))throw error;throw new SigningStateUnavailable();}
 }
 async status():Promise<'ready'|'signing_state_unavailable'>{try{await this.load();return 'ready';}catch(error){if(error instanceof SigningStateUnavailable)return 'signing_state_unavailable';throw error;}}
 async ensure():Promise<{deviceId:string;keyId:string;registration:any;registered:boolean}>{
  const old=await this.load();if(old)return old;
  const deviceId=hex(await this.crypto.random(16)),keyId=hex(await this.crypto.random(16));hexId(deviceId,32);hexId(keyId,32);
  const record={deviceId,keyId,registration:null,registered:false};if(!await this.secure.compareAndSet(this.slot,null,canonical(record)))return this.ensure();return record;
 }
 /** 26.1 P6-7 read-only: the registered v2 signing deviceId, or null. Never creates a record. */
 async registeredDeviceId():Promise<string|null>{try{const record=await this.load();return record?.registered===true?record.deviceId:null;}catch(error){if(error instanceof SigningStateUnavailable)return null;throw error;}}
 async register(http:SyncV2Http,revocationRevision:string,now:number){
  if(!http.indexWrite||(await http.capabilities()).flags?.indexWrite!==true)throw Error('feature_disabled');let record=await this.ensure();
  const alias=signingAlias(this.accountId,this.scope,record.deviceId,record.keyId);
  if(!record.registration){const registration=await signingRegistration(this.crypto,this.idKey,this.accountId,this.scope,record.deviceId,record.keyId,now,revocationRevision,true),next={...record,registration};if(!await this.secure.compareAndSet(this.slot,canonical(record),canonical(next)))throw Error('choice_stale');record=next;}
  // Retry exactly the persisted randomized signature, never generate a replacement proof.
  if(!record.registered){const result=await http.json('POST','/devices/signing-key',record.registration);if(result.deviceId!==record.deviceId||result.keyId!==record.keyId||result.registered!==true)throw Error('signature_invalid');const next={...record,registered:true};if(!await this.secure.compareAndSet(this.slot,canonical(record),canonical(next)))throw Error('choice_stale');record=next;}
  const publicKey=await this.crypto.signingKey(alias,false);if(b64(publicKey)!==record.registration.body.publicKey)throw Error('signature_invalid');return {...record,alias};
 }
}
