import type {HttpTransport} from '../cloud/types';
import type {CloudBlobStore} from '../cloud/cache';
import {sha256Hex} from '@podjs/framework/crypto';
import {jsonBytes,exact,hexId,uint,type Scope} from './protocol';
import {sameScope} from './wire';
import {parseNetwork,SyncV2Error,syncV2Origin,type OriginPolicy} from './http';
import {BODY_PURPOSE,validateCarrier,type Carrier} from './body-channel-codec';
const ALIGNMENT=65536;
function advertisedPartSize(headers:Record<string,string>){
 const value=Object.entries(headers).find(([key])=>key.toLowerCase()==='x-watchrss-max-body-part-bytes')?.[1]?.trim();
 const size=value&&/^\d+$/.test(value)?Number(value):0;
 return size>=ALIGNMENT&&size<=524288&&size%ALIGNMENT===0?size:ALIGNMENT;
}
/** Separate namespace, no legacy snapshots/records calls and no v2 ACK writes. */
export class BodyChannelHttp {
 readonly prefix:string;
 constructor(private readonly options:{enabled:boolean;origin:string;policy:OriginPolicy;scope:Scope;transport:HttpTransport;progress?:()=>import('../cloud/sync-progress').SyncProgress|undefined;session:()=>Promise<{accessToken:string;legacyDeviceId:string;legacyEpoch:string;legacyGeneration:string}>;check:()=>Promise<void>}){
  this.prefix=syncV2Origin(options.origin,options.policy)+'/functions/v1/cloud/bodies/v1';
 }
 private async request(method:string,path:string,body?:unknown,raw?:Uint8Array){
  if(!this.options.enabled)throw Error('feature_disabled');await this.options.check();const s=await this.options.session();
  if(!s.accessToken||!s.legacyDeviceId)throw Error('authorization_required');
  const headers:Record<string,string>={Authorization:'Bearer '+s.accessToken,'x-watchrss-cloud-device-id':s.legacyDeviceId,'Content-Type':raw?'application/octet-stream':'application/json'};
  if(method!=='GET'){headers['x-watchrss-library-epoch']=s.legacyEpoch;headers['x-watchrss-content-generation']=s.legacyGeneration;}
  if(raw){headers['x-watchrss-sync-part-sha256']=sha256Hex(raw);for(const [k,v]of Object.entries(this.options.scope))headers[{'repoId':'x-watchrss-sync-repo-id','libraryEpoch':'x-watchrss-sync-library-epoch','contentGeneration':'x-watchrss-sync-content-generation'}[k]!]=v;}
  const query=method==='GET'?(path.includes('?')?'&':'?')+Object.entries(this.options.scope).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'):'';
  const r=await this.options.transport.request({method,url:this.prefix+path+query,headers,...(raw||body!==undefined?{body:raw??jsonBytes(body)}:{}),timeoutMs:10000,readTimeoutMs:10000,acceptHttpErrors:true});await this.options.check();
  if(r.status>=300&&r.status<400)throw Error('transport_error');
  if(raw&&raw.length>ALIGNMENT&&r.status===413)throw Object.assign(new SyncV2Error('object_too_large'),{status:r.status});
  if(r.status>=400){if(r.body.length>1048576)throw Error('object_too_large');const v=parseNetwork(r.body),e=v?.error;exact(v,['error']);exact(e,['code','retryable','retryAfterMillis','details']);if(typeof e.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(e.code)||typeof e.retryable!=='boolean'||!e.details||Object.getPrototypeOf(e.details)!==Object.prototype)throw Error('invalid_schema');if(e.retryAfterMillis!==null)uint(e.retryAfterMillis);throw Object.assign(new SyncV2Error(e.code,e.retryable,e.retryAfterMillis,e.details),{status:r.status});}return r;
 }
 async json(method:string,path:string,body?:unknown,onHeaders?:(headers:Record<string,string>)=>void){const r=await this.request(method,path,body);if(r.body.length>1048576)throw Error('object_too_large');const v=parseNetwork(r.body);if(v.version!==1||v.purpose!==BODY_PURPOSE)throw Error('invalid_schema');sameScope(v.scope,this.options.scope);onHeaders?.(r.headers);return v;}
 async list(entityKey:string,bodyRevision:string,after=''){
  hexId(entityKey,64);hexId(bodyRevision,32);if(after)hexId(after,32);
  const v=await this.json('GET','/carriers?entityKey='+entityKey+'&bodyRevision='+bodyRevision+'&limit=20'+(after?'&after='+after:''));exact(v,['version','purpose','scope','carriers','nextAfter']);
  if(!Array.isArray(v.carriers)||v.carriers.length>20)throw Error('invalid_schema');let cursor=after;
  for(const c of v.carriers){exact(c,['carrierId','descriptor']);hexId(c.carrierId,32);validateCarrier(c.descriptor,this.options.scope);if(c.carrierId<=cursor||c.carrierId!==c.descriptor.body.carrierId||c.descriptor.body.entityKey!==entityKey||c.descriptor.body.bodyRevision!==bodyRevision)throw Error('invalid_schema');cursor=c.carrierId;}
  if(v.nextAfter!==null&&(v.nextAfter!==cursor||cursor===after))throw Error('invalid_schema');return v;
 }
 async upload(descriptor:Carrier,read:(hash:string)=>Promise<Uint8Array>){
  validateCarrier(descriptor,this.options.scope);const b=descriptor.body,id=b.carrierId,expected=new Map([b.manifest,...b.chunks].map(o=>[o.sha256,o.sizeBytes]));
  let size=ALIGNMENT,locked=false;
  const status=async(path:string,body:unknown)=>{
   const v=await this.json('POST',path,body,headers=>{size=locked?ALIGNMENT:advertisedPartSize(headers);});
   exact(v,['version','purpose','scope','carrierId','state','expiresAtMillis','objects']);
   if(v.carrierId!==id||!['reserved','ready'].includes(v.state)||!Array.isArray(v.objects))throw Error('invalid_schema');
   uint(v.expiresAtMillis);
   const offsets=new Map<string,number>();
   if(v.state==='ready')return null;
   for(const o of v.objects){
    exact(o,['sha256','sizeBytes','offset']);
    if(!expected.has(o.sha256)||expected.get(o.sha256)!==o.sizeBytes||offsets.has(o.sha256))throw Error('closure_incomplete');
    uint(o.offset,o.sizeBytes);
    if(o.offset!==o.sizeBytes&&o.offset%ALIGNMENT)throw Error('invalid_range');
    offsets.set(o.sha256,o.offset);
   }
   if(offsets.size!==expected.size)throw Error('closure_incomplete');
   return offsets;
  };
  let offsets=await status('/reserve',descriptor);
  if(!offsets)return;
  for(const hash of offsets.keys()){
   const data=await read(hash);
   if(data.length!==expected.get(hash)||sha256Hex(data)!==hash)throw Error('hash_mismatch');
   let at=offsets.get(hash)!,high=at,stalls=0;
   while(at<data.length){
    const part=data.subarray(at,at+size);
    try{await this.request('PUT','/carriers/'+id+'/objects/'+hash+'/parts/'+at,undefined,part);at+=part.length;}
    catch(error){
     if(!(error instanceof SyncV2Error))throw error;
     const httpStatus=(error as SyncV2Error&{status?:number}).status;
     if(part.length>ALIGNMENT&&(httpStatus===413||httpStatus===400&&error.code==='object_too_large'))locked=true;
     else if(error.code!=='offset_conflict'&&error.code!=='part_conflict')throw error;
     offsets=await status('/carriers/'+id+'/missing',{scope:this.options.scope});
     if(!offsets)return;
     at=offsets.get(hash)!;
     if(at<=high&&++stalls>=4)throw error;
    }
    if(at>high){high=at;stalls=0;}
   }
  }
  const completed=await this.json('POST','/carriers/'+id+'/complete',{scope:this.options.scope});exact(completed,['version','purpose','scope','carrierId','state']);if(completed.carrierId!==id||completed.state!=='ready')throw Error('closure_incomplete');
  this.options.progress?.()?.advance(expected.size);
 }
 /** Checkpoint only ciphertext. Final size/hash verification precedes decode. */
 async download(id:string,hash:string,size:number,files:CloudBlobStore,path:string,check?:()=>Promise<void>){
  hexId(id,32);hexId(hash,64);uint(size,16777216);const old=await files.read(path);if(old?.length===size&&sha256Hex(old)===hash)return old;
  const partial=path+'.part';let data=await files.read(partial)??new Uint8Array();if(data.length>size){data=new Uint8Array();await files.writeAtomic(partial,data);}
  for(let at=data.length;at<size;){await check?.();const r=await this.request('GET','/carriers/'+id+'/objects/'+hash+'?offset='+at),header=(name:string)=>Object.entries(r.headers).find(([k])=>k.toLowerCase()===name)?.[1];
   if(header('x-watchrss-body-total-bytes')!==String(size)||header('x-watchrss-body-offset')!==String(at)||r.body.length!==Math.min(65536,size-at))throw Error('invalid_range');
   if(files.append){await files.append(partial,r.body,at);}else{const next=new Uint8Array(at+r.body.length);next.set(data);next.set(r.body,at);data=next;await files.writeAtomic(partial,data);}at+=r.body.length;
  }
  const result=await files.read(partial);if(!result||result.length!==size||sha256Hex(result)!==hash){await files.writeAtomic(partial,new Uint8Array());throw Error('hash_mismatch');}await files.writeAtomic(path,result);await files.writeAtomic(partial,new Uint8Array());this.options.progress?.()?.advance(1);return result;
 }
}
