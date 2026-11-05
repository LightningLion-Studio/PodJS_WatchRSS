/** Explicit isolated-backend adapter. No runtime registration or global fetch. */
import {accountIdFromUserId} from './signing';
import type {WatchServiceKeyPin} from './service-key';
import type {HttpTransport,HttpResponse} from '../cloud/types';
import {decodeUtf8Chunk} from '@podjs/framework/bytes';
import {parseRawJson,rawJsonValue} from '@podjs/framework/json-raw';
import {bytes,jsonBytes,canonical,exact,hexId,checkD64,uint,oid,validateScope,type Scope} from './protocol';
import {sameScope,b64,unb64} from './wire';
import {sha256Hex} from '@podjs/framework/crypto';
export const P2_CLOSED_GATES=Object.freeze({indexWrite:false,contentWrite:false,relay:false,gc:false,historyRestore:false,noteSegments:false,keyRotation:false,localObjects:false,autoEvict:false});
export class SyncV2Error extends Error {constructor(readonly code:string,readonly retryable=false,readonly retryAfterMillis:number|null=null){super(code);}}
export function parseNetwork(input:Uint8Array){try{
 let at=0,text='';while(at<input.length){const chunk=decodeUtf8Chunk(input,at);if(chunk.next<=at)throw Error();text+=chunk.text;at=chunk.next;}
 const round=bytes(text);if(round.length!==input.length||round.some((b,i)=>b!==input[i]))throw Error();
 const root=parseRawJson(text,{maxBytes:1048576,maxDepth:32,native:false});
 const visit=(node:any)=>{if(node.kind==='scalar'){const raw=node.source.slice(node.start,node.end);if(/^[0-9-]/.test(raw)&&! /^-?(0|[1-9][0-9]*)$/.test(raw))throw Error();}for(const prop of node.properties??[])visit(prop.value);for(const item of node.items??[])visit(item);};visit(root);
 const value=rawJsonValue<any>(root);canonical(value);return value;
 }catch{throw Error('invalid_encoding');}}

