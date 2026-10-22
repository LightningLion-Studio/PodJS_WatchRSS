import {encodeUtf8Async} from '@podjs/framework/bytes';
import {javaJsonQuote,type SyncArticleBody,type SyncBodyCodec,type SyncBodyPayload} from "./article-body.ts";
import type {WireIncomingArticle,RequestedArticleBody} from "./article-batches.ts";
import type {ArticleManifest} from "./manifest.ts";
import {isImportedContentUrl} from "../core/imported-content.ts";
export interface ExportedArticle extends WireIncomingArticle,SyncArticleBody {
 /** Local cloud projection only; excluded from records/archives and native wire metadata. */
 cloudRssArticleId?:string;cloudLegacyArticleIds?:string[];
}
export const BODY_CHUNK_SIZE=128*1024;
const integerFields=["importedAt","updatedAt","independentChangedAt","independentSortOrder","favoriteChangedAt","favoriteSortOrder","watchLaterChangedAt","watchLaterSortOrder","deletedAt"] as const;
/** JSONObject insertion order, omitted Java null fields, slash escaping and UTF-8 replacement are significant. */
export function metadataJson(article:ExportedArticle):string {
 for(const key of integerFields)if(!Number.isSafeInteger(article[key]))throw new Error(`Invalid article metadata ${key}`);
 const fields:Record<string,string|number|boolean|null>={bodyEncodingVersion:3,articleId:article.articleId,sourceDeviceId:article.sourceDeviceId,url:article.url,title:article.title,siteName:article.siteName,excerpt:article.excerpt,imageUrl:article.imageUrl,importedAt:article.importedAt,updatedAt:article.updatedAt,independentSaved:article.independentSaved,independentChangedAt:article.independentChangedAt,independentSortOrder:article.independentSortOrder,rssSourceUrl:article.rssSourceUrl,rssSourceTitle:article.rssSourceTitle,favoriteSaved:article.favoriteSaved,favoriteChangedAt:article.favoriteChangedAt,favoriteSortOrder:article.favoriteSortOrder,watchLaterSaved:article.watchLaterSaved,watchLaterChangedAt:article.watchLaterChangedAt,watchLaterSortOrder:article.watchLaterSortOrder,deleted:article.deleted,deletedAt:article.deletedAt};
 return '{'+Object.entries(fields).filter(([,v])=>v!==null).map(([k,v])=>javaJsonQuote(k)+':'+(typeof v==='string'?javaJsonQuote(v):String(v))).join(',')+'}';
}
export async function hashJavaText(value:string,codec:Pick<SyncBodyCodec,"sha256">):Promise<string>{
 return codec.sha256(await encodeUtf8Async(value,'question'));
}
export async function articleMetadataHash(article:ExportedArticle,codec:Pick<SyncBodyCodec,"sha256">){return hashJavaText(metadataJson(article),codec);}
export interface PreparedArticle {article:ExportedArticle;manifest:ArticleManifest;encodedBody:Uint8Array|null}
export interface CachedBodyManifest {bodyHash:string;bodyByteCount:number;chunkSize:number;chunkHashes:string[]}
const bodySyncMode=(article:ExportedArticle)=>article.independentSaved||isImportedContentUrl(article.rssSourceUrl)||isImportedContentUrl(article.url)?"full":"saved";
/** A committed body cache can advertise the same manifest without reading and
 * compressing its text. Callers must materialize it before answering a body request. */
