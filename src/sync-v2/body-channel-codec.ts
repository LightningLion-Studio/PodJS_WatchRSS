/** P6 independent body carrier. This never applies legacy business state. */
import {hex,sha256Hex} from '@podjs/framework/crypto';
import {WatchCloudCodec,validateManifest,type SnapshotCrypto,type LogicalObject,type CloudManifest} from '../cloud/codec';
import {ContentSha256} from '@podjs/framework/content-sha256';
import {indexWrss,readWrssEntry} from '../cloud/wrss';
import {cloudCompatibility,cloudHasUnknownData} from '../cloud/compatibility';
import {bytes,jsonBytes,parseCanonicalJson,exact,hexId,uint,oid,checkD64,text,validateScope,digest,type Scope} from './protocol';
import {sameScope} from './wire';
import {signControl,verifySigned,type SigningPort} from './signing';
export const BODY_PURPOSE='p6-body.v1',BODY_DOMAIN='wrss.cloud.body.v1/carrier-sign';
export type BodyKind='book'|'asset';
export type BodyAnchor={commitOid:string;revision:string;rollbackGeneration:string};
export type BodyBinding={entityKey:string;bodyRevision:string;kind:BodyKind;logicalId:string};
export type Carrier={body:{version:1;purpose:string;scope:Scope;carrierId:string;authorDeviceId:string;entityKey:string;bodyRevision:string;keyVersion:number;anchor:BodyAnchor;sourceSnapshotId:string|null;manifest:{sha256:string;sizeBytes:number};chunks:{sha256:string;sizeBytes:number}[]};signature:string};
const guard={require(){}};
export const carrierUuid=(id:string)=>{hexId(id,32);return id.slice(0,8)+'-'+id.slice(8,12)+'-'+id.slice(12,16)+'-'+id.slice(16,20)+'-'+id.slice(20);};
/** Shared application mapping: raw immutable bytes bind the placeholder row.
 * Metadata edits alone cannot replace a body with the same revision. */
