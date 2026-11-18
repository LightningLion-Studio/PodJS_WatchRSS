import {decodeFrame,encodeFrame,encodeDataHeader,type ByteTransport,type Frame,type OutgoingData,type DataReader} from './codec';
import {fail,HARD_LIMITS,ResumeError,type Limits} from './wire';
import {SwitchGate} from './routing';
import {Grant,TokenBucket} from './state';

interface Queued {
 kind:number;bytes?:Uint8Array;data?:()=>OutgoingData|null;receiveEpoch?:number;
 started?:()=>void;done:()=>void;reject:(e:unknown)=>void;
}
/** One reader and one writer; complete frames never interleave. Durable ACK,
 * negative replies and heartbeat replies bypass ordinary DATA/control work.
 * The RFCOMM coordinator owns this connection after the switch write barrier.
 */
export class BinaryConnection {
 private high:Queued[]=[];private normal:Queued[]=[];private writing=false;private reading=false;private closed=false;
 private readonly controlBudget:TokenBucket;private readonly ackBudget:TokenBucket;
 readonly staleAckBudget:TokenBucket;
 private queuedControlBytes=0;private queuedControls=0;
 constructor(private readonly gate:SwitchGate,private readonly io:ByteTransport,private readonly grant:Grant,private readonly now:()=>number,private readonly limits:Pick<Limits,'maxFrameBytes'|'maxControlHeaderBytes'>=HARD_LIMITS){
  gate.requireBinary();this.staleAckBudget=new TokenBucket(32,16,now());this.controlBudget=new TokenBucket(128,64,now());this.ackBudget=new TokenBucket(256,128,now());
 }
 read():Promise<Frame>;
 read(readData:DataReader):Promise<Frame|null>;
 async read(readData?:DataReader):Promise<Frame|null> {
  this.check();if(this.reading)fail('BUSY');this.reading=true;
  try{
   const bytes=await this.io.readFrame(readData);this.check();if(!bytes)return null;
   if(bytes[8]===3)this.ackBudget.take(this.now());if(bytes[8]===1)this.controlBudget.take(this.now());
   const frame=decodeFrame(bytes,this.limits.maxFrameBytes);if(frame.kind==='control'&&bytes.length-16>this.limits.maxControlHeaderBytes)fail('LIMIT_EXCEEDED');return frame;
  }catch(e){this.close();throw e;}finally{this.reading=false;}
 }
 write(frame:Frame,priority:'ordinary'|'urgent'='ordinary',started?:()=>void,receiveEpoch?:number):Promise<void> {
  this.check();const bytes=encodeFrame(frame),control=frame.kind==='control';
  const urgent=frame.kind==='ack'||control&&(frame.envelope.success===false||frame.envelope.phase==='cancel'||frame.envelope.phase==='missing'&&frame.envelope.type==='response'&&(frame.envelope.result?.items as unknown[]|undefined)?.length===0)||priority==='urgent';
  if(bytes.length-4>this.limits.maxFrameBytes||control&&bytes.length-16>this.limits.maxControlHeaderBytes)fail('LIMIT_EXCEEDED');
  if(frame.kind==='data'&&this.normal.some(q=>q.kind===2))fail('LIMIT_EXCEEDED');
  if(frame.kind==='ack'&&this.high.filter(q=>q.kind===3).length>=HARD_LIMITS.maxInFlightChunks)fail('LIMIT_EXCEEDED');
  if(control&&(this.queuedControls>=(urgent?8:6)||this.queuedControlBytes+bytes.length-16>1048576))fail('LIMIT_EXCEEDED');
  if(control){this.queuedControls++;this.queuedControlBytes+=bytes.length-16;}
  return this.enqueue({kind:bytes[8]!,bytes,started,receiveEpoch},urgent);
 }
 writeData(data:()=>OutgoingData|null):Promise<void>{
  this.check();
  if(this.normal.some(q=>q.kind===2))fail('LIMIT_EXCEEDED');
  return this.enqueue({kind:2,data},false);
 }
 private enqueue(frame:Omit<Queued,'done'|'reject'>,urgent:boolean):Promise<void>{
  const result=new Promise<void>((done,reject)=>{(urgent?this.high:this.normal).push({...frame,done,reject});});
  void this.flush();return result;
 }
 discardReceiveEpoch(epoch:number):void{
  this.high=this.high.filter(q=>{
   if(q.receiveEpoch!==epoch)return true;
   this.dequeued(q);q.reject(new ResumeError('STALE_EPOCH'));return false;
  });
 }
 private dequeued(q:Queued){
  if(q.kind===1){this.queuedControls--;this.queuedControlBytes-=q.bytes!.length-16;}
 }
 private check():void {if(this.closed)fail('AUTH_REVOKED');this.gate.requireBinary();this.grant.check(this.grant.token());}
 private async flush():Promise<void> {
  if(this.writing||this.closed)return;this.writing=true;
  try{
   for(;;){const q=this.high.shift()??this.normal.shift();if(!q)break;
    this.dequeued(q);
    try{
     this.check();
     const data=q.data?.();
     if(q.data&&!data){q.done();continue;}
     if(data&&!(data.payload instanceof Uint8Array)){
      if(!this.io.writeFile||data.payload.length+92>this.limits.maxFrameBytes)fail('CAPABILITY_MISMATCH');
      await this.io.writeFile(encodeDataHeader(data),data.payload);
     }else{
      const bytes=data?encodeFrame({...data,payload:data.payload as Uint8Array}):q.bytes!;
      if(bytes.length-4>this.limits.maxFrameBytes)fail('LIMIT_EXCEEDED');
      q.started?.();await this.io.writeFrame(bytes);
     }
     this.check();q.done();
    }catch(e){q.reject(e);this.close();break;}
   }
  }finally{this.writing=false;}
 }
 close():void {
  if(this.closed)return;this.closed=true;this.grant.fence();this.gate.close();
  const pending=[...this.high,...this.normal];this.high=[];this.normal=[];this.queuedControls=0;this.queuedControlBytes=0;
  for(const q of pending)q.reject(new Error('AUTH_REVOKED'));this.io.close();
 }
}