export async function prepareCachedArticle(article:ExportedArticle,codec:Pick<SyncBodyCodec,'sha256'>,cached:CachedBodyManifest):Promise<PreparedArticle>{
 if(!/^[0-9a-f]{64}$/.test(cached.bodyHash)||!Number.isSafeInteger(cached.bodyByteCount)||cached.bodyByteCount<=0||cached.chunkSize!==BODY_CHUNK_SIZE||
    cached.chunkHashes.length!==Math.max(1,Math.ceil(cached.bodyByteCount/cached.chunkSize))||cached.chunkHashes.some(hash=>!/^([0-9a-f]{64})$/.test(hash)))throw new Error('Invalid cached sync body manifest');
 const manifest:ArticleManifest={articleId:article.articleId,sourceDeviceId:article.sourceDeviceId,contentHash:article.contentHash,updatedAt:article.updatedAt,independentChangedAt:article.independentChangedAt,favoriteChangedAt:article.favoriteChangedAt,watchLaterChangedAt:article.watchLaterChangedAt,deletedAt:article.deletedAt,deleted:article.deleted,bodyHash:cached.bodyHash,bodyByteCount:cached.bodyByteCount,chunkSize:cached.chunkSize,chunkHashes:[...cached.chunkHashes],metadataHash:await articleMetadataHash(article,codec),bodyAvailable:true,bodySyncMode:bodySyncMode(article),readingProgress:article.readingProgress,readingPositionBytes:article.readingPositionBytes,readingPositionContentHash:article.readingPositionContentHash,readingPositionChangedAt:article.readingPositionChangedAt,isRead:article.isRead};
 return {article,manifest,encodedBody:null};
}
/** Computes hashes from actual hydrated body bytes, never trusts a cached manifest. */
export async function prepareArticle(article:ExportedArticle,codec:SyncBodyCodec,bodyAvailable=true):Promise<PreparedArticle>{
 const bytes=bodyAvailable?await codec.encode(article):null,chunkHashes:string[]=[];
 if(bytes)for(let index=0;index<Math.max(1,Math.ceil(bytes.length/BODY_CHUNK_SIZE));index++)chunkHashes.push(await codec.sha256(bytes.subarray(index*BODY_CHUNK_SIZE,(index+1)*BODY_CHUNK_SIZE)));
 const bodyHash=bytes?(chunkHashes.length===1?chunkHashes[0]!:await codec.sha256(bytes)):"",metadataHash=bytes?await articleMetadataHash(article,codec):"";
 const manifest:ArticleManifest={articleId:article.articleId,sourceDeviceId:article.sourceDeviceId,contentHash:article.contentHash,updatedAt:article.updatedAt,independentChangedAt:article.independentChangedAt,favoriteChangedAt:article.favoriteChangedAt,watchLaterChangedAt:article.watchLaterChangedAt,deletedAt:article.deletedAt,deleted:article.deleted,bodyHash,bodyByteCount:bytes?.length??0,chunkSize:bytes?BODY_CHUNK_SIZE:0,chunkHashes,metadataHash,bodyAvailable,bodySyncMode:bodySyncMode(article),readingProgress:article.readingProgress,readingPositionBytes:article.readingPositionBytes,readingPositionContentHash:article.readingPositionContentHash,readingPositionChangedAt:article.readingPositionChangedAt,isRead:article.isRead};
 return {article,manifest,encodedBody:bytes};
}
/** Native payloadForRequest fallback: stale hashes and empty ordinary requests send a full body. */
export function bodyForRequest(prepared:PreparedArticle,request:RequestedArticleBody):SyncBodyPayload {
 const {manifest:m,encodedBody:bytes}=prepared;
 if(request.articleId!==m.articleId)throw new Error("Article request identity mismatch");
 if(!m.bodyAvailable||!bytes)throw new Error("Requested local body unavailable");
 const full=!request.bodyHash||request.bodyHash!==m.bodyHash||(!request.metadataOnly&&request.chunkIndexes.length===0);
 const metadataOnly=!full&&request.metadataOnly,indexes=full?m.chunkHashes.map((_,i)=>i):metadataOnly?[]:request.chunkIndexes;
 for(const i of indexes)if(!Number.isInteger(i)||i<0||i>=m.chunkHashes.length)throw new Error("Invalid requested chunk index");
 return {articleId:m.articleId,bodyHash:m.bodyHash,bodyByteCount:m.bodyByteCount,chunkSize:m.chunkSize,chunkHashes:[...m.chunkHashes],metadataOnly,chunks:[...new Set(indexes)].sort((a,b)=>a-b).map(index=>({index,hash:m.chunkHashes[index]!,bytes:bytes.slice(index*m.chunkSize,(index+1)*m.chunkSize)}))};
}
