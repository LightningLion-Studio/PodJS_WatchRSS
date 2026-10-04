import {decodeFrame,encodeFrame,MAX_FRAME_BYTES,type JsonObject} from './protocol.ts';
import type {SyncFrameConnection} from './session.ts';
export interface SyncByteStream {
 /** Return at most maxBytes; null is EOF. Empty reads are not progress. */
 read(maxBytes:number,timeoutMs:number):Promise<Uint8Array|null>;
 /** Resolve only after all bytes have been handed to the transport. */
 write(bytes:Uint8Array):Promise<void>;
 close():Promise<void>;
}
/** A bounded, single-reader connection. Read deadlines cover the entire frame,
 * so a peer cannot extend a deadline by sending one byte at a time. */
export class StreamFrameConnection implements SyncFrameConnection {
 private closed=false;
 private reading=false;
 private writing=false;
 constructor(private readonly stream:SyncByteStream,private readonly now=Date.now){}
 async readFrame(timeoutMs:number):Promise<JsonObject>{
  if(this.closed)throw new Error('Sync connection closed');if(this.reading)throw new Error('Concurrent sync frame reads');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Invalid sync read deadline');
  this.reading=true;const deadline=this.now()+timeoutMs;
  try{
   const header=new Uint8Array(4);await this.readInto(header,deadline);
   const length=new DataView(header.buffer).getInt32(0,false);if(length<1||length>MAX_FRAME_BYTES)throw new Error('Sync frame length out of range');
   const frame=new Uint8Array(length+4);frame.set(header);await this.readInto(frame.subarray(4),deadline);return decodeFrame(frame);
  }catch(error){await this.close();throw error;}finally{this.reading=false;}
 }
 private async readInto(target:Uint8Array,deadline:number):Promise<void>{
  let offset=0;
  while(offset<target.length){
   if(this.closed)throw new Error('Sync connection closed');const remaining=deadline-this.now();if(remaining<=0)throw new Error('Sync frame read timed out');
   const max=Math.min(64*1024,target.length-offset),bytes=await this.stream.read(max,remaining);
   if(this.closed)throw new Error('Sync connection closed');if(this.now()>deadline)throw new Error('Sync frame read timed out');
   if(bytes===null)throw new Error('Truncated sync stream');if(!bytes.length)throw new Error('Sync stream read made no progress');if(bytes.length>max)throw new Error('Sync stream exceeded read limit');
   target.set(bytes,offset);offset+=bytes.length;
  }
 }
 async writeFrame(frame:JsonObject):Promise<void>{
  if(this.closed)throw new Error('Sync connection closed');if(this.writing)throw new Error('Concurrent sync frame writes');this.writing=true;
  try{const bytes=encodeFrame(frame);for(let i=0;i<bytes.length;i+=64*1024){if(this.closed)throw new Error('Sync connection closed');await this.stream.write(bytes.subarray(i,i+64*1024));}if(this.closed)throw new Error('Sync connection closed');}
  finally{this.writing=false;}
 }
 async close():Promise<void>{if(this.closed)return;this.closed=true;await this.stream.close();}
}
