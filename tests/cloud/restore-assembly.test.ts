import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {WatchCloudCodec} from '../../src/cloud/codec';
async function assembly(){
 const f=await fixture();let opens=0,localDecrypts=0;
 f.session.codec=new WatchCloudCodec({...crypto,decrypt:async(...args)=>{localDecrypts++;return crypto.decrypt(...args);},openSealedParts:async(k,parts,length)=>{
  opens++;expect(length).toBeLessThanOrEqual(64*1024*1024);const out=new Uint8Array(length);let at=0;
  for(let i=0;i<parts.length;i++){const p=parts[i],b=f.blobs.get(p.path);if(!b||b.length!==p.bytes+28)throw Error('sealed_part_invalid_'+i);let plain:Uint8Array;try{plain=await crypto.decrypt(k,new Uint8Array(Buffer.from(p.aadBase64,'base64')),b.subarray(0,12),b.subarray(12));}catch{throw Error('sealed_part_invalid_'+i);}out.set(plain,at);at+=plain.length;}expect(at).toBe(length);return out;
 }},enabled);
 const open=(epoch='epoch')=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open(epoch,'generation');
 return {...f,open,counts:()=>({opens,localDecrypts})};
}
test('secure canonical receipts reconstruct legacy indices without decrypting the prefix; data AEAD still detects tampering',async()=>{
 const f=await assembly(),child='a'.repeat(64)+'-chunk-0',root='b'.repeat(64)+'-object',body=new Uint8Array(131072).fill(7);
 let cp=await f.open();await cp.begin();await cp.write(child,body);const indexPath=await f.cache.restoreProjectionPath('user',child);f.blobs.delete(indexPath);cp.close();
 cp=await f.open();const before=f.counts();expect((await cp.index(child))!.length).toBe(body.length);expect(f.counts()).toEqual(before);
 const piecePath=await f.cache.restoreProjectionPath('user',child+'-p0'),sealed=f.blobs.get(piecePath)!.slice();f.blobs.get(piecePath)![20]^=1;
 await expect(cp.assemble(root,[child],body.length,await crypto.sha256(body))).rejects.toThrow('sealed_part_invalid_0');expect(cp.has('decoded:'+root)).toBe(false);expect(cp.length(child)).toBeUndefined();cp.close();
 cp=await f.open();expect(cp.length(child)).toBeUndefined();f.blobs.set(piecePath,sealed);await cp.write(child,body);expect(await cp.assemble(root,[child],body.length,await crypto.sha256(body))).toEqual(body);cp.close();
 cp=await f.open('different-epoch');expect(cp.length(child)).toBeUndefined();expect(await cp.index(child)).toBeUndefined();cp.close();
});
test('assembly verifies content hash before publishing an object receipt and supports noncanonical linked children',async()=>{
 const f=await assembly(),a='a'.repeat(64),b='b'.repeat(64),linked='c'.repeat(64),root='d'.repeat(64),bytes=new Uint8Array([1,2,3,4]);
 let cp=await f.open();await cp.begin();await cp.write(a,bytes.subarray(0,2));await cp.write(b,bytes.subarray(2));await cp.link(linked,[a,b],4);cp.close();
 cp=await f.open();await expect(cp.assemble(root,[linked],4,'0'.repeat(64))).rejects.toThrow('cloud_snapshot_projection_integrity');expect(cp.has('decoded:'+root)).toBe(false);expect(await cp.read(root)).toBeUndefined();cp.close();
 cp=await f.open();expect(await cp.assemble(root,[linked],4,await crypto.sha256(bytes))).toEqual(bytes);expect(cp.has('decoded:'+root)).toBe(true);cp.close();
});
test('large native assembly bounds each open to 64 MiB and checks zero-length layouts',async()=>{
 const f=await assembly(),child='a'.repeat(64),root='b'.repeat(64),length=64*1024*1024+17,body=new Uint8Array(length).fill(23);
 let cp=await f.open();await cp.begin();await cp.write(child,body);cp.close();
 cp=await f.open();expect(await cp.assemble(root,[child],length,await crypto.sha256(body))).toEqual(body);expect(f.counts().opens).toBe(2);cp.close();
 cp=await f.open();expect(await cp.read(root)).toEqual(body);expect(f.counts().opens).toBe(4);cp.close();
 cp=await f.open();const empty='c'.repeat(64);await cp.write(empty,new Uint8Array());expect((await cp.index(empty))!.lengths).toEqual([0]);expect(await cp.assemble('d'.repeat(64),[empty],0,await crypto.sha256(new Uint8Array()))).toHaveLength(0);cp.close();
},20000);
