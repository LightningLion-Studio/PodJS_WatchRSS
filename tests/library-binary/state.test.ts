import {test,expect} from 'bun:test';
import {SendWindow,ReceiveWindow,Grant,RetryBackoff,TokenBucket,ControlSlots,planningHeartbeat,negativeReply} from '../../src/sync/library-binary/state';
import {requestDigest} from '../../src/sync/library-binary/digests';
import {ResumeError} from '../../src/sync/library-binary/wire';
import {binding,data,object,request,reply} from './helpers';
const ack=(seq=1,tx=1,epoch=1)=>({kind:'ack' as const,streamId:1 as const,epoch,ackSeq:seq,entries:[{txSeq:tx,disposition:1 as const}]});
const ctx={authenticated:true,beginAuthorized:true,admitted:false,state:'PLANNING',nextManifestPage:1,expiresAtMillis:30000};
test('window 1 retains exact byte credit until one atomic ACK settlement',()=>{
 const w=new SendWindow(binding,1),p=w.reserve(data());expect(w.credit).toEqual({chunks:1,bytes:3});expect(()=>w.reserve(data())).toThrow('WINDOW_FULL');
 expect(w.acceptAck(ack(),0)![0]!.pending.txSeq).toBe(p.txSeq);expect(w.credit).toEqual({chunks:0,bytes:0});const next=w.reserve(data());expect(next.txSeq).toBe(2);
 expect(w.acceptAck(ack(),0)).toBeNull();expect(w.credit.bytes).toBe(3);expect(w.acceptAck(ack(2,2),0)).not.toBeNull();
});
for(const bad of [ack(2),ack(1,2),ack(1,1,2),{...ack(),entries:[{txSeq:1,disposition:1 as const},{txSeq:2,disposition:1 as const}]}])test('unmatched/oversized S2 ACK is STOP '+JSON.stringify(bad),()=>{const w=new SendWindow(binding,1);w.reserve(data());expect(()=>w.acceptAck(bad,0)).toThrow();expect(w.credit.bytes).toBe(0);});
for(const code of ['WINDOW_FULL','BUSY','MANIFEST_INCOMPLETE','CHUNKS_MISSING','LEASE_EXPIRED','SOURCE_CHANGED','HASH_MISMATCH'])test('negative reply settles once, preserves operation identity: '+code,()=>{
 const w=new SendWindow(binding,1),p=w.reserve(data()),r=negativeReply(binding,p,new ResumeError(code));const result=w.negative(r,0)!;expect(w.credit.bytes).toBe(0);expect(result.pending.requestId).toBe(p.requestId);
 if(['WAIT','QUERY','BEGIN'].includes(result.action)){if(result.action==='BEGIN')w.regrant(2);const next=w.reserve(p);expect(next.requestId).toBe(p.requestId);expect(next.requestDigest).toBe(p.requestDigest);expect(next.txSeq).toBe(result.action==='BEGIN'?1:2);}else expect(()=>w.reserve(p)).toThrow('AUTH_REVOKED');
});
test('negative reply must match job/plan/epoch/request ID/digest; stale epoch never releases credit',()=>{
 for(const key of ['jobId','planDigest','requestId','requestDigest']){const w=new SendWindow(binding,1),p=w.reserve(data()),r=negativeReply(binding,p,new ResumeError('BUSY'));(r as any)[key]='f'.repeat(key.endsWith('Id')?32:64);expect(()=>w.negative(r,0)).toThrow();expect(w.credit.bytes).toBe(0);}
 const w=new SendWindow(binding,1),p=w.reserve(data()),old=negativeReply(binding,p,new ResumeError('BUSY'));w.regrant(2);w.reserve(data());expect(w.negative(old,0)).toBeNull();expect(w.credit.bytes).toBe(3);
});
test('disconnect clears temporary credit; fresh epoch restarts both sequences',()=>{
 const w=new SendWindow(binding,1);w.reserve(data());w.close();expect(w.credit.bytes).toBe(0);expect(()=>w.reserve(data())).toThrow();
 const r=new SendWindow(binding,1);r.regrant(2);expect(r.reserve(data()).txSeq).toBe(1);expect(r.acceptAck(ack(1,1,1),0)).toBeNull();expect(r.credit.bytes).toBe(3);expect(r.acceptAck(ack(1,1,2),0)).not.toBeNull();
});
test('stale ACK rate has independent bounded budget and no settlement',()=>{
 const w=new SendWindow(binding,1);w.regrant(2);w.reserve(data());for(let i=0;i<32;i++)expect(w.acceptAck(ack(1,1,1),0)).toBeNull();expect(()=>w.acceptAck(ack(1,1,1),0)).toThrow('RATE_LIMITED');expect(w.credit.bytes).toBe(0);
});
test('20 STATE retries use new txSeq with stable requestId/digest, no arbitrary retry ceiling',()=>{
 const w=new SendWindow(binding,1),backoff=new RetryBackoff(),bucket=new TokenBucket(8,4);let now=0;
 for(let i=0;i<20;i++){bucket.take(now);const p=w.reserve(data());expect(p.txSeq).toBe(i+1);expect(w.negative(negativeReply(binding,p,new ResumeError('WINDOW_FULL')),now)!.action).toBe('WAIT');now+=backoff.next(100);}
 expect([new RetryBackoff().next(900),backoff.next(1)]).toEqual([900,1000]);backoff.reset();expect(backoff.next(0)).toBe(100);
});
function receiver(){const o=object(),grant=new Grant('c1',1),r=new ReceiveWindow(binding,grant,{objectCount:1,at:async slot=>slot===0?o:null});r.admit();const frame={...data(),requestDigest:requestDigest(binding.jobId,binding.planDigest,'putChunk',{objectId:o.objectId,chunkIndex:0})};return {o,grant,r,frame};}
test('receiver ACK only after durable commit and immediately at callback; replay validates bytes',async()=>{
 const {r,frame}=receiver(),events:string[]=[];let commits=0;
 const store={commit:async()=>{events.push('durable');commits++;return 1 as const;}};
 await r.receive(frame,store,async a=>{events.push('ACK');expect(a.entries).toEqual([{txSeq:1,disposition:1}]);});expect(events).toEqual(['durable','ACK']);
 await expect(r.receive({...frame,txSeq:2,payload:new Uint8Array([97,98,100])},store,async()=>{})).rejects.toThrow('HASH_MISMATCH');expect(commits).toBe(1);
});
test('recoverable admission failure hashes bytes first, consumes seq and does not ACK',async()=>{
 const {r,frame}=receiver();let acks=0;const store={commit:async()=>1 as const},emit=async()=>{acks++;};
 await expect(r.receive(frame,store,emit,new ResumeError('WINDOW_FULL'))).rejects.toThrow('WINDOW_FULL');expect(acks).toBe(0);
 await expect(r.receive({...frame,txSeq:2},store,emit)).resolves.toBe('ACK');expect(acks).toBe(1);
 const b=receiver();await expect(b.r.receive({...b.frame,payload:new Uint8Array([0,0,0])},store,emit,new ResumeError('WINDOW_FULL'))).rejects.toThrow('HASH_MISMATCH');
});
test('duplicate/jumped txSeq, bad locator/length/digest STOP before durable commit',async()=>{
 for(const bad of [{txSeq:0},{txSeq:2},{objectSlot:1},{chunkIndex:1},{payload:new Uint8Array([1])},{requestDigest:'a'.repeat(64)}]){const {r,frame}=receiver();let calls=0;await expect(r.receive({...frame,...bad},{commit:async()=>{calls++;return 1;}},async()=>{})).rejects.toThrow();expect(calls).toBe(0);}
});
test('old async durable callback cannot commit or ACK after fence',async()=>{
 const {r,grant,frame}=receiver();let proceed!:()=>void,check!:()=>void;let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});const pending=r.receive(frame,{commit:async(_f,_o,c)=>{check=c;await new Promise<void>(resolve=>{proceed=resolve;started();});c();return 1;}},async()=>{throw Error('late ACK');});await entered;grant.fence();expect(()=>check()).toThrow('AUTH_REVOKED');proceed();await expect(pending).rejects.toThrow('AUTH_REVOKED');
});
test('PLANNING missing0 uses reserved slot while business manifest is occupied',()=>{
 const s=new ControlSlots(binding),m=request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:'a'.repeat(64),entries:[]}),h=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0});
 s.begin(m,ctx);s.begin(h,ctx);expect(()=>s.begin(h,ctx)).toThrow('BUSY');const result=planningHeartbeat(h,ctx);expect(result).toEqual({state:'PLANNING',nextManifestPage:1,expiresAtMillis:30000,items:[],next:null,done:true,completion:null});s.settle(reply(h,result));
 expect(()=>s.begin(request('missing',{afterObjectId:null,afterChunkIndex:null,limit:1}),ctx)).toThrow('MANIFEST_INCOMPLETE');
 for(const c of [{...ctx,authenticated:false},{...ctx,beginAuthorized:false}])expect(()=>planningHeartbeat(h,c)).toThrow('AUTH_REVOKED');
 expect(()=>s.settle(reply(h,result))).toThrow('REQUEST_CONFLICT');
});
test('txSeq safe-integer exhaustion closes stream and requests reconnect without wrap',()=>{
 const w=new SendWindow(binding,1);(w as unknown as {nextTxSeq:number}).nextTxSeq=Number.MAX_SAFE_INTEGER;const p=w.reserve(data());expect(p.txSeq).toBe(Number.MAX_SAFE_INTEGER);w.acceptAck(ack(1,p.txSeq),0);expect(()=>w.reserve(data())).toThrow('TXSEQ_EXHAUSTED');expect(w.credit.bytes).toBe(0);expect(()=>w.reserve(data())).toThrow('AUTH_REVOKED');
});
test('duplicate negative without matching pending is STOP and cannot release credit twice',()=>{
 const w=new SendWindow(binding,1),p=w.reserve(data()),r=negativeReply(binding,p,new ResumeError('BUSY'));w.negative(r,0);expect(()=>w.negative(r,100)).toThrow();expect(w.credit.bytes).toBe(0);
});
test('two streams share the connection-wide stale ACK budget',()=>{
 const budget=new TokenBucket(32,16),a=new SendWindow(binding,1,0,budget),b=new SendWindow({...binding,streamId:2},1,0,budget);a.regrant(2);b.regrant(2);
 for(let i=0;i<16;i++){a.acceptAck(ack(1,1,1),0);b.acceptAck({...ack(1,1,1),streamId:2},0);}expect(()=>b.acceptAck({...ack(1,1,1),streamId:2},0)).toThrow('RATE_LIMITED');
});
test('apply response binds the receipt to pending object/request and authenticated receiver',async()=>{
 const {appliedReceipt}=await import('../../src/sync/library-binary/digests'),p=request('apply',{objectId:'a'.repeat(64)}),context={...ctx,admitted:true,state:'READY'};
 for(const receiver of ['watch','other']){const slots=new ControlSlots(binding,'watch');slots.begin(p,context);const response=reply(p,{state:'APPLIED',receipt:appliedReceipt(p,String(p.payload!.objectId),receiver,'merged')});if(receiver==='watch')slots.settle(response);else expect(()=>slots.settle(response)).toThrow('RECEIPT_CONFLICT');}
 const slots=new ControlSlots(binding,'watch');slots.begin(p,context);const response=reply(p,{state:'APPLIED',receipt:appliedReceipt({...p,requestId:'f'.repeat(32)},String(p.payload!.objectId),'watch','merged')});expect(()=>slots.settle(response)).toThrow('RECEIPT_CONFLICT');
});
test('complete response cannot substitute a self-consistent but different receipt root',async()=>{
 const {completion}=await import('../../src/sync/library-binary/digests'),slots=new ControlSlots(binding),p=request('complete',{objectCount:1,receiptsRoot:'a'.repeat(64),ackToInclusive:0});slots.begin(p,{...ctx,admitted:true,state:'READY'});
 expect(()=>slots.settle(reply(p,completion(binding.jobId,binding.planDigest,1,'b'.repeat(64),0) as unknown as Record<string,unknown>))).toThrow('RECEIPT_CONFLICT');
});
test('DATA before native index/peak admission is STOP, without a retryable unconsumed sequence',async()=>{
 const o=object(),grant=new Grant('c',1),token=grant.token(),window=new ReceiveWindow(binding,grant,{objectCount:1,at:async()=>o});let commits=0;
 await expect(window.receive(data(),{commit:async()=>{commits++;return 1;}},async()=>{})).rejects.toThrow('FLOW_CONTROL_VIOLATION');expect(commits).toBe(0);expect(()=>grant.check(token)).toThrow('AUTH_REVOKED');
});
test('only the current pending ACK sequence can refresh partial-frame activity',()=>{
 const w=new SendWindow(binding,1);expect(w.acceptsAckProgress(1,1)).toBe(false);w.reserve(data());
 expect(w.acceptsAckProgress(1,1)).toBe(true);expect(w.acceptsAckProgress(0,1)).toBe(false);expect(w.acceptsAckProgress(2,1)).toBe(false);expect(w.acceptsAckProgress(1,2)).toBe(false);
 w.acceptAck(ack(),0);expect(w.acceptsAckProgress(1,1)).toBe(false);w.reserve(data());expect(w.acceptsAckProgress(1,1)).toBe(false);expect(w.acceptsAckProgress(1,2)).toBe(true);
 w.regrant(2);expect(w.acceptsAckProgress(2,1)).toBe(false);w.reserve(data());expect(w.acceptsAckProgress(1,2)).toBe(false);expect(w.acceptsAckProgress(2,1)).toBe(true);w.close();expect(w.acceptsAckProgress(2,1)).toBe(false);
});

