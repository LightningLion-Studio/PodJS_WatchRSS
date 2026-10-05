import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {isImportedContentUrl} from '../core/imported-content';
import {parseChunkedArticles} from '../sync/article-batches';
import {parseSources,type SyncedSource} from '../sync/library-wire';
import type {ExportedArticle} from '../sync/article-export';
import type {JsonObject} from '../sync/protocol';
import {utf8Encode,utf8Decode,type RssInventory} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface CloudLibrarySnapshot {articles:readonly ExportedArticle[];sources:readonly SyncedSource[];stateArticles:readonly ExportedArticle[]}
export interface CloudLibraryRepository {
 cloudSnapshot(full:boolean):Promise<CloudLibrarySnapshot>;
 /** Each entity commits its source/body/saved/reading state transactionally. No
  * applied cursor or ACK may be advanced until this entire operation succeeds. */
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string):Promise<number>;
}
export interface CloudLibraryCrypto {gzip(bytes:Uint8Array):Promise<Uint8Array>;gunzip(bytes:Uint8Array,max:number):Promise<Uint8Array>;sha256(bytes:Uint8Array):Promise<string>;stableId(url:string):Promise<string>}
export const privateCloudBody=(a:Pick<ExportedArticle,'url'|'rssSourceUrl'>)=>isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim();
const stateJson=(a:ExportedArticle)=>{const {contentHtml,contentText,...state}=a;return state;};
export class WatchCloudLibraryAdapter {
 constructor(private repository:CloudLibraryRepository,private deviceId:string,private crypto:CloudLibraryCrypto,private guard:CloudGuard=cloudDisabled){}
 async publicSources(){this.guard.require();return (await this.repository.cloudSnapshot(false)).sources.filter(s=>!s.deleted&&!isImportedContentUrl(s.url)&&/^https?:\/\//i.test(s.url));}
 /** Stable timestamps: wall-clock export time must not force an upload on every tick. */
 async exportPayloads(full:boolean){
  this.guard.require();const snapshot=await this.repository.cloudSnapshot(full);
  const sources=[...snapshot.sources].sort((a,b)=>a.url.localeCompare(b.url));
  const stateArticles=[...snapshot.stateArticles].sort((a,b)=>a.articleId.localeCompare(b.articleId));
  const state=utf8Encode(JSON.stringify({format:'watchrss-rss-state',version:1,exportedAt:0,articles:stateArticles.map(stateJson),sources}));
  let relay:Uint8Array|undefined;
  if(full){const articles:JsonObject[]=[];
   for(const a of [...snapshot.articles].sort((a,b)=>a.articleId.localeCompare(b.articleId))){
    const out:JsonObject=Object.fromEntries(Object.entries(stateJson(a)).filter(([,value])=>value!==null));
    if(privateCloudBody(a)){
     if(a.contentHtml!==null)out.contentHtmlGzip=bytesToBase64(await this.crypto.gzip(utf8Encode(a.contentHtml)));
     out.contentTextGzip=bytesToBase64(await this.crypto.gzip(utf8Encode(a.contentText)));
    }else out.contentTextGzip=bytesToBase64(await this.crypto.gzip(utf8Encode('')));
    articles.push(out);
   }
   relay=utf8Encode(JSON.stringify({success:true,version:14,action:'syncLibrary',phase:'complete',deviceId:this.deviceId,sentAt:0,articles,rssSources:sources.map(source=>Object.fromEntries(Object.entries(source).filter(([,value])=>value!==null))),stats:{sent:articles.length,applied:0,sourcesSent:sources.length,sourcesApplied:0}}));
  }
  return {state,relay};
 }
 private async decode(bytes:Uint8Array,state:boolean):Promise<{sources:SyncedSource[];articles:ExportedArticle[]}>{
  const root=JSON.parse(utf8Decode(bytes));
  if(!root||!Array.isArray(root.articles)||root.articles.length>100000)throw Error('无效云资料');
  if(state&&(root.format!=='watchrss-rss-state'||root.version!==1))throw Error('云端RSS状态格式不受支持');
  if(!state&&(root.action!=='syncLibrary'||root.version!==14))throw Error('云资料格式不受支持');
  const sourceRows=state?(root.sources??[]):(root.rssSources??[]);
  if(!Array.isArray(sourceRows)||sourceRows.some((s:any)=>!s||typeof s.url!=='string'||!s.url.trim()))throw Error('无效云订阅');
  const articles:ExportedArticle[]=[];
  for(const raw of root.articles){
   if(!raw||typeof raw.articleId!=='string'||!raw.articleId.trim()||typeof raw.url!=='string'||!raw.url.trim())throw Error('无效云文章');
   // Reuse native-compatible metadata normalization, without chunked-body validation.
   const clean=Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==null));
   const metadata=parseChunkedArticles({articles:[{...clean,body:{}}]})[0]?.article;
   if(!metadata)throw Error('无效云文章');
   const unzip=async(key:string)=>{if(raw[key]==null||raw[key]==='')return null;if(typeof raw[key]!=='string'||raw[key].length>Math.ceil(32*1024*1024/3)*4)throw Error('云正文过大');return utf8Decode(await this.crypto.gunzip(base64ToBytes(raw[key]),32*1024*1024));};
   articles.push({...metadata,contentHtml:state?null:await unzip('contentHtmlGzip'),contentText:state?'':(await unzip('contentTextGzip'))??''});
  }
  return {sources:parseSources({rssSources:sourceRows.map((s:JsonObject)=>Object.fromEntries(Object.entries(s).filter(([,v])=>v!==null)))}),articles};
 }
 async restorePayloads(payload:Map<string,Uint8Array>,remote:string){
  this.guard.require();const decoded=[];
  // Validate/decompress both objects before any mutation. Retry safely after a
  // process interruption; entity merges are clock-based and idempotent.
  for(const [name,state] of [['library-sync.json',false],['rss-state.json',true]] as const){const bytes=payload.get(name);if(bytes)decoded.push(await this.decode(bytes,state));}
  let changed=0;for(const value of decoded)changed+=await this.repository.mergeCloud(value.sources,value.articles,remote);return changed;
 }
 async mergeInventory(inventory:RssInventory){
  this.guard.require();if(isImportedContentUrl(inventory.url)||!/^https?:\/\//i.test(inventory.url))throw Error('非公共 RSS');
  const articles:ExportedArticle[]=[];
  for(const item of inventory.items){
   const id=await this.crypto.stableId(item.url),hash=item.contentHash??await this.crypto.sha256(utf8Encode(item.contentHtml??item.contentText??item.url));
   // Inventories supply no save/reading mutation clocks. The repository
   // preserves existing publication timestamps across repeated fetches.
   articles.push({articleId:id,sourceDeviceId:'cloud-rss-inventory',url:item.url,title:item.title||item.url,siteName:inventory.title||inventory.url,excerpt:item.excerpt,contentHtml:item.contentHtml,contentText:item.contentText||item.excerpt,imageUrl:item.imageUrl,contentHash:hash,importedAt:0,updatedAt:0,rssSourceUrl:inventory.url,rssSourceTitle:inventory.title||inventory.url,independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false});
  }
  return this.repository.mergeCloud([],articles,'cloud-rss-inventory');
 }
}
