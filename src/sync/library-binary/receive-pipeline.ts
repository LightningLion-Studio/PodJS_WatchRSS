import {ContentSha256} from '@podjs/framework/content-sha256';
import type {AckFrame,DataHeader,DataReader} from './codec';
import type {ReceiveWindow} from './state';
import {CHUNK_BYTES,fail,hash,resumeError,type Limits,type ObjectDescriptor,type ResumeError} from './wire';

export interface ChunkWork {
 header:DataHeader;
 object:ObjectDescriptor;
 check():void;
}
type BufferedChunk=ChunkWork&{payload:Uint8Array};
type StagedChunk=ChunkWork&{disposition:1|2;readyAt:number};
interface ReceivePorts {
 live():void;
 now():number;
 admission(object:ObjectDescriptor):Promise<ResumeError|undefined>;
 stage(chunk:BufferedChunk):Promise<1|2>;
 commit(chunks:readonly StagedChunk[],check:()=>void):Promise<void>;
 ack(frame:AckFrame,started:()=>void):void;
 negative(header:DataHeader,error:ResumeError,started:()=>void):void;
 sleep(milliseconds:number):{result:Promise<void>;cancel():void};
 stale():void;
 stop(error:unknown):void;
}

/** One credit owns one pool block until staging and one header until its reply
 * starts writing. Reader, hash, stage and durable queues share that bound.
 */
export class ReceivePipeline {
 private readonly pool:Uint8Array[];
 private readonly pending=new Map<number,DataHeader>();
 private readonly scratch=new Uint8Array(4096);
 private readonly hashing:BufferedChunk[]=[];
 private readonly staging:BufferedChunk[]=[];
 private readonly durable:StagedChunk[]=[];
 private readonly groupSize:number;
 private hashScheduled=false;
 private stageWork?:Promise<void>;
 private commitWork?:Promise<void>;
 private timer?:{result:Promise<void>;cancel():void};
 private due=false;
 private closed=false;
 private bytes=0;

 constructor(private readonly window:ReceiveWindow,private readonly limits:Limits,private readonly ports:ReceivePorts){
  this.pool=Array.from({length:limits.maxInFlightChunks},()=>new Uint8Array(CHUNK_BYTES));
  this.groupSize=Math.min(4,limits.maxInFlightChunks);
 }

 get busy():boolean {return this.pending.size>0;}
 get working():boolean {
  return this.hashing.length>0||this.staging.length>0||this.durable.length>0||!!this.stageWork||!!this.commitWork;
 }
 private check(){if(this.closed)fail('AUTH_REVOKED');this.ports.live();}
 private release=(header:DataHeader)=>{
  if(this.pending.delete(header.txSeq))this.bytes-=header.payloadBytes;
 };
 private take(header:DataHeader){
  if(this.pending.size>=this.limits.maxInFlightChunks||this.bytes+header.payloadBytes>this.limits.maxInFlightBytes)fail('FLOW_CONTROL_VIOLATION');
  for(const p of this.pending.values())if(p.requestId===header.requestId||p.objectSlot===header.objectSlot&&p.chunkIndex===header.chunkIndex)fail('REQUEST_CONFLICT');
  this.pending.set(header.txSeq,header);this.bytes+=header.payloadBytes;
 }

 readonly read:DataReader=async(header,read)=>{
  if(this.closed){
   // The owner verifies the epoch during a regrant barrier.
   await this.drain(header,read);
   return;
  }
  this.check();
  const valid=await this.window.header(header);
  if(!valid){this.ports.stale();await this.drain(header,read);return;}
  const check=()=>{this.check();valid.check();};
  check();this.take(header);
  const denied=await this.ports.admission(valid.object);
  check();
  if(denied){
   await this.drain(header,read,valid.object.chunkHashes[header.chunkIndex]!);
   check();this.ports.negative(header,denied,()=>this.release(header));return;
  }
  const block=this.pool.pop();
  if(!block)fail('FLOW_CONTROL_VIOLATION');
  const payload=block.subarray(0,header.payloadBytes);
  await read(payload,true);
  check();
  this.hashing.push({header,object:valid.object,check,payload});
  this.hashNext();
 };