test('S3 settles selective durable ACKs and a negative reply independently',()=>{
 const w=new SendWindow(binding,1,0,undefined,{maxInFlightChunks:8,maxInFlightBytes:524288});
 const frames=Array.from({length:8},(_,chunkIndex)=>w.reserve({...data(),chunkIndex,requestId:chunkIndex.toString(16).padStart(32,'0'),payload:new Uint8Array(65536)}));
 expect(w.credit).toEqual({chunks:8,bytes:524288});
 expect(w.canSend(1)).toBe(false);
 const first={...ack(),entries:[{txSeq:1,disposition:1 as const},{txSeq:3,disposition:2 as const}]};
 expect(w.acceptAck(first,0)?.map(x=>x.pending.txSeq)).toEqual([1,3]);
 expect(w.acceptAck(first,0)).toBeNull();
 expect(w.negative(negativeReply(binding,frames[1]!,new ResumeError('BUSY')),0)?.pending.txSeq).toBe(2);
 const retried=w.reserve({...data(),chunkIndex:1,requestId:frames[1]!.requestId,payload:new Uint8Array(65536)});
 expect(retried.txSeq).toBe(9);
 expect(w.credit).toEqual({chunks:6,bytes:393216});
 expect(()=>w.acceptAck({...ack(2),entries:[{txSeq:4,disposition:1},{txSeq:10,disposition:1}]},0)).toThrow();
 expect(w.credit).toEqual({chunks:0,bytes:0});
});

