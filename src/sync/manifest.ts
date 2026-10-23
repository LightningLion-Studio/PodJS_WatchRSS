import {parseLegacyArticleIds,assertUniqueArticleAliases} from './article-aliases';
import {wireFields,type RequestedArticleBody} from "./article-batches.ts";
import type {JsonObject} from "./protocol.ts";
const {trim,object,string,bool,optLong,strictInteger}=wireFields;
export interface ArticleManifest {
 articleId:string;legacyArticleIds?:readonly string[];sourceDeviceId:string;contentHash:string;updatedAt:number;independentChangedAt:number;favoriteChangedAt:number;watchLaterChangedAt:number;deletedAt:number;deleted:boolean;
 bodyHash:string;bodyByteCount:number;chunkSize:number;chunkHashes:readonly string[];metadataHash:string;bodyAvailable:boolean;bodySyncMode:string;
 readingProgress:number;readingPositionBytes:number;readingPositionContentHash:string;readingPositionChangedAt:number;isRead:boolean;
}
export function parseArticleManifest(frame:JsonObject):ArticleManifest[]{
 if(!Array.isArray(frame.articleManifest))return [];
 const out:ArticleManifest[]=[];
 for(const raw of frame.articleManifest){const v=object(raw);if(!v)continue;const articleId=trim(string(v.articleId));if(!articleId)continue;
  const rawHashes=Array.isArray(v.chunkHashes)?v.chunkHashes:[],hashes=rawHashes.map(h=>{if(typeof h!=="string"||!trim(h))throw new Error("invalid manifest chunk hash");return trim(h);});
  const progress=typeof v.readingProgress==="number"||typeof v.readingProgress==="string"?Number(v.readingProgress):0,deletedAt=optLong(v.deletedAt);
  out.push({articleId,...(v.legacyArticleIds===undefined?{}:{legacyArticleIds:parseLegacyArticleIds(v.legacyArticleIds)}),sourceDeviceId:trim(string(v.sourceDeviceId)),contentHash:trim(string(v.contentHash)),updatedAt:optLong(v.updatedAt),independentChangedAt:optLong(v.independentChangedAt),favoriteChangedAt:optLong(v.favoriteChangedAt),watchLaterChangedAt:optLong(v.watchLaterChangedAt),deletedAt,deleted:bool(v.deleted,deletedAt>0),
   bodyHash:trim(string(v.bodyHash)),bodyByteCount:strictInteger(v,"bodyByteCount",-1,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),chunkSize:strictInteger(v,"chunkSize",-1,-2147483648,2147483647),chunkHashes:hashes,metadataHash:trim(string(v.metadataHash)),bodyAvailable:bool(v.bodyAvailable,true),bodySyncMode:trim(string(v.bodySyncMode))||"full",
   readingProgress:Number.isFinite(progress)?Math.fround(Math.max(0,Math.min(1,progress))):0,readingPositionBytes:Math.max(0,optLong(v.readingPositionBytes)),readingPositionContentHash:trim(string(v.readingPositionContentHash)),readingPositionChangedAt:Math.max(0,optLong(v.readingPositionChangedAt)),isRead:bool(v.isRead)});
 }assertUniqueArticleAliases(out);return out;
}
function equalHashes(a:readonly string[],b:readonly string[]):boolean{return a.length===b.length&&a.every((h,i)=>h===b[i]);}
export function canReuseLocalBody(local:ArticleManifest|undefined,remote:ArticleManifest):boolean{return !!local&&!local.deleted&&local.bodyAvailable&&remote.bodyAvailable&&!!trim(local.bodyHash)&&local.bodyHash===remote.bodyHash&&local.bodyByteCount===remote.bodyByteCount&&local.chunkSize>0&&local.chunkSize===remote.chunkSize&&local.chunkHashes.length>0&&equalHashes(local.chunkHashes,remote.chunkHashes);}
export function meaningfulProgressAhead(value:number,other:number):boolean {
 const clamp=(v:number)=>Math.fround(Math.max(0,Math.min(1,v)));
 return clamp(value)>Math.fround(clamp(other)+Math.fround(.001));
}
/** Shape validation is intentionally only required when requesting a new body,
 * as in the native selector; deleted/metadata-only requests can have no chunks. */
function requireShape(r:ArticleManifest):void{
 if(!trim(r.bodyHash)||!Number.isSafeInteger(r.bodyByteCount)||r.bodyByteCount<0||!Number.isInteger(r.chunkSize)||r.chunkSize<1)throw new Error("invalid manifest body shape");
 if(r.chunkHashes.length!==Math.max(1,Math.ceil(r.bodyByteCount/r.chunkSize))||r.chunkHashes.some(h=>!trim(h)))throw new Error("invalid manifest chunk shape");
}
export function selectArticleBodyRequests(local:readonly ArticleManifest[],remote:readonly ArticleManifest[],options:{maxChunks?:number;supportsMetadataOnly?:boolean;supportsFullMetadataOnly?:boolean}={}):RequestedArticleBody[]{
 const limit=options.maxChunks??2147483647;if(!Number.isInteger(limit)||limit< -2147483648||limit>2147483647)throw new Error("invalid body request chunk budget");
 const byId=new Map(local.map(a=>[a.articleId,a]));const requests:RequestedArticleBody[]=[];
 for(const r of remote){
  const l=byId.get(r.articleId),newer=!l||r.updatedAt>l.updatedAt;
  const metadata=r.deleted?(!l||!l.deleted||r.deletedAt>l.deletedAt||r.independentChangedAt>l.independentChangedAt||r.favoriteChangedAt>l.favoriteChangedAt||r.watchLaterChangedAt>l.watchLaterChangedAt):
   (!l||(r.metadataHash!==l.metadataHash&&newer)||r.updatedAt>l.updatedAt||r.independentChangedAt>l.independentChangedAt||r.favoriteChangedAt>l.favoriteChangedAt||r.watchLaterChangedAt>l.watchLaterChangedAt||r.deletedAt>l.deletedAt||r.deleted!==l.deleted||r.readingPositionChangedAt>l.readingPositionChangedAt||(r.readingPositionChangedAt===0&&l.readingPositionChangedAt===0&&meaningfulProgressAhead(r.readingProgress,l.readingProgress))||(r.isRead&&!l.isRead));
  const reuse=canReuseLocalBody(l,r),metadataOnly=metadata&&reuse&&options.supportsMetadataOnly===true&&!r.deleted&&r.bodyAvailable&&(r.bodySyncMode==="saved"||options.supportsFullMetadataOnly===true);
  if(!r.deleted&&!r.bodyAvailable)continue;
  const body=!r.deleted&&r.bodyAvailable&&!reuse;if(body)requireShape(r);if(!metadata&&!body)continue;
  const chunksReusable=!!l&&!l.deleted&&l.bodyAvailable&&r.bodyAvailable&&l.chunkSize>0&&l.chunkSize===r.chunkSize&&l.chunkHashes.length>0;
  const chunkIndexes=body?r.chunkHashes.flatMap((hash,i)=>r.bodySyncMode==="saved"||!chunksReusable||l!.chunkHashes[i]!==hash?[i]:[]):[];
  requests.push({articleId:r.articleId,bodyHash:r.bodyHash,chunkIndexes,metadataOnly});
 }
 if(limit===2147483647)return requests;if(limit<=0)return requests.filter(r=>!r.chunkIndexes.length);
 let used=0;return requests.filter(r=>{const n=r.chunkIndexes.length;if(!n)return true;if(used===0&&n>limit){used+=n;return true;}if(used+n>limit)return false;used+=n;return true;});
}
