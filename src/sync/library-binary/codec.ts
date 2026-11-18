import {withFrameBytes} from '../wire-frame-size';
import {utf8ToString} from '@podjs/framework/bytes';
import {envelope,strictJson,utf8,integer,hex,fail,CHUNK_BYTES,type Envelope} from './wire';
import {requestDigest,planDigest} from './digests';
import type {BeginPayload} from './wire';

export interface DataFrame {
 kind:'data';streamId:1|2;objectSlot:number;epoch:number;txSeq:number;chunkIndex:number;
 requestId:string;requestDigest:string;payload:Uint8Array;
}
export interface DataHeader extends Omit<DataFrame,'payload'> {payloadBytes:number}
export interface SourceFileRange {path:string;offset:number;size:number;sha256:string}
export interface SourceFileChunk {reference:string;length:number}
export interface InputFileChunk {stream:string;reference:string;length:number}
export type ReadFileChunk=(retain:boolean,sha256?:string)=>Promise<InputFileChunk|undefined>;
export type DataReader=(header:DataHeader,read:(target:Uint8Array,activity?:boolean)=>Promise<void>,readFile?:ReadFileChunk,rejection?:string)=>Promise<void>;
export type OutgoingData=Omit<DataFrame,'payload'>&{payload:Uint8Array|SourceFileChunk};
export interface AckFrame {kind:'ack';streamId:1|2;epoch:number;ackSeq:number;entries:{txSeq:number;disposition:1|2}[]}
export interface ControlFrame {kind:'control';envelope:Envelope}
export type Frame=DataFrame|AckFrame|ControlFrame;
export const MAX_FRAME_LENGTH=131084;
function stream(v:number):1|2 {if(v!==1&&v!==2)fail();return v;}
function positive(v:number):number {if(!integer(v))fail();return v;}
function set64(v:DataView,at:number,n:number):void {v.setBigUint64(at,BigInt(positive(n)));}
function get64(v:DataView,at:number):number {const n=v.getBigUint64(at);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n===0n)fail();return Number(n);}
function fromHex(s:string,n:number):Uint8Array {hex(s,n*2);return Uint8Array.from(s.match(/../g)!,h=>parseInt(h,16));}
function toHex(b:Uint8Array):string {return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
function base(kind:number,header:number,payload:number,headerOnly=false):{b:Uint8Array;v:DataView} {
 const length=12+header+payload;if(length>MAX_FRAME_LENGTH)fail('LIMIT_EXCEEDED');
 const b=new Uint8Array(headerOnly?4+12+header:4+length),v=new DataView(b.buffer);
 v.setUint32(0,length);b.set([76,66,86,50],4);b[8]=kind;v.setUint32(12,header);return {b,v};
}
function checkJson(value:unknown,depth=0,budget={nodes:0}):void {
 if(depth>16||++budget.nodes>32768)fail('LIMIT_EXCEEDED');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='string'){utf8(value);return;}
 if(typeof value==='number'){integer(value);return;}
 if(typeof value!=='object')fail();for(const [key,v] of Object.entries(value)){utf8(key);checkJson(v,depth+1,budget);}
}
export function encodeDataHeader(f:OutgoingData):Uint8Array {
 stream(f.streamId);integer(f.objectSlot,4095);integer(f.chunkIndex,255);
 const length=integer(f.payload.length,CHUNK_BYTES);
 if(!length)fail();
 const {b,v}=base(2,80,length,true);v.setUint32(16,f.streamId);v.setUint32(20,f.objectSlot);
 set64(v,24,f.epoch);set64(v,32,f.txSeq);v.setUint32(40,f.chunkIndex);v.setUint32(44,length);
 b.set(fromHex(f.requestId,16),48);b.set(fromHex(f.requestDigest,32),64);return b;
}
export function encodeFrame(frame:Frame):Uint8Array {
 if(frame.kind==='control'){
  checkJson(frame.envelope);const header=utf8(JSON.stringify(frame.envelope));if(header.length>131072)fail('LIMIT_EXCEEDED');
  const {b}=base(1,header.length,0);b.set(header,16);decodeFrame(b);return b;
 }
 if(frame.kind==='data'){
  if(!(frame.payload instanceof Uint8Array))fail();
  const header=encodeDataHeader(frame),bytes=new Uint8Array(header.length+frame.payload.length);
  bytes.set(header);bytes.set(frame.payload,header.length);return bytes;
 }
 if(frame.entries.length<1||frame.entries.length>32)fail();
 const {b,v}=base(3,32+16*frame.entries.length,0);v.setUint32(16,stream(frame.streamId));
 set64(v,24,frame.epoch);set64(v,32,frame.ackSeq);v.setUint32(40,frame.entries.length);
 let last=0;frame.entries.forEach((e,i)=>{if(e.txSeq<=last||![1,2].includes(e.disposition))fail();last=e.txSeq;set64(v,48+16*i,e.txSeq);b[56+16*i]=e.disposition;});return b;
}
/** The transport must reject the prefix before allocating, and return exactly one frame. */
export function frameAllocationBytes(prefix:Uint8Array,maximum=MAX_FRAME_LENGTH):number {
 if(prefix.length!==4)fail();const n=new DataView(prefix.buffer,prefix.byteOffset,4).getUint32(0);
 if(n<12||n>Math.min(maximum,MAX_FRAME_LENGTH))fail('LIMIT_EXCEEDED');return n+4;
}
export function decodeDataHeader(b:Uint8Array,payloadBytes:number):Omit<DataFrame,'payload'> {
 const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(payloadBytes<1||payloadBytes>CHUNK_BYTES||v.getUint32(44)!==payloadBytes)fail();
 return {kind:'data',streamId:stream(v.getUint32(16)),objectSlot:integer(v.getUint32(20),4095),
  epoch:get64(v,24),txSeq:get64(v,32),chunkIndex:integer(v.getUint32(40),255),
  requestId:toHex(b.subarray(48,64)),requestDigest:toHex(b.subarray(64,96))};
}
export function decodeFrame(b:Uint8Array,maximum=MAX_FRAME_LENGTH):Frame {
 if(!(b instanceof Uint8Array)||b.length<16||frameAllocationBytes(b.subarray(0,4),maximum)!==b.length)fail();
 const v=new DataView(b.buffer,b.byteOffset,b.length),h=v.getUint32(12),n=b.length-16-h;
 if(b[4]!==76||b[5]!==66||b[6]!==86||b[7]!==50||b[9]!==0||v.getUint16(10)!==0||n<0)fail();
 if(b[8]===1){
  if(n!==0||h>131072)fail();let value:unknown;try{value=strictJson(utf8ToString(b.subarray(16)));}catch{fail();}
  const e=withFrameBytes(envelope(value),h);
  if(e.type==='request'){
   if(requestDigest(e.jobId,e.planDigest,e.phase,e.payload!)!==e.requestDigest)fail('REQUEST_CONFLICT');
   if(e.phase==='begin'&&planDigest(e.payload as unknown as BeginPayload)!==e.planDigest)fail('PLAN_CONFLICT');
  }
  return {kind:'control',envelope:e};
 }
 if(b[8]===2){
  if(h!==80)fail();
  return {...decodeDataHeader(b,n),payload:b.subarray(96)};
 }
 if(b[8]!==3||n!==0||h<48||h>544||v.getUint32(20)!==0||v.getUint32(44)!==0)fail();
 const count=v.getUint32(40);if(count<1||count>32||h!==32+16*count)fail();
 const f:AckFrame={kind:'ack',streamId:stream(v.getUint32(16)),epoch:get64(v,24),ackSeq:get64(v,32),entries:[]};
 let last=0;for(let i=0;i<count;i++){
  const txSeq=get64(v,48+16*i),disposition=b[56+16*i];if(txSeq<=last||disposition!==1&&disposition!==2||b.subarray(57+16*i,64+16*i).some(x=>x!==0))fail();
  f.entries.push({txSeq,disposition});last=txSeq;
 }return f;
}

/** No RFCOMM dependency: S1 supplies bounded complete byte frames and cancellation. */
export interface ByteTransport {
 readonly native?:import('./transport').NativeFramePort;
 activateReceive?():void;
 settleNativeRejection?(sequence:number):void;
 setNetworkProgress?(listener:(kind:'control'|'data'|'ack',streamId?:number,epoch?:number,sequence?:number)=>void):void;
 readFrame(readData?:DataReader):Promise<Uint8Array|null>;
 writeFrame(bytes:Uint8Array):Promise<void>;
 prepareFile?(range:SourceFileRange):Promise<SourceFileChunk>;
 writeFile?(header:Uint8Array,chunk:SourceFileChunk):Promise<void>;
 dropFile?(chunk:{reference:string}):Promise<void>;
 close():void;
}
