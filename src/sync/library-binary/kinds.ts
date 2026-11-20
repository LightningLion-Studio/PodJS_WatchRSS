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

type BusinessRepository=Pick<SqlLibrarySessionRepository,'binaryFreezeSources'|'binaryReceiveArticle'|'binaryReceiveSource'>;

export class BinaryLibraryKinds {
 constructor(private readonly repository:()=>Promise<BusinessRepository>,private readonly files:BinaryArticleFiles,
  private readonly work:()=>void,private readonly intake?:BoundLocalTransferIntake){}
 async freezeSources(){
  return (await (await this.repository()).binaryFreezeSources(this.work)).map(sourceDescriptor);
 }
 validate(d:ObjectDescriptor){
  if(d.kind==='articleBody'||d.kind==='articleMetadata'){
   if(d.dependsOn.length>1)fail('OBJECT_CONFLICT');
   return validateArticle(d);
  }
  if(d.kind==='rssSource'){
   if(d.dependsOn.length)fail('OBJECT_CONFLICT');
   return validateSource(d);
  }
  fail('UNSUPPORTED_KIND');
 }
 /** The manifest keeps objectId order for digests. The declared edge orders apply. */
 validatePlan(objects:readonly ObjectDescriptor[]){
  const sources=new Map(objects.filter(d=>d.kind==='rssSource').map(d=>[d.businessId,d.objectId]));
  for(const d of objects){
   if(d.kind!=='articleBody'&&d.kind!=='articleMetadata')continue;
   const url=validateArticle(d).article.rssSourceUrl;
   const source=url?sources.get(normalizeSourceUrl(url)):undefined;
   if(d.dependsOn.length!==(source===undefined?0:1)||d.dependsOn[0]!==source)fail('PLAN_CONFLICT');
   this.work();
  }
 }
 /** Temporary inflate file and decoded field files can coexist. */
 shadowBytes(objects:readonly ObjectDescriptor[]){
  return objects.some(d=>d.kind==='articleBody')?ARTICLE_IMPORT_SHADOW_BYTES:0;
 }
 async apply(d:ObjectDescriptor,path:string,peer:string,boundary:ReceiptBoundary,jobId?:string){
  const value=this.validate(d),repository=await this.repository();
  const apply=async(check?:LocalTransferWrite)=>{
   const input={peer,version:2 as const,cursor:(jobId??'')+':'+d.objectId,check:boundary.check};
   if('article' in value){
    const article=Object.fromEntries(Object.entries(value.article).filter(([key,value])=>value!==undefined&&BUSINESS_FIELDS.article.includes(key)));
    const body=d.kind==='articleBody'?{size:d.size,sha256:d.sha256,read:async(offset:number,length:number)=>{this.work();return (await this.files.readBytes(path,offset,length)).bytes;}}:undefined;
    await check?.({...input,records:[{kind:'article',logicalId:d.businessId,value:article}],body});
    const staged=d.kind==='articleBody'?await importArticleFile(this.files,path,d,value.body.chunkHashes,this.work):null;
    await repository.binaryReceiveArticle(value,peer,boundary,staged);
   }else{
    await check?.({...input,records:[{kind:'source',logicalId:d.businessId,value}]});
    await repository.binaryReceiveSource(value,peer,boundary);
   }
  };
  if(this.intake)await this.intake(apply);else await apply();
  this.work();
 }
}
import {BUSINESS_FIELDS} from '../../sync-v2/business';
import type {BoundLocalTransferIntake,LocalTransferWrite} from '../../sync-v2/local-transfer-intake';
