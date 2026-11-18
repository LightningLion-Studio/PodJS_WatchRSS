import {fail,hex,integer,hash,envelope,ResumeError,type Envelope,type ObjectDescriptor,type Row} from './wire';
import {requestDigest,offerDigest,appliedReceipt,completion} from './digests';
import type {Capability,Snapshot,AppliedReceipt,BeginPayload} from './wire';
import type {RegisteredManifest} from './lifecycle';
import {type DataFrame,type OutgoingData,type AckFrame,type DataHeader} from './codec';

export class TokenBucket {
 private tokens:number;private at:number;
 constructor(private readonly burst:number,private readonly perSecond:number,now=0){this.tokens=burst;this.at=now;}
 take(now:number):void {if(now<this.at)fail('LOCAL_IO');this.tokens=Math.min(this.burst,this.tokens+(now-this.at)*this.perSecond/1000);this.at=now;if(this.tokens<1)fail('RATE_LIMITED');this.tokens--;}
}
export class RetryBackoff {
 private k=0;
 next(retryAfterMillis:number):number {integer(retryAfterMillis,1000);const delay=Math.max(retryAfterMillis,Math.min(1000,100*2**this.k));this.k=Math.min(this.k+1,4);return delay;}
 reset():void {this.k=0;}
}
export interface JobBinding {streamId:1|2;jobId:string;planDigest:string;selectionDigest:string}
export interface Pending extends Omit<DataFrame,'payload'> {payloadBytes:number;state:'IN_FLIGHT'}
export interface Settlement {pending:Pending;disposition:1|2}
export class SequenceExhausted extends Error {readonly recovery='RECONNECT';constructor(){super('TXSEQ_EXHAUSTED');this.name='SequenceExhausted';}}
export type RecoveryAction='QUERY'|'WAIT'|'BEGIN'|'REPLAN'|'STOP';
/** One instance per stream, with immutable job/plan binding for this connection. */
export class SendWindow {
 private readonly pending=new Map<number,Pending>();
 private bytes=0;
 private nextTxSeq=1;private lastAckSeq=0;private active=true;
 private readonly binding:JobBinding;
 private readonly stale:TokenBucket;
 private readonly grantedEpochs=new Set<number>();
 constructor(binding:JobBinding,private epoch:number,now=0,staleAckBudget?:TokenBucket,
  private readonly limits={maxInFlightChunks:1,maxInFlightBytes:65536}){
  this.binding=Object.freeze({...binding});if(!integer(epoch))fail();this.grantedEpochs.add(epoch);this.stale=staleAckBudget??new TokenBucket(32,16,now);
 }
 get currentEpoch():number{return this.epoch;}
 granted(epoch:number):boolean{return this.grantedEpochs.has(epoch);}
 oldEpoch(epoch:number):boolean{if(!this.granted(epoch))fail('STALE_EPOCH');return epoch<this.epoch;}
 get credit():{chunks:number;bytes:number} {return {chunks:this.pending.size,bytes:this.bytes};}
 canSend(bytes:number):boolean {
  return this.active&&this.pending.size<this.limits.maxInFlightChunks&&this.bytes+bytes<=this.limits.maxInFlightBytes;
 }
 acceptsAckProgress(epoch:number,ackSeq:number):boolean{
  return this.active&&this.pending.size>0&&epoch===this.epoch&&ackSeq===this.lastAckSeq+1;
 }
 /** Reserve credit at the writer, before encoding or writing the first byte. */
 reserve(input:Omit<DataFrame,'kind'|'streamId'|'epoch'|'txSeq'>):DataFrame;
 reserve(input:Omit<OutgoingData,'kind'|'streamId'|'epoch'|'txSeq'>):OutgoingData;
 reserve(input:Omit<OutgoingData,'kind'|'streamId'|'epoch'|'txSeq'>):OutgoingData {
  if(!this.active)fail('AUTH_REVOKED');
  if(!this.canSend(input.payload.length))fail('WINDOW_FULL');
  if(this.nextTxSeq>Number.MAX_SAFE_INTEGER){this.close();throw new SequenceExhausted();}
  const {payload,...header}=input;
  hex(header.requestId,32);hex(header.requestDigest);integer(header.objectSlot,4095);integer(header.chunkIndex,255);
  if(!payload.length||payload.length>65536)fail();
  for(const p of this.pending.values())if(p.requestId===header.requestId||p.objectSlot===header.objectSlot&&p.chunkIndex===header.chunkIndex)fail('REQUEST_CONFLICT');
  const frame={...header,kind:'data' as const,streamId:this.binding.streamId,epoch:this.epoch,txSeq:this.nextTxSeq++};
  this.pending.set(frame.txSeq,{...frame,payloadBytes:payload.length,state:'IN_FLIGHT'});this.bytes+=payload.length;
  return {...frame,payload};
 }
 acceptAck(ack:AckFrame,now:number):Settlement[]|null {
  try{return this.checkedAck(ack,now);}catch(e){this.close();throw e;}
 }
 private checkedAck(ack:AckFrame,now:number):Settlement[]|null {
  if(!this.active)fail('AUTH_REVOKED');
  if(ack.streamId!==this.binding.streamId||!ack.entries.length||ack.entries.length>32||!integer(ack.epoch)||!integer(ack.ackSeq))fail();
  let last=0;for(const e of ack.entries){if(integer(e.txSeq)<=last||e.disposition!==1&&e.disposition!==2)fail();last=e.txSeq;}
  if(this.oldEpoch(ack.epoch)||ack.ackSeq<=this.lastAckSeq){this.stale.take(now);return null;}
  if(ack.epoch!==this.epoch||ack.ackSeq!==this.lastAckSeq+1)fail();
  const result=ack.entries.map(e=>{
   const pending=this.pending.get(e.txSeq);if(!pending)fail();
   return {pending,disposition:e.disposition};
  });
  for(const {pending} of result)this.settle(pending);
  this.lastAckSeq=ack.ackSeq;return result;
 }
 private settle(p:Pending){this.pending.delete(p.txSeq);this.bytes-=p.payloadBytes;}
 negative(value:Envelope,now:number):{action:RecoveryAction;retryAfterMillis:number;pending:Pending}|null {
  try{return this.checkedNegative(value,now);}catch(e){this.close();throw e;}
 }
 private checkedNegative(value:Envelope,now:number):{action:RecoveryAction;retryAfterMillis:number;pending:Pending}|null {
  const r=envelope(value);if(!this.active)fail('AUTH_REVOKED');
  if(r.type!=='response'||r.phase!=='putChunk'||r.success!==false||r.jobId!==this.binding.jobId||r.planDigest!==this.binding.planDigest||r.epoch===null)fail();
  if(this.oldEpoch(r.epoch)){this.stale.take(now);return null;}
  const p=Array.from(this.pending.values()).find(p=>p.requestId===r.requestId);if(r.epoch!==this.epoch||!p||r.requestDigest!==p.requestDigest)fail('REQUEST_CONFLICT');
  this.settle(p);const action=r.error!.recovery as RecoveryAction;
  if(action==='REPLAN'||action==='STOP')this.close();return {action,retryAfterMillis:Number(r.error!.retryAfterMillis),pending:p};
 }
 /** Caller must complete the begin barrier and discard old worker/ACK queues first. */
 regrant(epoch:number):void {if(!this.active||integer(epoch)<=this.epoch)fail('STALE_EPOCH');this.epoch=epoch;this.grantedEpochs.add(epoch);this.pending.clear();this.bytes=0;this.nextTxSeq=1;this.lastAckSeq=0;}
 close():void {this.active=false;this.pending.clear();this.bytes=0;}
}

