import type {SyncByteStream} from '../stream';
import {decodeDataHeader,frameAllocationBytes,type ByteTransport,type DataReader,type SourceFileRange,type SourceFileChunk,type InputFileChunk} from './codec';
import {fail,utf8} from './wire';
import {utf8ToString} from '@podjs/framework/bytes';
import type {HostSyncByteStream} from '../rfcomm';
/** One exact-frame owner after detachStream(). Reads never consume a tail owned
 * by another codec. Native idle deadlines and a 60s frame deadline are separate. */
export interface FileStream extends SyncByteStream {
 claimBinary?():Promise<void>;
 openFramed?:HostSyncByteStream['openFramed'];
 write(bytes:Uint8Array,timeoutMs?:number):Promise<void>;
 prepareFile?(range:SourceFileRange):Promise<SourceFileChunk>;
 readFile?(size:number,timeoutMs:number,retain:boolean,sha256?:string):Promise<InputFileChunk|undefined>;
 writeFile?(header:Uint8Array,chunk:SourceFileChunk,timeoutMs:number):Promise<void>;
 dropFile?(reference:string):Promise<void>;
}
export type NativeFramePort=NonNullable<Awaited<ReturnType<HostSyncByteStream['openFramed']>>>;
export class BinaryByteTransport implements ByteTransport {
 private activate=false;
 private revocation?:Promise<void>;
 waitRevoked(){return this.revocation??Promise.resolve();}
 private rejected?:number;
 settleNativeRejection(sequence:number){this.rejected=sequence;}
 activateReceive(){this.activate=true;}
 private closed=false;private reading=false;private writing=false;
 private networkProgress?: (kind:'control'|'data'|'ack',streamId?:number,epoch?:number,sequence?:number)=>void;
 constructor(private readonly stream:FileStream,private readonly now=()=>performance.now(),private readonly progress?:(direction:'read'|'write',bytes:number)=>void,readonly native?:NativeFramePort){}
 setNetworkProgress(listener:(kind:'control'|'data'|'ack',streamId?:number,epoch?:number,sequence?:number)=>void){this.networkProgress=listener;}
 private network(error:unknown):never{const e=error as {code?:string;message?:string};if(e?.code==='host_error'){
  if(/^(Stream operation timed out|.*[Ss]ocket.*timed out)$/.test(e.message??''))throw Error('SocketTimeout');
  if(/([Ss]ocket closed|[Ss]tream closed|Connection reset|[Bb]t socket closed)/.test(e.message??''))throw Error('reset');
 }throw error;}
 private async into(target:Uint8Array,deadline:()=>number,onBytes?:()=>void){let at=0;while(at<target.length){if(this.closed)fail('AUTH_REVOKED');const left=deadline()-this.now();if(left<=0)throw Error('SocketTimeout');const b=await this.stream.read(Math.min(65536,target.length-at),Math.max(1,Math.ceil(Math.min(30000,left)))).catch(e=>this.network(e));if(b===null)throw Error('EOF');if(!b.length||b.length>target.length-at)fail();target.set(b,at);at+=b.length;onBytes?.();this.progress?.('read',b.length);}}
 readFrame():Promise<Uint8Array>;
 readFrame(readData:DataReader):Promise<Uint8Array|null>;
 async readFrame(readData?:DataReader):Promise<Uint8Array|null>{
  if(this.closed||this.reading)fail('AUTH_REVOKED');this.reading=true;
  try{
   const fixed=new Uint8Array(96),prefix=fixed.subarray(0,4),idle=this.now()+30000;
   let started:number|undefined;const end=()=>started===undefined?idle:started+60000;
   let rejection:string|undefined;
   if(this.native){
    const next=await this.native.next().catch(e=>this.network(e));
    if(next.kind===1){
     const bytes=utf8(next.control!),frame=new Uint8Array(16+bytes.length),view=new DataView(frame.buffer);
     view.setUint32(0,12+bytes.length);view.setUint32(4,0x4c425632);frame[8]=1;view.setUint32(12,bytes.length);
     frame.set(bytes,16);this.networkProgress?.('control');return frame;
    }
    if(next.kind===3){
     const frame=Uint8Array.from(next.bytes!),view=new DataView(frame.buffer);
     this.networkProgress?.('ack',view.getUint32(16),Number(view.getBigUint64(24)),Number(view.getBigUint64(32)));
     return frame;
    }
    fixed.set(next.bytes!);
    rejection=next.error;
    started=this.now();
   }else{
    await this.into(prefix,end,()=>{started??=this.now();});
    await this.into(fixed.subarray(4,16),end);
   }
   const length=frameAllocationBytes(prefix);
   const v=new DataView(fixed.buffer),header=v.getUint32(12),payload=length-16-header;
   if(fixed[4]!==76||fixed[5]!==66||fixed[6]!==86||fixed[7]!==50||fixed[9]!==0||v.getUint16(10)!==0||payload<0)fail();
   if(fixed[8]===2){
    if(header!==80||payload<1||payload>65536)fail();
    if(!this.native)await this.into(fixed.subarray(16),end);
    const data={...decodeDataHeader(fixed,payload),payloadBytes:payload};
    const unit=()=>this.networkProgress?.('data',data.streamId,data.epoch,data.txSeq);
    if(readData){
     if(rejection){await readData(data,async()=>fail(),undefined,rejection);return null;}
     let left=payload;
     await readData(data,async(target,activity)=>{
      if(!target.length||target.length>left)fail();
      left-=target.length;if(activity)unit();
      await this.into(target,end,activity?unit:undefined);
     },this.stream.readFile?async(retain,sha256)=>{
      if(left!==payload)fail();
      const deadline=end()-this.now();if(deadline<=0)throw Error('SocketTimeout');
      left=0;if(retain)unit();
      const result=await this.stream.readFile!(payload,Math.ceil(Math.min(30000,deadline)),retain,sha256).catch(e=>this.network(e));
      this.progress?.('read',payload);return result;
     }:undefined);
     if(left)fail();
     return null;
    }
    const frame=new Uint8Array(length);frame.set(fixed);
    unit();await this.into(frame.subarray(96),end,unit);return frame;
   }
   const frame=new Uint8Array(length);frame.set(fixed.subarray(0,16));
   if(fixed[8]===1){
    if(payload!==0||header<1||header>131072)fail();
    const unit=()=>this.networkProgress?.('control');unit();await this.into(frame.subarray(16),end,unit);
   }else{
    if(fixed[8]!==3||payload!==0||header<48||header>544)fail();
    await this.into(frame.subarray(16,48),end);
    const view=new DataView(frame.buffer),stream=view.getUint32(16),epoch=view.getBigUint64(24),seq=view.getBigUint64(32);
    if((stream!==1&&stream!==2)||epoch<1n||epoch>BigInt(Number.MAX_SAFE_INTEGER)||seq<1n||seq>BigInt(Number.MAX_SAFE_INTEGER))fail();
    const unit=()=>this.networkProgress?.('ack',stream,Number(epoch),Number(seq));unit();
    await this.into(frame.subarray(48),end,unit);
   }
   return frame;
  }catch(e){this.close();throw e;}finally{this.reading=false;}
 }
 async prepareFile(range:SourceFileRange){
  if(this.closed||!this.stream.prepareFile)fail('CAPABILITY_MISMATCH');
  return this.stream.prepareFile(range);
 }
 async dropFile(chunk:{reference:string}){await this.stream.dropFile?.(chunk.reference);}
 async writeFile(header:Uint8Array,chunk:SourceFileChunk){
  if(this.closed||this.writing||!this.stream.writeFile)fail('AUTH_REVOKED');
  this.writing=true;
  try{await this.stream.writeFile(header,chunk,60000).catch(e=>this.network(e));this.progress?.('write',header.length+chunk.length);}
  catch(e){this.close();throw e;}finally{this.writing=false;}
 }
 async writeFrame(bytes:Uint8Array){
  if(this.closed||this.writing)fail('AUTH_REVOKED');this.writing=true;
  const deadline=this.now()+60000;
  try{
   if(this.native){
    if(bytes[8]===1){
     const activate=this.activate,rejected=this.rejected;this.activate=false;this.rejected=undefined;
     await this.native.control(utf8ToString(bytes.subarray(16)),activate,rejected);
    }
    else if(bytes[8]===3)await this.native.ack(bytes);
    else await this.native.data(bytes.subarray(0,96),bytes.subarray(96));
    return;
   }
   for(let at=0;at<bytes.length;at+=65536){
    if(this.closed)fail('AUTH_REVOKED');
    const left=deadline-this.now();if(left<=0)throw Error('SocketTimeout');
    const b=bytes.subarray(at,at+65536);
    await this.stream.write(b,Math.max(1,Math.ceil(Math.min(30000,left)))).catch(e=>this.network(e));this.progress?.('write',b.length);
   }
  }catch(e){this.close();throw e;}finally{this.writing=false;}
 }
 close(){
  if(this.closed)return;
  this.closed=true;
  if(this.native){
   this.revocation=this.native.revoke().finally(()=>this.stream.close());
   void this.revocation.catch(()=>{});
  }else void this.stream.close().catch(()=>{});
 }
}
