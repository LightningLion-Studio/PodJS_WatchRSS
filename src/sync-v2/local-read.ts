import {ObjectFrameConnection} from '@podjs/framework/object-frame';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
import {sha256Hex} from '@podjs/framework/crypto';
import {exact,hexId,uint,jsonBytes,parseCanonicalJson,canonical,type Scope} from './protocol';
import {parseNetwork} from './http';
import {sameScope} from './wire';
import {anyObjectOid,partHeader,partFrameHeader,validatePart,type PartHeader,type LocalObjectStore} from './local-objects';
import {checkedResumeOffset} from './resume';
import type {WatchContentStore} from './content-store';
export function localObjectFrames(stream:FrameByteStream,scope:Scope,sessionId:string,enabled:()=>boolean){return new ObjectFrameConnection<any,PartHeader>(stream,{
 encodeControl:async value=>jsonBytes(value),decodeControl:async raw=>parseNetwork(raw),encodeHeader:jsonBytes,decodeHeader:raw=>{const h=parseCanonicalJson(raw);return partHeader(h,h.scope,h.sessionId);},partBytes:h=>h.partBytes,
 // Integrity and session checks run at the consumer before any persistence.
 // A complete bad part can therefore receive C26's exact refusal response.
 validatePart:async(header)=>{partHeader(header,header.scope,header.sessionId);},
 },enabled);}
