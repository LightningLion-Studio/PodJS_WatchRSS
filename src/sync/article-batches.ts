import {ACTION_SYNC_LIBRARY,PHASE_ARTICLES,decodeChunkData,type JsonObject} from "./protocol.ts";
import {isWireInteger,wireNumberToken} from "./wire-json.ts";
import {validateBodyShape,type SyncBodyPayload,type SyncBodyChunk} from "./article-body.ts";
import type {IncomingArticle} from "./article-receiver.ts";
const trim=(v:string)=>v.replace(/^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,"");
const object=(v:unknown):JsonObject|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as JsonObject:null;
const string=(v:unknown):string=>v===undefined?"":v===null?"null":typeof v==="string"?v:JSON.stringify(v);
const bool=(v:unknown,fallback=false):boolean=>typeof v==="boolean"?v:typeof v==="string"&&/^(true|false)$/i.test(v)?v.toLowerCase()==="true":fallback;
function optLong(v:unknown,fallback=0):number{
 if(typeof v!=="number"&&typeof v!=="string")return fallback;
 if(typeof v==="string"&&!v.trim())return fallback;
 const n=Number(v);if(!Number.isFinite(n))return fallback;
 const value=Math.trunc(n);if(!Number.isSafeInteger(value))throw new Error("sync integer exceeds exact JavaScript range");return value;
}
function optInt(parent:JsonObject,key:string,fallback=0):number{
 const v=parent[key];if(typeof v!=="number"&&typeof v!=="string")return fallback;
 if(typeof v==="string"&&!v.trim())return fallback;const n=Number(v);if(Number.isNaN(n))return fallback;
 const token=wireNumberToken(parent,key);
 if(typeof v==="number"&&Number.isSafeInteger(v)&&(token===undefined||/^-?[0-9]+$/.test(token)))return v|0;
 return Math.max(-2147483648,Math.min(2147483647,Math.trunc(n)));
}
function strictInteger(parent:JsonObject,key:string,fallback:number,min:number,max:number):number{
 if(!Object.prototype.hasOwnProperty.call(parent,key))return fallback;
 const v=parent[key];if(!isWireInteger(parent,key)||Number(v)<min||Number(v)>max)throw new Error(`invalid body integer: ${key}`);return Number(v);
}
export interface RequestedArticleBody {articleId:string;bodyHash:string;chunkIndexes:readonly number[];metadataOnly:boolean}
export interface WireIncomingArticle extends IncomingArticle {contentHash:string;independentSaved:boolean;independentChangedAt:number;independentSortOrder:number;deletedAt:number}
export interface ReceivedArticle {article:WireIncomingArticle;body:SyncBodyPayload}
export interface ArticleBatchReceipt {frameCount:number;receivedArticles:number;committedArticles:number;bodyRequests:readonly RequestedArticleBody[]}
export function validateArticleRequestFrame(frame:JsonObject,index:number,count?:number):number{
 if(frame.action!==ACTION_SYNC_LIBRARY||frame.phase!==PHASE_ARTICLES)throw new Error("unexpected articles request action/phase");
 const hasIndex=Object.prototype.hasOwnProperty.call(frame,"batchIndex"),hasCount=Object.prototype.hasOwnProperty.call(frame,"batchCount");
 if(!hasIndex&&!hasCount&&count===undefined&&index===0)return 1;
 if(!hasIndex||!hasCount)throw new Error("incomplete article batch fields");
 const n=optInt(frame,"batchCount",-1),i=optInt(frame,"batchIndex",-1);
 if(n<1||n>256||i<0||i>=n||i!==index||(count!==undefined&&n!==count))throw new Error("article batch index/count mismatch");return n;
}
export function parseBodyRequests(frame:JsonObject):RequestedArticleBody[]{
 if(!Array.isArray(frame.bodyRequests))return [];
 const out:RequestedArticleBody[]=[];
 for(const raw of frame.bodyRequests){const item=object(raw);if(!item)continue;const id=trim(string(item.articleId));if(!id)continue;
  const indexes=Array.isArray(item.chunkIndexes)?item.chunkIndexes:[];
  for(let i=0;i<indexes.length;i++)if(!isWireInteger(indexes,String(i))||Number(indexes[i])<0||Number(indexes[i])>2147483647)throw new Error("invalid requested chunk index");
  out.push({articleId:id,bodyHash:trim(string(item.bodyHash)),chunkIndexes:indexes as number[],metadataOnly:bool(item.metadataOnly)});
 }return out;
}
function merge(first:ReceivedArticle,next:ReceivedArticle):ReceivedArticle{
 const a=first.body,b=next.body;
 if(a.bodyHash!==b.bodyHash||a.bodyByteCount!==b.bodyByteCount||a.chunkSize!==b.chunkSize||a.metadataOnly!==b.metadataOnly||a.chunkHashes.length!==b.chunkHashes.length||a.chunkHashes.some((h,i)=>h!==b.chunkHashes[i]))throw new Error("conflicting article body metadata");
 const chunks=new Map<number,SyncBodyChunk>();
 for(const c of [...a.chunks,...b.chunks]){const old=chunks.get(c.index);if(old&&(old.hash!==c.hash||old.bytes.length!==c.bytes.length||old.bytes.some((v,i)=>v!==c.bytes[i])))throw new Error("conflicting duplicate body chunk");if(!old)chunks.set(c.index,c);}
 return {article:next.article,body:{...a,chunks:[...chunks.values()].sort((x,y)=>x.index-y.index)}};
}
export function parseChunkedArticles(frame:JsonObject):ReceivedArticle[]{
 if(!Array.isArray(frame.articles))return [];
 const out=new Map<string,ReceivedArticle>();
 for(const raw of frame.articles){
  const item=object(raw);if(!item)continue;const articleId=trim(string(item.articleId)),url=trim(string(item.url));if(!articleId||!url)continue;
  const progress=typeof item.readingProgress==="number"||typeof item.readingProgress==="string"?Number(item.readingProgress):0,bodyObject=object(item.body)??{};
  const hashes=Array.isArray(bodyObject.chunkHashes)?bodyObject.chunkHashes:[];
  if(hashes.some(h=>typeof h!=="string"))throw new Error("invalid body chunk hash array");
  const chunks:SyncBodyChunk[]=[];
  for(const rawChunk of Array.isArray(bodyObject.chunks)?bodyObject.chunks:[]){const c=object(rawChunk);if(!c)continue;const data=string(c.data);if(!trim(data))continue;chunks.push({index:optInt(c,"index"),hash:trim(string(c.hash)),bytes:decodeChunkData(data)});}
  const body:SyncBodyPayload={articleId,bodyHash:trim(string(bodyObject.bodyHash)),bodyByteCount:strictInteger(bodyObject,"bodyByteCount",-1,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),chunkSize:strictInteger(bodyObject,"chunkSize",-1,-2147483648,2147483647),chunkHashes:(hashes as string[]).map(h=>{const value=trim(h);if(!value)throw new Error("empty body chunk hash");return value;}),chunks,metadataOnly:bool(bodyObject.metadataOnly)};
  const article:WireIncomingArticle={articleId,url,sourceDeviceId:trim(string(item.sourceDeviceId))?string(item.sourceDeviceId):string(item.deviceId),title:trim(string(item.title))||url,siteName:trim(string(item.siteName)),excerpt:trim(string(item.excerpt)),imageUrl:trim(string(item.imageUrl))||null,
   contentHash:trim(string(item.contentHash)),independentSaved:bool(item.independentSaved,!bool(item.favoriteSaved)&&!bool(item.watchLaterSaved)&&!bool(item.deleted)&&!trim(string(item.rssSourceUrl))),independentChangedAt:optLong(item.independentChangedAt),independentSortOrder:optLong(item.independentSortOrder),deletedAt:optLong(item.deletedAt),
   importedAt:optLong(item.importedAt),updatedAt:optLong(item.updatedAt),rssSourceUrl:trim(string(item.rssSourceUrl))||null,rssSourceTitle:trim(string(item.rssSourceTitle))||null,
   favoriteSaved:bool(item.favoriteSaved),favoriteChangedAt:optLong(item.favoriteChangedAt),favoriteSortOrder:optLong(item.favoriteSortOrder),watchLaterSaved:bool(item.watchLaterSaved),watchLaterChangedAt:optLong(item.watchLaterChangedAt),watchLaterSortOrder:optLong(item.watchLaterSortOrder),
   readingProgress:Number.isFinite(progress)?Math.fround(Math.max(0,Math.min(1,progress))):0,readingPositionBytes:Math.max(0,optLong(item.readingPositionBytes)),readingPositionContentHash:trim(string(item.readingPositionContentHash)),readingPositionChangedAt:Math.max(0,optLong(item.readingPositionChangedAt)),isRead:bool(item.isRead),deleted:bool(item.deleted)};
  const parsed={article,body};const own=merge({...parsed,body:{...body,chunks:[]}},parsed),old=out.get(articleId);out.set(articleId,old?merge(old,own):own);
 }return [...out.values()];
}

