/** C4 keeps the original K_id binding/possession proof byte-for-byte. */
import {exact,hexId,text,checkD64,digest,compareD64,type Scope} from './protocol';
import {sameScope} from './wire';
import {verifyBinding,type SigningPort} from './signing';
import {WatchServiceKeyPin} from './service-key';
import {SyncV2Http} from './http';
import type {IdentityStorage} from './identity-store';
import type {ApprovedKey} from './head-pins';
export type ApprovedLegacyDevice={deviceId:string;revokedAt:string|null};
export async function verifyDeviceBinding(crypto:SigningPort,pin:WatchServiceKeyPin,idKey:Uint8Array,scope:Scope,value:any,approved:ApprovedLegacyDevice[]){
 exact(value,['body','bindingProof','possessionSignature','deviceMapping']);
 const body=await verifyBinding(crypto,idKey,scope,{body:value.body,bindingProof:value.bindingProof,possessionSignature:value.possessionSignature},async()=>{});
 exact(value.deviceMapping,['body','signature']);const m=value.deviceMapping.body;exact(m,['scope','deviceId','keyId','legacyDeviceId','approvalRevision']);sameScope(m.scope,scope);hexId(m.deviceId,32);hexId(m.keyId,32);text(m.legacyDeviceId,1024);checkD64(m.approvalRevision);
 await pin.signature(crypto,'wrss.sync.v2/device-mapping',value.deviceMapping,scope);
 if(m.deviceId!==body.deviceId||m.keyId!==body.keyId||!approved.some(d=>d.deviceId===m.legacyDeviceId&&d.revokedAt===null))throw Error('authentication_required');
 return {...body,legacyDeviceId:m.legacyDeviceId,approvalRevision:m.approvalRevision};
}
export class WatchSigningKeys {
 private keys=new Map<string,ApprovedKey>();private revision:string|null=null;
 fingerprint:string|null=null;
 constructor(private readonly http:SyncV2Http,private readonly crypto:SigningPort,private readonly idKey:Uint8Array,private readonly approved:()=>Promise<ApprovedLegacyDevice[]>,private readonly watermark?:{storage:IdentityStorage;slot:string}){ }
 async refresh(windowId:string,capabilitiesChecked=false):Promise<string>{
  hexId(windowId,32);if(!capabilitiesChecked)await this.http.capabilities();const list=await this.http.json('GET','/devices/signing-keys?windowId='+windowId);exact(list,['version','scope','bindings','revocationRevision']);checkD64(list.revocationRevision);if(!Array.isArray(list.bindings)||list.bindings.length>64)throw Error('invalid_schema');
  const revision=checkD64(list.revocationRevision),watermark=this.watermark;
  const rejectRollback=(previous:string|null)=>{
   if(previous!==null&&compareD64(revision,checkD64(previous))<0)throw Error('replay_detected');
  };
  rejectRollback(this.revision);
  const readWatermark=async()=>watermark?await watermark.storage.get(watermark.slot)??null:null;
  let stored=await readWatermark();
  rejectRollback(stored);
  const approved=await this.approved(),next=new Map<string,ApprovedKey>(),bindings:unknown[]=[];let previous='';for(const entry of list.bindings){
   const body=await verifyDeviceBinding(this.crypto,this.http.servicePin!,this.idKey,this.http.scope,entry,approved),order=body.deviceId+body.keyId;if(order<=previous||next.has(body.deviceId))throw Error('invalid_schema');previous=order;
   next.set(body.deviceId,{deviceId:body.deviceId,keyId:body.keyId,publicKey:body.publicKey});
   bindings.push([entry.body,entry.deviceMapping.body]);
  }
  // Publish a whole validated list; one malformed mapping leaves the prior list intact.
  if(watermark){
   stored=await readWatermark();rejectRollback(stored);
   for(let attempt=0;stored!==revision;attempt++){
    if(attempt===3)throw Error('choice_stale');
    if(await watermark.storage.compareAndSet(watermark.slot,stored,revision))break;
    stored=await readWatermark();rejectRollback(stored);
   }
  }
  rejectRollback(this.revision);
  this.keys=next;this.revision=revision;this.fingerprint=digest({revision,bindings});return revision;
 }
 get(deviceId:string){const key=this.keys.get(deviceId);if(!key)throw Error('authentication_required');return {...key};}
}
