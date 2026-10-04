import {fileChunks} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64,stringToUtf8,utf8ToString} from '@podjs/framework/bytes';

const ROOT='legal-recovery/v1';
const MAX_BYTES=512*1024;
const CHUNK_BYTES=64*1024;
const HASH=/^[a-f0-9]{64}$/;
const OWNER=/^[A-Za-z0-9_-]{1,96}$/;
const TOKEN=/^[A-Za-z0-9_-]{1,96}$/;
// Share protection across service instances in this guest. Across guest/process
// recreation the submitting writer must markPublished before exposing a saved ref.
const published=new Set<string>();
const retired=new Set<string>();

export interface LegalDocumentIdentity {readonly page:'privacy'|'useragreement';readonly url:string}
export class LegalRecoveryIdentityError extends Error {
 constructor(){super('协议恢复URL摘要不匹配');this.name='LegalRecoveryIdentityError';}
}
export interface LegalBodyReference {
 readonly version:1;
 readonly owner:string;
 readonly identity:LegalDocumentIdentity;
 readonly identitySha256:string;
 readonly path:string;
 readonly byteLength:number;
 readonly sha256:string;
}
export interface LegalRecoveryFilePorts {
 createTemp(directory:string):Promise<{path:string}>;
 write(path:string,dataBase64:string):Promise<{size:number}>;
 append(path:string,dataBase64:string,expectedOffset:number):Promise<{size:number}>;
 hash(path:string):Promise<{size:number;sha256:string}>;
 commit(path:string,target:string,expectedSize:number,expectedSha256:string):Promise<{path:string;size:number;sha256:string;reused:boolean}>;
 read(path:string,offset:number,maxBytes:number):ReturnType<typeof fileChunks.read>;
 remove(path:string):Promise<unknown>;
 digest?(bytes:Uint8Array):Promise<string>;
}
export interface LegalRecoveryFiles {
 write(identity:LegalDocumentIdentity,content:string,owner:string):Promise<LegalBodyReference>;
 read(reference:LegalBodyReference,expectedIdentity:LegalDocumentIdentity):Promise<string>;
 /** Revoke early deletion BEFORE submitting saved state, including writes with uncertain acknowledgements. */
 markPublished(reference:LegalBodyReference):void;
 /** Only for a write result that has never entered saved state. */
 discardUnpublished(reference:LegalBodyReference):Promise<void>;
}

const hostPorts:LegalRecoveryFilePorts={
 createTemp:fileChunks.createTemp,write:fileChunks.write,append:fileChunks.append,
 hash:fileChunks.hash,commit:fileChunks.commit,read:fileChunks.read,remove:fileChunks.remove,
};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function validateOwner(owner:unknown):asserts owner is string {
 if(typeof owner!=='string'||!OWNER.test(owner))throw Error('协议恢复任务标识无效');
}
function identity(value:unknown):LegalDocumentIdentity {
 if(!object(value)||(value.page!=='privacy'&&value.page!=='useragreement')||typeof value.url!=='string'||value.url.length>2048||!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(value.url)||utf8ToString(stringToUtf8(value.url))!==value.url)throw Error('协议恢复页面标识无效');
 return Object.freeze({page:value.page,url:value.url});
}
function sameIdentity(a:LegalDocumentIdentity,b:LegalDocumentIdentity){return a.page===b.page&&a.url===b.url;}
function identityBytes(value:LegalDocumentIdentity){return stringToUtf8(JSON.stringify([value.page,value.url]));}
function key(value:LegalBodyReference){return JSON.stringify(value);}

/** Synchronous metadata validation. read() additionally verifies the URL digest and file bytes. */
export function validateLegalBodyReference(value:unknown,expectedIdentity?:LegalDocumentIdentity):LegalBodyReference {
 if(!object(value)||value.version!==1)throw Error('协议恢复引用无效');
 validateOwner(value.owner);
 const route=identity(value.identity);
 if(expectedIdentity&&!sameIdentity(route,identity(expectedIdentity)))throw Error('协议恢复页面不匹配');
 if(typeof value.sha256!=='string'||!HASH.test(value.sha256)||typeof value.identitySha256!=='string'||!HASH.test(value.identitySha256)||!Number.isSafeInteger(value.byteLength)||Number(value.byteLength)<1||Number(value.byteLength)>MAX_BYTES||typeof value.path!=='string')throw Error('协议恢复引用无效');
 const prefix=`${ROOT}/${value.owner}/${value.identitySha256}-${value.sha256}-`;
 const token=value.path.startsWith(prefix)&&value.path.endsWith('.utf8')?value.path.slice(prefix.length,-5):'';
 if(!TOKEN.test(token))throw Error('协议恢复文件路径无效');
 return Object.freeze({version:1,owner:value.owner,identity:route,identitySha256:value.identitySha256,path:value.path,byteLength:value.byteLength as number,sha256:value.sha256});
}

