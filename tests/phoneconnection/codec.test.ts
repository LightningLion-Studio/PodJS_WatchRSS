import {expect,test} from 'bun:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import oracle from './native-acoustic-oracle.json';
import {AcousticCodec,AcousticStreamDecoder,packetFromCompressed,synthesizeChunk,decodeSymbols,crc32,nativeCompatibleGzip,SYMBOL_SAMPLES} from '../../src/phoneconnection/codec.ts';
export const compression={gzip:async(bytes:Uint8Array)=>{const value=new Uint8Array(gzipSync(bytes));value[9]=255;return value;},gunzip:async(bytes:Uint8Array,max:number)=>new Uint8Array(gunzipSync(bytes,{maxOutputLength:max}))};
const text=new TextEncoder();
test('unmodified native AcousticCodecTest vector has identical PCM16 sample bytes',async()=>{
 const bytes=Buffer.from(oracle.gzipBase64,'base64'),packet=packetFromCompressed(bytes),codec=new AcousticCodec(compression);
 expect((await new AcousticCodec({...compression,gzip:async()=>new Uint8Array(bytes)}).encode(text.encode(oracle.payload))).symbols).toEqual(packet.symbols);
 expect(packet.durationMs).toBe(oracle.durationMs);expect(packet.compressedBytes).toBe(oracle.compressedBytes);expect(packet.encodedChars).toBe(oracle.encodedChars);
 const hash=createHash('sha256'),decoder=new AcousticStreamDecoder();let decoded:Uint8Array|null=null;
 for(let i=0;i<packet.sampleCount;i+=4096){const pcm=synthesizeChunk(packet,i),wire=Buffer.alloc(pcm.length*2);for(let j=0;j<pcm.length;j++)wire.writeInt16LE(pcm[j],j*2);hash.update(wire);decoded=decoder.push(pcm)??decoded;}
 expect(hash.digest('hex')).toBe(oracle.nativePcmSha256);expect(new TextDecoder().decode(await codec.decompress(decoded!))).toBe(oracle.payload);
});
test('four phase receiver handles leading silence and arbitrary chunk boundaries',async()=>{
 const packet=packetFromCompressed(Buffer.from(oracle.gzipBase64,'base64')),decoder=new AcousticStreamDecoder();
 decoder.push(new Int16Array(700));let bytes:Uint8Array|null=null;
 for(let i=0;i<packet.sampleCount&&!bytes;i+=997)bytes=decoder.push(synthesizeChunk(packet,i,997));
 if(!bytes)bytes=decoder.push(new Int16Array(SYMBOL_SAMPLES));
 expect(bytes).not.toBeNull();expect(new TextDecoder().decode(await compression.gunzip(bytes!,65536))).toBe(oracle.payload);
});
test('CRC, end marker, truncated frame and malicious length are rejected',()=>{
 const p=packetFromCompressed(Buffer.from(oracle.gzipBase64,'base64'));expect(decodeSymbols(p.symbols.slice(0,-1))).toBeNull();
 const crc=[...p.symbols];crc[20]^=1;expect(decodeSymbols(crc)).toBeNull();
 const end=[...p.symbols];end[end.length-1]=3;expect(decodeSymbols(end)).toBeNull();
 const length=[...p.symbols];length.splice(8,6,31,31,31,31,31,31);expect(decodeSymbols(length)).toBeNull();
 expect(()=>packetFromCompressed(new Uint8Array(4097))).toThrow();
});
test('native signed CRC workaround changes only gzip MTIME and preserves payload',async()=>{
 let found=false;
 for(let n=0;n<20;n++){const payload=text.encode(`{"kind":"pure_sound","ability":"SYNC_FAVORITES","items":[{"link":"https://example.com/${n}"}]}`),bytes=await compression.gzip(payload);if(crc32(bytes)<0x80000000)continue;found=true;
  const safe=nativeCompatibleGzip(bytes);expect(crc32(safe)).toBeLessThan(0x80000000);expect(safe.slice(8)).toEqual(bytes.slice(8));expect(await compression.gunzip(safe,65536)).toEqual(payload);break;
 }expect(found).toBe(true);
});
test('silence never decodes and recording/payload budgets are enforced',async()=>{
 const d=new AcousticStreamDecoder();for(let i=0;i<20;i++)expect(d.push(new Int16Array(4096))).toBeNull();
 expect(()=>d.push(new Int16Array(8193))).toThrow();await expect(new AcousticCodec(compression).encode(new Uint8Array(65537))).rejects.toThrow();
});