export interface GrantToken {connectionId:string;generation:number;epoch:number}
export class Grant {
 private generation=1;private live=true;private epoch:number;
 constructor(readonly connectionId:string,epoch:number){this.epoch=integer(epoch);if(!epoch)fail();}
 token():GrantToken {return {connectionId:this.connectionId,generation:this.generation,epoch:this.epoch};}
 check(token:GrantToken):void {if(!this.live||token.connectionId!==this.connectionId||token.generation!==this.generation||token.epoch!==this.epoch)fail('AUTH_REVOKED');}
 regrant(epoch:number):void {if(!this.live||integer(epoch)<=this.epoch)fail('STALE_EPOCH');this.generation++;this.epoch=epoch;}
 fence():void {this.live=false;this.generation++;}
}
/** S1/native adapter must atomically bind requestId to locator/digest and commit
 * durable bytes/index, rechecking check() at its final commit point. Replay must
 * return the persisted disposition after actual payload validation by this core.
 */
export interface DurableChunks {
 commit(frame:DataFrame,object:ObjectDescriptor,check:()=>void):Promise<1|2>;
}
export class ReceiveWindow {
 private nextTxSeq=1;private nextAckSeq=1;private busy=false;
 private readonly objects:RegisteredManifest;private admitted=false;
 private readonly connectionId:string;private grantToken:GrantToken;private readonly grantedEpochs=new Set<number>();
 private readonly binding:JobBinding;
 constructor(binding:JobBinding,readonly grant:Grant,objects:RegisteredManifest){
  this.binding=Object.freeze({...binding});integer(objects.objectCount,4096);this.objects=objects;
  this.grantToken=grant.token();grant.check(this.grantToken);this.connectionId=this.grantToken.connectionId;this.grantedEpochs.add(this.grantToken.epoch);
 }

