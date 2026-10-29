import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {utf8Encode} from '../../src/cloud/types';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
test('host permission errors become a capability failure, while authentication errors keep their meaning',async()=>{
 let failure='permission_denied';const ports=createCloudHostPorts(async()=>{throw Error(failure);},{require(){}});
 await expect(ports.crypto.decrypt(new Uint8Array(32),new Uint8Array(),new Uint8Array(12),new Uint8Array(16))).rejects.toThrow('cloud_host_capability_unavailable');
 failure='authentication_failed';await expect(ports.crypto.decrypt(new Uint8Array(32),new Uint8Array(),new Uint8Array(12),new Uint8Array(16))).rejects.toThrow('authentication_failed');
});
test('cloud UTF-8 uses bounded native chunks without changing valid JSON bytes or splitting surrogate pairs',()=>{
 const global=globalThis as any,previous=global.pod,calls:string[]=[];
 try{global.pod={encodeUtf8Chunk:(part:string,policy:string)=>{expect(policy).toBe('replacement');expect(part.length).toBeLessThanOrEqual(4096);expect(part.charCodeAt(part.length-1)).not.toBe(0xd83d);calls.push(part);return new TextEncoder().encode(part);}};
 const raw=JSON.stringify({cache:'中😀\u0000'.repeat(16384)});expect(utf8Encode(raw)).toEqual(new TextEncoder().encode(raw));expect(calls.length).toBeGreaterThan(16);
 }finally{global.pod=previous;}
});
test('cloud file chunks use bounded native Base64 and preserve exact publication bytes',async()=>{
 const global=globalThis as any,previous=global.pod,encodedSizes:number[]=[],files=new Map<string,Buffer>();let next=0;
 try{global.pod={encodeBase64Chunk:(bytes:Uint8Array)=>{encodedSizes.push(bytes.length);expect(bytes.length).toBeLessThanOrEqual(3072);return Buffer.from(bytes).toString('base64');}};
 const ports=createCloudHostPorts(async<T>(method:string,args:any)=>{
  if(method==='file.createTemp'){const path='temp'+(++next);files.set(path,Buffer.alloc(0));return {path} as T;}
  if(method==='file.write'){const before=files.get(args.path)!;expect(args.expectedOffset).toBe(before.length);const value=Buffer.concat([before,Buffer.from(args.dataBase64,'base64')]);files.set(args.path,value);return {size:value.length} as T;}
  if(method==='file.commit'){const value=files.get(args.path)!;expect(args.expectedSize).toBe(value.length);expect(args.expectedSha256).toBe(createHash('sha256').update(value).digest('hex'));files.set(args.target,value);files.delete(args.path);return {} as T;}
  if(method==='file.delete'){files.delete(args.path);return {} as T;}
  if(method==='crypto.hash')return {digestBase64:createHash('sha256').update(Buffer.from(args.dataBase64,'base64')).digest('base64')} as T;
  if(method==='file.hash')return {sha256:createHash('sha256').update(files.get(args.path)!).digest('hex')} as T;
  throw Error(method);
 },{require(){}});
 const input=Uint8Array.from({length:65537},(_,i)=>i%251);await ports.files.writeAtomic('cache',input);expect(files.get('cache')).toEqual(Buffer.from(input));expect([...files.keys()]).toEqual(['cache']);expect(encodedSizes.length).toBeGreaterThan(20);
 }finally{global.pod=previous;}
});

test('cloud hash/gzip use the existing bounded native byte ABI without host file roundtrips and retain the output bound',async()=>{
 const global=globalThis as any,previous=global.pod;try{
  const {gunzipSync,gzipSync}=await import('node:zlib');let calls=0;global.pod={sha256Bytes:(b:Uint8Array)=>{expect(b.length).toBeLessThanOrEqual(256*1024);return new Uint8Array(createHash('sha256').update(b).digest());},gunzipBytes:(b:Uint8Array)=>{const out=gunzipSync(b);return out.length<=256*1024?new Uint8Array(out):null;}};
  const ports=createCloudHostPorts(async()=>{calls++;throw Error('native bytes must not stage files');},{require(){}}),body=new Uint8Array(128*1024).fill(71),zip=new Uint8Array(gzipSync(body));expect(await ports.crypto.sha256(body)).toBe(createHash('sha256').update(body).digest('hex'));expect(await ports.crypto.gunzip(zip,body.length)).toEqual(body);await expect(ports.crypto.gunzip(zip,body.length-1)).rejects.toThrow('cloud_snapshot_inflate_limit');expect(calls).toBe(0);
 }finally{global.pod=previous;}
});
