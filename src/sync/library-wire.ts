import {androidJsonQuotedByteLength} from '@podjs/framework/json-string';
import {ACTION_SYNC_LIBRARY,PROTOCOL_VERSION,MAX_FRAME_BYTES,encodeChunkData,type JsonObject} from './protocol.ts';
import {wireFields,parseBodyRequests,type RequestedArticleBody} from './article-batches.ts';
import {bodyForRequest,type PreparedArticle} from './article-export.ts';
import type {ArticleManifest} from './manifest.ts';
const {object,string,bool,optLong,trim}=wireFields;
export interface SyncCursor {localMaxSeq:number;lastRemoteSeqApplied:number;lastLocalSeqAckedByPeer:number}
export interface ChangeSequence {fromSeqExclusive:number;toSeqInclusive:number;fullSnapshot:boolean;fallbackReason:string}
export interface SyncedSource {url:string;sourceDeviceId:string;title:string;description:string;siteUrl:string|null;imageUrl:string|null;createdAt:number;updatedAt:number;sortOrder:number;isPinned:boolean;deleted:boolean;deletedAt:number}
export interface ResponseAck {success:boolean;phase:string;applied:boolean;message:string}
export function parseCursor(frame:JsonObject):SyncCursor {const c=object(frame.syncCursor)??{};return {localMaxSeq:Math.max(0,optLong(c.localMaxSeq)),lastRemoteSeqApplied:Math.max(0,optLong(c.lastRemoteSeqApplied)),lastLocalSeqAckedByPeer:Math.max(0,optLong(c.lastLocalSeqAckedByPeer))};}
export function parseChangeSequence(frame:JsonObject):ChangeSequence {const r=object(frame.changeSeqRange)??{};return {fromSeqExclusive:optLong(r.fromExclusive),toSeqInclusive:optLong(r.toInclusive),fullSnapshot:bool(frame.fullSnapshot,true),fallbackReason:trim(string(frame.fallbackReason))};}
export function parseResponseAck(frame:JsonObject|null):ResponseAck|null {
 if(!frame||string(frame.action)!=='ack')return null;
 const success=bool(frame.success),raw=trim(string(frame.phase)),applied=Object.prototype.hasOwnProperty.call(frame,'applied')?bool(frame.applied):!raw?success:raw==='applied';
 return {success,phase:raw||(applied?'applied':'received'),applied,message:trim(string(frame.message))};
}
export function parseSources(frame:JsonObject):SyncedSource[]{
 const out:SyncedSource[]=[];
 for(const raw of Array.isArray(frame.rssSources)?frame.rssSources:[]){const r=object(raw);if(!r)continue;const url=trim(string(r.url));if(!url)continue;
  out.push({url,sourceDeviceId:trim(string(r.sourceDeviceId))?string(r.sourceDeviceId):string(r.deviceId),title:trim(string(r.title))||url,description:trim(string(r.description)),siteUrl:trim(string(r.siteUrl))||null,imageUrl:trim(string(r.imageUrl))||null,createdAt:optLong(r.createdAt),updatedAt:optLong(r.updatedAt),sortOrder:optLong(r.sortOrder),isPinned:bool(r.isPinned),deleted:bool(r.deleted),deletedAt:optLong(r.deletedAt)});
 }return out;
}
/** Exact byte count for javaJsonQuote, including slash escapes and Java's
 * ASCII '?' replacement for unmatched UTF-16 surrogates. Response bodies are
 * mostly Base64; avoid constructing a second 40-MB JSON string just to size it. */
function quotedBytes(value:string):number {return androidJsonQuotedByteLength(value);}
/** Android JSONObject representation for native size estimates. Undefined
 * object fields are omitted; null remains a literal JSON null. */