export const carrierBodyRevision=(kind:BodyKind,entityKey:string,rawHash:string)=>{hexId(entityKey,64);hexId(rawHash,64);return digest(['wrss.cloud.body.v1/'+kind,entityKey,rawHash]).slice(0,32);};
export const bodyObjectName=(kind:BodyKind,id:string)=>{
 if(kind==='asset'){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(id))throw Error('source_identity_missing');return 'notes/assets/'+id;}
 hexId(id,64);return 'books/'+id+'.jsonl';
};
function synthetic(id:string,author:string,version:number,objects:CloudManifest['objects']):CloudManifest{return {format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:id,sourceDeviceId:author,deviceSequence:1,keyVersion:version,createdAtMillis:0,parentHeads:{},observedHeads:{},objects,settings:{},credentialEnvelopes:{}};}
export function validateCarrier(value:any,scope:Scope):asserts value is Carrier{
 exact(value,['body','signature']);const b=value.body;
 exact(b,['version','purpose','scope','carrierId','authorDeviceId','entityKey','bodyRevision','keyVersion','anchor','sourceSnapshotId','manifest','chunks']);
 if(b.version!==1||b.purpose!==BODY_PURPOSE||jsonBytes(value).length>262144)throw Error('invalid_schema');validateScope(b.scope);sameScope(b.scope,scope);
 for(const k of ['carrierId','authorDeviceId','bodyRevision'])hexId(b[k],32);hexId(b.entityKey,64);if(uint(b.keyVersion,4294967295)<1)throw Error('invalid_schema');
 exact(b.anchor,['commitOid','revision','rollbackGeneration']);oid(b.anchor.commitOid,'commit');if(checkD64(b.anchor.revision)==='0')throw Error('invalid_schema');checkD64(b.anchor.rollbackGeneration);
 if(b.sourceSnapshotId!==null&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(b.sourceSnapshotId))throw Error('invalid_schema');
 const object=(o:any,max:number)=>{exact(o,['sha256','sizeBytes']);hexId(o.sha256,64);if(uint(o.sizeBytes,max)<1)throw Error('invalid_schema');};
 object(b.manifest,1048576);if(!Array.isArray(b.chunks)||b.chunks.length>512)throw Error('invalid_schema');for(const c of b.chunks)object(c,16777216);
 if(new Set([b.manifest.sha256,...b.chunks.map((c:any)=>c.sha256)]).size!==1+b.chunks.length||b.manifest.sizeBytes+b.chunks.reduce((n:number,c:any)=>n+c.sizeBytes,0)>67108864)throw Error('object_too_large');
}
export async function prepareCarrier(options:{crypto:SnapshotCrypto;signer:SigningPort;alias:string;authorDeviceId:string;scope:Scope;anchor:BodyAnchor;binding:BodyBinding;key:Uint8Array;keyVersion:number;objects:LogicalObject[]}){
 const {crypto,scope,binding,key,keyVersion,authorDeviceId}=options;
 if(key.length!==32||options.objects.length!==1||options.objects[0]!.name!==bodyObjectName(binding.kind,binding.logicalId))throw Error('source_identity_missing');
 const plaintextSha256=sha256Hex(options.objects[0]!.bytes);
 if(carrierBodyRevision(binding.kind,binding.entityKey,plaintextSha256)!==binding.bodyRevision)throw Error('body_revision_changed');
 const id=hex(await crypto.random(16)),uuid=carrierUuid(id),codec=new WatchCloudCodec(crypto,guard);
 const snapshot=await codec.create({accountKey:key,keyVersion,sourceDeviceId:authorDeviceId,sequence:1,snapshotId:uuid,createdAtMillis:0,parentHeads:{},observedHeads:{},objects:options.objects.map(o=>({...o,contentSha256:sha256Hex(o.bytes)}))});
 const plain=jsonBytes({version:1,purpose:BODY_PURPOSE,scope,...binding,plaintextSha256,objects:snapshot.manifest.objects});
 const salt=await crypto.random(16),derived=await crypto.hkdf(key,salt,bytes('watchrss/cloud/manifest/v2/'+uuid));
 let sealed:Awaited<ReturnType<SnapshotCrypto['encrypt']>>;try{sealed=await crypto.encrypt(derived,bytes('watchrss-cloud-manifest-v2:'+uuid),plain);}finally{derived.fill(0);}
 const manifest=new Uint8Array(35+sealed.ciphertext.length);manifest.set(bytes('WRSSCM3'));manifest.set(salt,7);manifest.set(sealed.nonce,23);manifest.set(sealed.ciphertext,35);
 const hash=sha256Hex(manifest),objects=new Map(snapshot.newChunks);objects.set(hash,manifest);
 const descriptor=await signControl(options.signer,options.alias,BODY_DOMAIN,{version:1,purpose:BODY_PURPOSE,scope,carrierId:id,authorDeviceId,...{entityKey:binding.entityKey,bodyRevision:binding.bodyRevision},keyVersion,anchor:options.anchor,sourceSnapshotId:null,manifest:{sha256:hash,sizeBytes:manifest.length},chunks:[...snapshot.newChunks].map(([sha256,b])=>({sha256,sizeBytes:b.length})).sort((a,b)=>a.sha256<b.sha256?-1:a.sha256>b.sha256?1:0)}) as Carrier;
 validateCarrier(descriptor,scope);return {descriptor,objects};
}
export async function openCarrier(options:{descriptor:Carrier;scope:Scope;binding:BodyBinding;crypto:SnapshotCrypto;signer:SigningPort;publicKey:string;key:(version:number)=>Promise<Uint8Array>;read:(hash:string,size:number)=>Promise<Uint8Array>;yieldControl?:()=>Promise<void>}){
 const {descriptor,crypto,binding}=options;validateCarrier(descriptor,options.scope);const b=descriptor.body;
 if(b.entityKey!==binding.entityKey||b.bodyRevision!==binding.bodyRevision)throw Error('body_revision_changed');
 await verifySigned(options.signer,options.publicKey,BODY_DOMAIN,b,descriptor.signature);
 const read=async(hash:string,size:number)=>{const raw=await options.read(hash,size);if(raw.length!==size||sha256Hex(raw)!==hash)throw Error('hash_mismatch');return raw;};
 const manifest=await read(b.manifest.sha256,b.manifest.sizeBytes),uuid=carrierUuid(b.carrierId);
 if(manifest.length<51||b.sourceSnapshotId===null&&hex(manifest.subarray(0,7))!==hex(bytes('WRSSCM3')))throw Error('invalid_schema');
 const key=await options.key(b.keyVersion);if(key.length!==32)throw Error('key_unavailable');
 try{
  if(b.sourceSnapshotId!==null){
   // A frozen v1 manifest is a byte locator, never a business input. Only the
   // necessary body object is selected; all bundled state is ignored.
   const codec=new WatchCloudCodec(crypto,guard),legacy=await codec.decryptManifest(key,b.sourceSnapshotId,manifest);
   if(legacy.keyVersion!==b.keyVersion||cloudCompatibility(legacy).readOnly||cloudHasUnknownData(legacy))throw Error('body_legacy_mapping_unavailable');
   const selected=legacy.objects.filter(o=>o.name===(binding.kind==='book'?bodyObjectName('book',binding.logicalId):'notes-assets.zip'));
   if(selected.length!==1||selected.some(o=>o.entryRef||o.originalBytes>64*1024*1024||cloudCompatibility(o).readOnly||cloudHasUnknownData(o)))throw Error('body_legacy_mapping_unavailable');
   const closure=new Map<string,number>();for(const o of selected)for(const c of o.chunks){if(closure.has(c.ciphertextSha256)&&closure.get(c.ciphertextSha256)!==c.ciphertextBytes)throw Error('closure_incomplete');closure.set(c.ciphertextSha256,c.ciphertextBytes);}
   if(closure.size!==b.chunks.length||b.chunks.some(c=>closure.get(c.sha256)!==c.sizeBytes))throw Error('closure_incomplete');
   const objects=await codec.restore(key,legacy,hash=>read(hash,closure.get(hash)!),selected),body=objects.get(selected[0]!.name)!;
   let raw=body;
   if(binding.kind==='asset'){const path=bodyObjectName('asset',binding.logicalId),directory=indexWrss(body);if(!directory.has(path)||directory.get(path)!.length>5*1024*1024)throw Error('source_identity_missing');raw=(await readWrssEntry(body,path,crypto.gunzip,{},directory))!;}
   if(carrierBodyRevision(binding.kind,binding.entityKey,sha256Hex(raw))!==binding.bodyRevision)throw Error('hash_mismatch');
   return new Map([[bodyObjectName(binding.kind,binding.logicalId),raw]]);
  }
  const derived=await crypto.hkdf(key,manifest.slice(7,23),bytes('watchrss/cloud/manifest/v2/'+uuid));let plain:Uint8Array;
  try{plain=await crypto.decrypt(derived,bytes('watchrss-cloud-manifest-v2:'+uuid),manifest.slice(23,35),manifest.slice(35));}finally{derived.fill(0);}
  const m=parseCanonicalJson(plain);exact(m,['version','purpose','scope','entityKey','bodyRevision','kind','logicalId','plaintextSha256','objects']);sameScope(m.scope,options.scope);
  if(m.version!==1||m.purpose!==BODY_PURPOSE||m.entityKey!==binding.entityKey||m.bodyRevision!==binding.bodyRevision||m.kind!==binding.kind||m.logicalId!==binding.logicalId)throw Error('source_identity_missing');text(m.logicalId);hexId(m.plaintextSha256,64);
  const snapshot=synthetic(uuid,b.authorDeviceId,b.keyVersion,m.objects);validateManifest(snapshot);
  if(m.objects.length!==1||m.objects[0].name!==bodyObjectName(binding.kind,binding.logicalId))throw Error('source_identity_missing');
  const closure=new Map<string,number>();
  for(const o of m.objects){
   exact(o,['name','encoding','originalBytes','encodedBytes','chunks',...(Object.hasOwn(o,'contentSha256')?['contentSha256']:[])]);
   if(o.originalBytes>(binding.kind==='asset'?5*1024*1024:64*1024*1024))throw Error('object_too_large');
   for(const c of o.chunks){exact(c,['plaintextSha256','ciphertextSha256','plaintextBytes','ciphertextBytes','saltBase64','nonceBase64']);if(closure.has(c.ciphertextSha256)&&closure.get(c.ciphertextSha256)!==c.ciphertextBytes)throw Error('closure_incomplete');closure.set(c.ciphertextSha256,c.ciphertextBytes);}
  }
  if(closure.size!==b.chunks.length||b.chunks.some(c=>closure.get(c.sha256)!==c.sizeBytes))throw Error('closure_incomplete');
  const decoded=await new WatchCloudCodec(crypto,guard).restore(key,snapshot,hash=>read(hash,closure.get(hash)!));
  const digest=new ContentSha256();for(const o of m.objects){const raw=decoded.get(o.name)!;
   for(let at=0;at<raw.length;at+=262144){digest.update(raw.subarray(at,Math.min(raw.length,at+262144)));if(at+262144<raw.length)await options.yieldControl?.();}
  }
  const hash=digest.finish();if(hash!==m.plaintextSha256||carrierBodyRevision(binding.kind,binding.entityKey,hash)!==binding.bodyRevision)throw Error('hash_mismatch');return decoded;
 }finally{key.fill(0);}
}
