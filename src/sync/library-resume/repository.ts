import {encodeBase64} from '@podjs/framework/bytes';
import type {PreparedArticle} from '../article-export';
import type {SyncedSource} from '../library-wire';
import {parseChunkedArticles} from '../article-batches';
import type {SqlLibrarySessionRepository} from '../library-repository';
import type {ResumeStore,Job,ReceiptBoundary} from './store';
import type {ResumeSourcePlan} from './coordinator';
import {D,objectId,descriptor} from './digests';
import {CHUNK_BYTES,fail,hash,utf8,b64,strictJson,exact,integer,hex,type Snapshot,type Selection,type ObjectDescriptor,type Row} from './wire';
import type {FrozenAsset} from './assets';
import {decodeSyncUtf8} from '../protocol';
import {BUSINESS_FIELDS} from '../../sync-v2/business';
import type {LocalTransferWrite} from '../../sync-v2/local-transfer-intake';

export interface FrozenResumeArticle {prepared:PreparedArticle;binding:number|null;chunkHashes:string[]}
export interface FrozenResumeInventory {articles:FrozenResumeArticle[];sources:readonly SyncedSource[];assets?:FrozenAsset[];truncated:boolean}
const ARTICLE_KEYS=['articleId','legacyArticleIds','sourceDeviceId','url','title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','independentSaved','independentChangedAt','independentSortOrder','rssSourceUrl','rssSourceTitle','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','isRead'] as const;
export function resumeObjectKey(kind:ObjectDescriptor['kind'],businessId:string):string{return kind+'\0'+businessId;}
export function resumeArticleVersion(m:PreparedArticle['manifest']):string{return D('wrss.library-resume.v1/article-version',[m.contentHash,m.metadataHash,m.bodyHash,String(m.updatedAt),String(m.deletedAt)]);}
export function resumeSourceVersion(source:SyncedSource):string{return D('wrss.library-resume.v1/source-version',[source.sourceDeviceId,String(source.updatedAt),String(source.deletedAt)]);}
export function compareResumeSources(a:SyncedSource,b:SyncedSource):number{
 if(a.deleted!==b.deleted)return a.deleted?1:-1;
 const ta=Math.max(a.updatedAt,a.deletedAt),tb=Math.max(b.updatedAt,b.deletedAt);
 if(ta!==tb)return tb-ta;
 return a.url<b.url?-1:a.url>b.url?1:0;
}
export function compareResumeArticles(a:PreparedArticle,b:PreparedArticle):number{
 if(a.manifest.deleted!==b.manifest.deleted)return a.manifest.deleted?1:-1;
 const ta=Math.max(a.manifest.updatedAt,a.manifest.deletedAt),tb=Math.max(b.manifest.updatedAt,b.manifest.deletedAt);
 if(ta!==tb)return tb-ta;
 return a.article.articleId<b.article.articleId?-1:a.article.articleId>b.article.articleId?1:0;
}
function articleMetadata(p:PreparedArticle,metadataOnly:boolean):Row {
 const a=p.article,m=p.manifest;
 return {...Object.fromEntries(ARTICLE_KEYS.filter(k=>a[k]!==undefined).map(k=>[k,a[k]])),body:{bodyHash:m.bodyHash,bodyByteCount:m.bodyByteCount,chunkSize:m.chunkSize,chunkHashes:m.chunkHashes,metadataOnly}};
}
function make(kind:ObjectDescriptor['kind'],businessId:string,contentVersion:string,encoding:ObjectDescriptor['encoding'],size:number,sha256:string,chunkHashes:string[],metadata:Row):ObjectDescriptor{
 const bytes=utf8(JSON.stringify(metadata)),o={kind,schemaVersion:1 as const,businessId,contentVersion,encoding,size,sha256,chunkHashes,metadataBase64:encodeBase64(bytes),metadataSha256:hash(bytes),dependsOn:[] as string[]};return {objectId:objectId(o),...o};
}
const EMPTY_HASH=hash(new Uint8Array());
export function resumeArticleDescriptor(frozen:FrozenResumeArticle,body:boolean):ObjectDescriptor{
 const p=frozen.prepared,m=p.manifest,kind=body?'articleBody':'articleMetadata';
 return make(kind,p.article.articleId,resumeArticleVersion(m),body?'article-v14':'none',body?m.bodyByteCount:0,body?m.bodyHash:EMPTY_HASH,body?frozen.chunkHashes:[],articleMetadata(p,!body));
}
export function resumeSourceDescriptor(source:SyncedSource):ObjectDescriptor{
 return make('rssSource',source.url,resumeSourceVersion(source),'none',0,EMPTY_HASH,[],source as unknown as Row);
}
export function resumeAssetDescriptor(a:FrozenAsset):ObjectDescriptor{
 return make('noteAsset',a.storageKey,a.sha256,'raw',a.size,a.sha256,a.chunkHashes,{storageKey:a.storageKey,sha256:a.sha256,size:a.size});
}
export function resumeInventoryDigest(inventory:FrozenResumeInventory):string{return hash(utf8(JSON.stringify(inventory)));}
export async function sourcePlan(repository:SqlLibrarySessionRepository,store:ResumeStore,scope:string,witness:Snapshot,selection:Selection,readAsset?:(key:string)=>Promise<Uint8Array>):Promise<ResumeSourcePlan>{
 const saved=await store.snapshot(scope,witness.snapshotId);if(!saved||resumeInventoryDigest(saved.inventory as FrozenResumeInventory)!==witness.manifestDigest)fail('SOURCE_CHANGED');
 const inventory=saved.inventory as FrozenResumeInventory,selected=new Set(selection.kinds.map(k=>k.kind)),objects:ObjectDescriptor[]=[],articles=new Map<string,FrozenResumeArticle>();
 let manifestBytes=0;
 const admit=(d:ObjectDescriptor,frozen?:FrozenResumeArticle):boolean=>{
  descriptor(d,selection.limits);
  const bytes=utf8(JSON.stringify(d)).length;
  if(objects.length>=selection.limits.maxPlanObjects)return false;
  if(manifestBytes+bytes>selection.limits.maxManifestBytes){if(!objects.length)fail('LIMIT_EXCEEDED');return false;}
  objects.push(d);manifestBytes+=bytes;if(frozen)articles.set(d.objectId,frozen);return true;
 };
 let full=false;
 if(selected.has('rssSource'))for(const source of [...inventory.sources].sort(compareResumeSources)){if(!admit(resumeSourceDescriptor(source))){full=true;break;}}
 if(!full&&selected.has('noteAsset'))for(const a of [...(inventory.assets??[])].sort((x,y)=>x.storageKey<y.storageKey?-1:x.storageKey>y.storageKey?1:0)){if(!admit(resumeAssetDescriptor(a))){full=true;break;}}
 if(!full)for(const frozen of [...inventory.articles].sort((a,b)=>compareResumeArticles(a.prepared,b.prepared))){
  const p=frozen.prepared,m=p.manifest;if(!m.bodyAvailable&&!m.deleted)continue;
  const body=selected.has('articleBody')&&m.bodyAvailable&&!m.deleted,kind=body?'articleBody':'articleMetadata';if(!selected.has(kind))continue;
  if(!admit(resumeArticleDescriptor(frozen,body),frozen)){full=true;break;}
 }
 objects.sort((a,b)=>a.objectId<b.objectId?-1:1);
 let cachedId:string|undefined,cached:Uint8Array|undefined;
 return {objects,truncated:inventory.truncated===true||full,read:async(d,index)=>{if(d.kind==='noteAsset'){if(!readAsset)fail('SOURCE_CHANGED');const bytes=await readAsset(d.businessId);if(bytes.length!==d.size||hash(bytes)!==d.sha256)fail('SOURCE_CHANGED');return bytes.slice(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);}if(d.kind!=='articleBody')fail();if(cachedId!==d.objectId){const frozen=articles.get(d.objectId);if(!frozen)fail('SOURCE_CHANGED');cached=await repository.resumeReadBody(frozen);if(cached.length!==d.size||hash(cached)!==d.sha256)fail('SOURCE_CHANGED');cachedId=d.objectId;}const bytes=cached!.slice(index*CHUNK_BYTES,Math.min(d.size,(index+1)*CHUNK_BYTES));if(hash(bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');return bytes;}};
}
export interface ResumeFileReader {read(path:string,size:number):Promise<Uint8Array>}
export async function applyResumeObject(repository:SqlLibrarySessionRepository,files:ResumeFileReader,job:Job,d:ObjectDescriptor,path:string,boundary:ReceiptBoundary,protect?:LocalTransferWrite):Promise<void>{
 const metadata=strictJson(decodeSyncUtf8(b64(d.metadataBase64,job.description.selection.limits.maxMetadataBytes)),false),peer=job.description.phoneDeviceId;
 const input={peer,version:1 as const,cursor:job.jobId+':'+d.objectId,check:boundary.check};
 if(d.kind==='rssSource'){
  if(metadata.url!==d.businessId)fail('OBJECT_CONFLICT');validateSource(metadata);
  await protect?.({...input,records:[{kind:'source',logicalId:d.businessId,value:metadata}]});
  await repository.resumeReceiveSource(metadata as unknown as SyncedSource,peer,boundary);return;
 }
 if(d.kind!=='articleBody'&&d.kind!=='articleMetadata')fail('UNSUPPORTED_KIND');
 if(metadata.articleId!==d.businessId)fail('OBJECT_CONFLICT');if(Object.keys(metadata).some(k=>k!=='body'&&!ARTICLE_KEYS.includes(k as typeof ARTICLE_KEYS[number])))fail('BUSINESS_REJECTED');
 const body=exact(metadata.body,['bodyHash','bodyByteCount','chunkSize','chunkHashes','metadataOnly']);integer(body.bodyByteCount,16777216);if((body.chunkSize!==128*1024&&!(d.kind==='articleMetadata'&&body.chunkSize===0&&body.bodyByteCount===0&&body.bodyHash===''))||!Array.isArray(body.chunkHashes)||body.chunkHashes.length!==Math.ceil(Number(body.bodyByteCount)/(128*1024)))fail('OBJECT_CONFLICT');if(body.bodyHash!==''||Number(body.bodyByteCount)>0)hex(body.bodyHash);for(const h of body.chunkHashes)hex(h);
 if(body.metadataOnly!==(d.kind==='articleMetadata'))fail('OBJECT_CONFLICT');
 let bytes:Uint8Array|undefined;
 if(d.kind==='articleBody'){
  bytes=await files.read(path,d.size);if(bytes.length!==d.size||hash(bytes)!==d.sha256||body.bodyHash!==d.sha256||body.bodyByteCount!==d.size||body.chunkSize!==128*1024)fail('HASH_MISMATCH');
  const chunks:Row[]=[];for(let at=0,index=0;at<bytes.length;at+=128*1024,index++){const part=bytes.subarray(at,at+128*1024),digest=hash(part);if(!Array.isArray(body.chunkHashes)||body.chunkHashes[index]!==digest)fail('HASH_MISMATCH');chunks.push({index,hash:digest,data:encodeBase64(part)});}body.chunks=chunks;
 }else body.chunks=[];
 const entry=parseChunkedArticles({articles:[metadata]})[0];if(!entry)fail('BUSINESS_REJECTED');
 if(protect){
  const value=Object.fromEntries(Object.entries(entry.article).filter(([key,value])=>value!==undefined&&BUSINESS_FIELDS.article.includes(key)));
  await protect({...input,records:[{kind:'article',logicalId:d.businessId,value}],body:bytes?{size:d.size,sha256:d.sha256,read:async(offset,length)=>bytes!.subarray(offset,offset+length)}:undefined});
 }
 await repository.resumeReceiveArticle(entry,peer,boundary);
}
function validateSource(o:Row){
 const fields=['url','sourceDeviceId','title','description','siteUrl','imageUrl','createdAt','updatedAt','sortOrder','isPinned','deleted','deletedAt'];
 if(Object.keys(o).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(o,k)))fail('BUSINESS_REJECTED');
 for(const k of ['url','sourceDeviceId','title','description'])if(typeof o[k]!=='string')fail('BUSINESS_REJECTED');
 for(const k of ['siteUrl','imageUrl'])if(o[k]!==null&&typeof o[k]!=='string')fail('BUSINESS_REJECTED');
 for(const k of ['createdAt','updatedAt','sortOrder','deletedAt'])if(!Number.isSafeInteger(o[k]))fail('BUSINESS_REJECTED');
 if(typeof o.isPinned!=='boolean'||typeof o.deleted!=='boolean')fail('BUSINESS_REJECTED');
}
