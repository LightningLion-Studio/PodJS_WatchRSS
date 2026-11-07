import {SyncV2Http} from './http';
import {exact,hexId,oid,uint,jsonBytes,canonical,type Scope} from './protocol';
import type {SigningPort} from './signing';
import {signedAvailability} from './service-key';
import {custodyBody} from './peer-custody';
import {verifySigned} from './signing';
import type {ApprovedKey} from './head-pins';
/** Content-only methods on a separate HTTP instance/transport. */
export class WatchContentHttp {
 constructor(readonly http:SyncV2Http,readonly crypto:SigningPort,readonly now:()=>number){if(!http.contentWrite)throw Error('feature_disabled');}
 private async custodySignature(value:any,approved:(id:string)=>Promise<ApprovedKey>){exact(value,['body','signature']);const b=custodyBody(value.body,this.http.scope),key=await approved(b.holderDeviceId);if(key.deviceId!==b.holderDeviceId)throw Error('member_unknown');await verifySigned(this.crypto,key.publicKey,'wrss.sync.v2/custody-pin-sign',b,value.signature);return b;}
 async custody(value:any,approved:(id:string)=>Promise<ApprovedKey>){
  const b=await this.custodySignature(value,approved),v=await this.http.json('POST','/availability/custody',value);exact(v,['version','scope','pinId','state','result']);if(v.pinId!==b.pinId||v.state!=='active')throw Error('invalid_schema');await this.custodySignature(v.result,approved);if(canonical(v.result.body)!==canonical(b))throw Error('idempotency_conflict');return v;
 }
 async custodyGet(pinId:string,approved:(id:string)=>Promise<ApprovedKey>){hexId(pinId,32);const v=await this.http.json('GET','/availability/custody/'+pinId);exact(v,['version','scope','body','signature','state']);if(!['active','released'].includes(v.state)||v.body.pinId!==pinId)throw Error('invalid_schema');await this.custodySignature({body:v.body,signature:v.signature},approved);return v;}
 async have(windowId:string,ids:string[]){
  hexId(windowId,32);if(ids.length>512||ids.some((id,i)=>i>0&&id<=ids[i-1]!))throw Error('invalid_schema');
  const v=await this.http.json('POST','/objects/have-want',{scope:this.http.scope,windowId,oids:ids});exact(v,['version','scope','windowId','objects']);if(v.windowId!==windowId||!Array.isArray(v.objects)||v.objects.length!==ids.length)throw Error('invalid_schema');
  for(let i=0;i<ids.length;i++){const r=v.objects[i];exact(r,['oid','status','totalBytes','durableOffset','receipt']);if(r.oid!==ids[i])throw Error('invalid_schema');uint(r.durableOffset);if(r.status==='missing'){if(r.totalBytes!==null||r.durableOffset!==0||r.receipt!==null)throw Error('invalid_schema');}else if(r.status==='partial'||r.status==='present'){
   if(uint(r.totalBytes,266264)===0||r.status==='partial'&&r.durableOffset>=r.totalBytes||r.status==='present'&&r.durableOffset!==r.totalBytes)throw Error('invalid_schema');
   await this.http.servicePin!.receipt(this.crypto,r.receipt,this.http.scope,r.oid,r.totalBytes,this.now(),r.status==='present');if(r.receipt.body.durableOffset!==r.durableOffset)throw Error('invalid_schema');
  }else throw Error('invalid_schema');}return v.objects;
 }
 async reserve(id:string,totalBytes:number,requestId:string){const v=await this.http.json('POST','/objects/reserve',{scope:this.http.scope,requestId,channel:'content',objects:[{oid:id,totalBytes}],leaseMillis:300000});exact(v,['version','scope','reservationId','expiresAtMillis','objects','reservedBytes']);hexId(v.reservationId,32);uint(v.expiresAtMillis);uint(v.reservedBytes);if(v.expiresAtMillis<=this.now()||v.expiresAtMillis-this.now()>600000||v.objects?.length!==1)throw Error('invalid_schema');const o=v.objects[0];exact(o,['oid','totalBytes','durableOffset']);if(o.oid!==id||o.totalBytes!==totalBytes||uint(o.durableOffset)>totalBytes)throw Error('invalid_schema');return v;}
 async complete(id:string,total:number,reservationId:string,requestId:string){const v=await this.http.json('POST','/objects/'+encodeURIComponent(id)+'/complete',{scope:this.http.scope,reservationId,requestId,totalBytes:total});exact(v,['version','scope','oid','receipt']);if(v.oid!==id)throw Error('invalid_schema');await this.http.servicePin!.receipt(this.crypto,v.receipt,this.http.scope,id,total,this.now(),true);return v.receipt;}
 async availability(expected:{entityKey:string;bodyRevision:string;recipeOid:string;blobOids:string[]},readOnly=false,check?:()=>Promise<void>){
  const http=readOnly?this.http.readOnly(check):this.http,v=await http.json('POST','/availability/check',{scope:http.scope,entityKey:expected.entityKey,bodyRevision:expected.bodyRevision,recipeOid:expected.recipeOid});exact(v,['version','scope','availability','leaseId','expiresAtMillis']);
  const a=v.availability;exact(a,['scope','entityKey','bodyRevision','recipeOid','status','receipt']);
  if(canonical(a.scope)!==canonical(this.http.scope)||a.entityKey!==expected.entityKey||a.bodyRevision!==expected.bodyRevision||a.recipeOid!==expected.recipeOid)throw Error('invalid_schema');
  await check?.();const receipt=await signedAvailability(http.servicePin!,this.crypto,a.receipt,http.scope,expected,this.now(),readOnly);if(receipt.status!==a.status)throw Error('invalid_schema');return a;
 }
 async demands(approved:(deviceId:string)=>Promise<{deviceId:string}>){
  const v=await this.http.json('GET','/demand');exact(v,['version','scope','serverNowMillis','demands']);uint(v.serverNowMillis);
  if(!Array.isArray(v.demands)||v.demands.length>32)throw Error('invalid_schema');
  const out:any[]=[],seen=new Set<string>();let previous:any;
  for(const d of v.demands){exact(d,['demandId','entityKey','bodyRevision','requesterDeviceId','demandAtMillis','expiresAtMillis']);
   hexId(d.demandId,32);hexId(d.entityKey,64);hexId(d.bodyRevision,32);hexId(d.requesterDeviceId,32);uint(d.demandAtMillis);uint(d.expiresAtMillis);
   if(d.expiresAtMillis<=v.serverNowMillis||d.expiresAtMillis>v.serverNowMillis+600000||d.demandAtMillis>v.serverNowMillis+30000)throw Error('invalid_schema');
   const key=d.entityKey+':'+d.bodyRevision;if(seen.has(key))throw Error('invalid_schema');seen.add(key);
   if(previous&&(previous.demandAtMillis<d.demandAtMillis||previous.demandAtMillis===d.demandAtMillis&&(previous.entityKey>d.entityKey||previous.entityKey===d.entityKey&&previous.bodyRevision>=d.bodyRevision)))throw Error('invalid_schema');previous=d;
   try{if((await approved(d.requesterDeviceId)).deviceId!==d.requesterDeviceId)continue;}catch{continue;}
   out.push({...d});
  }return {serverNowMillis:v.serverNowMillis,demands:out};
 }
 async demand(value:{entityKey:string;bodyRevision:string;requesterDeviceId:string;demandId:string;demandAtMillis:number;expiresAtMillis:number}){
  exact(value,['entityKey','bodyRevision','requesterDeviceId','demandId','demandAtMillis','expiresAtMillis']);hexId(value.entityKey,64);for(const k of ['bodyRevision','requesterDeviceId','demandId'] as const)hexId(value[k],32);uint(value.demandAtMillis);uint(value.expiresAtMillis);const now=this.now();if(Math.abs(value.demandAtMillis-now)>30000||value.expiresAtMillis<=now||value.expiresAtMillis>now+600000)throw Error('invalid_schema');
  const v=await this.http.json('POST','/demand',{scope:this.http.scope,...value});exact(v,['version','scope','demandId','expiresAtMillis','accepted']);if(v.demandId!==value.demandId||v.expiresAtMillis!==value.expiresAtMillis||v.accepted!==true)throw Error('invalid_schema');return v;
 }
}