/** Immutable, app-owned snapshots. A unique host allocation avoids cross-reference deletion
 * when Android still holds an older saved Bundle. Published files are deliberately retained:
 * finishTask acknowledgement does not prove that Android discarded all saved references.
 * There is no published-file deletion, directory listing or eviction API. */
export function createLegalRecoveryFiles(ports:LegalRecoveryFilePorts=hostPorts):LegalRecoveryFiles {
 const known=new Map<string,LegalBodyReference>();
 const unpublished=new WeakSet<LegalBodyReference>();
 // crypto.hash accepts at most 256 KiB. Hash the complete input through a
 // separately reserved file so the legal body's 512 KiB limit remains usable.
 const fileDigest=async(bytes:Uint8Array)=>{
  let path:string|undefined;
  try {
   const allocated=await ports.createTemp('legal-recovery/digests');
   if(typeof allocated.path!=='string'||!/^legal-recovery\/digests\/\.pod-write-[A-Za-z0-9_-]{1,96}\.part$/.test(allocated.path))throw Error('协议恢复摘要临时路径无效');
   path=allocated.path;
   for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES){
    const part=bytes.subarray(offset,Math.min(bytes.length,offset+CHUNK_BYTES));
    const result=offset===0?await ports.write(path,bytesToBase64(part)):await ports.append(path,bytesToBase64(part),offset);
    if(result.size!==offset+part.length)throw Error('协议恢复摘要写入不完整');
   }
   const result=await ports.hash(path);
   if(result.size!==bytes.length)throw Error('协议恢复摘要大小不匹配');
   return result.sha256;
  }finally{if(path)try{await ports.remove(path);}catch{/* Only this reserved digest input may be removed. */}}
 };
 const digest=async(bytes:Uint8Array)=>{
  const result=await (ports.digest?ports.digest(bytes):fileDigest(bytes));
  if(typeof result!=='string'||!HASH.test(result))throw Error('协议恢复摘要无效');
  return result;
 };
 const verifyHash=async(path:string,size:number,sha256:string)=>{
  const actual=await ports.hash(path);
  if(actual.size!==size||actual.sha256!==sha256)throw Error('协议恢复文件摘要或大小不匹配');
 };
 async function writeBody(route:LegalDocumentIdentity,content:string,owner:string):Promise<LegalBodyReference> {
  if(typeof content!=='string'||!content.trim()||content.length>MAX_BYTES)throw Error('协议恢复正文大小无效');
  const bytes=stringToUtf8(content);
  if(bytes.length>MAX_BYTES||utf8ToString(bytes)!==content)throw Error('协议恢复正文UTF-8无效');
  const sha256=await digest(bytes),identitySha256=await digest(identityBytes(route));
  // Route pop may remove the navigation's reference while an older Android
  // Bundle still owns it. Reuse only published, verified metadata; unpublished
  // writes must stay independent because their original writer may discard them.
  for(const previous of known.values()){
   if(previous.owner!==owner||!sameIdentity(previous.identity,route)||previous.identitySha256!==identitySha256||previous.sha256!==sha256||previous.byteLength!==bytes.length||!published.has(previous.path)||retired.has(previous.path))continue;
   try{await verifyHash(previous.path,bytes.length,sha256);}catch{
    if(known.get(previous.path)===previous)known.delete(previous.path);
    continue; // Never delete a published file, even if it is now missing/corrupt.
   }
   if(known.get(previous.path)===previous&&published.has(previous.path)&&!retired.has(previous.path))return previous;
  }
  const directory=`${ROOT}/${owner}`;
  let temporary:string|undefined,exclusiveTarget:string|undefined;
  try {
   const allocated=await ports.createTemp(directory);
   const basename=typeof allocated.path==='string'&&allocated.path.startsWith(directory+'/')?allocated.path.slice(directory.length+1):'';
   const match=/^\.pod-write-([A-Za-z0-9_-]{1,96})\.part$/.exec(basename);
   if(!match)throw Error('协议恢复临时路径无效');
   temporary=allocated.path;
   const target=`${directory}/${identitySha256}-${sha256}-${match[1]}.utf8`;
   for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES){
    const part=bytes.subarray(offset,Math.min(bytes.length,offset+CHUNK_BYTES));
    const result=offset===0?await ports.write(temporary,bytesToBase64(part)):await ports.append(temporary,bytesToBase64(part),offset);
    if(result.size!==offset+part.length)throw Error('协议恢复文件写入不完整');
   }
   await verifyHash(temporary,bytes.length,sha256);
   const committed=await ports.commit(temporary,target,bytes.length,sha256);
   // An untrusted response-selected path or missing reuse flag conveys no target ownership.
   if(committed.path!==target||committed.size!==bytes.length||committed.sha256!==sha256||typeof committed.reused!=='boolean')throw Error('协议恢复提交回执不匹配');
   temporary=undefined;
   if(!committed.reused)exclusiveTarget=target;
   await verifyHash(target,bytes.length,sha256);
   const reference=validateLegalBodyReference({version:1,owner,identity:route,identitySha256,path:target,byteLength:bytes.length,sha256});
   known.set(target,reference);
   if(!committed.reused)unpublished.add(reference);
   return reference;
  }catch(error){
   if(exclusiveTarget)try{await ports.remove(exclusiveTarget);}catch{/* Preserve the primary failure. */}
   throw error;
  }finally{
   if(temporary)try{await ports.remove(temporary);}catch{/* Only the reserved placeholder is ours. */}
  }
 }
 return {
  async write(value,content,owner){
   validateOwner(owner);const route=identity(value);
   return writeBody(route,content,owner);
  },
  async read(value,expectedIdentity){
   const reference=validateLegalBodyReference(value,expectedIdentity);
   if(retired.has(reference.path))throw Error('协议恢复文件已释放');
   if(await digest(identityBytes(reference.identity))!==reference.identitySha256)throw new LegalRecoveryIdentityError();
   await verifyHash(reference.path,reference.byteLength,reference.sha256);
   const bytes=new Uint8Array(reference.byteLength);let offset=0;
   while(offset<bytes.length){
    const maximum=Math.min(CHUNK_BYTES,bytes.length-offset),chunk=await ports.read(reference.path,offset,maximum);
    if(chunk.offset!==offset||chunk.size!==bytes.length||typeof chunk.dataBase64!=='string'||chunk.dataBase64.length>4*Math.ceil(maximum/3))throw Error('协议恢复读取范围不匹配');
    const part=base64ToBytes(chunk.dataBase64);
    if(!part.length||part.length>maximum||bytesToBase64(part)!==chunk.dataBase64||chunk.eof!==(offset+part.length===bytes.length))throw Error('协议恢复读取不完整');
    bytes.set(part,offset);offset+=part.length;
   }
   if(await digest(bytes)!==reference.sha256)throw Error('协议恢复正文摘要不匹配');
   const content=utf8ToString(bytes);
   if(!content.trim()||bytesToBase64(stringToUtf8(content))!==bytesToBase64(bytes))throw Error('协议恢复正文UTF-8无效');
   if(retired.has(reference.path))throw Error('协议恢复文件已释放');
   const previous=known.get(reference.path);
   if(!previous||key(previous)!==key(reference))known.set(reference.path,reference);
   published.add(reference.path);
   // Once used for recovery, even the original write result no longer grants early deletion.
   unpublished.delete(value);
   return content;
  },
  markPublished(value){
   const reference=validateLegalBodyReference(value),previous=known.get(reference.path);
   if(retired.has(reference.path)||!previous||key(previous)!==key(reference))throw Error('协议恢复引用尚未验证或已释放');
   published.add(reference.path);
  },
  async discardUnpublished(reference){
   if(!unpublished.has(reference)||published.has(reference.path))return;
   const previous=known.get(reference.path);
   if(!previous||key(previous)!==key(reference))return;
   retired.add(reference.path);
   await ports.remove(reference.path);unpublished.delete(reference);known.delete(reference.path);
  },
 };
}
