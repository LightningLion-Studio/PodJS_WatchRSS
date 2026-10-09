import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import hashes from './fixtures/upstream-u13/sha256.json';
import * as current from '../src/sync/protocol.ts';
import {wireNumberToken,isWireInteger} from '../src/sync/wire-json.ts';
const source=readFileSync(import.meta.dir+'/fixtures/upstream-u13/protocol.ts.txt','utf8');
const relocated=source.replace(/(from\s*['"])(\.[^'"]+)(['"])/g,(_all,a,path,z)=>a+resolve(import.meta.dir,'../src/sync',path)+z);
const old=await import('data:text/javascript;base64,'+Buffer.from(new Bun.Transpiler({loader:'ts'}).transformSync(relocated)).toString('base64')) as typeof current;
const result=(fn:()=>unknown)=>{try{return {value:fn()};}catch(e){return {error:{name:(e as Error).name,message:(e as Error).message}};}};
const asyncResult=async(fn:()=>Promise<unknown>)=>{try{return {value:await fn()};}catch(e){return {error:{name:(e as Error).name,message:(e as Error).message}};}};
const prefix=(n:number,body=new Uint8Array())=>{const bytes=new Uint8Array(4+body.length);new DataView(bytes.buffer).setInt32(0,n,false);bytes.set(body,4);return bytes;};
const utf=(s:string)=>new Uint8Array(Buffer.from(s));
const work=()=>({yield:async()=>{}});
test('frozen protocol retains exact ed565f5 source provenance',()=>{
 expect(createHash('sha256').update(source).digest('hex')).toBe(hashes['protocol.ts.txt']);
});
test('JSON v14 bytes, async yields/cancellation and numeric-token payloads stay identical',async()=>{
 for(const payload of [{},{a:'汉😀é\0',version:14}, {text:'甲😀'.repeat(8000)}, {text:'x'.repeat(current.MAX_FRAME_BYTES-11)}, {text:'x'.repeat(current.MAX_FRAME_BYTES)}, {x:NaN}, {x:'\ud800'}]){
  expect(result(()=>current.encodeFrame(payload))).toEqual(result(()=>old.encodeFrame(payload)));
  expect(await asyncResult(()=>current.encodeFrameAsync(payload,work()))).toEqual(await asyncResult(()=>old.encodeFrameAsync(payload,work())));
 }
 for(const api of [old,current]){
  const circular:any={};circular.self=circular;expect(result(()=>api.encodeFrame(circular)).error?.name).toBe('TypeError');
 }
 for(const json of ['{"version":14,"i":1,"d":1.0,"e":1e0,"id":9223372036854775807}', '{"a":"😀"}', '{}']){
  const bytes=prefix(utf(json).length,utf(json));
  expect(current.decodeFrame(bytes)).toEqual(old.decodeFrame(bytes));
  expect(await current.decodeFrameAsync(bytes)).toEqual(await old.decodeFrameAsync(bytes));
  for(const method of ['decodeFrame','decodeFrameAsync'] as const){
   const a=await old[method](bytes),b=await current[method](bytes);
   for(const key of Object.keys(a)){expect(wireNumberToken(b,key)).toBe(wireNumberToken(a,key));expect(isWireInteger(b,key)).toBe(isWireInteger(a,key));}
  }
 }
 async function trace(api:typeof current,cancelAfter:number){
  let cancelled=false;const calls:string[]=[];
  const options={cancelled:()=>{calls.push('check');return cancelled;},yield:async()=>{calls.push('yield');if(calls.filter(c=>c==='yield').length===cancelAfter)cancelled=true;}};
  const frame=api.encodeFrame({text:'汉😀'.repeat(8000)});
  const encoded=await asyncResult(()=>api.encodeFrameAsync({text:'汉😀'.repeat(8000)},options));
  cancelled=false;
  const decoded=await asyncResult(()=>api.decodeFrameAsync(frame,options));return {calls,encoded,decoded};
 }
 for(const stop of [1,3,1000])expect(await trace(current,stop)).toEqual(await trace(old,stop));
 const cancelled={cancelled:()=>true};expect(await asyncResult(()=>current.decodeFrameAsync(prefix(-1),cancelled))).toEqual(await asyncResult(()=>old.decodeFrameAsync(prefix(-1),cancelled)));
});
test('malformed, truncated, signed, oversize and sliced-buffer inputs preserve exact errors',async()=>{
 const valid=current.encodeFrame({ok:true}),inputs:Uint8Array[]=[];
 for(let n=0;n<valid.length;n++)inputs.push(valid.subarray(0,n));
 inputs.push(new Uint8Array([...valid,0]),prefix(0),prefix(-1),prefix(-2147483648),prefix(current.MAX_FRAME_BYTES+1));
 for(const body of [utf('null'),utf('[]'),utf('true'),utf('{'),utf('{"a":1}tail'),Uint8Array.of(0xff),Uint8Array.of(0xc0,0x80),Uint8Array.of(0xe2,0x82),Uint8Array.of(0xed,0xa0,0x80)])inputs.push(prefix(body.length,body));
 for(const frame of inputs){
  const padded=new Uint8Array(frame.length+7);padded.set(frame,3);const sliced=padded.subarray(3,3+frame.length);
  for(const bytes of [frame,sliced]){
   expect(result(()=>current.decodeFrame(bytes))).toEqual(result(()=>old.decodeFrame(bytes)));
   expect(await asyncResult(()=>current.decodeFrameAsync(bytes,work()))).toEqual(await asyncResult(()=>old.decodeFrameAsync(bytes,work())));
  }
 }
});
test('every two-piece boundary, bytewise assembly, poison and recoverable EOF match the old decoder',()=>{
 const a=current.encodeFrame({version:14,text:'汉😀'}),b=current.encodeFrame({next:true});
 const joined=new Uint8Array([...a,...b]);
 function trace(api:typeof current,parts:Uint8Array[],finishBetween=false){
  const decoder=new api.FrameDecoder(),events:unknown[]=[];
  for(const bytes of parts){events.push(result(()=>decoder.push(bytes)));if(finishBetween)events.push(result(()=>decoder.finish()));}
  events.push(result(()=>decoder.finish()),result(()=>decoder.finish()),result(()=>decoder.push(b)),result(()=>decoder.push(new Uint8Array())),result(()=>decoder.finish()));return events;
 }
 for(let split=0;split<=joined.length;split++){
  const parts=[joined.subarray(0,split),new Uint8Array(),joined.subarray(split)];
  for(const finish of [false,true])expect(trace(current,parts,finish)).toEqual(trace(old,parts,finish));
 }
 expect(trace(current,[...joined].map(n=>Uint8Array.of(n)),true)).toEqual(trace(old,[...joined].map(n=>Uint8Array.of(n)),true));
 for(const bad of [prefix(-1),prefix(0),prefix(current.MAX_FRAME_BYTES+1),prefix(1,Uint8Array.of(0xff)),prefix(1,utf('{'))]){
  expect(trace(current,[new Uint8Array([...a,...bad,...b])])).toEqual(trace(old,[new Uint8Array([...a,...bad,...b])]));
  for(let split=0;split<=bad.length;split++)expect(trace(current,[bad.subarray(0,split),bad.subarray(split)])).toEqual(trace(old,[bad.subarray(0,split),bad.subarray(split)]));
 }
});
