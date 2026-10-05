import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {AcousticCodec,packetFromCompressed,synthesizeChunk} from '../../src/phoneconnection/codec.ts';
const root=process.argv[2],fixture=JSON.parse(readFileSync(join(root,'oracle.json'),'utf8'));
const packet=packetFromCompressed(Buffer.from(fixture.gzipBase64,'base64')),bytes=Buffer.alloc(packet.sampleCount*2);
for(let offset=0;offset<packet.sampleCount;offset+=4096){const chunk=synthesizeChunk(packet,offset);for(let i=0;i<chunk.length;i++)bytes.writeInt16LE(chunk[i],(offset+i)*2);}
writeFileSync(join(root,'js.pcm'),bytes);
const native=readFileSync(join(root,'native.pcm')),samples=new Int16Array(native.length/2);for(let i=0;i<samples.length;i++)samples[i]=native.readInt16LE(i*2);
const codec=new AcousticCodec({gzip:async()=>{throw Error('unused');},gunzip:async(bytes,max)=>new Uint8Array(gunzipSync(bytes,{maxOutputLength:max}))});
const decoded=await codec.decode(samples);if(!decoded)throw Error('Native PCM did not decode');writeFileSync(join(root,'js-from-native.txt'),decoded);

const encoder=new AcousticCodec({gzip:async()=>new Uint8Array(Buffer.from(fixture.gzipBase64,'base64')),gunzip:async(bytes,max)=>new Uint8Array(gunzipSync(bytes,{maxOutputLength:max}))});
const encoded=await encoder.encode(readFileSync(join(root,'payload.txt'))),encodedPcm=Buffer.alloc(encoded.sampleCount*2);
for(let offset=0;offset<encoded.sampleCount;offset+=4096){const chunk=synthesizeChunk(encoded,offset);for(let i=0;i<chunk.length;i++)encodedPcm.writeInt16LE(chunk[i],(offset+i)*2);}
writeFileSync(join(root,'js-encoded.pcm'),encodedPcm);
