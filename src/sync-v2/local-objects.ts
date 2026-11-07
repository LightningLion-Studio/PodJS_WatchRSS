/** P4 durable raw-object cache. Cloud/RFCOMM/LAN share the very same bytes.
 * Receiving objects never applies business rows or grants deletion authority. */
import {sha256Hex} from '@podjs/framework/crypto';
import {canonical,digest,exact,hexId,oid,uint,jsonBytes,parseCanonicalJson,type Scope} from './protocol';
import {sameScope} from './wire';
import {objectOid} from './sealed';
import type {WatchContentStore} from './content-store';
export type PartBody={scope:Scope;transferId:string;oid:string;totalBytes:number;offset:number;partBytes:number;partSha256:string};
export type PartHeader=PartBody&{sessionId:string};
export function anyObjectOid(id:unknown):string {if(typeof id!=='string'||!/^(meta|state|blob|recipe|tree|commit|state-refs|recipe-refs|commit-header|repo-descriptor|id-key-recovery):sha256:[a-f0-9]{64}$/.test(id))throw Error('invalid_oid');return id;}
export function partBody(value:any,scope:Scope):PartBody {
 exact(value,['scope','transferId','oid','totalBytes','offset','partBytes','partSha256']);sameScope(value.scope,scope);hexId(value.transferId,32);anyObjectOid(value.oid);hexId(value.partSha256,64);if(uint(value.totalBytes,266264)<1||uint(value.partBytes,65536)<1)throw Error('invalid_schema');uint(value.offset);if(value.offset>value.totalBytes-value.partBytes)throw Error('invalid_range');return value;
}
export function partHeader(value:any,scope:Scope,sessionId:string):PartHeader {
 exact(value,['scope','sessionId','transferId','oid','totalBytes','offset','partBytes','partSha256']);const {sessionId:session,...body}=value;partBody(body,scope);hexId(session,32);if(session!==sessionId)throw Error('session_mismatch');return value;
}
export function validatePart(header:PartHeader,payload:Uint8Array){if(payload.length!==header.partBytes)throw Error('offset_conflict');if(sha256Hex(payload)!==header.partSha256)throw Error('hash_mismatch');}
export type LocalReceipt={kind:'local';oid:string;durableOffset:number;totalBytes:number};
export class LocalObjectStore {
 private running=new Set<string>();
 constructor(readonly store:WatchContentStore,readonly scope:Scope,private readonly authenticate:(id:string,raw:Uint8Array)=>Promise<void>){}
 private key(id:string){anyObjectOid(id);return 'local-object:'+id;}
 private aad(id:string){return canonical({domain:'wrss.sync.v2/local-object-prefix',scope:this.scope,oid:id,binding:this.store.prefix});}
 private hash(id:string,raw:Uint8Array){const type=id.split(':')[0]!;let input=raw;if(type==='commit'){const v=parseCanonicalJson(raw);exact(v,['body','signature']);input=jsonBytes(v.body);}if(objectOid(type,input)!==id)throw Error('hash_mismatch');}
 async status(id:string){
  const key=this.key(id),[stat]=await this.store.files.stat([this.store.path(key)]);if(!stat?.exists||!stat.checkpoint)return {oid:id,status:'missing',totalBytes:null,durableOffset:0,receipt:null};
  const cp=await this.store.cipher.open(this.aad(id),stat.checkpoint);exact(cp,['oid','totalBytes','durableOffset']);if(cp.oid!==id||uint(cp.totalBytes,266264)<1||uint(cp.durableOffset)>cp.totalBytes||stat.size<cp.durableOffset||stat.durableOffset!==cp.durableOffset)throw Error('content_checkpoint_corrupt');
  if(cp.durableOffset===cp.totalBytes)await this.complete(id,cp.totalBytes);
  return {oid:id,status:cp.durableOffset===cp.totalBytes?'present':'partial',totalBytes:cp.totalBytes,durableOffset:cp.durableOffset,receipt:{kind:'local',oid:id,durableOffset:cp.durableOffset,totalBytes:cp.totalBytes} as LocalReceipt};
 }
 async part(body:PartBody,header:PartHeader,payload:Uint8Array,sessionId:string){
  partBody(body,this.scope);partHeader(header,this.scope,sessionId);const {sessionId:_,...actual}=header;
  if(canonical(actual)!==canonical(body))throw Error(body.partSha256!==header.partSha256?'hash_mismatch':'offset_conflict');validatePart(header,payload);
  if(body.offset%65536||body.offset+body.partBytes<body.totalBytes&&body.partBytes!==65536)throw Error('offset_conflict');
  if(this.running.has(body.oid))throw Error('object_busy');this.running.add(body.oid);
  try{
   const saved=await this.status(body.oid);if(saved.totalBytes!==null&&saved.totalBytes!==body.totalBytes)throw Error('offset_conflict');
   if(body.offset<saved.durableOffset){if(body.offset+body.partBytes>saved.durableOffset)throw Error('offset_conflict');const old=await this.store.bytes(this.key(body.oid),body.totalBytes,body.offset,body.partBytes);if(sha256Hex(old)!==body.partSha256)throw Error('hash_mismatch');return {transferId:body.transferId,oid:body.oid,durableOffset:saved.durableOffset};}
   if(body.offset!==saved.durableOffset)throw Error('offset_conflict');
   const durableOffset=body.offset+payload.length,checkpoint=await this.store.cipher.seal(this.aad(body.oid),{oid:body.oid,totalBytes:body.totalBytes,durableOffset});
   await this.store.files.frame(this.store.path(this.key(body.oid)),body.offset,payload,checkpoint);
   return {transferId:body.transferId,oid:body.oid,durableOffset};
  }finally{this.running.delete(body.oid);}
 }
 async complete(id:string,totalBytes:number){
  this.key(id);if(uint(totalBytes,266264)<1)throw Error('invalid_schema');const key=this.key(id),[stat]=await this.store.files.stat([this.store.path(key)]);if(!stat?.exists||stat.size!==totalBytes||stat.durableOffset!==totalBytes||!stat.checkpoint)throw Error('closure_incomplete');
  const cp=await this.store.cipher.open(this.aad(id),stat.checkpoint);if(cp.oid!==id||cp.totalBytes!==totalBytes||cp.durableOffset!==totalBytes)throw Error('content_checkpoint_corrupt');
  const raw=await this.store.bytes(key,totalBytes);this.hash(id,raw);await this.authenticate(id,raw);
  const receipt:LocalReceipt={kind:'local',oid:id,totalBytes,durableOffset:totalBytes},saved=await this.store.get('local-present:'+id);
  if(saved){if(canonical(saved.value)!==canonical(receipt))throw Error('idempotency_conflict');}
  else try{await this.store.put('local-present:'+id,receipt,null);}catch(e){const winner=await this.store.get('local-present:'+id);if(!winner||canonical(winner.value)!==canonical(receipt))throw e;}
  return receipt;
 }
 /** Adopt a verified P3 source without splitting/compressing/encrypting it. */
 async adopt(id:string,totalBytes:number,read:(offset:number,length:number)=>Promise<Uint8Array>){
  anyObjectOid(id);uint(totalBytes,266264);const saved=await this.status(id);if(saved.status==='present')return saved.receipt;
  for(let at=saved.durableOffset;at<totalBytes;){const payload=await read(at,Math.min(65536,totalBytes-at)),body={scope:this.scope,transferId:digest(['adopt',id]).slice(0,32),oid:id,totalBytes,offset:at,partBytes:payload.length,partSha256:sha256Hex(payload)};await this.part(body,{...body,sessionId:'0'.repeat(32)},payload,'0'.repeat(32));at+=payload.length;}
  return this.complete(id,totalBytes);
 }
 async object(id:string){const value=await this.status(id);if(value.status!=='present')throw Error('object_missing');const size=value.totalBytes!;return {size,read:async(offset:number,length:number)=>{uint(offset);uint(length,65536);if(offset>size-length)throw Error('invalid_range');return this.store.bytes(this.key(id),size,offset,length);}};}
 async registerRefs(mapping:any,raw:Uint8Array,verify:(mapping:any,raw:Uint8Array)=>Promise<void>){
  exact(mapping,['scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);sameScope(mapping.scope,this.scope);const type=mapping.parentOid?.startsWith('state:')?'state':'recipe';oid(mapping.parentOid,type);oid(mapping.refsOid,type+'-refs');hexId(mapping.authorDeviceId,32);hexId(mapping.keyId,32);if(uint(mapping.totalBytes,262144)!==raw.length)throw Error('hash_mismatch');this.hash(mapping.refsOid,raw);await verify(mapping,raw);
  const id='local-refs:'+mapping.parentOid,old=await this.store.get(id);if(old){if(canonical(old.value)!==canonical(mapping))throw Error('idempotency_conflict');return old.value;}
  await this.adopt(mapping.refsOid,raw.length,async(at,n)=>raw.slice(at,at+n));
  try{await this.store.put(id,JSON.parse(canonical(mapping)),null);}catch(e){const winner=await this.store.get(id);if(!winner||canonical(winner.value)!==canonical(mapping))throw Error('idempotency_conflict');}
  return mapping;
 }
 async refs(parent:string,type:'state'|'recipe'){try{oid(parent,type);}catch{throw Error('invalid_oid');}const value=await this.store.get('local-refs:'+parent);if(!value)throw Error('object_missing');await this.object(value.value.refsOid);return value.value;}
}
