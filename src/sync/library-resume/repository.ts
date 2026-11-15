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

export interface FrozenResumeArticle {prepared:PreparedArticle;binding:number|null;chunkHashes:string[]}
export interface FrozenResumeInventory {articles:FrozenResumeArticle[];sources:readonly SyncedSource[];assets?:FrozenAsset[]}
const ARTICLE_KEYS=['articleId','legacyArticleIds','sourceDeviceId','url','title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','independentSaved','independentChangedAt','independentSortOrder','rssSourceUrl','rssSourceTitle','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','isRead'] as const;
function articleMetadata(p:PreparedArticle,metadataOnly:boolean):Row {
 const a=p.article,m=p.manifest;
 return {...Object.fromEntries(ARTICLE_KEYS.filter(k=>a[k]!==undefined).map(k=>[k,a[k]])),body:{bodyHash:m.bodyHash,bodyByteCount:m.bodyByteCount,chunkSize:m.chunkSize,chunkHashes:m.chunkHashes,metadataOnly}};
}
function make(kind:ObjectDescriptor['kind'],businessId:string,contentVersion:string,encoding:ObjectDescriptor['encoding'],size:number,sha256:string,chunkHashes:string[],metadata:Row):ObjectDescriptor{
 const bytes=utf8(JSON.stringify(metadata)),o={kind,schemaVersion:1 as const,businessId,contentVersion,encoding,size,sha256,chunkHashes,metadataBase64:encodeBase64(bytes),metadataSha256:hash(bytes),dependsOn:[] as string[]};return {objectId:objectId(o),...o};
}
export function resumeInventoryDigest(inventory:FrozenResumeInventory):string{return hash(utf8(JSON.stringify(inventory)));}
export async function sourcePlan(repository:SqlLibrarySessionRepository,store:ResumeStore,scope:string,witness:Snapshot,selection:Selection,readAsset?:(key:string)=>Promise<Uint8Array>):Promise<ResumeSourcePlan>{
 const saved=await store.snapshot(scope,witness.snapshotId);if(!saved||resumeInventoryDigest(saved.inventory as FrozenResumeInventory)!==witness.manifestDigest)fail('SOURCE_CHANGED');
 const inventory=saved.inventory as FrozenResumeInventory,selected=new Set(selection.kinds.map(k=>k.kind)),objects:ObjectDescriptor[]=[],articles=new Map<string,FrozenResumeArticle>();
 for(const frozen of inventory.articles){const p=frozen.prepared,m=p.manifest;if(!m.bodyAvailable&&!m.deleted)continue;
  const body=selected.has('articleBody')&&m.bodyAvailable&&!m.deleted,kind=body?'articleBody':'articleMetadata';if(!selected.has(kind))continue;
  const d=make(kind,p.article.articleId,D('wrss.library-resume.v1/article-version',[m.contentHash,m.metadataHash,m.bodyHash,String(m.updatedAt),String(m.deletedAt)]),body?'article-v14':'none',body?m.bodyByteCount:0,body?m.bodyHash:hash(new Uint8Array()),body?frozen.chunkHashes:[],articleMetadata(p,!body));
  descriptor(d,selection.limits);objects.push(d);articles.set(d.objectId,frozen);
 }
 if(selected.has('rssSource'))for(const source of inventory.sources){const d=make('rssSource',source.url,D('wrss.library-resume.v1/source-version',[source.sourceDeviceId,String(source.updatedAt),String(source.deletedAt)]),'none',0,hash(new Uint8Array()),[],source as unknown as Row);descriptor(d,selection.limits);objects.push(d);}
 if(selected.has('noteAsset'))for(const a of inventory.assets??[]){const metadata={storageKey:a.storageKey,sha256:a.sha256,size:a.size};objects.push(make('noteAsset',a.storageKey,a.sha256,'raw',a.size,a.sha256,a.chunkHashes,metadata));}
 objects.sort((a,b)=>a.objectId<b.objectId?-1:1);if(objects.length>selection.limits.maxPlanObjects||objects.reduce((n,o)=>n+utf8(JSON.stringify(o)).length,0)>selection.limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
 let cachedId:string|undefined,cached:Uint8Array|undefined;
 return {objects,read:async(d,index)=>{if(d.kind==='noteAsset'){if(!readAsset)fail('SOURCE_CHANGED');const bytes=await readAsset(d.businessId);if(bytes.length!==d.size||hash(bytes)!==d.sha256)fail('SOURCE_CHANGED');return bytes.slice(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);}if(d.kind!=='articleBody')fail();if(cachedId!==d.objectId){const frozen=articles.get(d.objectId);if(!frozen)fail('SOURCE_CHANGED');cached=await repository.resumeReadBody(frozen);if(cached.length!==d.size||hash(cached)!==d.sha256)fail('SOURCE_CHANGED');cachedId=d.objectId;}const bytes=cached!.slice(index*CHUNK_BYTES,Math.min(d.size,(index+1)*CHUNK_BYTES));if(hash(bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');return bytes;}};
}
export interface ResumeFileReader {read(path:string,size:number):Promise<Uint8Array>}
export async function applyResumeObject(repository:SqlLibrarySessionRepository,files:ResumeFileReader,job:Job,d:ObjectDescriptor,path:string,boundary:ReceiptBoundary):Promise<void>{
 const metadata=strictJson(decodeSyncUtf8(b64(d.metadataBase64,job.description.selection.limits.maxMetadataBytes)),false),peer=job.description.phoneDeviceId;
 if(d.kind==='rssSource'){
  if(metadata.url!==d.businessId)fail('OBJECT_CONFLICT');validateSource(metadata);await repository.resumeReceiveSource(metadata as unknown as SyncedSource,peer,boundary);return;
 }
 if(d.kind!=='articleBody'&&d.kind!=='articleMetadata')fail('UNSUPPORTED_KIND');
 if(metadata.articleId!==d.businessId)fail('OBJECT_CONFLICT');if(Object.keys(metadata).some(k=>k!=='body'&&!ARTICLE_KEYS.includes(k as typeof ARTICLE_KEYS[number])))fail('BUSINESS_REJECTED');
 const body=exact(metadata.body,['bodyHash','bodyByteCount','chunkSize','chunkHashes','metadataOnly']);integer(body.bodyByteCount,16777216);if((body.chunkSize!==128*1024&&!(d.kind==='articleMetadata'&&body.chunkSize===0&&body.bodyByteCount===0&&body.bodyHash===''))||!Array.isArray(body.chunkHashes)||body.chunkHashes.length!==Math.ceil(Number(body.bodyByteCount)/(128*1024)))fail('OBJECT_CONFLICT');if(body.bodyHash!==''||Number(body.bodyByteCount)>0)hex(body.bodyHash);for(const h of body.chunkHashes)hex(h);
 if(body.metadataOnly!==(d.kind==='articleMetadata'))fail('OBJECT_CONFLICT');
 if(d.kind==='articleBody'){
  const bytes=await files.read(path,d.size);if(bytes.length!==d.size||hash(bytes)!==d.sha256||body.bodyHash!==d.sha256||body.bodyByteCount!==d.size||body.chunkSize!==128*1024)fail('HASH_MISMATCH');
  const chunks:Row[]=[];for(let at=0,index=0;at<bytes.length;at+=128*1024,index++){const part=bytes.subarray(at,at+128*1024),digest=hash(part);if(!Array.isArray(body.chunkHashes)||body.chunkHashes[index]!==digest)fail('HASH_MISMATCH');chunks.push({index,hash:digest,data:encodeBase64(part)});}body.chunks=chunks;
 }else body.chunks=[];
 const entry=parseChunkedArticles({articles:[metadata]})[0];if(!entry)fail('BUSINESS_REJECTED');
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
