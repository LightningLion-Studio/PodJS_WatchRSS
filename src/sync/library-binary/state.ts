import {fail,hex,integer,hash,envelope,ResumeError,type Envelope,type ObjectDescriptor,type Row} from './wire';
import {requestDigest,offerDigest,appliedReceipt,completion} from './digests';
import type {Capability,Snapshot,AppliedReceipt,BeginPayload} from './wire';
import type {RegisteredManifest} from './lifecycle';
import {type DataFrame,type AckFrame} from './codec';

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
export interface Pending extends DataFrame {state:'IN_FLIGHT'|'DURABLE'}
export interface Settlement {pending:Pending;disposition:1|2}
export class SequenceExhausted extends Error {readonly recovery='RECONNECT';constructor(){super('TXSEQ_EXHAUSTED');this.name='SequenceExhausted';}}
export type RecoveryAction='QUERY'|'WAIT'|'BEGIN'|'REPLAN'|'STOP';
/** One instance per stream, with immutable job/plan binding for this connection. */
export class SendWindow {
 private pending:Pending|null=null;private nextTxSeq=1;private lastAckSeq=0;private active=true;
 private binding:JobBinding;private epoch:number;
 private stale:TokenBucket;
 constructor(binding:JobBinding,epoch:number,now=0,staleAckBudget?:TokenBucket){this.binding=Object.freeze({...binding});this.epoch=integer(epoch);if(!epoch)fail();this.stale=staleAckBudget??new TokenBucket(32,16,now);}
 get credit():{chunks:number;bytes:number} {return {chunks:this.pending?1:0,bytes:this.pending?.payload.length??0};}
 /** Call immediately before the first write byte; a failed write closes the stream. */
 reserve(input:Omit<DataFrame,'kind'|'streamId'|'epoch'|'txSeq'>):Pending {
  if(!this.active)fail('AUTH_REVOKED');if(this.pending)fail('WINDOW_FULL');
  if(this.nextTxSeq>Number.MAX_SAFE_INTEGER){this.close();throw new SequenceExhausted();}
  hex(input.requestId,32);hex(input.requestDigest);integer(input.objectSlot,4095);integer(input.chunkIndex,255);
  if(!input.payload.length||input.payload.length>65536)fail();
  this.pending={...input,kind:'data',streamId:this.binding.streamId,epoch:this.epoch,txSeq:this.nextTxSeq++,state:'IN_FLIGHT'};return {...this.pending};
 }
 acceptAck(ack:AckFrame,now:number):Settlement|null {
  try{return this.checkedAck(ack,now);}catch(e){this.close();throw e;}
 }
 private checkedAck(ack:AckFrame,now:number):Settlement|null {
  if(!this.active)fail('AUTH_REVOKED');
  // Validate syntax even when called directly rather than through the codec.
  if(ack.streamId!==this.binding.streamId||!ack.entries.length||ack.entries.length>32||!integer(ack.epoch)||!integer(ack.ackSeq))fail();
  let last=0;for(const e of ack.entries){if(integer(e.txSeq)<=last||e.disposition!==1&&e.disposition!==2)fail();last=e.txSeq;}
  if(ack.epoch<this.epoch||ack.epoch===this.epoch&&ack.ackSeq<=this.lastAckSeq){this.stale.take(now);return null;}
  if(ack.epoch!==this.epoch||ack.ackSeq!==this.lastAckSeq+1||ack.entries.length!==1||!this.pending||ack.entries[0]!.txSeq!==this.pending.txSeq)fail();
  const result={pending:this.pending,disposition:ack.entries[0]!.disposition};this.pending=null;this.lastAckSeq=ack.ackSeq;return result;
 }
 negative(value:Envelope,now:number):{action:RecoveryAction;retryAfterMillis:number;pending:Pending}|null {
  try{return this.checkedNegative(value,now);}catch(e){this.close();throw e;}
 }
 private checkedNegative(value:Envelope,now:number):{action:RecoveryAction;retryAfterMillis:number;pending:Pending}|null {
  const r=envelope(value);if(!this.active)fail('AUTH_REVOKED');
  if(r.type!=='response'||r.phase!=='putChunk'||r.success!==false||r.jobId!==this.binding.jobId||r.planDigest!==this.binding.planDigest||r.epoch===null)fail();
  if(r.epoch<this.epoch){this.stale.take(now);return null;}
  const p=this.pending;if(r.epoch!==this.epoch||!p||r.requestId!==p.requestId||r.requestDigest!==p.requestDigest)fail('REQUEST_CONFLICT');
  this.pending=null;const action=r.error!.recovery as RecoveryAction;
  if(action==='REPLAN'||action==='STOP')this.close();return {action,retryAfterMillis:Number(r.error!.retryAfterMillis),pending:p};
 }
 /** Caller must complete the begin barrier and discard old worker/ACK queues first. */
 regrant(epoch:number):void {if(!this.active||integer(epoch)<=this.epoch)fail('STALE_EPOCH');this.epoch=epoch;this.pending=null;this.nextTxSeq=1;this.lastAckSeq=0;}
 close():void {this.active=false;this.pending=null;}
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
 /** Only after full manifest root/DAG validation, registration and peak reservation. */
 admit():void {this.checkGrant();this.admitted=true;}
 regrant(epoch:number):void {this.checkGrant();if(this.busy)fail('BUSY');this.grant.regrant(epoch);this.grantToken=this.grant.token();this.grantedEpochs.add(epoch);this.nextTxSeq=1;this.nextAckSeq=1;this.admitted=false;}
 async receive(frame:DataFrame,store:DurableChunks,emitAck:(ack:AckFrame)=>Promise<void>,admissionError?:ResumeError):Promise<'STALE'|'ACK'> {
  try{return await this.checkedReceive(frame,store,emitAck,admissionError);}catch(e){
   if(!(e instanceof ResumeError)||e.wire().recovery==='STOP')this.grant.fence();throw e;
  }
 }
 private async checkedReceive(frame:DataFrame,store:DurableChunks,emitAck:(ack:AckFrame)=>Promise<void>,admissionError?:ResumeError):Promise<'STALE'|'ACK'> {
  const token=this.checkGrant();
  if(frame.streamId!==this.binding.streamId||!this.grantedEpochs.has(frame.epoch)||frame.epoch>token.epoch)fail('STALE_EPOCH');
  if(frame.epoch<token.epoch)return 'STALE'; // codec already bounded and consumed the complete frame.
  if(!this.admitted||this.busy)fail('FLOW_CONTROL_VIOLATION');
  this.busy=true;
  try{
  const o=await this.objects.at(integer(frame.objectSlot,Math.max(0,this.objects.objectCount-1)));this.grant.check(token);if(!o||frame.txSeq!==this.nextTxSeq||frame.txSeq>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(frame.txSeq)||frame.chunkIndex<0||!Number.isSafeInteger(frame.chunkIndex)||frame.chunkIndex>=o.chunkHashes.length)fail();
  const length=Math.min(65536,o.size-frame.chunkIndex*65536);
  if(length<=0||frame.payload.length!==length||requestDigest(this.binding.jobId,this.binding.planDigest,'putChunk',{objectId:o.objectId,chunkIndex:frame.chunkIndex})!==frame.requestDigest)fail('REQUEST_CONFLICT');
  hex(frame.requestId,32);this.nextTxSeq++; // Recoverable admission failure consumes a validated sequence too.
  if(hash(frame.payload)!==o.chunkHashes[frame.chunkIndex])fail('HASH_MISMATCH');
  if(admissionError)throw admissionError; // Complete bounded payload was consumed and hash-checked first.
   const disposition=await store.commit(frame,o,()=>this.grant.check(token));this.grant.check(token);
   if(disposition!==1&&disposition!==2)fail('LOCAL_IO');
   // Same durable callback: enqueue a single fixed-layout ACK immediately.
   await emitAck({kind:'ack',streamId:frame.streamId,epoch:frame.epoch,ackSeq:this.nextAckSeq++,entries:[{txSeq:frame.txSeq,disposition}]});return 'ACK';
  }finally{this.busy=false;}
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
export function negativeReply(binding:JobBinding,frame:DataFrame,error:ResumeError):Envelope {
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
