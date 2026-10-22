import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {utf8Encode,utf8Decode,type EncryptedCloudSnapshot} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface SnapshotCrypto {
 random(size:number):Promise<Uint8Array>;
 sha256(bytes:Uint8Array):Promise<string>;
 hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
 encrypt(key:Uint8Array,aad:Uint8Array,input:Uint8Array):Promise<{nonce:Uint8Array;ciphertext:Uint8Array}>;
 decrypt(key:Uint8Array,aad:Uint8Array,nonce:Uint8Array,ciphertext:Uint8Array):Promise<Uint8Array>;
 gzip(bytes:Uint8Array):Promise<Uint8Array>;
 gunzip(bytes:Uint8Array,maxBytes:number):Promise<Uint8Array>;
}
export interface CloudChunk {plaintextSha256:string;ciphertextSha256:string;plaintextBytes:number;ciphertextBytes:number;saltBase64:string;nonceBase64:string;}
export interface CloudObject {privateArticle?:Record<string,unknown>;contentSha256?:string;name:string;encoding:'gzip-chunks-v1'|'gzip'|'identity';originalBytes:number;encodedBytes:number;chunks:CloudChunk[];readerKeyEnvelope?:{version:number;saltBase64:string;nonceBase64:string;ciphertextBase64:string;scope?:string};}
export interface CloudManifest {format:'watchrss-cloud-snapshot';schemaVersion:2;snapshotId:string;sourceDeviceId:string;deviceSequence:number;keyVersion:number;createdAtMillis:number;parentHeads:Record<string,string>;observedHeads:Record<string,number>;objects:CloudObject[];settings:Record<string,unknown>;credentialEnvelopes:Record<string,never>;}
export interface LogicalObject {privateArticle?:Record<string,unknown>;contentSha256?:string;name:string;bytes:Uint8Array;compress?:boolean;}
export interface SnapshotInput {accountKey:Uint8Array;keyVersion:number;sourceDeviceId:string;sequence:number;objects:LogicalObject[];parentHeads:Record<string,string>;observedHeads:Record<string,number>;snapshotId:string;createdAtMillis:number;previous?:CloudManifest;carried?:CloudObject[];settings?:Record<string,unknown>;}
export const CLOUD_CHUNK_BYTES=4*1024*1024;
const MAX_OBJECT_BYTES=256*1024*1024;
const hashPattern=/^[0-9a-f]{64}$/;
/** Raw content boundaries precede compression; additions do not shift all later bodies. */
export function contentChunks(bytes:Uint8Array):Uint8Array[]{
 const out:Uint8Array[]=[];let start=0,rolling=0;
 for(let i=0;i<bytes.length;i++){rolling=((rolling<<1)+Math.imul(bytes[i]+1,0x9e3779b1))>>>0;const n=i-start+1;if(n>=65536&&((rolling&262143)===0||n>=1048576)){out.push(bytes.subarray(start,i+1));start=i+1;rolling=0;}}
 if(start<bytes.length||!out.length)out.push(bytes.subarray(start));return out;
}
const join=(parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let at=0;for(const b of parts){out.set(b,at);at+=b.length;}return out;};
function check(ok:unknown,message='云快照校验失败'):asserts ok {if(!ok)throw Error(message);}
const size=(v:unknown,max=MAX_OBJECT_BYTES):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
export function validateManifest(m:CloudManifest):void {
 check(m&&m.format==='watchrss-cloud-snapshot'&&m.schemaVersion===2,'不支持的云快照格式');
 check(typeof m.snapshotId==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(m.snapshotId)&&typeof m.sourceDeviceId==='string'&&m.sourceDeviceId.length>0);
 check(size(m.deviceSequence,Number.MAX_SAFE_INTEGER)&&m.deviceSequence>0&&size(m.keyVersion,Number.MAX_SAFE_INTEGER)&&m.keyVersion>0&&size(m.createdAtMillis,Number.MAX_SAFE_INTEGER));
 check(m.parentHeads&&typeof m.parentHeads==='object'&&!Array.isArray(m.parentHeads)&&Object.values(m.parentHeads).every(v=>typeof v==='string'));
 check(m.observedHeads&&typeof m.observedHeads==='object'&&!Array.isArray(m.observedHeads)&&Object.values(m.observedHeads).every(v=>size(v,Number.MAX_SAFE_INTEGER)));
 check(Array.isArray(m.objects)&&m.objects.length<=1024&&new Set(m.objects.map(o=>o.name)).size===m.objects.length);
 for(const o of m.objects){
  check(typeof o.name==='string'&&o.name.length>0&&['gzip-chunks-v1','gzip','identity'].includes(o.encoding)&&size(o.originalBytes)&&size(o.encodedBytes)&&Array.isArray(o.chunks)&&o.chunks.length>0&&o.chunks.length<=1024);
  for(const c of o.chunks){check(hashPattern.test(c.plaintextSha256)&&hashPattern.test(c.ciphertextSha256)&&size(c.plaintextBytes,8*1024*1024)&&size(c.ciphertextBytes,8*1024*1024)&&c.ciphertextBytes===c.plaintextBytes+51&&typeof c.saltBase64==='string'&&typeof c.nonceBase64==='string');check(base64ToBytes(c.saltBase64).length===16&&base64ToBytes(c.nonceBase64).length===12);}
  check(o.chunks.reduce((n,c)=>n+c.plaintextBytes,0)===o.encodedBytes);
 }
}
/** Writes WRSSCM3, reads WRSSCM2/3; WRSSCC2 format; keys and gzip are supplied by the host. */
export class WatchCloudCodec {
 constructor(private crypto:SnapshotCrypto,private guard:CloudGuard=cloudDisabled){}
 private async seal(key:Uint8Array,plain:Uint8Array,kind:'chunk'|'manifest',aad:string,snapshotId?:string){
  const salt=await this.crypto.random(16);check(salt.length===16);
  const derived=await this.crypto.hkdf(key,salt,utf8Encode(kind==='manifest'?`watchrss/cloud/manifest/v2/${snapshotId}`:'watchrss/cloud/chunk/v1'));
  try{const sealed=await this.crypto.encrypt(derived,utf8Encode(aad),plain);check(sealed.nonce.length===12);return {salt,nonce:sealed.nonce,blob:join([utf8Encode(kind==='chunk'?'WRSSCC2':'WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])};}
  finally{derived.fill(0);}
 }
 private async open(key:Uint8Array,blob:Uint8Array,kind:'chunk'|'manifest',aad:string,snapshotId?:string){
  const magic=utf8Decode(blob.subarray(0,7));check(key.length===32&&blob.length>=51&&(kind==='chunk'?magic==='WRSSCC2':magic==='WRSSCM2'||magic==='WRSSCM3'));
  const info=kind==='manifest'&&magic==='WRSSCM3'?`watchrss/cloud/manifest/v2/${snapshotId}`:`watchrss/cloud/${kind}/v1`;
  const derived=await this.crypto.hkdf(key,blob.slice(7,23),utf8Encode(info));
  try{return await this.crypto.decrypt(derived,utf8Encode(aad),blob.slice(23,35),blob.slice(35));}finally{derived.fill(0);}
 }
 async create(input:SnapshotInput):Promise<EncryptedCloudSnapshot & {manifest:CloudManifest & {allChunks:CloudChunk[]};newChunks:Map<string,Uint8Array>}>{
  this.guard.require();check(input.accountKey.length===32&&input.sequence>0&&input.keyVersion>0);
  const carried=input.carried??[];
  check(!carried.length||input.previous?.keyVersion===input.keyVersion,'轮换密钥后不能沿用旧数据块');
  check(new Set([...input.objects,...carried].map(o=>o.name)).size===input.objects.length+carried.length);
  const reusable=new Map(input.previous?.keyVersion===input.keyVersion?input.previous.objects.filter(o=>!o.readerKeyEnvelope).flatMap(o=>o.chunks).map(c=>[c.plaintextSha256,c]):[]);
  const newChunks=new Map<string,Uint8Array>();const canonical=(c:CloudChunk)=>({...c,saltBase64:bytesToBase64(base64ToBytes(c.saltBase64)),nonceBase64:bytesToBase64(base64ToBytes(c.nonceBase64))});const objects:CloudObject[]=carried.map(o=>({...o,chunks:o.chunks.map(canonical)}));
  for(const logical of input.objects){
   check(logical.bytes.length<=MAX_OBJECT_BYTES);const chunks:CloudChunk[]=[];let encodedBytes=0;
   for(const slice of contentChunks(logical.bytes)){
    const plain=logical.compress===false?slice:await this.crypto.gzip(slice);
    const plaintextSha256=await this.crypto.sha256(plain);encodedBytes+=plain.length;
    let descriptor=reusable.get(plaintextSha256);
    if(!descriptor){const {blob,salt,nonce}=await this.seal(input.accountKey,plain,'chunk',`watchrss-cloud-chunk-v1:${plaintextSha256}`);const ciphertextSha256=await this.crypto.sha256(blob);descriptor={plaintextSha256,ciphertextSha256,plaintextBytes:plain.length,ciphertextBytes:blob.length,saltBase64:bytesToBase64(salt),nonceBase64:bytesToBase64(nonce)};newChunks.set(ciphertextSha256,blob);reusable.set(plaintextSha256,descriptor);}
    chunks.push(canonical(descriptor));
   }
   objects.push({...logical.privateArticle?{privateArticle:logical.privateArticle}:{},...logical.contentSha256?{contentSha256:logical.contentSha256}:{},name:logical.name,encoding:logical.compress===false?'identity':'gzip-chunks-v1',originalBytes:logical.bytes.length,encodedBytes,chunks});
  }
  const manifest:CloudManifest={format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:input.snapshotId,sourceDeviceId:input.sourceDeviceId,deviceSequence:input.sequence,keyVersion:input.keyVersion,createdAtMillis:input.createdAtMillis,parentHeads:{...input.parentHeads},observedHeads:{...input.observedHeads},objects,settings:input.settings??{},credentialEnvelopes:{}};
  validateManifest(manifest);const {blob}=await this.seal(input.accountKey,utf8Encode(JSON.stringify(manifest)),'manifest',`watchrss-cloud-manifest-v2:${manifest.snapshotId}`,manifest.snapshotId);
  return {manifest:{...manifest,allChunks:objects.flatMap(o=>o.chunks)},encryptedManifest:blob,newChunks};
 }
 async decryptManifest(key:Uint8Array,id:string,encrypted:Uint8Array):Promise<CloudManifest>{
  this.guard.require();const manifest=JSON.parse(utf8Decode(await this.open(key,encrypted,'manifest',`watchrss-cloud-manifest-v2:${id}`,id))) as CloudManifest;
  validateManifest(manifest);check(manifest.snapshotId===id);return manifest;
 }
 async restore(key:Uint8Array,manifest:CloudManifest,read:(hash:string)=>Promise<Uint8Array>):Promise<Map<string,Uint8Array>>{
  this.guard.require();validateManifest(manifest);const result=new Map<string,Uint8Array>();
  for(const o of manifest.objects){const parts:Uint8Array[]=[];let total=0;let root=key;
   const envelope=o.readerKeyEnvelope;if(envelope){check(envelope.version===1);const derived=await this.crypto.hkdf(key,base64ToBytes(envelope.saltBase64),utf8Encode('watchrss/cloud/reader-key/v1'));try{root=await this.crypto.decrypt(derived,utf8Encode(`watchrss-reader-key-v1:${envelope.scope||o.name}`),base64ToBytes(envelope.nonceBase64),base64ToBytes(envelope.ciphertextBase64));check(root.length===32);}finally{derived.fill(0);}}
   try{
   for(const c of o.chunks){const blob=await read(c.ciphertextSha256);check(blob.length===c.ciphertextBytes&&await this.crypto.sha256(blob)===c.ciphertextSha256);check(bytesToBase64(blob.slice(7,23)).replace(/=+$/,'')===c.saltBase64.replace(/=+$/,'')&&bytesToBase64(blob.slice(23,35)).replace(/=+$/,'')===c.nonceBase64.replace(/=+$/,''));const plain=await this.open(root,blob,'chunk',`watchrss-cloud-chunk-v1:${c.plaintextSha256}`);check(plain.length===c.plaintextBytes&&await this.crypto.sha256(plain)===c.plaintextSha256);const part=o.encoding==='gzip-chunks-v1'?await this.crypto.gunzip(plain,Math.min(CLOUD_CHUNK_BYTES,o.originalBytes-total)):plain;total+=part.length;check(total<=(o.encoding==='gzip'?o.encodedBytes:o.originalBytes));parts.push(part);}
   const bytes=o.encoding==='gzip'?await this.crypto.gunzip(join(parts),o.originalBytes):join(parts);check(bytes.length===o.originalBytes);result.set(o.name,bytes);
   }finally{if(root!==key)root.fill(0);}
  }return result;
 }
}