 async drain(header:DataHeader,read:Parameters<DataReader>[1],expected?:string){
  const digest=expected===undefined?undefined:new ContentSha256();
  for(let at=0;at<header.payloadBytes;){
   const part=this.scratch.subarray(0,Math.min(this.scratch.length,header.payloadBytes-at));
   await read(part);digest?.update(part);at+=part.length;
  }
  if(digest&&digest.finish()!==expected)fail('HASH_MISMATCH');
 }

 private hashNext(){
  if(this.hashScheduled||this.closed)return;
  this.hashScheduled=true;
  void Promise.resolve().then(()=>{
   let chunk:BufferedChunk|undefined;
   while(!this.closed&&(chunk=this.hashing.shift())){
    chunk.check();
    if(hash(chunk.payload)!==chunk.object.chunkHashes[chunk.header.chunkIndex])fail('HASH_MISMATCH');
    this.staging.push(chunk);this.stageNext();
   }
  }).catch(e=>this.failed(e)).finally(()=>{
   this.hashScheduled=false;if(this.hashing.length)this.hashNext();
  });
 }

 private stageNext(){
  if(this.stageWork||this.closed)return;
  const chunk=this.staging.shift();
  if(!chunk)return;
  const {header,object,check,payload}=chunk;
  this.stageWork=this.ports.stage(chunk).then(disposition=>{
   check();this.durable.push({header,object,check,disposition,readyAt:this.ports.now()});this.scheduleCommit();
  },e=>{
   if(this.closed)return;
   const error=resumeError(e);
   this.reject(header,error);
  }).catch(e=>this.failed(e)).finally(()=>{
   if(!this.closed)this.pool.push(new Uint8Array(payload.buffer));
   this.stageWork=undefined;this.stageNext();
  });
 }

 private scheduleCommit(){
  if(this.closed||!this.durable.length)return;
  if(this.durable.length>=this.groupSize||this.due){
   if(!this.commitWork)this.commitNext();
   return;
  }
  if(this.timer)return;
  const timer=this.ports.sleep(Math.max(0,this.durable[0]!.readyAt+20-this.ports.now()));this.timer=timer;
  void timer.result.then(()=>{
   if(this.timer!==timer||this.closed)return;
   this.timer=undefined;this.due=true;this.scheduleCommit();
  },e=>{if(this.timer===timer){this.timer=undefined;this.failed(e);}});
 }

 private commitNext(){
  const timer=this.timer;this.timer=undefined;timer?.cancel();this.due=false;
  const group=this.durable.splice(0,this.groupSize);
  const check=()=>{for(const chunk of group)chunk.check();};
  this.commitWork=this.ports.commit(group,check).then(()=>{
   check();
   const ack=this.window.ack(group[0]!.header.epoch,group.map(({header,disposition})=>({txSeq:header.txSeq,disposition})));
   this.ports.ack(ack,()=>{for(const chunk of group)this.release(chunk.header);});
  },e=>{
   if(!this.closed)this.reject(group[0]!.header,resumeError(e));
  }).catch(e=>this.failed(e)).finally(()=>{this.commitWork=undefined;this.scheduleCommit();});
 }

 private reject(header:DataHeader,error:ResumeError){
  this.ports.negative(header,error,()=>this.release(header));
  if(error.wire().recovery==='STOP')this.closed=true;
 }
 private failed(error:unknown){if(!this.closed)this.ports.stop(error);}
 fence():Promise<unknown>{
  this.closed=true;
  const timer=this.timer;this.timer=undefined;timer?.cancel();
  this.hashing.length=0;this.staging.length=0;this.durable.length=0;
  this.pending.clear();this.bytes=0;this.pool.length=0;
  return Promise.all([this.stageWork,this.commitWork]);
 }
}
