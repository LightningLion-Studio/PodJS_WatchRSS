import {parseChunkedArticles,type ReceivedArticle} from '../article-batches';
import {BODY_CHUNK_SIZE} from '../article-export';
import {MAX_BODY_JSON_BYTES} from '../article-body';
import {normalizeSourceUrl,isSyncedSourceUrl} from '../source-store';
import type {SyncedSource} from '../library-wire';
import type {SqlLibrarySessionRepository} from '../library-repository';
import {importArticleFile,type BinaryArticleFiles} from './article-file';
import {D,objectId} from './digests';
import type {ReceiptBoundary} from './store';
import {CHUNK_BYTES,exact,fail,hash,hex,integer,strictJson,utf8,type ObjectDescriptor} from './wire';

// One apply at a time can hold both the temporary JSON and decoded fields.
export const ARTICLE_IMPORT_SHADOW_BYTES=2*MAX_BODY_JSON_BYTES;

const sourceFields=['url','sourceDeviceId','title','description','siteUrl','imageUrl','createdAt','updatedAt','sortOrder','isPinned','deleted','deletedAt'];
const articleStrings=['articleId','sourceDeviceId','url','title','siteName','excerpt','contentHash','readingPositionContentHash'];
const articleNullable=['imageUrl','rssSourceUrl','rssSourceTitle'];
const articleClocks=['importedAt','updatedAt','independentChangedAt','independentSortOrder','favoriteChangedAt','favoriteSortOrder','watchLaterChangedAt','watchLaterSortOrder','deletedAt','readingPositionBytes','readingPositionChangedAt'];
const articleBooleans=['independentSaved','favoriteSaved','watchLaterSaved','deleted','isRead'];
const articleFields=new Set([...articleStrings,...articleNullable,...articleClocks,...articleBooleans,'body','readingProgress','legacyArticleIds']);

function validateSource(d:ObjectDescriptor):SyncedSource{
 const m=exact(strictJson(d.metadataUtf8,false),sourceFields);
 if(m.url!==d.businessId)fail('OBJECT_CONFLICT');
 for(const k of ['url','sourceDeviceId','title','description'])if(typeof m[k]!=='string')fail('BUSINESS_REJECTED');
 if(!isSyncedSourceUrl(d.businessId)||normalizeSourceUrl(d.businessId)!==d.businessId)fail('BUSINESS_REJECTED');
 for(const k of ['siteUrl','imageUrl'])if(m[k]!==null&&typeof m[k]!=='string')fail('BUSINESS_REJECTED');
 for(const k of ['createdAt','updatedAt','sortOrder','deletedAt'])if(!Number.isSafeInteger(m[k]))fail('BUSINESS_REJECTED');
 if(typeof m.isPinned!=='boolean'||typeof m.deleted!=='boolean')fail('BUSINESS_REJECTED');
 return m as unknown as SyncedSource;
}

function validateArticle(d:ObjectDescriptor):ReceivedArticle{
 const m=strictJson(d.metadataUtf8,false),body=exact(m.body,['bodyHash','bodyByteCount','chunkSize','chunkHashes','metadataOnly']);
 if(m.articleId!==d.businessId)fail('OBJECT_CONFLICT');
 if(Object.keys(m).some(k=>!articleFields.has(k)))fail('BUSINESS_REJECTED');
 for(const k of articleStrings)if(typeof m[k]!=='string')fail('BUSINESS_REJECTED');
 for(const k of articleNullable)if(m[k]!==null&&m[k]!==undefined&&typeof m[k]!=='string')fail('BUSINESS_REJECTED');
 for(const k of articleClocks)if(!Number.isSafeInteger(m[k]))fail('BUSINESS_REJECTED');
 for(const k of articleBooleans)if(typeof m[k]!=='boolean')fail('BUSINESS_REJECTED');
 if(typeof m.readingProgress!=='number'||!Number.isFinite(m.readingProgress))fail('BUSINESS_REJECTED');
 const size=integer(body.bodyByteCount,16777216),metadataOnly=d.kind==='articleMetadata';
 if(body.metadataOnly!==metadataOnly||!Array.isArray(body.chunkHashes)||body.chunkHashes.length!==Math.ceil(size/BODY_CHUNK_SIZE))fail('OBJECT_CONFLICT');
 if(size===0&&metadataOnly&&body.bodyHash===''){
  if(body.chunkSize!==0&&body.chunkSize!==BODY_CHUNK_SIZE)fail('OBJECT_CONFLICT');
 }else{
  hex(body.bodyHash);
  if(size===0||body.chunkSize!==BODY_CHUNK_SIZE)fail('OBJECT_CONFLICT');
 }
 if(!metadataOnly&&(m.deleted||body.bodyHash!==d.sha256||d.size!==size))fail('OBJECT_CONFLICT');
 for(const h of body.chunkHashes)hex(h);
 let entry:ReceivedArticle|undefined;
 try{entry=parseChunkedArticles({articles:[m]})[0];}catch{fail('BUSINESS_REJECTED');}
 if(!entry||entry.article.articleId!==d.businessId)fail('BUSINESS_REJECTED');
 return entry;
}

function sourceDescriptor(source:SyncedSource):ObjectDescriptor{
 const metadataUtf8=JSON.stringify(source),metadataSha256=hash(utf8(metadataUtf8));
 const fields={kind:'rssSource',schemaVersion:1,businessId:source.url,
  contentVersion:D('wrss.library-binary.v2/source-version',[source.sourceDeviceId,String(source.updatedAt),String(source.deletedAt)]),
  encoding:'none',size:0,sha256:hash(new Uint8Array()),chunkBytes:CHUNK_BYTES,chunkHashes:[],
  metadataUtf8,metadataSha256,dependsOn:[]} as const;
 const d={...fields,chunkHashes:[],dependsOn:[],objectId:''};
 d.objectId=objectId(d);
 validateSource(d);
 return d;
}

type BusinessRepository=Pick<SqlLibrarySessionRepository,'binaryFreezeSources'|'binaryReceiveArticle'|'resumeReceiveSource'>;

export class BinaryLibraryKinds {
 constructor(private readonly repository:()=>Promise<BusinessRepository>,private readonly files:BinaryArticleFiles,
  private readonly work:()=>void){}
 async freezeSources(){
  return (await (await this.repository()).binaryFreezeSources(this.work)).map(sourceDescriptor);
 }
 validate(d:ObjectDescriptor){
  if(d.dependsOn.length)fail('OBJECT_CONFLICT');
  if(d.kind==='articleBody'||d.kind==='articleMetadata')return validateArticle(d);
  if(d.kind==='rssSource')return validateSource(d);
  fail('UNSUPPORTED_KIND');
 }
 /** Temporary inflate file and decoded field files can coexist. */
 shadowBytes(objects:readonly ObjectDescriptor[]){
  return objects.some(d=>d.kind==='articleBody')?ARTICLE_IMPORT_SHADOW_BYTES:0;
 }
 async apply(d:ObjectDescriptor,path:string,peer:string,boundary:ReceiptBoundary){
  const value=this.validate(d),repository=await this.repository();
  if('article' in value){
   const staged=d.kind==='articleBody'?await importArticleFile(this.files,path,d,value.body.chunkHashes,this.work):null;
   await repository.binaryReceiveArticle(value,peer,boundary,staged);
  }else await repository.resumeReceiveSource(value,peer,boundary);
  this.work();
 }
}
