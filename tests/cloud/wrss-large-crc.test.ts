import {expect,test} from 'bun:test';
import {gunzipSync,gzipSync} from 'node:zlib';
import {crc32,readWrss,writeWrss} from '../../src/cloud/wrss';
const gunzip=async(b:Uint8Array)=>new Uint8Array(gunzipSync(b));

test('one 32 MiB ZIP entry yields while validating CRC; cancellation publishes no entries',async()=>{
 const raw=new Uint8Array(32*1024*1024);for(let i=0;i<raw.length;i++)raw[i]=i*31;
 const zip=writeWrss(new Map([['reader/fonts/synthetic.ttf',raw]]));let yields=0;
 const entries=await readWrss(zip,gunzip,{yield:async()=>{yields++;}});
 expect(yields).toBeGreaterThan(1);expect(entries.size).toBe(1);expect(entries.get('reader/fonts/synthetic.ttf')).toEqual(raw);
 let cancelled=false;
 await expect(readWrss(zip,gunzip,{cancelled:()=>cancelled,yield:async()=>{cancelled=true;}})).rejects.toThrow('checksum cancelled');
},20000);
test('CRC values preserve deterministic ZIP bytes and reject corrupt STORE/DEFLATE entries',async()=>{
 const raw=new TextEncoder().encode('123456789');expect(crc32(raw)).toBe(0xcbf43926);
 const zip=writeWrss(new Map([['bodies/x.txt',raw]]));const view=new DataView(zip.buffer);expect(view.getUint32(14,true)).toBe(0xcbf43926);
 expect(writeWrss(new Map([['bodies/x.txt',raw]]))).toEqual(zip);
 const changed=zip.slice();changed[30+'bodies/x.txt'.length]^=1;await expect(readWrss(changed,gunzip)).rejects.toThrow('cloud_archive_invalid');
 // A decoder returning the wrong plaintext must still fail our explicit CRC.
 const gzip=gzipSync(raw);const packed=gzip.subarray(10,gzip.length-8);const compressed=zip.slice(0,30+'bodies/x.txt'.length);new DataView(compressed.buffer).setUint16(8,8,true);
 const oldCentral=30+'bodies/x.txt'.length+raw.length,central=zip.slice(oldCentral),cv=new DataView(central.buffer);cv.setUint16(10,8,true);cv.setUint32(20,packed.length,true);cv.setUint32(central.length-6,compressed.length+packed.length,true);new DataView(compressed.buffer).setUint32(18,packed.length,true);
 const deflated=new Uint8Array(compressed.length+packed.length+central.length);deflated.set(compressed);deflated.set(packed,compressed.length);deflated.set(central,compressed.length+packed.length);
 expect((await readWrss(deflated,gunzip)).get('bodies/x.txt')).toEqual(raw);
 await expect(readWrss(deflated,async()=>new Uint8Array(raw.length))).rejects.toThrow('cloud_archive_invalid');
});
