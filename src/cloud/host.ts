import {hostOperation,fileChunks,secureStorage} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {debugGate,initializeDebugBuild} from '../debug/host';
import {WatchCloudCodec,type SnapshotCrypto} from './codec';
import {WatchCloudKeyManager,type CloudStringStore} from './keys';
import {WatchCloudCache,type CloudBlobStore} from './cache';
import {WatchCloudStateStore} from './state';
import {WatchCloudClient} from './client';
import {SupabaseTusUploader} from './tus';
import type {CloudClientOptions,HttpTransport} from './types';
const b64=bytesToBase64,bytes=base64ToBytes;
async function operation<T>(method:string,args:Record<string,unknown>):Promise<T>{debugGate.require();return hostOperation<T>(method,args).result;}
const data=async(method:string,args:Record<string,unknown>)=>bytes((await operation<{dataBase64:string}>(method,args)).dataBase64);
async function withInput<T>(input:Uint8Array,action:(path:string)=>Promise<T>):Promise<T>{
 debugGate.require();if(input.length>8*1024*1024)throw Error('云加密输入过大');
 const temporary=await fileChunks.createTemp('cloud-crypto');
 try {for(let offset=0;offset<input.length;offset+=65536){const part=input.subarray(offset,offset+65536);const result=await fileChunks.append(temporary.path,b64(part),offset);if(result.size!==offset+part.length)throw Error('云加密输入不完整');}return await action(temporary.path);}
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
const crypto:SnapshotCrypto={
 random:async size=>bytes((await operation<{bytesBase64:string}>('crypto.random',{bytes:size})).bytesBase64),
 sha256:async input=>input.length>256*1024?withInput(input,async path=>(await fileChunks.hash(path)).sha256):Array.from(bytes((await operation<{digestBase64:string}>('crypto.hash',{dataBase64:b64(input)})).digestBase64),b=>b.toString(16).padStart(2,'0')).join(''),
 hkdf:async(key,salt,info)=>bytes((await operation<{keyBase64:string}>('crypto.hkdfSha256',{inputBase64:b64(key),saltBase64:b64(salt),infoBase64:b64(info)})).keyBase64),
 encrypt:async(key,aad,input)=>{const value=await transform('crypto.largeAesGcmEncrypt',input,{keyBase64:b64(key),aadBase64:b64(aad)});if(!value.nonceBase64)throw Error('缺少云加密 nonce');return {nonce:bytes(value.nonceBase64),ciphertext:value.bytes};},
 decrypt:async(key,aad,nonce,ciphertext)=>(await transform('crypto.largeAesGcmDecrypt',ciphertext,{keyBase64:b64(key),aadBase64:b64(aad),nonceBase64:b64(nonce)})).bytes,
 gzip:async input=>(await transform('crypto.gzip',input)).bytes,
 gunzip:async(input,maxBytes)=>(await transform('crypto.gunzip',input,{maxBytes})).bytes,
};
const files:CloudBlobStore={
 async read(path){debugGate.require();const stat=await fileChunks.stat(path);if(!stat.exists)return undefined;if(!stat.file||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>8*1024*1024)throw Error('无效云缓存文件');const out=new Uint8Array(stat.size);for(let offset=0;offset<out.length;){const part=await fileChunks.read(path,offset,Math.min(65536,out.length-offset)),value=bytes(part.dataBase64);if(part.offset!==offset||part.size!==out.length||!value.length||value.length>out.length-offset)throw Error('云缓存读取不完整');out.set(value,offset);offset+=value.length;}return out;},
 async writeAtomic(path,input){debugGate.require();const temporary=await fileChunks.createTemp('watch-cloud-cache');try{for(let offset=0;offset<input.length;offset+=65536){const part=input.subarray(offset,offset+65536);const written=await fileChunks.append(temporary.path,b64(part),offset);if(written.size!==offset+part.length)throw Error('云缓存写入不完整');}await fileChunks.commit(temporary.path,path,input.length,await crypto.sha256(input));}finally{await fileChunks.remove(temporary.path).catch(()=>{});}},
};
const store:CloudStringStore={async get(key){debugGate.require();return secureStorage.get(key);},async set(key,value){debugGate.require();await secureStorage.set(key,value);}};
/** No registration, timer, worker or network starts during module import/factory creation.
 * K2 will supply the bounded HTTP transport and wire this foundation into the sync service.
 * Release/unknown builds return before reading storage, keys or making network calls. */
export async function createHostCloudFoundation(userId:string,deviceId:string,http:HttpTransport,options:CloudClientOptions){
 if(!await initializeDebugBuild())return undefined;
 debugGate.require();if(!userId||!deviceId)throw Error('云同步缺少账号或设备身份');
 return {
  codec:new WatchCloudCodec(crypto,debugGate),
  keys:new WatchCloudKeyManager({sha256:crypto.sha256,publicKey:async keyId=>(await operation<{publicKeySpki:string}>('crypto.ecdhPublicKey',{keyId})).publicKeySpki,unwrap:args=>data('crypto.ecdhUnwrap',args)},store,debugGate),
  cache:new WatchCloudCache(files,crypto.sha256,debugGate),
  state:new WatchCloudStateStore(store,userId,deviceId,debugGate),
  client:new WatchCloudClient(http,options,crypto,debugGate),
  uploader:new SupabaseTusUploader(http,crypto,{guard:debugGate}),
 };
}
