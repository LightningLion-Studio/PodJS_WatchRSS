import {PRIVATE_OVERLAY_FEATURE,PRIVATE_OVERLAY_NAME,planPrivateOverlay} from './private-overlay';
import {mergeCloudArchive,retireCloudArchive} from './archive-compat';
import {rawJsonUnknownBytes,parseRawJsonAsync,type RawJsonNode} from '@podjs/framework/json-raw';
import {readWrss} from './wrss';
import {bindCloudRaw,cloudRaw,cloudCompatibility,requireCloudWritable,parseRawJson,rawJsonValue,rawJsonProperty,rawJsonText,patchCloudObject,patchRawJsonObject,schemaFields,chunkFields,objectFields,manifestFields,settingFields,recordFields,type CloudFeatures} from './compatibility';
import {base64ToBytes,bytesToBase64,equalBytesAsync} from '@podjs/framework/bytes';
import {utf8Encode,utf8Decode,type EncryptedCloudSnapshot} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface SnapshotCrypto {
 yieldTurn?():Promise<void>;
 random(size:number):Promise<Uint8Array>;
 sha256(bytes:Uint8Array):Promise<string>;
 hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
 encrypt(key:Uint8Array,aad:Uint8Array,input:Uint8Array):Promise<{nonce:Uint8Array;ciphertext:Uint8Array}>;
 decrypt(key:Uint8Array,aad:Uint8Array,nonce:Uint8Array,ciphertext:Uint8Array):Promise<Uint8Array>;
 gzip(bytes:Uint8Array):Promise<Uint8Array>;
 gunzip(bytes:Uint8Array,maxBytes:number):Promise<Uint8Array>;
}
export interface CloudChunk {plaintextSha256:string;ciphertextSha256:string;plaintextBytes:number;ciphertextBytes:number;saltBase64:string;nonceBase64:string;}
export interface CloudObject {features?:CloudFeatures;entryRef?:{object:string;entryPath:string;encoding:'identity'};objectKeyEnvelope?:{version:1;scope:string;saltBase64:string;nonceBase64:string;ciphertextBase64:string};privateBook?:Record<string,unknown>;privateArticle?:Record<string,unknown>;contentSha256?:string;name:string;encoding:'gzip-chunks-v1'|'gzip'|'identity';originalBytes:number;encodedBytes:number;chunks:CloudChunk[];readerKeyEnvelope?:{version:number;saltBase64:string;nonceBase64:string;ciphertextBase64:string;scope?:string};}
export interface CloudManifest {features?:CloudFeatures;format:'watchrss-cloud-snapshot';schemaVersion:2;snapshotId:string;sourceDeviceId:string;deviceSequence:number;keyVersion:number;createdAtMillis:number;parentHeads:Record<string,string>;observedHeads:Record<string,number>;objects:CloudObject[];settings:Record<string,unknown>;credentialEnvelopes:Record<string,never>;}
export interface LogicalObject {privateBook?:Record<string,unknown>;privateArticle?:Record<string,unknown>;contentSha256?:string;name:string;bytes:Uint8Array;compress?:boolean;}
const authenticatedRoots=new WeakMap<CloudManifest,string>();
export interface SnapshotInput {reuseManifests?:readonly CloudManifest[];removedPrivateArticleUrls?:readonly string[];features?:CloudFeatures;removedObjectNames?:readonly string[];readPreviousChunk?:(hash:string)=>Promise<Uint8Array>;removedPrivateArticleIds?:readonly string[];accountKey:Uint8Array;keyVersion:number;sourceDeviceId:string;sequence:number;objects:LogicalObject[];parentHeads:Record<string,string>;observedHeads:Record<string,number>;snapshotId:string;createdAtMillis:number;previous?:CloudManifest;carried?:CloudObject[];settings?:Record<string,unknown>;}
export interface CloudCodecWriteGates {writeV1():boolean;migrationV1?():boolean}
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
 if(cloudCompatibility(m).opaque)return;
 check(Array.isArray(m.objects)&&m.objects.length<=1024&&new Set(m.objects.map(o=>o.name)).size===m.objects.length);
 check(m.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE)===true?m.objects.some(o=>o.name===PRIVATE_OVERLAY_NAME&&!o.entryRef):!m.objects.some(o=>o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('private/articles/')),'cloud_format_overlay_invalid');
 for(const o of m.objects){
  check(o&&typeof o.name==='string'&&o.name.length>0);if(cloudCompatibility(o).opaque)continue;
  check(!(o.readerKeyEnvelope&&o.objectKeyEnvelope));
  if(o.objectKeyEnvelope){const e=o.objectKeyEnvelope;check(o.features?.incompat?.includes('r48.object-key.v1')&&e.version===1&&/^migration:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.scope));for(const [v,n]of [[e.saltBase64,16],[e.nonceBase64,12],[e.ciphertextBase64,48]] as const){const b=base64ToBytes(v);check(b.length===n&&bytesToBase64(b)===v);}}
  if(o.entryRef){const r=o.entryRef;check(o.features?.incompat?.includes('r48.entry-ref.v1')&&!o.chunks&&!o.readerKeyEnvelope&&!o.objectKeyEnvelope&&r.encoding==='identity'&&typeof r.object==='string'&&typeof r.entryPath==='string'&&!!r.entryPath&&!r.entryPath.startsWith('/')&&!r.entryPath.includes('\\')&&!r.entryPath.includes('\0')&&r.entryPath.split('/').every(p=>p&&p!=='.'&&p!=='..'));const target=m.objects.find(x=>x.name===r.object);check(target&&target!==o&&!target.entryRef&&Array.isArray(target.chunks)&&target.chunks.length>0&&size(o.originalBytes));continue;}
  check(typeof o.name==='string'&&o.name.length>0&&['gzip-chunks-v1','gzip','identity'].includes(o.encoding)&&size(o.originalBytes)&&size(o.encodedBytes)&&Array.isArray(o.chunks)&&o.chunks.length>0&&o.chunks.length<=1024);
  for(const c of o.chunks){check(hashPattern.test(c.plaintextSha256)&&hashPattern.test(c.ciphertextSha256)&&size(c.plaintextBytes,8*1024*1024)&&size(c.ciphertextBytes,8*1024*1024)&&c.ciphertextBytes===c.plaintextBytes+51&&typeof c.saltBase64==='string'&&typeof c.nonceBase64==='string');check(base64ToBytes(c.saltBase64).length===16&&base64ToBytes(c.nonceBase64).length===12);}
  check(o.chunks.reduce((n,c)=>n+c.plaintextBytes,0)===o.encodedBytes);
 }
}
function parseManifestText(text:string,node:RawJsonNode=parseRawJson(text,{maxBytes:8*1024*1024})):CloudManifest {const manifest=rawJsonValue<CloudManifest>(node);bindCloudRaw(manifest,node,{...schemaFields(manifestFields),settings:schemaFields(settingFields)},1048576,[PRIVATE_OVERLAY_FEATURE]);if(cloudCompatibility(manifest).opaque){validateManifest(manifest);return manifest;}check(Array.isArray(manifest.objects)&&manifest.objects.length<=1024);let unknown=0;const objectNodes=rawJsonProperty(node,'objects')?.items??[];for(let i=0;i<(manifest.objects??[]).length;i++){const o=manifest.objects[i],n=objectNodes[i];check(o&&n);const chunkNodes=rawJsonProperty(n,'chunks')?.items??[];let nested=0;for(let j=0;j<(o.chunks??[]).length;j++){const c=o.chunks[j],cn=chunkNodes[j];check(c&&cn);bindCloudRaw(c,cn,schemaFields(chunkFields),4096);nested+=rawJsonUnknownBytes(cn,schemaFields(chunkFields));}for(const [field,keys]of [['privateArticle',recordFields.article],['privateBook',[...recordFields.book,'packagePath']],['readerKeyEnvelope',['version','scope','saltBase64','nonceBase64','ciphertextBase64']],['objectKeyEnvelope',['version','scope','saltBase64','nonceBase64','ciphertextBase64']],['entryRef',['object','entryPath','encoding']]] as [string,readonly string[]][]){const child=rawJsonProperty(n,field);if(child)nested+=rawJsonUnknownBytes(child,schemaFields(keys));}bindCloudRaw(o,n,schemaFields(objectFields),4096,['r48.entry-ref.v1','r48.object-key.v1'],nested);unknown+=rawJsonUnknownBytes(n,schemaFields(objectFields))+nested;}bindCloudRaw(manifest,node,{...schemaFields(manifestFields),settings:schemaFields(settingFields)},1048576,[PRIVATE_OVERLAY_FEATURE],unknown);validateManifest(manifest);return manifest;}
function serializeDescriptor(o:CloudObject,basis?:CloudObject):string {
 const raw=basis&&cloudRaw(basis);if(o===basis&&raw)return rawJsonText(raw);
 const overrides:Record<string,string|undefined>={};
 if(o.entryRef)overrides.chunks=undefined;else overrides.chunks='['+(o.chunks??[]).map(c=>patchCloudObject(c as unknown as Record<string,any>,chunkFields,basis?.chunks?.find(old=>old.ciphertextSha256===c.ciphertextSha256))).join(',')+']';
 for(const field of ['readerKeyEnvelope','objectKeyEnvelope','entryRef'] as const)if(!o[field])overrides[field]=undefined;
 for(const [field,keys]of [['privateArticle',recordFields.article],['privateBook',[...recordFields.book,'packagePath']]] as const){const child=raw&&rawJsonProperty(raw,field),v=o[field];if(child&&v){const edits=Object.fromEntries(keys.map(k=>[k,Object.prototype.hasOwnProperty.call(v,k)?JSON.stringify(v[k]):undefined]));overrides[field]=patchRawJsonObject(child,edits);}else if(!v)overrides[field]=undefined;}
 if(basis?.features&&!o.features)overrides.features=JSON.stringify({...basis.features,incompat:basis.features.incompat.filter(x=>x!=='r48.object-key.v1'&&x!=='r48.entry-ref.v1')});
 return patchCloudObject(o as unknown as Record<string,any>,objectFields,basis,overrides);
}
function serializeManifest(m:CloudManifest,basis?:CloudManifest):string {
 const overrides:Record<string,string>={objects:'['+m.objects.map(o=>serializeDescriptor(o,basis?.objects.find(old=>old.name===o.name))).join(',')+']'};
 const settings=basis&&cloudRaw(basis)&&rawJsonProperty(cloudRaw(basis)!,'settings');if(settings)overrides.settings=patchRawJsonObject(settings,Object.fromEntries(Object.entries(m.settings).map(([k,v])=>[k,JSON.stringify(v)])));
 return patchCloudObject(m as unknown as Record<string,any>,manifestFields,basis,overrides);
}
/** Writes WRSSCM3, reads WRSSCM2/3; WRSSCC2 format; keys and gzip are supplied by the host. */
export class WatchCloudCodec {
 constructor(private crypto:SnapshotCrypto,private guard:CloudGuard=cloudDisabled,private writeGates?:CloudCodecWriteGates){}
 private requireWriteV1(){this.guard.require();check(this.writeGates?.writeV1()===true,'cloud_format_write_disabled');}
 /** This creates only the wrapping envelope. Output chunks remain encrypted
  * under the per-plan read-only root; ordinary edits always use accountKey. */
 async wrapObjectKey(accountKey:Uint8Array,outputRoot:Uint8Array,planId:string):Promise<NonNullable<CloudObject['objectKeyEnvelope']>>{
  this.requireWriteV1();check(this.writeGates?.migrationV1?.()===true,'cloud_format_migration_disabled');
  check(accountKey.length===32&&outputRoot.length===32&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(planId));
  const scope='migration:'+planId,salt=await this.crypto.random(16);check(salt.length===16);
  const key=await this.crypto.hkdf(accountKey,salt,utf8Encode('watchrss/cloud/object-key/v1'));
  try{const sealed=await this.crypto.encrypt(key,utf8Encode('watchrss-object-key-v1:'+scope),outputRoot);check(sealed.nonce.length===12&&sealed.ciphertext.length===48);this.requireWriteV1();check(this.writeGates?.migrationV1?.()===true,'cloud_format_migration_disabled');return {version:1,scope,saltBase64:bytesToBase64(salt),nonceBase64:bytesToBase64(sealed.nonce),ciphertextBase64:bytesToBase64(sealed.ciphertext)};}
  finally{key.fill(0);}
 }
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
  if(input.previous)requireCloudWritable(input.previous);
  const rootIdentity=await this.crypto.sha256(input.accountKey);if(input.previous?.keyVersion===input.keyVersion)check(authenticatedRoots.get(input.previous)===rootIdentity,'cloud_format_reuse_scope');
  if(input.previous?.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE)||input.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE))this.requireWriteV1();
  const overlayWrite=this.writeGates?.writeV1()===true;
  if(overlayWrite&&input.previous?.objects.some(o=>o.name==='private-library.wrss'||o.name===PRIVATE_OVERLAY_NAME)&&(input.objects.some(o=>o.name==='private-library.wrss')||input.removedPrivateArticleIds?.length||input.removedObjectNames?.length))check(input.readPreviousChunk,'cloud_format_previous_missing');
  if(overlayWrite&&input.previous&&input.readPreviousChunk)input=await planPrivateOverlay(input,this.crypto,async object=>(await this.restore(input.accountKey,input.previous!,input.readPreviousChunk!,[object])).get(object.name)!);
  if(input.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE))this.requireWriteV1();
  const requested=new Set(input.objects.map(o=>o.name)),explicit=input.carried??[];const retained=(input.previous?.keyVersion===input.keyVersion?input.previous.objects:[]).filter(o=>!requested.has(o.name)&&!explicit.some(c=>c.name===o.name)&&!['rss-state.json','library-sync.json'].includes(o.name)&&!input.removedObjectNames?.includes(o.name));
  const logicalObjects=[...input.objects];const oldArchive=retained.find(o=>o.name==='private-library.wrss');if(oldArchive&&input.readPreviousChunk&&input.removedPrivateArticleIds?.length){requireCloudWritable(oldArchive);const bytes=(await this.restore(input.accountKey,input.previous!,input.readPreviousChunk,[oldArchive])).get(oldArchive.name)!;const remaining=await retireCloudArchive(bytes,input.removedPrivateArticleIds,(b,max)=>this.crypto.gunzip(b,max));retained.splice(retained.indexOf(oldArchive),1);if(remaining)logicalObjects.push({name:oldArchive.name,bytes:remaining,compress:false});}
  for(const o of explicit)if((o.entryRef||o.objectKeyEnvelope)&&!input.previous?.objects.includes(o)){this.requireWriteV1();if(o.objectKeyEnvelope)check(this.writeGates?.migrationV1?.()===true,'cloud_format_migration_disabled');}
  const carried=[...explicit,...retained];
  for(const o of input.previous?.objects??[])if(cloudCompatibility(o).readOnly&&(requested.has(o.name)||!carried.some(c=>c.name===o.name)))throw Error('cloud_format_read_only');
  check(!carried.length||input.previous?.keyVersion===input.keyVersion,'轮换密钥后不能沿用旧数据块');
  check(new Set([...input.objects,...carried].map(o=>o.name)).size===input.objects.length+carried.length);
  for(const m of input.reuseManifests??[])check(authenticatedRoots.get(m)===rootIdentity&&m.keyVersion===input.keyVersion,'cloud_format_reuse_scope');
  const reusable=new Map(input.previous?.keyVersion===input.keyVersion?input.previous.objects.filter(o=>!o.readerKeyEnvelope&&!o.objectKeyEnvelope&&!o.entryRef&&!cloudCompatibility(o).opaque).flatMap(o=>o.chunks??[]).map(c=>[c.plaintextSha256,c]):[]);
  for(const m of input.reuseManifests??[])if(!cloudCompatibility(m).readOnly)for(const o of m.objects)if(!o.readerKeyEnvelope&&!o.objectKeyEnvelope&&!o.entryRef&&!cloudCompatibility(o).readOnly)for(const c of o.chunks??[])if(!reusable.has(c.plaintextSha256))reusable.set(c.plaintextSha256,c);
  const newChunks=new Map<string,Uint8Array>();const canonical=(c:CloudChunk)=>({...c,saltBase64:bytesToBase64(base64ToBytes(c.saltBase64)),nonceBase64:bytesToBase64(base64ToBytes(c.nonceBase64))});const objects:CloudObject[]=[...carried];
  for(const original of logicalObjects){let logical=original;const old=input.previous?.objects.find(o=>o.name===logical.name);if(old&&(old.objectKeyEnvelope||old.readerKeyEnvelope)&&input.previous?.keyVersion===input.keyVersion&&input.readPreviousChunk&&this.writeGates?.writeV1()===true){const bytes=(await this.restore(input.accountKey,input.previous,input.readPreviousChunk,[old])).get(old.name)!;if(bytes.length===logical.bytes.length&&await this.crypto.sha256(bytes)===await this.crypto.sha256(logical.bytes)){objects.push({...old,...(logical.privateArticle?{privateArticle:logical.privateArticle}:{}),...(logical.privateBook?{privateBook:logical.privateBook}:{})});continue;}}if(old&&input.previous?.keyVersion===input.keyVersion&&old.contentSha256&&old.originalBytes===logical.bytes.length&&old.contentSha256===await this.crypto.sha256(logical.bytes)){objects.push({...old,...(logical.privateArticle?{privateArticle:logical.privateArticle}:{}),...(logical.privateBook?{privateBook:logical.privateBook}:{})});continue;}if(input.objects.includes(original)&&old&&input.previous?.keyVersion===input.keyVersion&&logical.name==='private-library.wrss'&&input.readPreviousChunk){const previous=(await this.restore(input.accountKey,input.previous!,input.readPreviousChunk,[old])).get(old.name)!;if(await equalBytesAsync(previous,logical.bytes,{yield:this.crypto.yieldTurn})){objects.push(old);continue;}const merged=await mergeCloudArchive(previous,logical.bytes,(b,max)=>this.crypto.gunzip(b,max),input.removedPrivateArticleIds);if(merged.unchanged){objects.push(old);continue;}logical={...logical,bytes:merged.bytes};}
   check(logical.bytes.length<=MAX_OBJECT_BYTES);const chunks:CloudChunk[]=[];let encodedBytes=0;
   for(const slice of contentChunks(logical.bytes)){
    const plain=logical.compress===false?slice:await this.crypto.gzip(slice);
    const plaintextSha256=await this.crypto.sha256(plain);encodedBytes+=plain.length;
    let descriptor=reusable.get(plaintextSha256);
    if(!descriptor){const {blob,salt,nonce}=await this.seal(input.accountKey,plain,'chunk',`watchrss-cloud-chunk-v1:${plaintextSha256}`);const ciphertextSha256=await this.crypto.sha256(blob);descriptor={plaintextSha256,ciphertextSha256,plaintextBytes:plain.length,ciphertextBytes:blob.length,saltBase64:bytesToBase64(salt),nonceBase64:bytesToBase64(nonce)};newChunks.set(ciphertextSha256,blob);reusable.set(plaintextSha256,descriptor);}
    chunks.push(canonical(descriptor));
   }
   objects.push({...logical.privateBook?{privateBook:logical.privateBook}:{},...logical.privateArticle?{privateArticle:logical.privateArticle}:{},...logical.contentSha256?{contentSha256:logical.contentSha256}:{},name:logical.name,encoding:logical.compress===false?'identity':'gzip-chunks-v1',originalBytes:logical.bytes.length,encodedBytes,chunks});
  }
  const constructed:CloudManifest={...((input.features??input.previous?.features)?{features:input.features??input.previous?.features}:{}),format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:input.snapshotId,sourceDeviceId:input.sourceDeviceId,deviceSequence:input.sequence,keyVersion:input.keyVersion,createdAtMillis:input.createdAtMillis,parentHeads:{...input.parentHeads},observedHeads:{...input.observedHeads},objects,settings:input.settings??{},credentialEnvelopes:{}};
  const text=serializeManifest(constructed,input.previous),manifest=parseManifestText(text);
  // Never publish an unverified archive reference. A name/path assertion alone
  // cannot prove that the immutable target contains the requested bytes.
  for(const o of explicit)if(o.entryRef&&!input.previous?.objects.includes(o)){
   check(input.readPreviousChunk,'cloud_entry_ref_unverified');
   const body=(await this.restore(input.accountKey,manifest,input.readPreviousChunk,[manifest.objects.find(x=>x.name===o.name)!])).get(o.name)!;
   if(o.contentSha256)check(await this.crypto.sha256(body)===o.contentSha256,'cloud_entry_ref_hash');
   this.requireWriteV1();
  }
  const {blob}=await this.seal(input.accountKey,utf8Encode(text),'manifest',`watchrss-cloud-manifest-v2:${manifest.snapshotId}`,manifest.snapshotId);
  if(manifest.features?.incompat.includes(PRIVATE_OVERLAY_FEATURE)||explicit.some(o=>(o.entryRef||o.objectKeyEnvelope)&&!input.previous?.objects.includes(o)))this.requireWriteV1();
  authenticatedRoots.set(manifest,rootIdentity);
  return {manifest:Object.assign(manifest,{allChunks:manifest.objects.flatMap(o=>o.chunks??[])}),encryptedManifest:blob,newChunks};
 }
 async decryptManifest(key:Uint8Array,id:string,encrypted:Uint8Array):Promise<CloudManifest>{
  this.guard.require();const plain=await this.open(key,encrypted,'manifest',`watchrss-cloud-manifest-v2:${id}`,id);try{const text=utf8Decode(plain),round=utf8Encode(text);check(await equalBytesAsync(round,plain,{yield:this.crypto.yieldTurn}));const manifest=parseManifestText(text,await parseRawJsonAsync(text,{maxBytes:8*1024*1024,yield:this.crypto.yieldTurn}));check(manifest.snapshotId===id);authenticatedRoots.set(manifest,await this.crypto.sha256(key));return manifest;}catch(error){if(error instanceof Error&&error.message==='raw_json_depth')throw Error('cloud_format_depth');throw error;}finally{plain.fill(0);}
 }
 async restore(key:Uint8Array,manifest:CloudManifest,read:(hash:string)=>Promise<Uint8Array>,selected:readonly CloudObject[]=manifest.objects):Promise<Map<string,Uint8Array>>{
  this.guard.require();validateManifest(manifest);if(cloudCompatibility(manifest).opaque)throw Error('cloud_format_opaque');const result=new Map<string,Uint8Array>();
  for(const o of selected){if(cloudCompatibility(o).opaque)throw Error('cloud_format_opaque');if(o.entryRef){const target=manifest.objects.find(x=>x.name===o.entryRef!.object);check(target&&!target.entryRef);const bytes=(await this.restore(key,manifest,read,[target])).get(target.name);check(bytes);const zip=await readWrss(bytes,(b,max)=>this.crypto.gunzip(b,max));const body=zip.get(o.entryRef.entryPath);check(body&&body.length===o.originalBytes,'cloud_entry_ref_missing');result.set(o.name,body);continue;}const parts:Uint8Array[]=[];let total=0;let root=key;
   const envelope=o.objectKeyEnvelope??o.readerKeyEnvelope;if(envelope){check(envelope.version===1);const derived=await this.crypto.hkdf(key,base64ToBytes(envelope.saltBase64),utf8Encode(o.objectKeyEnvelope?'watchrss/cloud/object-key/v1':'watchrss/cloud/reader-key/v1'));try{root=await this.crypto.decrypt(derived,utf8Encode(`${o.objectKeyEnvelope?'watchrss-object-key-v1':'watchrss-reader-key-v1'}:${envelope.scope||o.name}`),base64ToBytes(envelope.nonceBase64),base64ToBytes(envelope.ciphertextBase64));check(root.length===32);}finally{derived.fill(0);}}
   try{
   for(const c of o.chunks){const blob=await read(c.ciphertextSha256);check(blob.length===c.ciphertextBytes&&await this.crypto.sha256(blob)===c.ciphertextSha256);check(bytesToBase64(blob.slice(7,23)).replace(/=+$/,'')===c.saltBase64.replace(/=+$/,'')&&bytesToBase64(blob.slice(23,35)).replace(/=+$/,'')===c.nonceBase64.replace(/=+$/,''));const plain=await this.open(root,blob,'chunk',`watchrss-cloud-chunk-v1:${c.plaintextSha256}`);check(plain.length===c.plaintextBytes&&await this.crypto.sha256(plain)===c.plaintextSha256);const part=o.encoding==='gzip-chunks-v1'?await this.crypto.gunzip(plain,Math.min(CLOUD_CHUNK_BYTES,o.originalBytes-total)):plain;total+=part.length;check(total<=(o.encoding==='gzip'?o.encodedBytes:o.originalBytes));parts.push(part);}
   const bytes=o.encoding==='gzip'?await this.crypto.gunzip(join(parts),o.originalBytes):join(parts);check(bytes.length===o.originalBytes);if(o.contentSha256)check(await this.crypto.sha256(bytes)===o.contentSha256);result.set(o.name,bytes);
   }finally{if(root!==key)root.fill(0);}
  }return result;
 }
}