function jsonBytes(value:unknown):number {
 if(value===null)return 4;
 if(typeof value==='string')return quotedBytes(value);
 if(typeof value==='boolean')return value?4:5;
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Nonfinite wire number');return (Object.is(value,-0)?'-0':String(value)).length;}
 if(Array.isArray(value))return 2+Math.max(0,value.length-1)+value.reduce<number>((n,item)=>n+jsonBytes(item),0);
 if(value&&typeof value==='object'){
  let bytes=2,first=true;
  for(const [key,item] of Object.entries(value))if(item!==undefined){if(!first)bytes++;first=false;bytes+=quotedBytes(key)+1+jsonBytes(item);}
  return bytes;
 }
 throw new Error('Invalid wire JSON value');
}
export function nativeJsonSize(value:JsonObject):number {return jsonBytes(value);}
/** Emit a short decimal that round-trips to the Android Float value. Legacy
 * Float.toString may choose a different equivalent decimal at exponent edges. */
export function wireProgress(value:number):number {
 const f=Math.fround(Math.max(0,Math.min(1,value)));if(!Number.isFinite(f))throw new Error('Invalid reading progress');if(f===0)return f;
 for(let digits=f<0.001?2:1;digits<=9;digits++){const n=Number(f.toPrecision(digits));if(Math.fround(n)===f)return n;}return f;
}
const envelope=(phase:string,deviceId:string,now:()=>number):JsonObject=>({success:true,version:PROTOCOL_VERSION,action:ACTION_SYNC_LIBRARY,phase,deviceId,sentAt:now()});
export function buildCursorResponse(deviceId:string,cursor:SyncCursor,now=Date.now):JsonObject {return {...envelope('cursor',deviceId,now),supportsManifestBatches:true,syncCursor:{...cursor},supportsAuthoritativeLibraryReplace:true};}
export function buildManifestResponse(deviceId:string,articles:readonly ArticleManifest[],bodyRequests:readonly RequestedArticleBody[],sources:readonly SyncedSource[],sourcesApplied:number,range:ChangeSequence,now=Date.now):JsonObject {
 return {...envelope('manifest',deviceId,now),supportsArticleBatches:true,supportsManifestBatches:true,supportsChunkedBodies:true,supportsChangeSequences:true,supportsMetadataOnlyArticles:true,supportsReceivedAck:true,supportsTransferByteProgress:true,
  articleManifest:articles.map(a=>({...a,readingProgress:wireProgress(a.readingProgress),chunkHashes:[...a.chunkHashes]})),bodyRequests:bodyRequests.map(r=>({...r,chunkIndexes:[...r.chunkIndexes]})),rssSources:sources.map(sourceJson),
  fullSnapshot:range.fullSnapshot,fallbackReason:range.fallbackReason,changeSeqRange:{fromExclusive:range.fromSeqExclusive,toInclusive:range.toSeqInclusive},
  stats:{sourcesSent:sources.length,sourcesApplied,bodyRequests:bodyRequests.length,metadataOnlyRequests:bodyRequests.filter(r=>r.metadataOnly).length,bodyRequestChunks:bodyRequests.reduce((n,r)=>n+r.chunkIndexes.length,0)}};
}
function sourceJson(s:SyncedSource):JsonObject {return Object.fromEntries(Object.entries(s).filter(([,v])=>v!==null));}
const manifestFields=['articleManifest','bodyRequests','rssSources'] as const;
export function manifestBatchCount(frame:JsonObject):number {return Math.max(1,optLong(frame.manifestBatchCount,1));}
export function combineManifestFrames(frames:readonly JsonObject[]):JsonObject {
 if(!frames.length)throw new Error('Empty manifest batches');const first=frames[0]!,count=manifestBatchCount(first);
 if(count>512||frames.length!==count)throw new Error('Incomplete manifest batches');if(count===1)return first;
 const arrays:Record<string,JsonObject[]>={articleManifest:[],bodyRequests:[],rssSources:[]};
 frames.forEach((f,i)=>{if(optLong(f.manifestBatchIndex,-1)!==i||manifestBatchCount(f)!==count||string(f.phase)!=='manifest'||optLong(f.version,14)!==optLong(first.version,14)||string(f.deviceId)!==string(first.deviceId))throw new Error('Manifest batch identity/order mismatch');
  for(const name of manifestFields)for(const item of Array.isArray(f[name])?f[name] as unknown[]:[]){const o=object(item);if(o)arrays[name]!.push(o);}
 });
 const combined={...first};for(const name of manifestFields)if(name in combined||arrays[name]!.length)combined[name]=arrays[name];
 delete combined.manifestBatchIndex;delete combined.manifestBatchCount;combined.manifestTotalArticles=arrays.articleManifest!.length;return combined;
}
export function buildManifestFrames(payload:JsonObject):JsonObject[]{
 if(payload.phase!=='manifest')throw new Error('Only manifest messages can use manifest batches');const base:JsonObject={...payload,supportsManifestBatches:true};if(nativeJsonSize(base)<=MAX_FRAME_BYTES)return [base];
 const groups:{name:string;value:JsonObject}[][]=[];let group:{name:string;value:JsonObject}[]=[],bytes=0;
 for(const name of manifestFields)for(const raw of Array.isArray(base[name])?base[name] as unknown[]:[]){const value=object(raw);if(!value)continue;const size=nativeJsonSize(value);if(size>MAX_FRAME_BYTES)throw new Error('Manifest entry exceeds frame limit');if(group.length&&bytes+size>1024*1024){groups.push(group);group=[];bytes=0;}group.push({name,value});bytes+=size;}
 if(group.length)groups.push(group);if(!groups.length||groups.length+1>512)throw new Error('Manifest metadata/batch limit exceeded');
 const count=groups.length+1,total=Array.isArray(base.articleManifest)?base.articleManifest.length:0;
 const header:JsonObject={...base,manifestBatchIndex:0,manifestBatchCount:count,manifestTotalArticles:total};for(const name of manifestFields)if(name in header)header[name]=[];
 const frames=[header,...groups.map((items,i)=>{const frame:JsonObject={...(payload.success!==undefined?{success:bool(payload.success)}:{}),version:optLong(payload.version,14),action:ACTION_SYNC_LIBRARY,phase:'manifest',deviceId:string(payload.deviceId),sentAt:optLong(payload.sentAt),supportsManifestBatches:true,articleManifest:[],bodyRequests:[],rssSources:[],manifestBatchIndex:i+1,manifestBatchCount:count,manifestTotalArticles:total};for(const item of items)(frame[item.name] as JsonObject[]).push(item.value);return frame;})];
 if(frames.some(f=>nativeJsonSize(f)>MAX_FRAME_BYTES))throw new Error('Manifest frame exceeds limit');return frames;
}
function articleItems(prepared:PreparedArticle,request:RequestedArticleBody):JsonObject[]{
 const payload=bodyForRequest(prepared,request),a=prepared.article;
 const names=['articleId','legacyArticleIds','sourceDeviceId','url','title','siteName','excerpt','imageUrl','contentHash','importedAt','updatedAt','independentSaved','independentChangedAt','independentSortOrder','rssSourceUrl','rssSourceTitle','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','isRead'] as const;
 const meta:JsonObject={};for(const key of names)if(a[key]!==null&&a[key]!==undefined)meta[key]=key==='readingProgress'?wireProgress(a.readingProgress):a[key];
 const groups=payload.metadataOnly||!payload.chunks.length?[[]]:payload.chunks.map(c=>[c]);
 return groups.map(chunks=>({...meta,body:{bodyHash:payload.bodyHash,bodyByteCount:payload.bodyByteCount,chunkSize:payload.chunkSize,chunkHashes:[...payload.chunkHashes],metadataOnly:!!payload.metadataOnly,chunks:chunks.map(c=>({index:c.index,hash:c.hash,data:encodeChunkData(c.bytes)}))}}));
}
function itemSize(item:JsonObject):{estimate:number;exact:number} {const body=object(item.body),chunks=body&&Array.isArray(body.chunks)?body.chunks:[];const size=chunks.reduce<number>((n,c)=>n+string(object(c)?.data).length,0),exact=nativeJsonSize(item);return {estimate:size>64*1024?size+8*1024:exact,exact};}
function hints(frames:JsonObject[],sizes:number[]):JsonObject[]{const bytes=sizes.map(n=>n+164),total=bytes.reduce((a,b)=>a+b,0);return frames.map((f,i)=>({...f,batchWireBytes:bytes[i],batchTotalWireBytes:total}));}
/** Each body chunk is a separate repeated article item, as on Android. */
export function buildChunkedResponseFrames(deviceId:string,prepared:readonly PreparedArticle[],requests:readonly RequestedArticleBody[],applied:number,sourcesApplied:number,useBatches:boolean,now=Date.now,onProgress?:(stage:string,count:number)=>void):JsonObject[]{
 const requested=new Map(requests.map(r=>[r.articleId,r])),items:JsonObject[]=[];
 for(let i=0;i<prepared.length;i++){
  const p=prepared[i]!;items.push(...articleItems(p,requested.get(p.article.articleId)??{articleId:p.article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}));
  if(onProgress&&(i+1)%100===0)onProgress('items',i+1);
 }
 onProgress?.('items',prepared.length);
 const stats=(sent:number)=>({sent,applied,sourcesSent:0,sourcesApplied});
 if(!useBatches){const frame={...envelope('complete',deviceId,now),articles:items,stats:stats(items.length)};return hints([frame],[nativeJsonSize(frame)]);}
 let groups:{item:JsonObject;size:number;exact:number}[][]=[],group:{item:JsonObject;size:number;exact:number}[]=[],bytes=0;
 for(let i=0;i<items.length;i++){const item=items[i]!,{estimate:size,exact}=itemSize(item);if(group.length&&bytes+size>384*1024){groups.push(group);group=[];bytes=0;}group.push({item,size,exact});bytes+=size;if(onProgress&&(i+1)%100===0)onProgress('sizes',i+1);}if(group.length)groups.push(group);if(!groups.length)groups=[[]];
 onProgress?.('sizes',items.length);
 let estimates:number[]=[];
 while(true){estimates=groups.map(g=>g.reduce((n,x)=>n+x.size,0)+Math.max(0,g.length-1)+2048);const oversized=estimates.findIndex(n=>n>MAX_FRAME_BYTES);if(oversized<0)break;const g=groups[oversized]!;if(g.length<2)throw new Error('Article item exceeds response frame limit');const half=Math.floor(g.length/2);groups.splice(oversized,1,g.slice(0,half),g.slice(half));}
 let frames:JsonObject[]=groups.map((g,i)=>({...envelope('complete',deviceId,now),articles:g.map(x=>x.item),batchIndex:i,batchCount:groups.length,totalArticles:prepared.length,...(i===0?{stats:stats(prepared.length)}:{})}));
 if(!items.length)estimates=[nativeJsonSize(frames[0]!)];
 frames=hints(frames,estimates);
 if(frames.length>1||frames.some(f=>Number(f.batchWireBytes)>16*1024)){
  const header:JsonObject={...envelope('complete',deviceId,now),articles:[],batchIndex:0,batchCount:frames.length+1,totalArticles:prepared.length,stats:stats(prepared.length)};
  frames=[header,...frames.map((f,i)=>({...f,batchIndex:i+1,batchCount:frames.length+1}))];estimates=[nativeJsonSize(header),...estimates];frames=hints(frames,estimates);
 }
 const offset=frames.length-groups.length;
 for(let i=0;i<frames.length;i++){
  const frame=frames[i]!,group=groups[i-offset];
  const exact=group?nativeJsonSize({...frame,articles:[]})-2+group.reduce((n,x)=>n+x.exact,0)+Math.max(0,group.length-1):nativeJsonSize(frame);
  if(exact>MAX_FRAME_BYTES)throw new Error('Article response frame exceeds limit');if(onProgress&&(i+1)%20===0)onProgress('verify',i+1);
 }
 onProgress?.('verify',frames.length);return frames;
}
export {parseBodyRequests};