export type Session={accessToken:string;legacyDeviceId:string;userId:string;scope:Scope};
export class SyncV2Http {
 readonly prefix:string;private flags:any;
 constructor(private readonly transport:HttpTransport,origin:string,readonly scope:Scope,private readonly session:()=>Promise<Session>,readonly indexWrite=false,readonly servicePin?:WatchServiceKeyPin){
  validateScope(scope);if(!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(origin))throw Error('isolated_backend_required');this.prefix=origin+'/functions/v1/sync/v2';
 }
 private async send(method:string,path:string,body?:any,extra:Record<string,string>={},raw?:Uint8Array):Promise<HttpResponse>{
  if(!this.servicePin)throw Error('service_key_unpinned');await this.servicePin.assertBootstrap();
  const s=await this.session();if(accountIdFromUserId(s.userId)!==this.servicePin.accountId)throw Error('cloud_account_busy');sameScope(s.scope,this.scope);
  if(path!=='/capabilities'){if(!this.flags)await this.capabilities();const route=path.split('?')[0],write=method==='PUT'||method==='POST'&&(['/devices/signing-key','/objects/reserve','/state-refs','/refs/cas','/account/publish'].includes(route)||/^\/objects\/[^/]+\/complete$/.test(route));if(this.flags.read!==true||write&&this.flags.indexWrite!==true)throw Error('feature_disabled');}if(!s.accessToken||!s.legacyDeviceId)throw Error('authorization_required');
  const query=method==='GET'?(path.includes('?')?'&':'?')+Object.entries(this.scope).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'):'';
  return this.transport.request({method,url:this.prefix+path+query,headers:{Authorization:'Bearer '+s.accessToken,'x-watchrss-cloud-device-id':s.legacyDeviceId,'Content-Type':raw?'application/octet-stream':'application/json',...extra},...(raw||body!==undefined?{body:raw??jsonBytes(body)}:{}),timeoutMs:10000,readTimeoutMs:path.startsWith('/events')?30000:10000,acceptHttpErrors:true});
 }
 async json(method:string,path:string,body?:any){
  const route=path.split('?')[0];
  const reads=method==='GET'&&(new Set(['/capabilities','/checkpoint','/account','/refs','/events','/history','/devices/signing-keys','/account/ancestry','/repo/descriptor']).has(route)||/^\/(requests|state-refs|recipe-refs)\/[^/]+$/.test(route));
  const queries=method==='POST'&&['/negotiate','/trees/diff','/objects/have-want','/objects/batch-get'].includes(route);
  const writes=method==='POST'&&(['/devices/signing-key','/objects/reserve','/state-refs','/refs/cas','/account/publish'].includes(route)||/^\/objects\/[^/]+\/complete$/.test(route));
  if(!reads&&!queries&&!(writes&&this.indexWrite))throw Error('feature_disabled');if(route==='/objects/reserve'&&body?.channel!=='control')throw Error('feature_disabled');
  const r=await this.send(method,path,body);if(r.body.length>1048576)throw Error('object_too_large');const value=parseNetwork(r.body);
  if(r.status>=300&&r.status<400)throw new SyncV2Error('transport_error');
  if(r.status>=400){if(value?.error?.code==='upgrade_required'||r.status===426)throw new SyncV2Error('upgrade_required');const e=value?.error;exact(value,['error']);exact(e,['code','retryable','retryAfterMillis','details']);if(typeof e.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(e.code)||typeof e.retryable!=='boolean'||!e.details||Object.getPrototypeOf(e.details)!==Object.prototype)throw Error('invalid_schema');if(e.retryAfterMillis!==null)uint(e.retryAfterMillis);throw new SyncV2Error(e.code,e.retryable,e.retryAfterMillis);}
  if(value.version!==2)throw new SyncV2Error('upgrade_required');sameScope(value.scope,this.scope);return value;
 }
 async capabilities(){const v=await this.json('GET','/capabilities');if(v.minVersion!==2||v.maxVersion!==2)throw new SyncV2Error('upgrade_required');exact(v,['version','scope','minVersion','maxVersion','features','maxPartBytes','historyDays','flags','receiptKeyId','receiptSigningPublicKey']);exact(v.flags,['read','indexWrite','contentWrite','relay','gc','historyRestore']);if(Object.values(v.flags).some(x=>typeof x!=='boolean')||v.maxPartBytes!==65536||v.historyDays!==7)throw Error('invalid_schema');await this.servicePin!.capabilities(v);this.flags={...v.flags};return v;}
 async negotiate(knownRefs:any[],features:string[]){return this.json('POST','/negotiate',{scope:this.scope,knownRefs,features});}
 async publish(value:any){if(!this.indexWrite)throw Error('feature_disabled');return this.json('POST','/account/publish',value);}
 async requestResult(requestId:string){hexId(requestId,32);return this.json('GET','/requests/'+requestId);}
 async events(after:string,waitMillis=25000){checkD64(after);uint(waitMillis,25000);return this.json('GET','/events?after='+after+'&waitMillis='+waitMillis);}
 async batch(windowId:string,oids:string[]){hexId(windowId,32);return this.json('POST','/objects/batch-get',{scope:this.scope,windowId,oids});}
 async object(id:string,range?:{start:number;end:number;totalBytes:number}){if(!/^[a-z-]+:sha256:[a-f0-9]{64}$/.test(id))throw Error('invalid_oid');if(range){uint(range.start);uint(range.end);uint(range.totalBytes,266264);if(range.start>range.end||range.end>=range.totalBytes)throw Error('invalid_range');}
  const r=await this.send('GET','/objects/'+encodeURIComponent(id),undefined,range?{Range:'bytes='+range.start+'-'+range.end}:{});if(r.status===416)throw new SyncV2Error('invalid_range');if(r.status!==(range?206:200))throw new SyncV2Error(r.status===404?'object_missing':'transport_error');if(r.body.length>266264||r.headers['etag']!==id&&r.headers['ETag']!==id||String(r.body.length)!==(r.headers['content-length']??r.headers['Content-Length']))throw Error('invalid_encoding');if(range&&(r.body.length!==range.end-range.start+1||(r.headers['Content-Range']??r.headers['content-range'])!=='bytes '+range.start+'-'+range.end+'/'+range.totalBytes))throw Error('invalid_range');return r.body;}
 async recipeRefs(windowId:string,recipeOid:string){oid(recipeOid,'recipe');hexId(windowId,32);return this.json('GET','/recipe-refs/'+encodeURIComponent(recipeOid)+'?windowId='+windowId);}
 async stateRefs(windowId:string,stateOid:string){oid(stateOid,'state');hexId(windowId,32);return this.json('GET','/state-refs/'+encodeURIComponent(stateOid)+'?windowId='+windowId);}
 async putPart(id:string,offset:number,reservationId:string,requestId:string,part:Uint8Array){
  if(!this.indexWrite)throw Error('feature_disabled');if(!/^(meta|state|tree|commit|state-refs):sha256:[a-f0-9]{64}$/.test(id))throw Error('feature_disabled');uint(offset);if(offset%65536||part.length>65536||part.length===0)throw Error('invalid_schema');hexId(reservationId,32);hexId(requestId,32);
  const r=await this.send('PUT','/objects/'+encodeURIComponent(id)+'/parts/'+offset,undefined,{
   'x-watchrss-sync-repo-id':this.scope.repoId,'x-watchrss-sync-library-epoch':this.scope.libraryEpoch,'x-watchrss-sync-content-generation':this.scope.contentGeneration,'x-watchrss-sync-reservation-id':reservationId,'x-watchrss-sync-request-id':requestId,'x-watchrss-sync-part-sha256':sha256Hex(part),
  },part);
  const value=parseNetwork(r.body);if(r.status>=400)throw new SyncV2Error(value?.error?.code??'transport_error');if(value.version!==2)throw Error('invalid_schema');sameScope(value.scope,this.scope);return value;
 }
}
