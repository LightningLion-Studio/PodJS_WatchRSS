import type {SyncByteStream} from '../stream';
import {frameAllocationBytes,type ByteTransport} from './codec';
import {fail} from './wire';
/** One exact-frame owner after detachStream(). Reads never consume a tail owned
 * by another codec. Native idle deadlines and a 60s frame deadline are separate. */
export class BinaryByteTransport implements ByteTransport {
 private closed=false;private reading=false;private writing=false;
 private networkProgress?: (kind:'control'|'data'|'ack',streamId?:number,epoch?:number)=>void;
 constructor(private readonly stream:SyncByteStream,private readonly now=()=>performance.now(),private readonly progress?:(direction:'read'|'write',bytes:number)=>void){}
 setNetworkProgress(listener:(kind:'control'|'data'|'ack',streamId?:number,epoch?:number)=>void){this.networkProgress=listener;}
 private network(error:unknown):never{const e=error as {code?:string;message?:string};if(e?.code==='host_error'){
  if(/^(Stream operation timed out|.*[Ss]ocket.*timed out)$/.test(e.message??''))throw Error('SocketTimeout');
  if(/([Ss]ocket closed|[Ss]tream closed|Connection reset|[Bb]t socket closed)/.test(e.message??''))throw Error('reset');
 }throw error;}
 private async into(target:Uint8Array,deadline:()=>number,onBytes?:()=>void){let at=0;while(at<target.length){if(this.closed)fail('AUTH_REVOKED');const left=deadline()-this.now();if(left<=0)throw Error('SocketTimeout');const b=await this.stream.read(Math.min(65536,target.length-at),Math.max(1,Math.ceil(Math.min(30000,left)))).catch(e=>this.network(e));if(b===null)throw Error('EOF');if(!b.length||b.length>target.length-at)fail();target.set(b,at);at+=b.length;onBytes?.();this.progress?.('read',b.length);}}
 async readFrame(){
  if(this.closed||this.reading)fail('AUTH_REVOKED');this.reading=true;
  try{const prefix=new Uint8Array(4),idle=this.now()+30000;let started:number|undefined;const end=()=>started===undefined?idle:started+60000;
   await this.into(prefix,end,()=>{started??=this.now();});const frame=new Uint8Array(frameAllocationBytes(prefix));frame.set(prefix);await this.into(frame.subarray(4,16),end);
   const v=new DataView(frame.buffer),header=v.getUint32(12),payload=frame.length-16-header;
   if(frame[4]!==76||frame[5]!==66||frame[6]!==86||frame[7]!==50||frame[9]!==0||v.getUint16(10)!==0||payload<0)fail();
   if(frame[8]===1){if(payload!==0||header<1||header>131072)fail();const unit=()=>this.networkProgress?.('control');unit();await this.into(frame.subarray(16),end,unit);}
   else{const data=frame[8]===2;if(!data&&frame[8]!==3||data&&(header!==80||payload<1||payload>65536)||!data&&(payload!==0||header<48||header>544))fail();const fixed=data?96:48;if(frame.length<fixed)fail();await this.into(frame.subarray(16,fixed),end);const stream=v.getUint32(16),raw=v.getBigUint64(24);if((stream!==1&&stream!==2)||raw<1n||raw>BigInt(Number.MAX_SAFE_INTEGER))fail();const unit=()=>this.networkProgress?.(data?'data':'ack',stream,Number(raw));unit();await this.into(frame.subarray(fixed),end,unit);}
   return frame;
  }catch(e){this.close();throw e;}finally{this.reading=false;}
 }
 async writeFrame(bytes:Uint8Array){if(this.closed||this.writing)fail('AUTH_REVOKED');this.writing=true;try{for(let at=0;at<bytes.length;at+=65536){if(this.closed)fail('AUTH_REVOKED');const b=bytes.subarray(at,at+65536);await this.stream.write(b).catch(e=>this.network(e));this.progress?.('write',b.length);}}catch(e){this.close();throw e;}finally{this.writing=false;}}
 close(){if(this.closed)return;this.closed=true;void this.stream.close().catch(()=>{});}
}
