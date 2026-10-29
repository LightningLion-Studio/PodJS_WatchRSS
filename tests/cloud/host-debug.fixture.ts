// Isolated fake bridge: no Android/device and no network. Exercise the actual host adapter.
import {expect} from 'bun:test';
import {createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {__pumpPodEvents} from '@podjs/framework/watch';
import {createHostCloudFoundation} from '../../src/cloud/host';
const files=new Map<string,Uint8Array>();const stored=new Map<string,string>();
const commands:string[]=[],events:string[]=[];let next=0;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const decode=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
const encode=(b:Uint8Array)=>Buffer.from(b).toString('base64');
function resultFile(bytes:Uint8Array){const path=`cloud-crypto/.pod-write-${++next}.part`;files.set(path,bytes);return {path,size:bytes.length,sha256:hash(bytes)};}
async function execute(method:string,a:any):Promise<any>{
 switch(method){
  case 'app.buildInfo':return {debugBuild:process.env.CLOUD_RELEASE!=='1'};
  case 'file.createTemp':{const path=`${a.directory}/.pod-write-${++next}.part`;files.set(path,new Uint8Array());return {path};}
  case 'file.write':{const old=a.append?files.get(a.path)!:new Uint8Array(),part=decode(a.dataBase64);expect(part.length).toBeLessThanOrEqual(262144);expect(a.expectedOffset).toBe(old.length);const out=new Uint8Array(old.length+part.length);out.set(old);out.set(part,old.length);files.set(a.path,out);return {size:out.length};}
  case 'file.read':{const file=files.get(a.path)!;return {dataBase64:encode(file.slice(a.offset,a.offset+a.maxBytes)),offset:a.offset,size:file.length,eof:a.offset+a.maxBytes>=file.length};}
  case 'file.stat':{const file=files.get(a.path);return {exists:!!file,file:!!file,directory:false,size:file?.length??0,modified:0};}
  case 'file.hash':{const file=files.get(a.path)!;return {size:file.length,sha256:hash(file)};}
  case 'file.delete':files.delete(a.path);return {deleted:true};
  case 'file.commit':{const file=files.get(a.path)!;expect(file.length).toBe(a.expectedSize);expect(hash(file)).toBe(a.expectedSha256);files.set(a.target,file);files.delete(a.path);return {path:a.target,size:file.length,sha256:hash(file),reused:false};}
  case 'crypto.random':return {bytesBase64:encode(randomBytes(a.bytes))};
  case 'crypto.hash':return {digestBase64:encode(createHash('sha256').update(decode(a.dataBase64)).digest())};
  case 'crypto.hkdfSha256':return {keyBase64:encode(new Uint8Array(hkdfSync('sha256',decode(a.inputBase64),decode(a.saltBase64),decode(a.infoBase64),32)))};
  case 'file.gzip':return resultFile(new Uint8Array(gzipSync(files.get(a.path)!)));
  case 'file.gunzip':return resultFile(new Uint8Array(gunzipSync(files.get(a.path)!,{maxOutputLength:Math.max(1,a.maxOutputBytes)})));
  case 'crypto.gzip':return resultFile(new Uint8Array(gzipSync(files.get(a.inputPath)!)));
  case 'crypto.gunzip':return resultFile(new Uint8Array(gunzipSync(files.get(a.inputPath)!,{maxOutputLength:Math.max(1,a.maxBytes)})));
  case 'crypto.aesGcmEncrypt':{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',decode(a.keyBase64),nonce);cipher.setAAD(decode(a.aadBase64));return {nonceBase64:encode(nonce),ciphertextBase64:encode(Buffer.concat([cipher.update(decode(a.dataBase64)),cipher.final(),cipher.getAuthTag()]))};}
  case 'crypto.aesGcmDecrypt':{const input=decode(a.ciphertextBase64),cipher=createDecipheriv('aes-256-gcm',decode(a.keyBase64),decode(a.nonceBase64));cipher.setAAD(decode(a.aadBase64));cipher.setAuthTag(input.slice(-16));return {dataBase64:encode(Buffer.concat([cipher.update(input.slice(0,-16)),cipher.final()]))};}
  case 'crypto.largeAesGcmEncrypt':{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',decode(a.keyBase64),nonce);cipher.setAAD(decode(a.aadBase64));return {...resultFile(new Uint8Array(Buffer.concat([cipher.update(files.get(a.inputPath)!),cipher.final(),cipher.getAuthTag()]))),nonceBase64:encode(nonce)};}
  case 'crypto.largeAesGcmDecrypt':{const input=files.get(a.inputPath)!,cipher=createDecipheriv('aes-256-gcm',decode(a.keyBase64),decode(a.nonceBase64));cipher.setAAD(decode(a.aadBase64));cipher.setAuthTag(input.slice(-16));return resultFile(new Uint8Array(Buffer.concat([cipher.update(input.slice(0,-16)),cipher.final()])));}
  case 'secure.get':return {exists:stored.has(a.key),value:stored.get(a.key)};
  case 'secure.set':stored.set(a.key,a.value);return {};
  default:throw Error(`unexpected fixture method: ${method}`);
 }
}
(globalThis as any).pod={
 capabilities:()=> '["host.lifecycle","crypto.basic","data.secure","data.files.chunks"]',
 takeEvents:()=>events.shift(),
 emit:(line:string)=>{expect(line.length).toBeLessThan(1024*1024);const command=JSON.parse(line);commands.push(command.method);queueMicrotask(async()=>{
  let reply;try{reply={t:'service.result',id:command.id,ok:true,value:await execute(command.method,command.args)};}catch(error){reply={t:'service.result',id:command.id,ok:false,code:'fixture',message:String(error)};}
  const event=JSON.stringify([reply]);expect(event.length).toBeLessThan(1024*1024);events.push(event);__pumpPodEvents();
 });},
};
const foundation=await createHostCloudFoundation('user','device',{request:async()=>{throw Error('network forbidden');}},{baseUrl:'https://fixture.invalid',accessToken:'fixture'});
expect(foundation).toBeDefined();expect(commands).toEqual(['app.buildInfo']);
const original=new Uint8Array(randomBytes(4*1024*1024+33)),key=new Uint8Array(randomBytes(32));
const snapshot=await foundation!.codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'w',sequence:1,snapshotId:'host-fixture',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'library-sync.json',bytes:original}]});
expect(snapshot.manifest.objects[0].chunks.length).toBeGreaterThanOrEqual(5);expect(snapshot.manifest.objects[0].chunks.every(c=>c.plaintextBytes<=1049000)).toBe(true);
const opened=await foundation!.codec.decryptManifest(key,'host-fixture',snapshot.encryptedManifest);
expect((await foundation!.codec.restore(key,opened,async h=>snapshot.newChunks.get(h)!)).get('library-sync.json')).toEqual(original);
expect(files.size).toBe(0); // All input/output/verification temporary files removed.
await foundation!.cache.storeManifest('user','host-fixture',snapshot.encryptedManifest,true);
expect((await foundation!.cache.latest('user'))!.bytes).toEqual(snapshot.encryptedManifest);
expect(await foundation!.state.nextSequence(99)).toBe(100);
expect(commands).toContain('crypto.largeAesGcmEncrypt');expect(commands).toContain('crypto.largeAesGcmDecrypt');
expect([...files.keys()].every(path=>!path.includes('.pod-write-'))).toBe(true);

// Small record envelopes use the existing bounded authenticated memory service.
// Large snapshots keep the streamed path. Identical bytes/AAD across the boundary.
for(const size of [0,1,32768,32769,131072,131073]){
 const input=new Uint8Array(randomBytes(size)),aad=new TextEncoder().encode('record fixture');
 const before=commands.length,encrypted=await foundation!.crypto.encrypt(key,aad,input),plain=await foundation!.crypto.decrypt(key,aad,encrypted.nonce,encrypted.ciphertext);
 expect(plain).toEqual(input);const used=commands.slice(before);
 if(size<=131072){expect(used).toEqual(['crypto.aesGcmEncrypt','crypto.aesGcmDecrypt']);}
 else{expect(used).toContain('crypto.largeAesGcmEncrypt');expect(used).toContain('crypto.largeAesGcmDecrypt');}
 const wrong=aad.slice();wrong[0]^=1;await expect(foundation!.crypto.decrypt(key,wrong,encrypted.nonce,encrypted.ciphertext)).rejects.toThrow();
 expect([...files.keys()].every(path=>!path.includes('.pod-write-'))).toBe(true);
}