 private checkGrant():GrantToken {if(this.grantToken.connectionId!==this.connectionId)fail('AUTH_REVOKED');this.grant.check(this.grantToken);return {...this.grantToken};}
 granted(epoch:number):boolean{return this.grantedEpochs.has(epoch);}
 /** Only after full manifest root/DAG validation, registration and peak reservation. */
 admit():void {this.checkGrant();this.admitted=true;}
 regrant(epoch:number):void {this.checkGrant();if(this.busy)fail('BUSY');this.grant.regrant(epoch);this.grantToken=this.grant.token();this.grantedEpochs.add(epoch);this.nextTxSeq=1;this.nextAckSeq=1;this.admitted=false;}
 async receive(frame:DataFrame,store:DurableChunks,emitAck:(ack:AckFrame)=>Promise<void>,admissionError?:ResumeError):Promise<'STALE'|'ACK'> {
  try{return await this.checkedReceive(frame,store,emitAck,admissionError);}catch(e){
   if(!(e instanceof ResumeError)||e.wire().recovery==='STOP')this.grant.fence();throw e;
  }
 }
 private async checkedReceive(frame:DataFrame,store:DurableChunks,emitAck:(ack:AckFrame)=>Promise<void>,admissionError?:ResumeError):Promise<'STALE'|'ACK'> {
  if(this.busy)fail('FLOW_CONTROL_VIOLATION');
  this.busy=true;
  try{
   const {payload,...header}=frame;
   const validated=await this.header({...header,payloadBytes:payload.length});
   if(!validated)return 'STALE';
   const {object,check}=validated;
   if(hash(payload)!==object.chunkHashes[frame.chunkIndex])fail('HASH_MISMATCH');
   if(admissionError)throw admissionError;
   const disposition=await store.commit(frame,object,check);check();
   await emitAck(this.ack(frame.epoch,[{txSeq:frame.txSeq,disposition}]));return 'ACK';
  }finally{this.busy=false;}
 }
 async header(frame:DataHeader, sequenced=false):Promise<{object:ObjectDescriptor;check:()=>void}|null>{
  const token=this.checkGrant();
  if(frame.streamId!==this.binding.streamId||!this.grantedEpochs.has(frame.epoch)||frame.epoch>token.epoch)fail('STALE_EPOCH');
  if(frame.epoch<token.epoch)return null;
  if(!this.admitted)fail('FLOW_CONTROL_VIOLATION');
  if((!sequenced&&frame.txSeq!==this.nextTxSeq)||!Number.isSafeInteger(frame.txSeq))fail();
  const check=()=>this.grant.check(token);
  const object=await this.objects.at(integer(frame.objectSlot,Math.max(0,this.objects.objectCount-1)));check();
  if(!object||!Number.isSafeInteger(frame.chunkIndex)||frame.chunkIndex<0||frame.chunkIndex>=object.chunkHashes.length)fail();
  const length=Math.min(65536,object.size-frame.chunkIndex*65536);
  if(length<=0||frame.payloadBytes!==length||requestDigest(this.binding.jobId,this.binding.planDigest,'putChunk',{objectId:object.objectId,chunkIndex:frame.chunkIndex})!==frame.requestDigest)fail('REQUEST_CONFLICT');
  hex(frame.requestId,32);this.nextTxSeq++;
  return {object,check};
 }
 ack(epoch:number,entries:AckFrame['entries']):AckFrame{
  if(this.checkGrant().epoch!==epoch)fail('STALE_EPOCH');
  if(entries.some(e=>e.disposition!==1&&e.disposition!==2))fail('LOCAL_IO');
  return {kind:'ack',streamId:this.binding.streamId,epoch,ackSeq:this.nextAckSeq++,entries};
 }

}

