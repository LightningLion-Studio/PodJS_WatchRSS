import {createCrypto,hex} from '@podjs/framework/crypto';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import type {CloudGuard} from './guard';
import {WatchCloudCodec,type SnapshotCrypto} from './codec';
import {WatchCloudKeyManager,type CloudStringStore} from './keys';
import {WatchCloudCache,type CloudBlobStore} from './cache';
import {WatchCloudStateStore} from './state';
import {WatchCloudClient} from './client';
import type {CloudClientOptions,HttpTransport,CloudUploadObject} from './types';
export type CloudHostRequest=<T>(method:string,args:Record<string,unknown>)=>Promise<T>;
export function createCloudHostPorts(request:CloudHostRequest,guard:CloudGuard){
 const hostOperation=<T>(method:string,args:Record<string,unknown>)=>({result:request<T>(method,args)});
 const fileChunks={
  createTemp:(directory:string)=>request<{path:string}>('file.createTemp',{directory}),
  append:(path:string,dataBase64:string,offset:number)=>request<{size:number}>('file.write',{path,dataBase64,append:true,expectedOffset:offset}),
  remove:(path:string)=>request('file.delete',{path}),
  stat:(path:string)=>request<{exists:boolean;file:boolean;size:number}>('file.stat',{path}),
  read:(path:string,offset:number,maxBytes:number)=>request<{dataBase64:string;offset:number;size:number}>('file.read',{path,offset,maxBytes}),
  hash:(path:string)=>request<{sha256:string}>('file.hash',{path}),
  commit:(temporaryPath:string,path:string,expectedSize:number,expectedSha256:string)=>request('file.commit',{path:temporaryPath,target:path,expectedSize,expectedSha256}),
 };
 const secureStorage={get:async(key:string)=>{const r=await request<{exists:boolean;value?:string}>('secure.get',{key});return r.exists?r.value:undefined;},set:(key:string,value:string)=>request('secure.set',{key,value})};
 const b64=bytesToBase64,bytes=base64ToBytes;
async function operation<T>(method:string,args:Record<string,unknown>):Promise<T>{guard.require();return hostOperation<T>(method,args).result;}
const data=async(method:string,args:Record<string,unknown>)=>bytes((await operation<{dataBase64:string}>(method,args)).dataBase64);
async function withInput<T>(input:Uint8Array,action:(path:string)=>Promise<T>):Promise<T>{
 guard.require();if(input.length>128*1024*1024)throw Error('云加密输入过大');
 const temporary=await fileChunks.createTemp('cloud-crypto');
 try {for(let offset=0;offset<input.length;offset+=32768){const part=input.subarray(offset,offset+32768);const result=await fileChunks.append(temporary.path,b64(part),offset);if(result.size!==offset+part.length)throw Error('云加密输入不完整');}return await action(temporary.path);}
 finally{await fileChunks.remove(temporary.path).catch(()=>{});}
}
async function transform(method:string,input:Uint8Array,args:Record<string,unknown>={}){
 return withInput(input,async inputPath=>{
  const result=await operation<{path:string;size:number;sha256:string;nonceBase64?:string}>(method,{...args,inputPath});
  if(!/^cloud-crypto\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(result.path))throw Error('云加密输出路径无效');
  try{const output=await files.read(result.path);if(!output||output.length!==result.size||await crypto.sha256(output)!==result.sha256)throw Error('云加密输出不完整');return {...result,bytes:output};}
  finally{await fileChunks.remove(result.path).catch(()=>{});}
 });
}
async function transcode(input:Uint8Array,method:string,maximum:number){
 return withInput(input,async path=>{const result=await operation<{path:string;size:number;sha256:string}>(method,{path,maxOutputBytes:maximum});
  if(!/^cloud-crypto\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(result.path))throw Error('无效云转码路径');
  try{const output=await files.read(result.path);if(!output||output.length!==result.size||output.length>maximum||await crypto.sha256(output)!==result.sha256)throw Error('云转码输出不完整');return output;}
  finally{await fileChunks.remove(result.path).catch(()=>{});}
 });
}
const crypto:SnapshotCrypto={
 random:async size=>bytes((await operation<{bytesBase64:string}>('crypto.random',{bytes:size})).bytesBase64),
 sha256:async input=>input.length>32768?withInput(input,async path=>(await fileChunks.hash(path)).sha256):Array.from(bytes((await operation<{digestBase64:string}>('crypto.hash',{dataBase64:b64(input)})).digestBase64),b=>b.toString(16).padStart(2,'0')).join(''),
 hkdf:async(key,salt,info)=>bytes((await operation<{keyBase64:string}>('crypto.hkdfSha256',{inputBase64:b64(key),saltBase64:b64(salt),infoBase64:b64(info)})).keyBase64),
 encrypt:async(key,aad,input)=>{const value=await transform('crypto.largeAesGcmEncrypt',input,{keyBase64:b64(key),aadBase64:b64(aad)});if(!value.nonceBase64)throw Error('缺少云加密 nonce');return {nonce:bytes(value.nonceBase64),ciphertext:value.bytes};},
 decrypt:async(key,aad,nonce,ciphertext)=>(await transform('crypto.largeAesGcmDecrypt',ciphertext,{keyBase64:b64(key),aadBase64:b64(aad),nonceBase64:b64(nonce)})).bytes,
 gzip:async input=>transcode(input,'file.gzip',64*1024*1024),
 gunzip:async(input,maxBytes)=>transcode(input,'file.gunzip',maxBytes),
};
const files:CloudBlobStore={
 async read(path){guard.require();const stat=await fileChunks.stat(path);if(!stat.exists)return undefined;if(!stat.file||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>64*1024*1024)throw Error('无效云缓存文件');const out=new Uint8Array(stat.size);for(let offset=0;offset<out.length;){const part=await fileChunks.read(path,offset,Math.min(32768,out.length-offset)),value=bytes(part.dataBase64);if(part.offset!==offset||part.size!==out.length||!value.length||value.length>out.length-offset)throw Error('云缓存读取不完整');out.set(value,offset);offset+=value.length;}return out;},
 async writeAtomic(path,input){guard.require();const temporary=await fileChunks.createTemp('watch-cloud-cache');try{for(let offset=0;offset<input.length;offset+=32768){const part=input.subarray(offset,offset+32768);const written=await fileChunks.append(temporary.path,b64(part),offset);if(written.size!==offset+part.length)throw Error('云缓存写入不完整');}await fileChunks.commit(temporary.path,path,input.length,await crypto.sha256(input));}finally{await fileChunks.remove(temporary.path).catch(()=>{});}},
};
async function removeTree(path:string):Promise<void>{const {entries}=await operation<{entries:{path:string;directory:boolean}[]}>('file.list',{path});for(const entry of entries){if(!entry.path.startsWith(path+'/'))throw Error('invalid_cleanup_path');if(entry.directory)await removeTree(entry.path);else await operation('file.delete',{path:entry.path});}}
async function cleanupCrypto(){const {entries}=await operation<{entries:{path:string}[]}>('file.list',{path:'cloud-crypto'});for(const e of entries)if(/^cloud-crypto\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(e.path))await operation('file.delete',{path:e.path});}
const genericCrypto=createCrypto(operation);
const v2Crypto={sha256:crypto.sha256,random:crypto.random,hmac:async(k:Uint8Array,b:Uint8Array)=>hex(await genericCrypto.hmacSha256(k,b)),verify:genericCrypto.verifyP256};
files.removeTree=removeTree;
const store:CloudStringStore={async get(key){guard.require();return secureStorage.get(key);},async set(key,value){guard.require();await secureStorage.set(key,value);},async update(values,removePrefixes){guard.require();await request('secure.update',{values,removePrefixes});}};
/** No registration, timer, worker or network starts during module import/factory creation.
 * The coordinator supplies the bounded HTTP transport and owns registration.
 * Callers supply a gate initialized from app.buildInfo; no import-time I/O. */
function foundation(userId:string,deviceId:string,http:HttpTransport,options:CloudClientOptions){
 guard.require();if(!userId||!deviceId)throw Error('云同步缺少账号或设备身份');
 const scopedStore:CloudStringStore={get:async key=>{await options.assertCurrent?.();return store.get(key);},set:async(key,value)=>{await options.assertCurrent?.();await store.set(key,value);},update:async(values,prefixes)=>{await options.assertCurrent?.();await store.update!(values,prefixes);}};
 const keys=new WatchCloudKeyManager({sha256:crypto.sha256,hmac:v2Crypto.hmac,publicKey:async keyId=>(await operation<{publicKeySpki:string}>('crypto.ecdhPublicKey',{keyId})).publicKeySpki,unwrap:args=>data('crypto.ecdhUnwrap',args)},scopedStore,guard,options.baseUrl);
 const cache=new WatchCloudCache(files,crypto.sha256,guard,options.baseUrl),state=new WatchCloudStateStore(scopedStore,userId,deviceId,guard,options.baseUrl);
 const invalidate=async()=>{await keys.clear(userId);await state.clear();await cache.clear(userId);};
 const client=new WatchCloudClient(http,{...options,onEpochMismatch:invalidate},crypto,guard);
 return {
  crypto,v2Crypto,files,store,invalidate,codec:new WatchCloudCodec(crypto,guard),
  keys,cache,state,
  client,
  uploader:{upload:(target:CloudUploadObject,bytes:Uint8Array)=>client.uploadObject(target,bytes)},
 };
}

 return {crypto,v2Crypto,files,store,foundation,cleanupCrypto};
}