export function parseChunkedArticleFrames(frames:readonly JsonObject[]):ReceivedArticle[]{
 const articles=new Map<string,ReceivedArticle>();
 for(const frame of frames)for(const item of parseChunkedArticles(frame)){const old=articles.get(item.article.articleId);articles.set(item.article.articleId,old?merge(old,item):item);}
 return [...articles.values()];
}

/** Article phase only. The selected requests must come from the manifest
 * coordinator, not from the peer's current article frame. No wire ACK is sent. */
export class ArticleBatchReceiver {
 private count:number|undefined;
 private frameIndex=0;
 private pending:ReceivedArticle|null=null;
 private completed=new Set<string>();
 private requests:RequestedArticleBody[]=[];
 private received=0;
 private committed=0;
 private done=false;
 private failure:Error|null=null;
 private tail:Promise<unknown>=Promise.resolve();
 private readonly selected=new Map<string,RequestedArticleBody>();
 constructor(selected:readonly RequestedArticleBody[],private readonly commit:(article:ReceivedArticle)=>Promise<void>,private readonly options:{ignoreIncoming?:boolean;flushCompleteArticles?:boolean}={}){
  for(const request of selected){if(this.selected.has(request.articleId))throw new Error("duplicate selected article");this.selected.set(request.articleId,{...request,chunkIndexes:[...request.chunkIndexes]});}
 }
 consume(frame:JsonObject):Promise<ArticleBatchReceipt|null>{
  const next=this.tail.then(()=>this.consumeNext(frame));this.tail=next.catch(()=>{});return next;
 }
 abort(reason="article transfer aborted"):void{this.failure??=new Error(reason);this.pending=null;}
 get committedArticles(){return this.committed;}
 get checkpointReady(){return this.pending===null;}
 finish():void{if(this.failure)throw this.failure;if(!this.done)throw new Error("truncated article batches");}
 private check():void{if(this.failure)throw this.failure;}
 private async consumeNext(frame:JsonObject):Promise<ArticleBatchReceipt|null>{
  try{
   this.check();if(this.done)throw new Error("article phase already complete");
   const count=validateArticleRequestFrame(frame,this.frameIndex,this.count);this.count=count;
   const entries=parseChunkedArticles(frame),requests=parseBodyRequests(frame),ready:ReceivedArticle[]=[];
   for(const entry of entries){
    if(!this.options.ignoreIncoming){
     const request=this.selected.get(entry.article.articleId);if(!request||request.bodyHash!==entry.body.bodyHash||request.metadataOnly!==!!entry.body.metadataOnly)throw new Error("unsolicited article body");
     validateBodyShape(entry.body);
     if(entry.body.bodyByteCount>64*1024*1024)throw new Error("encoded article body exceeds receive buffer limit");
     for(const c of entry.body.chunks){const expected=Math.min(entry.body.chunkSize,entry.body.bodyByteCount-c.index*entry.body.chunkSize);if(c.bytes.length!==expected)throw new Error("body chunk length mismatch");if(request.chunkIndexes.length&&!request.chunkIndexes.includes(c.index))throw new Error("unsolicited body chunk");}
    }
    if(this.pending?.article.articleId===entry.article.articleId)this.pending=merge(this.pending,entry);
    else{
     if(this.completed.has(entry.article.articleId))throw new Error("noncontiguous article batches");
     if(this.pending){this.completed.add(this.pending.article.articleId);ready.push(this.pending);}
     this.pending=entry;this.received++;
    }
   }
   if(this.options.flushCompleteArticles&&this.pending){
    const body=this.pending.body;
    const indexes=this.selected.get(this.pending.article.articleId)?.chunkIndexes??[];
    const expected=indexes.length?indexes:body.chunkHashes.map((_,i)=>i);
    if(body.metadataOnly||expected.every(index=>body.chunks.some(chunk=>chunk.index===index))){
     this.completed.add(this.pending.article.articleId);ready.push(this.pending);this.pending=null;
    }
   }
   this.requests.push(...requests);
   for(const article of ready)await this.commitOne(article);
   this.frameIndex++;
   if(this.frameIndex<count)return null;
   if(this.pending){await this.commitOne(this.pending);this.completed.add(this.pending.article.articleId);this.pending=null;}
   this.check();
   if(this.received!==this.committed)throw new Error("article commit count mismatch");
   // A peer may omit unavailable requested articles, as the native protocol
   // permits. Report actual committed counts, never the requested count.
   this.done=true;return {frameCount:this.frameIndex,receivedArticles:this.received,committedArticles:this.committed,bodyRequests:this.requests.slice()};
  }catch(error){this.abort(error instanceof Error?error.message:String(error));throw this.failure;}
 }
 private async commitOne(article:ReceivedArticle):Promise<void>{this.check();await this.commit(article);this.check();this.committed++;}
}

/** Shared JSONObject field semantics for manifest and article phases. */
export const wireFields={trim,object,string,bool,optLong,optInt,strictInteger};