function heartbeat(e:Envelope):boolean {return e.phase==='missing'&&e.payload?.limit===0;}
export interface ControlContext {authenticated:boolean;beginAuthorized:boolean;admitted:boolean;state:string;nextManifestPage:number;expiresAtMillis:number}
export function planningHeartbeat(e:Envelope,c:ControlContext):Row {
 if(e.type!=='request'||!heartbeat(e)||e.payload!.afterObjectId!==null||e.payload!.afterChunkIndex!==null||!c.authenticated||!c.beginAuthorized||c.state!=='PLANNING')fail('AUTH_REVOKED');
 return {state:'PLANNING',nextManifestPage:c.nextManifestPage,expiresAtMillis:c.expiresAtMillis,items:[],next:null,done:true,completion:null};
}
/** Business and heartbeat slots are independent; cancel/responses use neither. */
export class ControlSlots {
 private business:Envelope|null=null;private light:Envelope|null=null;
 private readonly binding:JobBinding;
 constructor(binding:JobBinding,private readonly receiverDeviceId?:string){this.binding=Object.freeze({...binding});}
 begin(request:Envelope,c:ControlContext):void {
  const e=envelope(request);if(e.type!=='request')fail();
  if(requestDigest(e.jobId,e.planDigest,e.phase,e.payload!)!==e.requestDigest)fail('REQUEST_CONFLICT');
  if(e.phase!=='prepare'&&(e.jobId!==this.binding.jobId||e.planDigest!==this.binding.planDigest))fail('PLAN_CONFLICT');
  if(!c.authenticated)fail('AUTH_REVOKED');
  if(e.phase==='cancel')return;
  if(heartbeat(e)){
   if(!c.beginAuthorized||e.payload!.afterObjectId!==null||e.payload!.afterChunkIndex!==null)fail('AUTH_REVOKED');
   if(this.light)fail('BUSY');this.light=e;return;
  }
  if(['missing','apply','complete'].includes(e.phase)&&!c.admitted&&c.state!=='COMPLETE'&&c.state!=='CANCELLED')fail('MANIFEST_INCOMPLETE');
  if(this.business)fail('BUSY');this.business=e;
 }
 settle(response:Envelope):void {try{this.settleChecked(response);}catch(e){this.clear();throw e;}}
 private settleChecked(response:Envelope):void {
  const r=envelope(response);if(r.type!=='response')fail();
  const slot=this.light?.requestId===r.requestId?'light':'business',p=this[slot];
  if(!p||p.requestId!==r.requestId||p.requestDigest!==r.requestDigest||p.phase!==r.phase||p.jobId!==r.jobId||p.planDigest!==r.planDigest||p.phase!=='begin'&&p.epoch!==r.epoch)fail('REQUEST_CONFLICT');
  if(slot==='light'&&r.success&&((r.result!.items as unknown[]).length!==0||r.result!.next!==null||r.result!.done!==true))fail();
  if(r.success)this.checkResult(p,r);
  this[slot]=null;
 }
 private checkResult(p:Envelope,r:Envelope):void {
  const result=r.result!,payload=p.payload!;
  switch(p.phase){
   case 'prepare':if(payload.step==='offer'){
    if(result.offerDigest!==offerDigest(payload,result.watchCapabilities as unknown as Capability,result.watchSnapshot as unknown as Snapshot))fail('PLAN_CONFLICT');
   }else if(result.preparationDigest!==payload.preparationDigest)fail('PLAN_CONFLICT');break;
   case 'begin':{
    const b=payload as unknown as BeginPayload;
    if(result.selectionDigest!==b.selectionDigest||Number(result.nextManifestPage)>b.pageObjectCounts.length)fail('PLAN_CONFLICT');
    if(result.state==='COMPLETE'){
     const d=result.completion as Row,expected=completion(p.jobId!,p.planDigest!,b.objectCount,String(d.receiptsRoot),(b.direction==='phoneToWatch'?b.phoneSnapshot:b.watchSnapshot).toInclusive);
     if(Object.keys(expected).some(k=>d[k]!==expected[k as keyof typeof expected]))fail('RECEIPT_CONFLICT');
    }break;
   }
   case 'manifestPage':if(result.pageIndex!==payload.pageIndex||result.pageDigest!==payload.pageDigest||result.nextManifestPage!==Number(payload.pageIndex)+1)fail('PLAN_CONFLICT');break;
   case 'missing':if((result.items as unknown[]).length>Number(payload.limit))fail();break;
   case 'apply':{
    const receipt=result.receipt as unknown as AppliedReceipt,expected=appliedReceipt(p,String(payload.objectId),this.receiverDeviceId??receipt.receiverDeviceId,receipt.outcome);
    if(Object.keys(expected).some(k=>receipt[k as keyof AppliedReceipt]!==expected[k as keyof AppliedReceipt]))fail('RECEIPT_CONFLICT');break;
   }
   case 'complete':{
    const expected=completion(p.jobId!,p.planDigest!,Number(payload.objectCount),String(payload.receiptsRoot),Number(payload.ackToInclusive));
    if(Object.keys(expected).some(k=>result[k]!==expected[k as keyof typeof expected]))fail('RECEIPT_CONFLICT');break;
   }
  }
 }
 clear():void {this.business=null;this.light=null;}
}
export function negativeReply(binding:JobBinding,frame:Pick<DataFrame,'epoch'|'requestId'|'requestDigest'>,error:ResumeError):Envelope {
 return envelope({action:'syncLibraryBinary',version:2,phase:'putChunk',type:'response',jobId:binding.jobId,planDigest:binding.planDigest,epoch:frame.epoch,requestId:frame.requestId,requestDigest:frame.requestDigest,success:false,result:null,error:error.wire()});
}

