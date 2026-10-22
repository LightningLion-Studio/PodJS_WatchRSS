import {base64ToBytes} from '@podjs/framework/bytes';
import {isImportedContentUrl} from '../core/imported-content';
import {parseChunkedArticles} from '../sync/article-batches';
import {parseSources,type SyncedSource} from '../sync/library-wire';
import type {ExportedArticle} from '../sync/article-export';
import type {JsonObject} from '../sync/protocol';
import {utf8Encode,utf8Decode,type RssInventory} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
import {writeWrss,readWrss} from './wrss';
import type {LogicalObject,CloudObject} from './codec';
import {rssSourceKey,rssArticleId,legacyWebArticleId,tryRssArticleId,isLocalOnlyRssSource,canonicalRssUrl} from './rss-identity';
import {canonical,type RecordDocument} from './records';
export interface CloudLibrarySnapshot {articles:readonly ExportedArticle[];sources:readonly SyncedSource[];stateArticles:readonly ExportedArticle[];pendingPrivateBodies?:boolean;pendingPrivateArticleIds?:readonly string[]}
export interface CloudLibraryRepository {
 cloudSnapshot(full:boolean):Promise<CloudLibrarySnapshot>;
 cloudReadingCandidates?():Promise<readonly ExportedArticle[]>;
 /** Each entity commits its source/body/saved/reading state transactionally. No
  * applied cursor or ACK may be advanced until this entire operation succeeds. */
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string):Promise<number>;
}
export interface CloudLibraryCrypto {gzip(bytes:Uint8Array):Promise<Uint8Array>;gunzip(bytes:Uint8Array,max:number):Promise<Uint8Array>;sha256(bytes:Uint8Array):Promise<string>;stableId(url:string):Promise<string>}
export const privateCloudBody=(a:Pick<ExportedArticle,'url'|'rssSourceUrl'>)=>isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim();
const stateJson=(a:ExportedArticle)=>{const {contentHtml,contentText,cloudRssArticleId,cloudLegacyArticleIds,...state}=a;return state;};
export class WatchCloudLibraryAdapter {
 constructor(private repository:CloudLibraryRepository,private deviceId:string,private crypto:CloudLibraryCrypto,private guard:CloudGuard=cloudDisabled){}
 async publicSources(){this.guard.require();return (await this.repository.cloudSnapshot(false)).sources.filter(s=>!s.deleted&&!isImportedContentUrl(s.url)&&/^https?:\/\//i.test(s.url)&&!isLocalOnlyRssSource(s.url));}
 private async articleIdentity(a:ExportedArticle){return a.cloudRssArticleId??tryRssArticleId({link:a.url,title:a.title,contentHash:a.contentHash},this.crypto.sha256);}
 private sourceIds=new Map<string,string>();
 private pendingReading=new Map<string,RecordDocument>();
 private readingAliases=new Map<string,string>();
 private retainedSources=new Map<string,Record<string,any>>();
 async exportRecords():Promise<RecordDocument[]>{
  this.guard.require();const s=await this.repository.cloudSnapshot(false),out:RecordDocument[]=[];
  for(const source of s.sources){const sourceId=this.sourceIds.get(source.url);out.push({kind:'source',value:{url:source.url,sourceDeviceId:source.sourceDeviceId,sourceId:sourceId??'',title:source.title,sortOrder:source.sortOrder,isPinned:source.isPinned,updatedAt:source.updatedAt,deleted:source.deleted,deletedAt:source.deletedAt,...Object.fromEntries(Object.entries(this.retainedSources.get(source.url)??{}).filter(([k])=>['useOriginalContent','continuePlaybackInBackground'].includes(k)))}});}
  for(const a of s.stateArticles){
   if(privateCloudBody(a)){out.push({kind:'article',value:Object.fromEntries(Object.entries(stateJson(a)).filter(([,v])=>v!==null))});continue;}
   if(isLocalOnlyRssSource(a.rssSourceUrl!))continue;
   if(!(a.isRead||a.readingProgress||a.readingPositionChangedAt||a.favoriteChangedAt||a.watchLaterChangedAt||a.favoriteSaved||a.watchLaterSaved))continue;
   const articleId=await this.articleIdentity(a);if(!articleId)continue;const sourceId=await rssSourceKey(a.rssSourceUrl!,this.crypto.sha256);
   const value:Record<string,any>={sourceId,articleIdHash:await this.crypto.sha256(utf8Encode(articleId)),sourceDeviceId:a.sourceDeviceId};
   for(const k of ['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'] as const)value[k]=a[k];
   if(!value.readingPositionChangedAt&&(a.isRead||a.readingProgress))value.readingPositionChangedAt=a.updatedAt;
   out.push({kind:'rss-state',value});
  }
  // States may precede public entries, or outlive entries expired from the pool.
  const combined=new Map<string,RecordDocument>();for(const doc of out.filter(d=>d.kind==='rss-state')){const id=doc.value.sourceId+':'+doc.value.articleIdHash,old=combined.get(id);combined.set(id,old?{kind:doc.kind,value:mergeReadingValue(old.value,doc.value)}:doc);}out.splice(0,out.length,...out.filter(d=>d.kind!=='rss-state'),...combined.values());
  const blocked=new Set<string>();for(const source of s.sources)if(isLocalOnlyRssSource(source.url)){const poolId=this.sourceIds.get(source.url);if(poolId)blocked.add(poolId);try{blocked.add(await this.crypto.sha256(utf8Encode(canonicalRssUrl(source.url,false))));}catch{/* Credentialed URLs have no public source key. */}}
  const ids=new Set(out.filter(d=>d.kind==='rss-state').map(d=>d.value.sourceId+':'+d.value.articleIdHash));for(const [id,doc]of this.pendingReading)if(!ids.has(id)&&!blocked.has(doc.value.sourceId)){const current=combined.get(this.readingAliases.get(id)??'');out.push(current?{kind:doc.kind,value:mergeReadingValue(doc.value,current.value)}:doc);}
  return out;
 }
 async applyRecords(documents:RecordDocument[]){
  this.guard.require();let changed=0;const articles:ExportedArticle[]=[],sources:SyncedSource[]=[];
  for(const doc of documents.filter(d=>d.kind==='source')){const v=doc.value;if(v.sourceId)this.sourceIds.set(v.url,v.sourceId);}
  for(const doc of documents){const v=doc.value;
   if(doc.kind==='source'){this.retainedSources.set(v.url,v);if(v.sourceId)this.sourceIds.set(v.url,v.sourceId);sources.push(...parseSources({rssSources:[v]}));}
   else if(doc.kind==='rss-state'){const id=v.sourceId+':'+v.articleIdHash,old=this.pendingReading.get(id);this.pendingReading.set(id,old?{kind:doc.kind,value:mergeReadingValue(old.value,v)}:doc);}
   else if(doc.kind==='article'){
    if(v.deleted&&!privateCloudBody(v as ExportedArticle))continue;
    // Old public index tombstones retire cloud metadata, never delete cached pool articles.
    if(!privateCloudBody(v as ExportedArticle)&&!v.deleted){if(isLocalOnlyRssSource(v.rssSourceUrl))continue;const articleId=await tryRssArticleId({link:v.url,guid:v.guid,title:v.title,contentHash:v.contentHash},this.crypto.sha256);if(!articleId)continue;const sourceId=await rssSourceKey(v.rssSourceUrl,this.crypto.sha256);if(v.isRead||v.readingProgress||v.readingPositionChangedAt||v.favoriteChangedAt||v.watchLaterChangedAt||v.favoriteSaved||v.watchLaterSaved){const hash=await this.crypto.sha256(utf8Encode(articleId)),id=sourceId+':'+hash,value={...Object.fromEntries(Object.entries(v).filter(([k])=>k.startsWith('reading')||k.startsWith('favorite')||k.startsWith('watchLater')||['isRead','sourceDeviceId','deleted','deletedAt'].includes(k))),sourceId,articleIdHash:hash,readingPositionChangedAt:v.readingPositionChangedAt||(v.isRead||v.readingProgress?v.updatedAt:0)||0},old=this.pendingReading.get(id);this.pendingReading.set(id,{kind:'rss-state',value:old?mergeReadingValue(old.value,value):value});}if(!v.favoriteSaved&&!v.watchLaterSaved)continue;}
    const clean=Object.fromEntries(Object.entries(v).filter(([,v])=>v!==null));const a=parseChunkedArticles({articles:[{...clean,body:{}}]})[0]?.article;if(!a)throw Error('cloud_record_invalid');articles.push({...a,contentHtml:null,contentText:''});
   }
  }
  if(sources.length||articles.length)changed+=await this.repository.mergeCloud(sources,articles,'cloud-records');return changed+await this.applyReadingStates();
 }
 async applyReadingStates(){
  if(!this.pendingReading.size)return 0;
  const candidates=this.repository.cloudReadingCandidates?await this.repository.cloudReadingCandidates():(await this.repository.cloudSnapshot(false)).stateArticles,articles:ExportedArticle[]=[];
  for(const a of candidates){
   if(!a.rssSourceUrl||isImportedContentUrl(a.rssSourceUrl)||isLocalOnlyRssSource(a.rssSourceUrl))continue;
   const articleId=await this.articleIdentity(a);if(!articleId)continue;
   const hash=await this.crypto.sha256(utf8Encode(articleId)),sourceId=await rssSourceKey(a.rssSourceUrl,this.crypto.sha256),aliases:string[]=[];
   // Only web URLs had a legacy URL projection. Opaque links must never all
   // alias the backend's empty-input hash and inherit another entry's state.
   let web=false;try{canonicalRssUrl(a.url,false);web=true;}catch{}
   if(web)for(const id of [await rssArticleId(a.url,this.crypto.sha256),await legacyWebArticleId(a.url,this.crypto.sha256)]){
    const alias=await this.crypto.sha256(utf8Encode(id));if(alias!==hash){aliases.push(sourceId+':'+alias);this.readingAliases.set(sourceId+':'+alias,sourceId+':'+hash);}
   }
   let merged:Record<string,any>|undefined;
   for(const key of [sourceId+':'+hash,this.sourceIds.get(a.rssSourceUrl)+':'+hash,...aliases]){const remote=this.pendingReading.get(key);if(remote)merged=merged?mergeReadingValue(merged,remote.value):remote.value;}
   if(merged)articles.push({...a,...mergeReadingValue(a,merged),articleId:a.articleId,contentHtml:null,contentText:''});
  }
  return articles.length?this.repository.mergeCloud([],articles,'cloud-records'):0;
 }
 async exportPayloads(full:boolean):Promise<{objects:LogicalObject[];fingerprint:string;articleIds?:string[];pendingPrivateArticles?:number}>{
  this.guard.require();if(!full)return {objects:[],fingerprint:''};const s=await this.repository.cloudSnapshot(true);const pending=new Set(s.pendingPrivateArticleIds??(s.pendingPrivateBodies?s.articles.filter(a=>!a.contentText.trim()&&!a.contentHtml?.trim()).map(a=>a.articleId):[]));
  const rows=s.articles.filter(a=>!pending.has(a.articleId)&&!a.deleted&&(privateCloudBody(a)||a.favoriteSaved||a.watchLaterSaved)).sort((a,b)=>a.articleId<b.articleId?-1:a.articleId>b.articleId?1:0);
  const entries=new Map<string,Uint8Array>(),metadata:Record<string,any>[]=[],fingerprints:any[]=[];
  for(const a of rows){const stem='bodies/'+await this.crypto.sha256(utf8Encode(a.articleId)),text=utf8Encode(a.contentText),html=a.contentHtml===null?undefined:utf8Encode(a.contentHtml);entries.set(stem+'.txt',text);if(html)entries.set(stem+'.html',html);
   const m:Record<string,any>={...stateJson(a),sourceDeviceId:a.sourceDeviceId,updatedAt:a.importedAt,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false,contentTextEntry:stem+'.txt',contentHtmlEntry:html?stem+'.html':null};metadata.push(m);
   // Reading/reordering clocks are records state, not a reason to republish bodies.
   fingerprints.push([a.articleId,a.url,a.title,a.siteName,a.excerpt,a.imageUrl,a.rssSourceUrl,a.rssSourceTitle,a.contentHash,a.importedAt,a.independentSaved,a.favoriteSaved,a.watchLaterSaved,await this.crypto.sha256(text),html?await this.crypto.sha256(html):null]);
  }
  const archive=new Map<string,Uint8Array>();archive.set('manifest.json',utf8Encode(canonical({format:'watchrss-library-backup',version:3,cloudContentOnly:true,exportedAt:Math.max(1,...metadata.map(a=>a.importedAt)),sourceCount:0,articleCount:rows.length,savedItemCount:0,readerPresetCount:0,readerFontCount:0,readerBackgroundCount:0,appMetaCount:0})));for(const name of ['sources.json','saved_items.json','app_meta.json'])archive.set(name,utf8Encode('[]'));archive.set('articles.json',utf8Encode(canonical(metadata)));for(const e of entries)archive.set(...e);
  return {objects:rows.length?[{name:'private-library.wrss',bytes:writeWrss(archive),compress:false}]:[],fingerprint:await this.crypto.sha256(utf8Encode(canonical(fingerprints))),articleIds:[...new Set(rows.flatMap(a=>[a.articleId,...(a.cloudLegacyArticleIds??[])]))],pendingPrivateArticles:pending.size};
 }
 private async decode(bytes:Uint8Array,state:boolean):Promise<{sources:SyncedSource[];articles:ExportedArticle[]}>{
  const root=JSON.parse(utf8Decode(bytes));
  if(!root||!Array.isArray(root.articles)||root.articles.length>100000)throw Error('无效云资料');
  if(state&&(root.format!=='watchrss-rss-state'||root.version!==1))throw Error('云端RSS状态格式不受支持');
  if(!state&&(root.action!=='syncLibrary'||![13,14].includes(root.version)))throw Error('云资料格式不受支持');
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
 async restorePayloads(payload:Map<string,Uint8Array>,remote:string,descriptors:readonly CloudObject[]=[]){
  this.guard.require();const decoded:{sources:SyncedSource[];articles:ExportedArticle[]}[]=[],warnings:string[]=[];let pending=0,abandoned=0;
  const currentArticles=new Map((await this.repository.cloudSnapshot(false)).stateArticles.map(a=>[a.articleId,a]));
  const lost=()=>{abandoned++;warnings.push('已放弃结构不完整、无法恢复的私有条目');};
  const retry=()=>{pending++;warnings.push('私有条目缺少正文，等待重试');};
  for(const [name,state]of [['library-sync.json',false],['rss-state.json',true]] as const){const bytes=payload.get(name);if(bytes){const value=await this.decode(bytes,state);value.articles=value.articles.map(a=>{const known=currentArticles.get(a.articleId);return known&&known.contentHash!==a.contentHash?{...a,contentHash:known.contentHash,contentHtml:null,contentText:''}:a;});decoded.push(value);}}
  const metadata=(raw:any)=>{if(!raw||typeof raw.articleId!=='string'||!raw.articleId.trim()||typeof raw.url!=='string'||!raw.url.trim()||typeof raw.title!=='string'||!raw.title.trim()||typeof raw.contentHash!=='string'||!raw.contentHash.trim())throw Error('cloud_private_metadata_missing');const a=parseChunkedArticles({articles:[{...Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==null)),body:{}}]})[0]?.article;if(!a)throw Error('cloud_private_metadata_missing');return a;};
  const keepReading=(a:ReturnType<typeof metadata>)=>{const base=currentArticles.get(a.articleId);return base&&!base.deleted?{...a,...mergeReadingValue(a,base)} as typeof a:a;};
  const archive=payload.get('private-library.wrss');if(archive){let zip:Map<string,Uint8Array>|undefined,rows:any[]=[];
   try{zip=await readWrss(archive,(b,max)=>this.crypto.gunzip(b,max));const manifest=JSON.parse(utf8Decode(zip.get('manifest.json')??new Uint8Array()));if(manifest.format!=='watchrss-library-backup'||![1,2,3].includes(manifest.version))throw Error('cloud_archive_invalid');rows=JSON.parse(utf8Decode(zip.get('articles.json')??new Uint8Array()));if(!Array.isArray(rows)||rows.length>100000)throw Error('cloud_archive_invalid');}catch(error){if(error instanceof SyntaxError||String(error).includes('cloud_archive_invalid'))lost();else retry();zip=undefined;}
   const articles:ExportedArticle[]=[];if(zip)for(const raw of rows){if(raw?.deleted)continue;let a:ReturnType<typeof metadata>;
    try{const base=currentArticles.get(raw?.articleId);a=metadata(raw?.url?raw:base&&base.contentHash===raw?.contentHash&&!base.deleted?base:raw);}catch{lost();continue;}
    const stem='bodies/'+await this.crypto.sha256(utf8Encode(a.articleId));
    if(raw.contentTextEntry!==stem+'.txt'||raw.contentHtmlEntry!=null&&raw.contentHtmlEntry!==stem+'.html'){lost();continue;}
    const text=zip.get(raw.contentTextEntry),html=raw.contentHtmlEntry?zip.get(raw.contentHtmlEntry):undefined;
    // A successfully authenticated immutable ZIP cannot grow missing entries.
    if(!text||raw.contentHtmlEntry&&!html){lost();continue;}articles.push({...keepReading(a),contentText:utf8Decode(text),contentHtml:html?utf8Decode(html):null});
   }decoded.push({sources:[],articles});
  }
  const readers:ExportedArticle[]=[],seen=new Set<string>();
  for(const object of descriptors.filter(o=>o.name.startsWith('reader/'))){seen.add(object.name);let raw=object.privateArticle;
   if(!raw)for(const a of currentArticles.values())if(!a.deleted&&object.name===`reader/${(await this.crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await this.crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`){raw={...a};break;}
   let a:ReturnType<typeof metadata>;try{a=metadata(raw);}catch{lost();continue;}
   const name=`reader/${(await this.crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await this.crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`;
   if(name!==object.name){lost();continue;}const body=payload.get(name);if(!body){retry();continue;}
   if(object.contentSha256&&await this.crypto.sha256(body)!==object.contentSha256){lost();continue;}
   readers.push({...keepReading(a),contentHtml:null,contentText:utf8Decode(body)});
  }
  for(const [name,body]of payload)if(name.startsWith('reader/')&&!seen.has(name)){let matched=false;for(const a of currentArticles.values())if(!a.deleted&&name===`reader/${(await this.crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await this.crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`){readers.push({...keepReading(a),contentHtml:null,contentText:utf8Decode(body)});matched=true;break;}if(!matched)lost();}
  if(readers.length)decoded.push({sources:[],articles:readers});let changed=0;for(const value of decoded)changed+=await this.repository.mergeCloud(value.sources,value.articles,remote);changed+=await this.applyReadingStates();return {changed,pending,abandoned,warnings};
 }
 async mergeInventory(inventory:RssInventory){
  this.guard.require();if(isImportedContentUrl(inventory.url)||!/^https?:\/\//i.test(inventory.url))throw Error('非公共 RSS');
  if(inventory.sourceId)this.sourceIds.set(inventory.url,inventory.sourceId);
  const userTitle=(await this.repository.cloudSnapshot(false)).sources.find(s=>s.url===inventory.url)?.title||inventory.title||inventory.url;
  const articles:ExportedArticle[]=[];
  for(const item of inventory.items){
   const id=await tryRssArticleId({link:item.identityLink===undefined?item.url:item.identityLink,guid:item.guid,title:item.title,contentHash:item.contentHash,dedupKey:item.dedupKey},this.crypto.sha256);if(!id)continue;const hash=item.contentHash??await this.crypto.sha256(utf8Encode(item.contentHtml??item.contentText??item.url));
   // Inventories supply no save/reading mutation clocks. The repository
   // preserves existing publication timestamps across repeated fetches.
   articles.push(Object.assign({articleId:id,cloudRssArticleId:id,sourceDeviceId:'cloud-rss-inventory',url:item.url,title:item.title||item.url,siteName:inventory.title||inventory.url,excerpt:item.excerpt,contentHtml:item.contentHtml,contentText:item.contentText||item.excerpt,imageUrl:item.imageUrl,contentHash:hash,importedAt:0,updatedAt:0,rssSourceUrl:inventory.url,rssSourceTitle:userTitle,independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false},{cloudMedia:{audioUrl:item.audioUrl??null,videoUrl:item.videoUrl??null,publishedAt:item.publishedAt??null}}));
  }
  const changed=await this.repository.mergeCloud([],articles,'cloud-rss-inventory');return changed+await this.applyReadingStates();
 }
}

/** Reading LWW never uses the public feed refresh clock. Exact ties prefer unread. */
export function mergeReadingValue(local:Record<string,any>,remote:Record<string,any>){
 const out={...local},lc=local.readingPositionChangedAt||0,rc=remote.readingPositionChangedAt||0,ld=local.sourceDeviceId||'',rd=remote.sourceDeviceId||'';
 if(rc>lc||rc===lc&&(rd>ld||rd===ld&&remote.isRead===false)){for(const k of ['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','sourceDeviceId'])if(k in remote)out[k]=remote[k];}
 for(const type of ['favorite','watchLater']){const k=type+'ChangedAt';if((remote[k]??0)>(local[k]??0)||(remote[k]??0)===(local[k]??0)&&rd>=ld)for(const suffix of ['Saved','ChangedAt','SortOrder'])if(type+suffix in remote)out[type+suffix]=remote[type+suffix];}return out;
}