test('ACK and negative responses STOP for a never-granted older epoch',()=>{
 for(const first of [1,3]){
  for(const kind of ['ack','negative'] as const){
   const w=new SendWindow(binding,first);if(first===1)w.regrant(3);
   const current=w.reserve(data());
   const settle=kind==='ack'?()=>w.acceptAck(ack(1,current.txSeq,2),0):
    ()=>w.negative(negativeReply(binding,{...current,epoch:2},new ResumeError('BUSY')),0);
   expect(settle).toThrow('STALE_EPOCH');expect(w.credit.chunks).toBe(0);
  }
 }
});

test('native send settlement hands back a contiguous cursor and epoch reset',()=>{
 const window=new SendWindow(binding,1);
 expect(window.nativeCursor()).toEqual({tx:0,ack:0});
 window.acceptNativeCursor(8,2);
 expect(window.reserve(data()).txSeq).toBe(9);
 expect(()=>window.nativeCursor()).toThrow('BUSY');
 expect(window.acceptAck(ack(2,8),0)).toBeNull();
 expect(window.acceptAck(ack(3,9),0)![0]!.pending.txSeq).toBe(9);
 window.regrant(2);
 expect(window.nativeCursor()).toEqual({tx:0,ack:0});
 expect(window.reserve(data()).txSeq).toBe(1);
});