export function localRequest(value:any){exact(value,['requestId','action','body']);hexId(value.requestId,32);if(typeof value.action!=='string'||!value.action.startsWith('syncObjectsV2.'))throw Error('unknown_action');if(jsonBytes(value).length>262144)throw Error('object_too_large');return value;}
export const localResponse=(requestId:string,body:any)=>({requestId,ok:true,body,error:null});
export const localFailure=(requestId:string,code:string)=>({requestId,ok:false,body:null,error:{code,retryable:false,retryAfterMillis:null,details:{}}});
export class LocalReadService {
 constructor(readonly objects:LocalObjectStore,readonly scope:Scope,readonly sessionId:string,private readonly window:(id:string)=>Promise<void>,private readonly nonce:()=>Promise<string>,private readonly check:()=>void|Promise<void>){}
 async read(request:any,frames:ObjectFrameConnection<any,PartHeader>){
  localRequest(request);await this.check();const {body:b,action,requestId}=request;sameScope(b?.scope,this.scope);hexId(b.windowId,32);await this.window(b.windowId);await this.check();
  if(action==='syncObjectsV2.stateRefsGet'||action==='syncObjectsV2.recipeRefsGet'){
   exact(b,['scope','windowId','parentOid']);const refs=await this.objects.refs(b.parentOid,action.includes('stateRefs')?'state':'recipe');await this.check();await frames.writeControl(localResponse(requestId,refs));return;
  }
  if(action!=='syncObjectsV2.objectGet')throw Error('unknown_action');exact(b,['scope','windowId','oid','range']);anyObjectOid(b.oid);const source=await this.objects.object(b.oid);await this.check();
  let start=0,end=source.size-1;if(b.range!==null){try{exact(b.range,['start','end']);start=uint(b.range.start);end=uint(b.range.end);}catch{throw Error('invalid_range');}if(start>end||end>=source.size)throw Error('invalid_range');}
  const transferId=await this.nonce();hexId(transferId,32);await this.check();await frames.writeControl(localResponse(requestId,{scope:this.scope,oid:b.oid,totalBytes:source.size,start,end,transferId}));
  for(let at=start;at<=end;){await this.check();await this.window(b.windowId);const payload=await source.read(at,Math.min(65536,end-at+1));if(!payload.length)throw Error('closure_incomplete');await this.check();await frames.writePart({scope:this.scope,sessionId:this.sessionId,oid:b.oid,totalBytes:source.size,offset:at,partBytes:payload.length,partSha256:sha256Hex(payload)},payload);at+=payload.length;}
 }
}
class LocalPeerError extends Error {}
/** Cloud-compatible read facade, so public-table authentication is shared. */
export class LocalReadClient {
 constructor(readonly scope:Scope,readonly sessionId:string,private readonly frames:ObjectFrameConnection<any,PartHeader>,private readonly nonce:()=>Promise<string>,private readonly receipts?:{store:WatchContentStore;peerDeviceId:string}){}
 private active=false;
 private async single<T>(work:()=>Promise<T>){if(this.active)throw Error('local_request_busy');this.active=true;try{return await work();}catch(error){if(!(error instanceof LocalPeerError))await this.frames.close();throw error;}finally{this.active=false;}}
 control(action:string,body:any,afterWrite?:()=>Promise<void>){return this.single(()=>this.exchange(action,body,afterWrite));}
 private async exchange(action:string,body:any,afterWrite?:()=>Promise<void>){const requestId=await this.nonce();hexId(requestId,32);await this.frames.writeControl({requestId,action,body});await afterWrite?.();const frame=await this.frames.read(10000);if(frame.kind!=='control')throw Error('unexpected_data_frame');const r=frame.value;exact(r,['requestId','ok','body','error']);if(r.requestId!==requestId||typeof r.ok!=='boolean')throw Error('request_mismatch');if(!r.ok){if(r.body!==null||typeof r.error?.code!=='string')throw Error('invalid_schema');exact(r.error,['code','retryable','retryAfterMillis','details']);throw new LocalPeerError(r.error.code);}if(r.error!==null)throw Error('invalid_schema');return r.body;}
 upload(id:string,source:{size:number;read:(offset:number,length:number)=>Promise<Uint8Array>},windowId:string){return this.single(async()=>{
  anyObjectOid(id);hexId(windowId,32);uint(source.size,266264);const transferId=await this.nonce();hexId(transferId,32);
  const have=await this.exchange('syncObjectsV2.haveWant',{scope:this.scope,windowId,oids:[id]});exact(have,['scope','windowId','objects']);sameScope(have.scope,this.scope);if(have.windowId!==windowId||!Array.isArray(have.objects)||have.objects.length!==1)throw Error('invalid_schema');
  const r=have.objects[0];exact(r,['oid','status','totalBytes','durableOffset','receipt']);if(r.oid!==id)throw Error('invalid_schema');uint(r.durableOffset,source.size);
  const receiptKey='local-send:'+this.receipts?.peerDeviceId+':'+id,prior=await this.receipts?.store.get(receiptKey);let confirmed=prior?.value.durableOffset??0;
  if(prior&&prior.value.totalBytes!==source.size)throw Error('hash_mismatch');
  if(r.status==='missing'){if(r.totalBytes!==null||r.durableOffset!==0||r.receipt!==null)throw Error('invalid_schema');}
  else if(r.status==='partial'||r.status==='present'){exact(r.receipt,['kind','oid','durableOffset','totalBytes']);if(r.totalBytes!==source.size||canonical(r.receipt)!==canonical({kind:'local',oid:id,totalBytes:source.size,durableOffset:r.durableOffset})||r.status==='present'&&r.durableOffset!==source.size||r.status==='partial'&&r.durableOffset>=source.size)throw Error('invalid_schema');}
  else throw Error('invalid_schema');let at=checkedResumeOffset(confirmed,r.durableOffset,source.size),sentBytes=0;
  const remember=async(offset:number)=>{confirmed=Math.max(confirmed,offset);if(this.receipts){const previous=await this.receipts.store.get(receiptKey);await this.receipts.store.put(receiptKey,{kind:'local',oid:id,totalBytes:source.size,durableOffset:confirmed},previous?.revision??null);}};
  await remember(at);if(r.status==='present')return {sentBytes,receipt:r.receipt};
  while(at<source.size){const payload=await source.read(at,Math.min(65536,source.size-at));if(payload.length!==Math.min(65536,source.size-at))throw Error('closure_incomplete');const part={scope:this.scope,transferId,oid:id,totalBytes:source.size,offset:at,partBytes:payload.length,partSha256:sha256Hex(payload)};
   if(this.receipts)await this.receipts.store.consumeReplay('local:'+this.receipts.peerDeviceId+':'+id,source.size,confirmed,at,payload.length);
   const reply=await this.exchange('syncObjectsV2.putPart',part,()=>this.frames.writePart(partFrameHeader(part,this.sessionId),payload));exact(reply,['transferId','oid','durableOffset']);if(reply.transferId!==transferId||reply.oid!==id||reply.durableOffset!==at+payload.length)throw Error('offset_conflict');at=reply.durableOffset;sentBytes+=payload.length;await remember(at);
  }
  const receipt=await this.exchange('syncObjectsV2.complete',{scope:this.scope,transferId,oid:id,totalBytes:source.size});if(canonical(receipt)!==canonical({kind:'local',oid:id,totalBytes:source.size,durableOffset:source.size}))throw Error('invalid_schema');return {sentBytes,receipt};
 });}
 private refs(type:'state'|'recipe',windowId:string,parentOid:string){return this.single(async()=>({version:2,...await this.exchange('syncObjectsV2.'+type+'RefsGet',{scope:this.scope,windowId,parentOid})}));}
 stateRefs(windowId:string,parentOid:string){return this.refs('state',windowId,parentOid);}
 recipeRefs(windowId:string,parentOid:string){return this.refs('recipe',windowId,parentOid);}
 object(id:string,range?:{start:number;end:number;totalBytes:number},windowId?:string){return this.single(async()=>{
  anyObjectOid(id);hexId(windowId,32);const b=await this.exchange('syncObjectsV2.objectGet',{scope:this.scope,windowId,oid:id,range:range?{start:range.start,end:range.end}:null});
  exact(b,['scope','oid','totalBytes','start','end','transferId']);sameScope(b.scope,this.scope);hexId(b.transferId,32);uint(b.totalBytes,266264);uint(b.start);uint(b.end);if(b.oid!==id||b.start!==(range?.start??0)||b.end!==(range?.end??b.totalBytes-1)||range&&b.totalBytes!==range.totalBytes||b.start>b.end||b.end>=b.totalBytes)throw Error('invalid_range');
  const raw=new Uint8Array(b.end-b.start+1);let at=b.start;while(at<=b.end){const f=await this.frames.read(10000);if(f.kind!=='part')throw Error('unexpected_control_frame');const h=f.header;partHeader(h,this.scope,this.sessionId);validatePart(h,f.payload);if(h.oid!==id||h.totalBytes!==b.totalBytes||h.offset!==at||h.partBytes>b.end-at+1)throw Error('offset_conflict');raw.set(f.payload,at-b.start);at+=f.payload.length;}
  if(!range){const type=id.split(':')[0],input=type==='commit'?jsonBytes(parseCanonicalJson(raw).body):raw;if(type+':sha256:'+sha256Hex(input)!==id)throw Error('hash_mismatch');}return raw;
 });}
}
