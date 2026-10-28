import {test,expect} from 'bun:test';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {writeWrss,readWrss} from '../../src/cloud/wrss';
import {utf8Encode} from '../../src/cloud/types';
import {crypto,enabled,key} from './k2-crypto';

function archive(last=65){
 const body=new Uint8Array(1024*1024).fill(65);body[body.length-1]=last;
 return writeWrss(new Map([
  ['manifest.json',utf8Encode('{"format":"watchrss-library-backup","version":3,"articleCount":1,"future":{"keep":true}}')],
  ['articles.json',utf8Encode('[{"articleId":"a","url":"https://example.invalid/a","title":"a","contentTextEntry":"bodies/a.txt"}]')],
  ['bodies/a.txt',body],['reader/fonts/extension.bin',new Uint8Array([1,2,3])],
 ]));
}
const input=(bytes:Uint8Array,sequence=1)=>({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence,snapshotId:'snapshot-'+sequence,createdAtMillis:sequence,parentHeads:{},observedHeads:{},objects:[{name:'private-library.wrss',bytes,compress:false}]});

test('large identical private archive yields to input and retains its exact ciphertext descriptor',async()=>{
 let inputTicks=0;
 const codec=new WatchCloudCodec({...crypto,yieldTurn:()=>new Promise<void>(resolve=>setTimeout(()=>{inputTicks++;resolve();},0))},enabled);
 const bytes=archive(),previous=await codec.create(input(bytes));inputTicks=0;
 const next=await codec.create({...input(bytes.slice(),2),previous:previous.manifest,readPreviousChunk:async h=>previous.newChunks.get(h)!});
 expect(next.newChunks.size).toBe(0);
 expect(next.manifest.objects).toEqual(previous.manifest.objects);
 expect(inputTicks).toBeGreaterThan(0);
});

test('a changed final body byte is published and authenticated extensions survive the async comparison',async()=>{
 const codec=new WatchCloudCodec({...crypto,yieldTurn:async()=>{}},enabled);
 const previous=await codec.create(input(archive())),next=await codec.create({...input(archive(66),2),previous:previous.manifest,readPreviousChunk:async h=>previous.newChunks.get(h)!});
 const chunks=new Map([...previous.newChunks,...next.newChunks]);
 const restored=await codec.restore(key,next.manifest,async h=>chunks.get(h)!);
 const zip=await readWrss(restored.get('private-library.wrss')!,crypto.gunzip),body=zip.get('bodies/a.txt')!;
 expect(body.length).toBe(1024*1024);expect(body.at(-1)).toBe(66);
 expect(zip.get('reader/fonts/extension.bin')).toEqual(new Uint8Array([1,2,3]));
 expect(next.newChunks.size).toBeGreaterThan(0);
});
