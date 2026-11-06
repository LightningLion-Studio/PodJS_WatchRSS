/** C3 fixed service key, pinned in the same protected store as cloud identity. */
import {validateP256PublicKey} from '@podjs/framework/p256';
import {hex,unhex} from '@podjs/framework/crypto';
import {exact,hexId,canonical,uint,checkD64,oid,type Scope} from './protocol';
import {unb64,b64,sameScope} from './wire';
import {verifySigned,type SigningPort} from './signing';
import type {IdentityStorage} from './identity-store';
export const SERVICE_KEY_CHANGED='云同步服务密钥变化，请更新应用';
export type ServiceKey={receiptKeyId:string;receiptSigningPublicKey:string;algorithm:'ES256'};
export function serviceKey(value:any):ServiceKey {
 exact(value,['receiptKeyId','receiptSigningPublicKey','algorithm']);hexId(value.receiptKeyId,32);if(value.algorithm!=='ES256')throw Error('unsupported_feature');const spki=unb64(value.receiptSigningPublicKey);validateP256PublicKey(spki);
 if(hex(spki.subarray(0,26))!=='3059301306072a8648ce3d020106082a8648ce3d030107034200'||spki.length!==91)throw Error('invalid_encoding');return JSON.parse(canonical(value));
}
/** The callback must come from the existing authenticated login/bootstrap port.
 * It returns the authenticated user identity separately from untrusted DTOs. */
export class WatchServiceKeyPin {
 private failed=false;
 constructor(private readonly secure:IdentityStorage,readonly accountId:string,private readonly bootstrap:()=>Promise<{accountId:string;syncV2:unknown}>){hexId(accountId,32);}
 private slot(){return 'watchrss.syncv2.service-key.'+this.accountId;}
 async assertBootstrap(){
  if(this.failed)throw Error(SERVICE_KEY_CHANGED);const approved=await this.bootstrap();if(approved.accountId!==this.accountId)throw Error('cloud_account_busy');if(approved.syncV2===undefined)throw Error('upgrade_required');const current=serviceKey(approved.syncV2),raw=canonical(current),old=await this.secure.get(this.slot());
  if(old&&old!==raw){this.failed=true;throw Error(SERVICE_KEY_CHANGED);}
  if(!old&&!await this.secure.compareAndSet(this.slot(),null,raw)){const winner=await this.secure.get(this.slot());if(winner!==raw){this.failed=true;throw Error(SERVICE_KEY_CHANGED);}}
  return current;
 }
 async capabilities(value:any){const key=await this.assertBootstrap();if(value.receiptKeyId!==key.receiptKeyId||value.receiptSigningPublicKey!==key.receiptSigningPublicKey){this.failed=true;throw Error(SERVICE_KEY_CHANGED);}return key;}
 async signature(port:SigningPort,domain:string,value:any,scope:Scope){
  const key=await this.assertBootstrap();exact(value,['body','signature']);sameScope(value.body.scope,scope);const sec1=b64(unb64(key.receiptSigningPublicKey).subarray(26));
  await verifySigned(port,sec1,domain,value.body,value.signature);return value.body;
 }
 async verify(port:SigningPort,domain:string,value:any,scope:Scope,now:number){
  await this.signature(port,domain,value,scope);uint(now);uint(value.body.expiresAtMillis);if(now>value.body.expiresAtMillis)throw Error('lease_expired');return value.body;
 }
 async checkpoint(port:SigningPort,value:any,scope:Scope,now:number){
  const b=value?.body;exact(b,['scope','checkpointId','serverRevision','refs','account','historyFloorRevision','historyFloorMillis','windowId','issuedAtMillis','expiresAtMillis']);
  hexId(b.checkpointId,32);hexId(b.windowId,32);checkD64(b.serverRevision);checkD64(b.historyFloorRevision);uint(b.historyFloorMillis);uint(b.issuedAtMillis);uint(b.expiresAtMillis);
  if(b.expiresAtMillis<b.issuedAtMillis||b.expiresAtMillis-b.issuedAtMillis>300000)throw Error('invalid_schema');
  exact(b.account,['commitOid','revision','rollbackGeneration']);if(b.account.commitOid!==null)oid(b.account.commitOid,'commit');checkD64(b.account.revision);checkD64(b.account.rollbackGeneration);
  if(!Array.isArray(b.refs)||b.refs.length>64)throw Error('invalid_schema');let previous='';for(const ref of b.refs){exact(ref,['deviceId','commitOid','refRevision']);hexId(ref.deviceId,32);oid(ref.commitOid,'commit');if(checkD64(ref.refRevision)==='0'||ref.deviceId<=previous)throw Error('invalid_schema');previous=ref.deviceId;}
  return this.verify(port,'wrss.sync.v2/checkpoint-sign',value,scope,now);
 }
 async receipt(port:SigningPort,value:any,scope:Scope,expectedOid:string,totalBytes:number,now:number,complete=false){
  const b=value?.body;exact(b,['version','scope','oid','totalBytes','durableOffset','storeId','receiptRevision','createdAtMillis','expiresAtMillis']);if(b.version!==2||b.oid!==expectedOid||b.totalBytes!==totalBytes)throw Error('invalid_schema');oid(b.oid,b.oid?.split(':')[0]);uint(b.totalBytes);uint(b.durableOffset);hexId(b.storeId,32);if(checkD64(b.receiptRevision)==='0')throw Error('invalid_schema');uint(b.createdAtMillis);uint(b.expiresAtMillis);if(b.durableOffset>b.totalBytes||complete&&b.durableOffset!==b.totalBytes||b.expiresAtMillis<b.createdAtMillis||b.expiresAtMillis-b.createdAtMillis>604800000)throw Error('invalid_schema');return this.verify(port,'wrss.sync.v2/object-receipt-sign',value,scope,now);
 }
}

/** Complete-body receipt, distinct from ObjectReceipt. Does not authorize eviction. */
export async function signedAvailability(pin:WatchServiceKeyPin,port:SigningPort,value:any,scope:Scope,
 expected:{entityKey:string;bodyRevision:string;recipeOid:string;blobOids:string[]},now:number){
 const b=value?.body;exact(b,['version','scope','entityKey','bodyRevision','recipeOid','status','blobOidsHash','storeId','receiptRevision','createdAtMillis','expiresAtMillis']);
 if(b.version!==2||b.entityKey!==expected.entityKey||b.bodyRevision!==expected.bodyRevision||b.recipeOid!==expected.recipeOid||!['source-pending','cloud-ready','source-unavailable'].includes(b.status))throw Error('invalid_schema');
 hexId(b.entityKey,64);hexId(b.bodyRevision,32);oid(b.recipeOid,'recipe');hexId(b.storeId,32);if(checkD64(b.receiptRevision)==='0')throw Error('invalid_schema');uint(b.createdAtMillis);uint(b.expiresAtMillis);
 if(b.expiresAtMillis<=b.createdAtMillis||b.expiresAtMillis-b.createdAtMillis>604800000)throw Error('invalid_schema');
 const {digest}=await import('./protocol');
 if(b.status==='cloud-ready'?b.blobOidsHash!==digest(expected.blobOids):b.blobOidsHash!==null)throw Error('fingerprint_mismatch');
 return pin.verify(port,'wrss.sync.v2/availability-sign',value,scope,now);
}
