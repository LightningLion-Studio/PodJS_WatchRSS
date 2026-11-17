import {decodeFrame,encodeFrame,type ByteTransport,type Frame} from './codec';
import {fail,HARD_LIMITS,type Limits} from './wire';
import {SwitchGate} from './routing';
import {Grant,TokenBucket} from './state';

interface Queued {bytes:Uint8Array;done:()=>void;reject:(e:unknown)=>void}
/** One reader and one writer; complete frames never interleave. Durable ACK,
 * negative replies and heartbeat replies bypass ordinary DATA/control work.
 * This class has no production caller until the S1 integration card.
 */
export class BinaryConnection {
 private high:Queued[]=[];private normal:Queued[]=[];private writing=false;private reading=false;private closed=false;
 private readonly controlBudget:TokenBucket;private readonly ackBudget:TokenBucket;
 readonly staleAckBudget:TokenBucket;
 private queuedControlBytes=0;private queuedControls=0;
 constructor(private readonly gate:SwitchGate,private readonly io:ByteTransport,private readonly grant:Grant,private readonly now:()=>number,private readonly limits:Pick<Limits,'maxFrameBytes'|'maxControlHeaderBytes'>=HARD_LIMITS){
  gate.requireBinary();this.staleAckBudget=new TokenBucket(32,16,now());this.controlBudget=new TokenBucket(128,64,now());this.ackBudget=new TokenBucket(256,128,now());
 }
 async read():Promise<Frame> {
  this.check();if(this.reading)fail('BUSY');this.reading=true;
  try{
   const bytes=await this.io.readFrame();this.check();
   if(bytes[8]===3)this.ackBudget.take(this.now());if(bytes[8]===1)this.controlBudget.take(this.now());
   const frame=decodeFrame(bytes,this.limits.maxFrameBytes);if(frame.kind==='control'&&bytes.length-16>this.limits.maxControlHeaderBytes)fail('LIMIT_EXCEEDED');return frame;
  }catch(e){this.close();throw e;}finally{this.reading=false;}
 }
 write(frame:Frame,priority:'ordinary'|'urgent'='ordinary'):Promise<void> {
  this.check();const bytes=encodeFrame(frame),control=frame.kind==='control';
  const urgent=frame.kind==='ack'||control&&(frame.envelope.success===false||frame.envelope.phase==='cancel'||frame.envelope.phase==='missing'&&frame.envelope.type==='response'&&(frame.envelope.result?.items as unknown[]|undefined)?.length===0)||priority==='urgent';
  if(bytes.length-4>this.limits.maxFrameBytes||control&&bytes.length-16>this.limits.maxControlHeaderBytes)fail('LIMIT_EXCEEDED');
  if(frame.kind==='ack'&&this.high.filter(q=>q.bytes[8]===3).length>=2)fail('LIMIT_EXCEEDED');
  if(control&&(this.queuedControls>=(urgent?8:6)||this.queuedControlBytes+bytes.length-16>1048576)||frame.kind==='data'&&this.normal.some(q=>q.bytes[8]===2))fail('LIMIT_EXCEEDED');
  if(control){this.queuedControls++;this.queuedControlBytes+=bytes.length-16;}
  const result=new Promise<void>((done,reject)=>{(urgent?this.high:this.normal).push({bytes,done,reject});});
  void this.flush();return result;
 }
 private check():void {if(this.closed)fail('AUTH_REVOKED');this.gate.requireBinary();this.grant.check(this.grant.token());}
 private async flush():Promise<void> {
  if(this.writing||this.closed)return;this.writing=true;
  try{
   for(;;){const q=this.high.shift()??this.normal.shift();if(!q)break;
    if(q.bytes[8]===1){this.queuedControls--;this.queuedControlBytes-=q.bytes.length-16;}
    try{this.check();await this.io.writeFrame(q.bytes);this.check();q.done();}catch(e){q.reject(e);this.close();break;}
   }
  }finally{this.writing=false;}
 }
 close():void {
  if(this.closed)return;this.closed=true;this.grant.fence();this.gate.close();
  const pending=[...this.high,...this.normal];this.high=[];this.normal=[];this.queuedControls=0;this.queuedControlBytes=0;
  for(const q of pending)q.reject(new Error('AUTH_REVOKED'));this.io.close();
 }
}