/** Connection-local stream identity cannot be reused even after COMPLETE. */
export class StreamBindings {
 private bindings=new Map<1|2,JobBinding>();
 bind(value:JobBinding):void {
  if(value.streamId!==1&&value.streamId!==2)fail();hex(value.jobId,32);hex(value.planDigest);hex(value.selectionDigest);
  const old=this.bindings.get(value.streamId);
  if(old&&(old.jobId!==value.jobId||old.planDigest!==value.planDigest||old.selectionDigest!==value.selectionDigest))fail('PLAN_CONFLICT');
  this.bindings.set(value.streamId,Object.freeze({...value}));
 }
}
/** Object slots are distinct from DATA byte/chunk credit. No cross-direction borrowing. */
export class ObjectSlots {
 private slots=new Map<string,1|2>();
 constructor(private readonly maximum:number,private readonly bidirectional:boolean){if(!integer(maximum,4))fail();}
 acquire(objectId:string,direction:1|2,dependenciesApplied:boolean,phoneToWatchComplete=false):void {
  hex(objectId);if(!dependenciesApplied)fail('DEPENDENCIES_PENDING');
  if(direction!==1&&direction!==2)fail();const key=direction+':'+objectId;if(this.slots.has(key))return;
  let capacity=this.maximum;
  if(this.bidirectional)capacity=this.maximum===1?(direction===1||phoneToWatchComplete?1:0):direction===1?Math.ceil(this.maximum/2):Math.floor(this.maximum/2);
  if(this.slots.size>=this.maximum||[...this.slots.values()].filter(x=>x===direction).length>=capacity)fail('WINDOW_FULL');this.slots.set(key,direction);
 }
 applied(objectId:string,direction:1|2):void {this.slots.delete(direction+':'+objectId);}
}
