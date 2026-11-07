/** Explicit host TCP comparison. Identical opaque bytes, SHA checks and ACKs.
 * Includes production old JSON codecs and P4 WRP2 codecs, not business disk IO. */
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {StreamFrameConnection} from '../../src/sync/stream';
import {localObjectFrames} from '../../src/sync-v2/local-read';
import {validatePart} from '../../src/sync-v2/local-objects';
import {objectOid} from '../../src/sync-v2/sealed';
import {sha256Hex} from '@podjs/framework/crypto';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {tcpStreams} from './p4-tcp';
import {scope} from './fixture';
const objectBytes=262144,objects=8,samples=10,payloads=Array.from({length:objects},()=>randomBytes(objectBytes)),sessionId='a'.repeat(32),transferId='b'.repeat(32);
async function sample(mode:'legacy'|'wrp2'){
 const sockets=await tcpStreams(),start=performance.now();
 try{
  if(mode==='legacy'){
   const out=new StreamFrameConnection(sockets.server),input=new StreamFrameConnection(sockets.client);
   const send=(async()=>{for(let n=0;n<objects;n++){const payload=payloads[n]!,id=objectOid('blob',payload);const chunks=[];for(let at=0;at<payload.length;at+=131072){const part=payload.subarray(at,at+131072);chunks.push({index:chunks.length,hash:sha256Hex(part),data:encodeBase64(part)});}await out.writeFrame({version:14,action:'syncLibrary',phase:'articles',articles:[{articleId:'synthetic',body:{bodyHash:sha256Hex(payload),chunks}}]});const ack=await out.readFrame(30000);if(ack.applied!==true)throw Error('old_ack_missing');}})();
   for(let n=0;n<objects;n++){const payload=payloads[n]!,id=objectOid('blob',payload);const response=await input.readFrame(30000),body=(response.articles as any[])[0].body,raw=new Uint8Array(payload.length);let at=0;for(const chunk of body.chunks){const part=decodeBase64(chunk.data);if(sha256Hex(part)!==chunk.hash)throw Error('old_part_hash');raw.set(part,at);at+=part.length;}if(sha256Hex(raw)!==body.bodyHash)throw Error('old_body_hash');await input.writeFrame({action:'ack',success:true,applied:true});}await send;
  }else{
   const out=localObjectFrames(sockets.server,scope,sessionId,()=>true),input=localObjectFrames(sockets.client,scope,sessionId,()=>true);
   const send=(async()=>{for(let n=0;n<objects;n++){const payload=payloads[n]!,id=objectOid('blob',payload);await out.writeControl({scope,oid:id,totalBytes:payload.length,start:0,end:payload.length-1,transferId});for(let at=0;at<payload.length;at+=65536){const part=payload.subarray(at,at+65536);await out.writePart({scope,sessionId,oid:id,totalBytes:payload.length,offset:at,partBytes:part.length,partSha256:sha256Hex(part)},part);}const ack=await out.read(30000);if(ack.kind!=='control'||ack.value.applied!==true)throw Error('new_ack_missing');}})();
   for(let n=0;n<objects;n++){const payload=payloads[n]!,id=objectOid('blob',payload);const metadata=await input.read(30000);if(metadata.kind!=='control')throw Error('missing_metadata');const raw=new Uint8Array(payload.length);for(let at=0;at<payload.length;at+=65536){const part=await input.read(30000);if(part.kind!=='part'||part.header.offset!==at)throw Error('wrong_part');validatePart(part.header,part.payload);raw.set(part.payload,at);}if(objectOid('blob',raw)!==id)throw Error('new_body_hash');await input.writeControl({action:'ack',success:true,applied:true});}await send;
  }
  return {payloadBytes:objectBytes*objects,wireBytes:sockets.client.writeBytes+sockets.server.writeBytes,durationMillis:performance.now()-start,objects};
 }finally{await sockets.close();}
}
for(let n=0;n<1;n++){process.stdout.write('warmup legacy\n');await sample('legacy');process.stdout.write('warmup wrp2\n');await sample('wrp2');}
const result:{legacy:Awaited<ReturnType<typeof sample>>[];wrp2:Awaited<ReturnType<typeof sample>>[]}={legacy:[],wrp2:[]};
for(let n=0;n<samples;n++)for(const mode of n%2?['wrp2','legacy'] as const:['legacy','wrp2'] as const){process.stdout.write('sample '+n+' '+mode+'\n');result[mode].push(await sample(mode));}
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!,old=median(result.legacy.map(v=>v.payloadBytes/v.durationMillis)),next=median(result.wrp2.map(v=>v.payloadBytes/v.durationMillis)),ratio=next/old;
const report={syntheticOnly:true,environment:'Bun/Linux, real 127.0.0.1 TCP, memory source, production framing codecs, per-part/full SHA256 and ACKs; no business/disk IO',sampleCountPerMode:samples,objectsPerSample:objects,objectBytes,legacyMedianBytesPerSecond:old*1000,wrp2MedianBytesPerSecond:next*1000,ratio,passes90Percent:ratio>=0.9,samples:result,physicalDevices:false};
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify({sampleCountPerMode:samples,ratio,passes90Percent:report.passes90Percent})+'\n');if(!report.passes90Percent)process.exitCode=1;
