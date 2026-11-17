import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import source from '../fixtures/library-binary/SOURCE.json';
import {fixed,cap,selection,data,request,begin,object} from './helpers';
import {encodeFrame,decodeFrame,frameAllocationBytes,type AckFrame} from '../../src/sync/library-binary/codec';
import {capabilityDigest,selectionDigest,requestDigest,descriptor,D} from '../../src/sync/library-binary/digests';
import {s2Capability} from '../../src/sync/library-binary/routing';
import {strictJson,capability,type Capability} from '../../src/sync/library-binary/wire';

test('unchanged r3 vector files retain source hashes shared with Kotlin',()=>{
 for(const [name,sha] of Object.entries(source.sha256))expect(createHash('sha256').update(readFileSync(new URL('../fixtures/library-binary/'+name,import.meta.url))).digest('hex')).toBe(sha);
});
test('golden raw DATA 99 bytes and ACK 64 bytes roundtrip byte-for-byte',()=>{
 const raw=Buffer.from(fixed.dataHex,'hex');expect(raw.length).toBe(99);expect(encodeFrame(data())).toEqual(new Uint8Array(raw));expect(encodeFrame(decodeFrame(raw))).toEqual(new Uint8Array(raw));
 const ack=Buffer.from(fixed.ackHex,'hex'),expected:AckFrame={kind:'ack',streamId:1,epoch:1,ackSeq:1,entries:[{txSeq:1,disposition:1}]};expect(ack.length).toBe(64);expect(decodeFrame(ack)).toEqual(expected);expect(encodeFrame(expected)).toEqual(new Uint8Array(ack));expect(encodeFrame(decodeFrame(ack))).toEqual(new Uint8Array(ack));
});
test('S2 and S3 capability/selection digests recompute frozen values',()=>{
 expect(capabilityDigest(cap)).toBe(fixed.s2CapabilityDigest);expect(selectionDigest(selection)).toBe(fixed.s2SelectionDigest);
 const c=fixed.capability as Capability;expect(capabilityDigest(c)).toBe(fixed.capabilityDigest);expect(selectionDigest({...selection,limits:c.limits})).toBe(fixed.selectionDigest);
 expect(requestDigest('00112233445566778899aabbccddeeff','b'.repeat(64),'putChunk',{objectId:'c'.repeat(64),chunkIndex:0})).toBe(fixed.requestDigest);
});
test('request digest excludes epoch and txSeq; all B2 domains are distinct',()=>{
 const a=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0});expect(requestDigest(a.jobId,a.planDigest,a.phase,a.payload!)).toBe(a.requestDigest);
 expect(D('wrss.library-binary.v2/account',['a'])).not.toBe(D('wrss.library-resume.v1/account',['a']));
});
for(const name of ['length','magic','kind','flags','reserved','headerLength','streamId','epoch','txSeq','payloadLength','slot','index','trailing'])test('malformed DATA STOP: '+name,()=>{
 const b=Buffer.from(fixed.dataHex,'hex'),v=new DataView(b.buffer,b.byteOffset,b.length);
 const mutate:Record<string,()=>void>={length:()=>v.setUint32(0,94),magic:()=>b[4]=0,kind:()=>b[8]=9,flags:()=>b[9]=1,reserved:()=>b[10]=1,headerLength:()=>v.setUint32(12,79),streamId:()=>v.setUint32(16,3),epoch:()=>v.setBigUint64(24,9007199254740992n),txSeq:()=>v.setBigUint64(32,0n),payloadLength:()=>v.setUint32(44,4),slot:()=>v.setUint32(20,4096),index:()=>v.setUint32(40,256),trailing:()=>{}};
 mutate[name]!();expect(()=>decodeFrame(name==='trailing'?Buffer.concat([b,Buffer.from([0])]):b)).toThrow();
});
for(const offset of [20,44,57,58,63])test('malformed ACK reserved byte '+offset,()=>{const b=Buffer.from(fixed.ackHex,'hex');b[offset]=1;expect(()=>decodeFrame(b)).toThrow();});
test('ACK selective format supports 32 entries and rejects unsorted/duplicate entries',()=>{
 const a=decodeFrame(Buffer.from(fixed.ackHex,'hex')) as AckFrame;a.entries=Array.from({length:32},(_,i)=>({txSeq:i+1,disposition:1 as const}));expect(decodeFrame(encodeFrame(a))).toEqual(a);
 a.entries[1]!.txSeq=1;expect(()=>encodeFrame(a)).toThrow();
});
test('raw allocation bound and max 64KiB DATA are checked before payload copy',()=>{
 for(const n of [0,11,131085,0xffffffff]){const p=new Uint8Array(4);new DataView(p.buffer).setUint32(0,n);expect(()=>frameAllocationBytes(p)).toThrow();}
 expect(encodeFrame({...data(),payload:new Uint8Array(65536)}).length).toBe(65632);expect(()=>encodeFrame({...data(),payload:new Uint8Array(65537)})).toThrow();
 for(let n=0;n<99;n++)expect(()=>decodeFrame(Buffer.from(fixed.dataHex,'hex').subarray(0,n))).toThrow();
});
for(const raw of ['{"a":1,"a":2}','{"a":{"x":1,"\\u0078":2}}','{"n":-0}','{"n":1.0}','{"n":9007199254740992}','{"x":"\\ud800"}','{"x":true}false'])test('strict CONTROL JSON rejects '+raw,()=>expect(()=>strictJson(raw)).toThrow());
test('CONTROL depth/nodes budgets and strict UTF8 reject before dispatch',()=>{
 expect(()=>strictJson('{"x":'+ '['.repeat(17)+'0'+']'.repeat(17)+'}')).toThrow();expect(()=>strictJson('{"x":['+Array(32768).fill('0').join(',')+']}')).toThrow();
 const e=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0}),b=encodeFrame({kind:'control',envelope:e});b[16]=0xff;expect(()=>decodeFrame(b)).toThrow();
});
test('all S2 CONTROL request phases roundtrip and forbid JSON putChunk / unknown fields',()=>{
 const b=begin([object('rssSource')]);
 const requests=[request('prepare',{step:'offer',accountScope:b.payload.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:cap,phoneSnapshot:b.payload.phoneSnapshot,watchSnapshot:null}),request('begin',b.payload as any,{planDigest:b.plan}),request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:'a'.repeat(64),entries:[object('rssSource')]}),request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0}),request('apply',{objectId:'a'.repeat(64)}),request('complete',{objectCount:0,receiptsRoot:'b'.repeat(64),ackToInclusive:0}),request('cancel',{reason:'USER_CANCEL'})];
 for(const e of requests)expect(decodeFrame(encodeFrame({kind:'control',envelope:e}))).toEqual({kind:'control',envelope:e});
 const p=request('putChunk',{objectId:'a'.repeat(64),chunkIndex:0});expect(()=>encodeFrame({kind:'control',envelope:p})).toThrow();
 const m=requests[3]!;expect(()=>encodeFrame({kind:'control',envelope:{...m,payload:{...m.payload,extra:1}}})).toThrow();
 expect(()=>encodeFrame({kind:'control',envelope:{...m,requestDigest:'f'.repeat(64)}})).toThrow('REQUEST_CONFLICT');
});
test('raw metadata whitespace preserved in descriptor digest; book kinds excluded',()=>{
 const o=object();expect(descriptor(o,selection.limits)).toEqual(o);expect(()=>descriptor({...o,metadataUtf8:'{"x":1}'},selection.limits)).toThrow('HASH_MISMATCH');
 expect(()=>s2Capability([{kind:'bookState',schemaVersion:1,send:true,receive:true}],cap.limits)).toThrow();
 for(const chunkSizes of [[32768],[65536,65536],[]])expect(()=>capability({...cap,chunkSizes})).toThrow();
});
test('independent r3 review oracle is identical and also drives golden digest/bytes checks',async()=>{
 const reviewed=(await import('../fixtures/library-binary/review-r3-vectors.json')).default;expect(reviewed).toEqual(fixed);expect(encodeFrame(data())).toEqual(new Uint8Array(Buffer.from(reviewed.dataHex,'hex')));expect(capabilityDigest(reviewed.s2Capability as Capability)).toBe(reviewed.s2CapabilityDigest);
});
test('raw ACK partial activity carries its sequence and ignores a same-epoch duplicate',async()=>{
 const {BinaryByteTransport}=await import('../../src/sync/library-binary/transport'),{SendWindow}=await import('../../src/sync/library-binary/state'),{binding}=await import('./helpers');
 const window=new SendWindow(binding,1);window.reserve(data());const ack:AckFrame={kind:'ack',streamId:1,epoch:1,ackSeq:1,entries:[{txSeq:1,disposition:1}]};
 let input:Uint8Array=new Uint8Array();let activity=0;const io=new BinaryByteTransport({read:async max=>{const out=input.slice(0,Math.min(max,7));input=input.slice(out.length);return out.length?out:null;},write:async()=>{},close:async()=>{}},()=>0);
 io.setNetworkProgress((kind,stream,epoch,seq)=>{if(kind==='ack'&&stream===1&&window.acceptsAckProgress(epoch!,seq!))activity++;});
 input=encodeFrame(ack);const first=decodeFrame(await io.readFrame());expect(first.kind).toBe('ack');expect(activity).toBeGreaterThan(1);if(first.kind==='ack')window.acceptAck(first,0);
 window.reserve(data());activity=0;input=encodeFrame(ack);await io.readFrame();expect(activity).toBe(0);
 input=encodeFrame({...ack,ackSeq:2,entries:[{txSeq:2,disposition:1}]});await io.readFrame();expect(activity).toBeGreaterThan(1);
});
