import type {HttpTransport} from '../cloud/types';
import type {CloudBlobStore} from '../cloud/cache';
import {sha256Hex} from '@podjs/framework/crypto';
import {jsonBytes,exact,hexId,uint,type Scope} from './protocol';
import {sameScope} from './wire';
import {parseNetwork,SyncV2Error,syncV2Origin,type OriginPolicy} from './http';
import {BODY_PURPOSE,validateCarrier,type Carrier} from './body-channel-codec';
/** Separate namespace, no legacy snapshots/records calls and no v2 ACK writes. */
export class BodyChannelHttp {
 readonly prefix:string;
 constructor(private readonly options:{enabled:boolean;origin:string;policy:OriginPolicy;scope:Scope;transport:HttpTransport;session:()=>Promise<{accessToken:string;legacyDeviceId:string;legacyEpoch:string;legacyGeneration:string}>;check:()=>Promise<void>}){
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
  if(r.status>=400){if(r.body.length>1048576)throw Error('object_too_large');const v=parseNetwork(r.body),e=v?.error;exact(v,['error']);exact(e,['code','retryable','retryAfterMillis','details']);if(typeof e.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(e.code)||typeof e.retryable!=='boolean'||!e.details||Object.getPrototypeOf(e.details)!==Object.prototype)throw Error('invalid_schema');if(e.retryAfterMillis!==null)uint(e.retryAfterMillis);throw new SyncV2Error(e.code,e.retryable,e.retryAfterMillis,e.details);}return r;
 }
 async json(method:string,path:string,body?:unknown){const r=await this.request(method,path,body);if(r.body.length>1048576)throw Error('object_too_large');const v=parseNetwork(r.body);if(v.version!==1||v.purpose!==BODY_PURPOSE)throw Error('invalid_schema');sameScope(v.scope,this.options.scope);return v;}
 async list(entityKey:string,bodyRevision:string,after=''){
  hexId(entityKey,64);hexId(bodyRevision,32);if(after)hexId(after,32);
  const v=await this.json('GET','/carriers?entityKey='+entityKey+'&bodyRevision='+bodyRevision+'&limit=20'+(after?'&after='+after:''));exact(v,['version','purpose','scope','carriers','nextAfter']);
  if(!Array.isArray(v.carriers)||v.carriers.length>20)throw Error('invalid_schema');let cursor=after;
  for(const c of v.carriers){exact(c,['carrierId','descriptor']);hexId(c.carrierId,32);validateCarrier(c.descriptor,this.options.scope);if(c.carrierId<=cursor||c.carrierId!==c.descriptor.body.carrierId||c.descriptor.body.entityKey!==entityKey||c.descriptor.body.bodyRevision!==bodyRevision)throw Error('invalid_schema');cursor=c.carrierId;}
  if(v.nextAfter!==null&&(v.nextAfter!==cursor||cursor===after))throw Error('invalid_schema');return v;
 }
 async upload(descriptor:Carrier,read:(hash:string)=>Promise<Uint8Array>){
  validateCarrier(descriptor,this.options.scope);const b=descriptor.body,id=b.carrierId,expected=new Map([b.manifest,...b.chunks].map(o=>[o.sha256,o.sizeBytes]));
  const reserved=await this.json('POST','/reserve',descriptor);exact(reserved,['version','purpose','scope','carrierId','state','expiresAtMillis','objects']);
  if(reserved.carrierId!==id||!['reserved','ready'].includes(reserved.state)||!Array.isArray(reserved.objects))throw Error('invalid_schema');uint(reserved.expiresAtMillis);
  if(reserved.state==='ready')return;
  if(reserved.objects.length!==expected.size||new Set(reserved.objects.map((o:any)=>o.sha256)).size!==expected.size)throw Error('closure_incomplete');
  for(const o of reserved.objects){exact(o,['sha256','sizeBytes','offset']);if(expected.get(o.sha256)!==o.sizeBytes)throw Error('closure_incomplete');uint(o.offset,o.sizeBytes);
   const data=await read(o.sha256);if(data.length!==o.sizeBytes||sha256Hex(data)!==o.sha256)throw Error('hash_mismatch');
   for(let at=o.offset;at<data.length;){const part=data.subarray(at,Math.min(data.length,at+65536));await this.request('PUT','/carriers/'+id+'/objects/'+o.sha256+'/parts/'+at,undefined,part);at+=part.length;}
  }
  const completed=await this.json('POST','/carriers/'+id+'/complete',{scope:this.options.scope});exact(completed,['version','purpose','scope','carrierId','state']);if(completed.carrierId!==id||completed.state!=='ready')throw Error('closure_incomplete');
 }
 /** Checkpoint only ciphertext. Final size/hash verification precedes decode. */
 async download(id:string,hash:string,size:number,files:CloudBlobStore,path:string){
  hexId(id,32);hexId(hash,64);uint(size,16777216);const old=await files.read(path);if(old?.length===size&&sha256Hex(old)===hash)return old;
  const partial=path+'.part';let data=await files.read(partial)??new Uint8Array();if(data.length>size){data=new Uint8Array();await files.writeAtomic(partial,data);}
  for(let at=data.length;at<size;){const r=await this.request('GET','/carriers/'+id+'/objects/'+hash+'?offset='+at),header=(name:string)=>Object.entries(r.headers).find(([k])=>k.toLowerCase()===name)?.[1];
   if(header('x-watchrss-body-total-bytes')!==String(size)||header('x-watchrss-body-offset')!==String(at)||r.body.length!==Math.min(65536,size-at))throw Error('invalid_range');
   if(files.append){await files.append(partial,r.body,at);}else{const next=new Uint8Array(at+r.body.length);next.set(data);next.set(r.body,at);data=next;await files.writeAtomic(partial,data);}at+=r.body.length;
  }
  const result=await files.read(partial);if(!result||result.length!==size||sha256Hex(result)!==hash){await files.writeAtomic(partial,new Uint8Array());throw Error('hash_mismatch');}await files.writeAtomic(path,result);await files.writeAtomic(partial,new Uint8Array());return result;
 }
}
