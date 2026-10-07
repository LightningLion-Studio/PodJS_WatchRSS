import * as before from '../../tests/fixtures/byte-codecs-before.ts';
import {encodeChunkData,decodeChunkData,encodeFrame,encodeFrameAsync,decodeFrameAsync,decodeSyncUtf8} from '../../src/sync/protocol.ts';
import {javaUtf8Chunks} from '../../src/reader/imported-text-writer.ts';
import {encodeUtf8} from '@podjs/framework/bytes';
import {encodeUtf8Async,decodeUtf8Async,encodeBase64Async,decodeBase64Async} from '@podjs/framework/bytes';
export async function differential(realText=''){
 let assertions=0,seed=42;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const equal=(a:unknown,b:unknown)=>{assertions++;if(JSON.stringify(a)!==JSON.stringify(b))throw Error('byte differential mismatch');};
 const attempt=(fn:()=>unknown)=>{try{return {value:fn()};}catch(e){return {error:(e as Error).message};}};
 const asyncAttempt=async(fn:()=>Promise<unknown>)=>{try{return {value:await fn()};}catch(e){return {error:(e as Error).message};}};
 for(let run=0;run<1200;run++){
  const bytes=new Uint8Array(run<256?run:random()%2000);for(let i=0;i<bytes.length;i++)bytes[i]=random()>>>24;
  const encoded=before.encodeChunkData(bytes);equal(encodeChunkData(bytes),encoded);
  equal([...decodeChunkData(encoded)],[...before.decodeChunkData(encoded)]);
  const text=Array.from({length:random()%400},()=>String.fromCharCode(random()&65535)).join('');
  equal([...javaUtf8Chunks(text)].map(b=>[...b]),[...before.javaUtf8Chunks(text)].map(b=>[...b]));
  equal(attempt(()=>[...encodeUtf8(text)]),attempt(()=>[...before.utf8Encode(text)]));
  equal(await asyncAttempt(()=>decodeUtf8Async(bytes)),attempt(()=>before.decodeSyncUtf8(bytes)));
 }
 for(const prefix of [4093,4094,4095,4096,12287,16383,32767,32768]){
  for(const tail of ['🙂中\0\ufeff','\ud800x\udc00','\ud800\ud800\udc00']){
   const text='a'.repeat(prefix)+tail.repeat(4000);
   equal([...javaUtf8Chunks(text)].map(b=>[...b]),[...before.javaUtf8Chunks(text)].map(b=>[...b]));
   const bytes=before.utf8Encode('a'.repeat(prefix)+'🙂中\0\ufeff'.repeat(4000));
   equal(encodeChunkData(bytes),before.encodeChunkData(bytes));
   equal([...decodeChunkData(before.encodeChunkData(bytes))],[...bytes]);
  }
 }
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 for(const a of alphabet)for(const b of alphabet){equal([...decodeChunkData(a+b)],[...before.decodeChunkData(a+b)]);equal([...decodeChunkData(a+b+'==')],[...before.decodeChunkData(a+b+'==')]);}
 for(const value of ['', 'A','A=','A===','AA=','AAA==','AAAA=','AAAA==',' AA==','AA==\n','AA===','AA==AAAA','☃','-w==','_w==','AAAA'.repeat(4096)+'=','AAAA'.repeat(4095)+'AA==AAAA'])equal(attempt(()=>[...decodeChunkData(value)]),attempt(()=>[...before.decodeChunkData(value)]));
 const text='同步 🙂'.repeat(10000),bytes=before.utf8Encode(text),encoded=before.encodeChunkData(bytes);
 // Production defaults: no injected clock, transport or yield callback.
 equal([...(await encodeUtf8Async(text))],[...bytes]);
 equal(await encodeBase64Async(bytes),encoded);equal([...(await decodeBase64Async(encoded))],[...bytes]);
 equal([...(await encodeFrameAsync({text}))],[...encodeFrame({text})]);
 equal(decodeSyncUtf8(bytes),before.decodeSyncUtf8(bytes));
 equal(await decodeFrameAsync(encodeFrame({text})),{text});
 if(realText){equal([...encodeUtf8(realText)],[...before.utf8Encode(realText)]);equal([...javaUtf8Chunks(realText)].map(b=>[...b]),[...before.javaUtf8Chunks(realText)].map(b=>[...b]));}
 let turns=0,cancelled=false;
 try{await encodeUtf8Async(text,'strict',{cancelled:()=>cancelled,yield:async()=>{turns++;cancelled=true;}});throw Error('cancel did not reject');}catch(e){if((e as Error).message!=='byte codec cancelled')throw e;}
 equal(turns,1);
 return assertions;
}
