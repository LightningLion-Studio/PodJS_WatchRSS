import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import legacy from '../fixtures/library-binary/v1-parity.json';
import {encodeFrame,decodeFrame,type JsonObject} from '../../src/sync/protocol';
import {gated} from '../../src/sync/library-binary/routing';
const inputs:JsonObject[]=legacy.cases.slice(0,3).map(c=>(c as {payload:JsonObject}).payload);
let seed=0x12345678;for(let i=0;i<256;i++){
 seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=[0,1,2,3,64,65536][i%6]!,bytes=Buffer.alloc(n);
 for(let j=0;j<n;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes[j]=seed>>>24;}
 inputs.push({action:'syncLibrary',version:i%2?13:14,phase:['probe','manifest','articles','complete'][i%4],index:i,metadata:' 空白 😀 \\ \"\n'+String(seed),dataBase64:bytes.toString('base64')});
}
test('off leaves legacy source hashes, 259 baseline frame hashes and byte lengths unchanged',()=>{
 for(const [path,sha] of Object.entries(legacy.sourceHashes))expect(createHash('sha256').update(readFileSync(resolve(import.meta.dir,'../..',path))).digest('hex')).toBe(sha);
 expect(inputs.length).toBe(259);for(let i=0;i<inputs.length;i++){
  let binaryCalls=0;const bytes=gated(false,()=>encodeFrame(inputs[i]!),()=>{binaryCalls++;throw Error('B2 invoked while off');});
  expect(binaryCalls).toBe(0);expect(bytes.length).toBe(legacy.cases[i]!.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(legacy.cases[i]!.frameSha256);expect(decodeFrame(bytes)).toEqual(inputs[i]);
 }
 const bytes=new Uint8Array([0,1,255]);expect(gated(false,()=>bytes,()=>new Uint8Array())).toBe(bytes);
});
const baselineRoot=process.env.B2_LEGACY_BASELINE_ROOT??resolve(import.meta.dir,'../../..','PodJS_WatchRSS');
(existsSync(resolve(baselineRoot,'src/sync/protocol.ts'))?test:test.skip)('live read-only baseline differential compares all 259 frames byte-for-byte',async()=>{
 for(const [path,sha] of Object.entries(legacy.sourceHashes))expect(createHash('sha256').update(readFileSync(resolve(baselineRoot,path))).digest('hex')).toBe(sha);
 const baseline=await import(pathToFileURL(resolve(baselineRoot,'src/sync/protocol.ts')).href);
 for(const input of inputs){const before=baseline.encodeFrame(input);expect(gated(false,()=>encodeFrame(input),()=>{throw Error('B2 invoked');})).toEqual(before);}
});
