import {legacyBookReadingArticle} from '../books/legacy-cloud-reading';
import type {RestoreApplyCheckpoint} from './snapshot-checkpoint';
import {memoizeSmallDigest} from '../core/digest-cache';
import {PRIVATE_OVERLAY_NAME,PrivateOverlayReadSet,decodePrivateOverlay} from './private-overlay';
import type {CloudBookSnapshot,CloudBookPort} from '../books/cloud-port';
import type {BookState,BookReading} from '../books/protocol';
import {mergeBook,mergeBookReading,validateBook,validateBookReading} from '../books/protocol';
import {parseBookHeader} from '../books/package';
import {base64ToBytes} from '@podjs/framework/bytes';
import {isImportedContentUrl} from '../core/imported-content';
import {parseChunkedArticles} from '../sync/article-batches';
import {parseSources,type SyncedSource} from '../sync/library-wire';
import type {ExportedArticle} from '../sync/article-export';
import type {JsonObject} from '../sync/protocol';
import {utf8Encode,utf8Decode,type RssInventory} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
import {writeWrss,readWrss,indexWrss,readWrssEntry,openWrssRange,type WrssRangeReader} from './wrss';
import type {LogicalObject,CloudObject} from './codec';
import {rssSourceKey,rssArticleId,legacyWebArticleId,tryRssArticleId,isLocalOnlyRssSource,canonicalRssUrl} from './rss-identity';
import {hasArticleRegisters} from './article-register';
import {knownRecordValue} from './compatibility';
import {canonical,type RecordDocument,type RecordWorkProgress} from './records';
export interface CloudLibrarySnapshot {articles:readonly ExportedArticle[];sources:readonly SyncedSource[];stateArticles:readonly ExportedArticle[];pendingPrivateBodies?:boolean;pendingPrivateArticleIds?:readonly string[]}
export interface CloudLibraryRepository extends Partial<CloudBookPort> {
 setCloudProgress?(sink?:(unit:string)=>Promise<void>):void;
 setCloudDiagnostic?(sink?:(fields:Record<string,string|number>)=>void):void;
 /** Includes pending/tombstone/private note state; never reads article bodies. */
 hasLocalPrivateContent?():Promise<boolean>;
 cloudArticleRegisters?():Promise<RecordDocument[]>;
 mergeCloudArticleRegisters?(documents:RecordDocument[]):Promise<number>;
 cloudSources?():Promise<readonly SyncedSource[]>;
 cloudRestoreMetadata?(request?:{ids?:readonly string[];urls?:readonly string[];after?:number;limit?:number},check?:()=>void):Promise<{articles:ExportedArticle[];next?:number}>;
 cloudSnapshot(full:boolean,check?:()=>void):Promise<CloudLibrarySnapshot>;
 mergeCloudLegacyBookReading?(articles:readonly ExportedArticle[],check?:()=>void):Promise<{changed:number;remaining:ExportedArticle[]}>;
 mergeCloudReading?(articles:readonly ExportedArticle[],check?:()=>void):Promise<number>;
 mergeCloudPublicMetadata?(articles:readonly ExportedArticle[],check?:()=>void,work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>):Promise<{changed:number;remaining:ExportedArticle[]}>;
 cloudReadingRevision?():Promise<number>;
 cloudReadingCandidates?(check?:()=>void,hashes?:readonly string[],work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>):Promise<readonly ExportedArticle[]>;
 /** Each entity commits its source/body/saved/reading state transactionally. No
  * applied cursor or ACK may be advanced until this entire operation succeeds. */
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string,check?:()=>void):Promise<number>;
}
export interface CloudLibraryCrypto {yieldTurn?():Promise<void>;gzip(bytes:Uint8Array):Promise<Uint8Array>;gunzip(bytes:Uint8Array,max:number):Promise<Uint8Array>;sha256(bytes:Uint8Array):Promise<string>;stableId(url:string):Promise<string>}
export const privateCloudBody=(a:Pick<ExportedArticle,'url'|'rssSourceUrl'>)=>isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim();
const stateJson=(a:ExportedArticle)=>{const {contentHtml,contentText,cloudReadingItemId,cloudRssArticleId,cloudLegacyArticleIds,bodySourceDeviceId,...state}=a;return state;};
export class WatchCloudLibraryAdapter {
 trackProgress(sink?:(unit:string)=>Promise<void>){this.repository.setCloudProgress?.(sink);}
 private readingRevision?:number;
 private async checkReadingRevision(){const revision=await this.repository.cloudReadingRevision?.();if(revision!==undefined&&revision!==this.readingRevision){this.matchedReading.clear();this.readingRevision=revision;}}
 private async mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string,check:()=>void=()=>this.guard.require(),work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>){this.guard.require();let result=0;if(remote==='cloud-records'&&articles.some(legacyBookReadingArticle)&&this.repository.mergeCloudLegacyBookReading){const fast=await this.repository.mergeCloudLegacyBookReading(articles,check);result+=fast.changed;articles=fast.remaining;this.matchedReading.clear();this.readingRevision=undefined;if(!sources.length&&!articles.length)return result;}await this.checkReadingRevision();if(remote==='cloud-records'&&!sources.length&&articles.length&&articles.every(a=>a.rssSourceUrl&&!privateCloudBody(a)&&!a.deleted&&!a.contentText&&!a.contentHtml)&&this.repository.mergeCloudPublicMetadata){const fast=await this.repository.mergeCloudPublicMetadata(articles,check,work);result+=fast.changed;articles=fast.remaining;}if(sources.length||articles.length)result+=await this.repository.mergeCloud(sources,articles,remote,check);this.readingRevision=await this.repository.cloudReadingRevision?.();return result;}
 private overlay:PrivateOverlayReadSet;
 constructor(private repository:CloudLibraryRepository,private deviceId:string,private crypto:CloudLibraryCrypto,private guard:CloudGuard=cloudDisabled){this.crypto={...crypto,sha256:memoizeSmallDigest(bytes=>crypto.sha256(bytes),{beforeUse:()=>this.guard.require()})};this.overlay=new PrivateOverlayReadSet(this.crypto);}
 /** A local projection may omit fields held only by an authenticated record.
  * Resolve that one basis on demand; never turn default clocks into an edit. */
 projectRecord(local:RecordDocument,basis:RecordDocument):RecordDocument {
  if(local.kind!==basis.kind)return local;
  let value=local.value;
  if(local.kind==='source'){value={...knownRecordValue('source',basis.value),...Object.fromEntries(Object.entries(local.value).filter(([,v])=>v!==undefined))};if(!local.value.sourceId&&basis.value.sourceId)value.sourceId=basis.value.sourceId;}
  else if(local.kind==='article'||local.kind==='rss-state')value=mergeReadingValue(local.value,basis.value);
  else if(local.kind==='book-reading')value=mergeBookReading(local.value as BookReading,basis.value as BookReading);
  else if(local.kind==='book')value=mergeBook(local.value as BookState,basis.value as BookState);
  return {...local,value};
 }
 async inventoryRecordLookups(inventory:RssInventory):Promise<RecordDocument[]>{
  this.guard.require();const sources=new Set([await rssSourceKey(inventory.url,this.crypto.sha256),inventory.sourceId,this.sourceIds.get(inventory.url)]),out:RecordDocument[]=[];
  for(const item of inventory.items){const identity=await tryRssArticleId({link:item.identityLink===undefined?item.url:item.identityLink,guid:item.guid,title:item.title,contentHash:item.contentHash,dedupKey:item.dedupKey},this.crypto.sha256);if(!identity)continue;const hash=await this.crypto.sha256(utf8Encode(identity));
   for(const sourceId of sources)if(sourceId)out.push({kind:'rss-state',value:{sourceId,articleIdHash:hash}});
   for(const articleId of new Set([identity,await legacyWebArticleId(item.url,this.crypto.sha256)]))out.push({kind:'article',value:{articleId}});
  }return out;
 }
 async observePrivateOverlay(payload:Map<string,Uint8Array>,remote:string,descriptors:readonly CloudObject[],trustedApplied=false,work?:{checkpoint:RestoreApplyCheckpoint;resolve:(name:string)=>Promise<Uint8Array|undefined>}){this.guard.require();return this.overlay.observe(payload,remote,descriptors,trustedApplied,work);}
 async publicSources(){this.guard.require();return (this.repository.cloudSources?await this.repository.cloudSources():(await this.repository.cloudSnapshot(false,()=>this.guard.require())).sources).filter(s=>!s.deleted&&!isImportedContentUrl(s.url)&&/^https?:\/\//i.test(s.url)&&!isLocalOnlyRssSource(s.url));}
 private async articleIdentity(a:ExportedArticle){return a.cloudRssArticleId??tryRssArticleId({link:a.url,title:a.title,contentHash:a.contentHash},this.crypto.sha256);}
 private sourceIds=new Map<string,string>();
 private bookExport:CloudBookSnapshot|undefined;
 private bookMappings=new Map<string,CloudBookSnapshot['mappings'][number][]>();
 private bookStates=new Map<string,BookState>();
 private bookReading=new Map<string,BookReading>();
 private cacheBooks(snapshot:CloudBookSnapshot|undefined){this.bookExport=snapshot;this.bookMappings.clear();this.bookStates.clear();this.bookReading.clear();if(!snapshot)return;for(const m of snapshot.mappings)for(const key of ['id:'+m.articleId,'url:'+m.url]){const rows=this.bookMappings.get(key)??[];rows.push(m);this.bookMappings.set(key,rows);}for(const b of snapshot.books)this.bookStates.set(b.bookId,b);for(const r of snapshot.reading)this.bookReading.set(r.bookId+':'+r.chapterIndex,r);}
 // Exact public identity inputs only. This cache contains no reading/save
 // values, pool-source bindings, account keys, receipts or persistent state.
 private readingIdentityCache=new Map<string,{canonical:string;hash:string;aliases:string[];bytes:number}>();
 private readingIdentityBytes=0;
 private async readingIdentity(a:ExportedArticle){
  this.guard.require();const key=JSON.stringify([a.cloudRssArticleId??null,a.articleId,a.url,a.rssSourceUrl,a.title,a.contentHash]);
  const old=this.readingIdentityCache.get(key);if(old){this.readingIdentityCache.delete(key);this.readingIdentityCache.set(key,old);return old;}
  const articleId=await this.articleIdentity(a);if(!articleId)return;
  const hash=await this.crypto.sha256(utf8Encode(articleId)),sourceId=await rssSourceKey(a.rssSourceUrl!,this.crypto.sha256),aliases:string[]=[];
  let web=false;try{canonicalRssUrl(a.url,false);web=true;}catch{}
  if(web)for(const id of [await rssArticleId(a.url,this.crypto.sha256),await legacyWebArticleId(a.url,this.crypto.sha256)]){const alias=await this.crypto.sha256(utf8Encode(id));if(alias!==hash)aliases.push(sourceId+':'+alias);}
  const canonical=sourceId+':'+hash,bytes=256+2*(key.length+canonical.length+hash.length+aliases.join('').length),value={canonical,hash,aliases,bytes};this.guard.require();
  if(key.length<=4096&&bytes<=8*1024*1024){while(this.readingIdentityCache.size&&(this.readingIdentityCache.size>=8192||this.readingIdentityBytes+bytes>8*1024*1024)){const first=this.readingIdentityCache.keys().next().value!;this.readingIdentityBytes-=this.readingIdentityCache.get(first)!.bytes;this.readingIdentityCache.delete(first);}this.readingIdentityCache.set(key,value);this.readingIdentityBytes+=bytes;}
  return value;
 }
 private pendingReading=new Map<string,RecordDocument>();
 private readingAliases=new Map<string,string>();
 private matchedReading=new Set<string>();
 private retainedReadingMetadata=new Map<string,ExportedArticle>();
 private retainedSources=new Map<string,Record<string,any>>();
 async exportRecords(work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T)=>Promise<T>):Promise<RecordDocument[]>{
  this.guard.require();const measure=work??(async<T>(_stage:string,_units:number,run:()=>Promise<T>|T)=>run());const s=await measure('projection',1,()=>this.repository.cloudSnapshot(false,()=>this.guard.require())),out:RecordDocument[]=[],protectedArticles=await this.repository.cloudArticleRegisters?.()??[],protectedIds=new Set(protectedArticles.flatMap(d=>[d.value.articleId,...(d.projectionAliases??[])]));
  for(const source of s.sources){const sourceId=this.sourceIds.get(source.url);out.push({kind:'source',value:{url:source.url,sourceDeviceId:source.sourceDeviceId,sourceId:sourceId??'',title:source.title,sortOrder:source.sortOrder,isPinned:source.isPinned,updatedAt:source.updatedAt,deleted:source.deleted,deletedAt:source.deletedAt,...Object.fromEntries(Object.entries(this.retainedSources.get(source.url)??{}).filter(([k])=>['useOriginalContent','continuePlaybackInBackground'].includes(k)))}});}
  for(const a of s.stateArticles){
   if(protectedIds.has(a.articleId))continue;
   if(privateCloudBody(a)){out.push({kind:'article',value:Object.fromEntries(Object.entries(stateJson(a)).filter(([,v])=>v!==null))});continue;}
   if(isLocalOnlyRssSource(a.rssSourceUrl!))continue;
   if(!(a.isRead||a.readingProgress||a.readingPositionChangedAt||a.favoriteChangedAt||a.watchLaterChangedAt||a.favoriteSaved||a.watchLaterSaved))continue;
   const articleId=await measure('identity',1,()=>this.articleIdentity(a));if(!articleId)continue;const sourceId=await measure('identity',1,()=>rssSourceKey(a.rssSourceUrl!,this.crypto.sha256));
   const value:Record<string,any>={sourceId,articleIdHash:await this.crypto.sha256(utf8Encode(articleId)),sourceDeviceId:a.sourceDeviceId};
   for(const k of ['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder','deleted','deletedAt'] as const)value[k]=a[k];
   if(!value.readingPositionChangedAt&&(a.isRead||a.readingProgress))value.readingPositionChangedAt=a.updatedAt;
   out.push({kind:'rss-state',value});
  }
  // States may precede public entries, or outlive entries expired from the pool.
  const combined=new Map<string,RecordDocument>();for(const doc of out.filter(d=>d.kind==='rss-state')){const id=doc.value.sourceId+':'+doc.value.articleIdHash,old=combined.get(id);combined.set(id,old?{kind:doc.kind,value:mergeReadingValue(old.value,doc.value)}:doc);}out.splice(0,out.length,...out.filter(d=>d.kind!=='rss-state'),...combined.values());
  const blocked=new Set<string>();for(const source of s.sources)if(isLocalOnlyRssSource(source.url)){const poolId=this.sourceIds.get(source.url);if(poolId)blocked.add(poolId);try{blocked.add(await this.crypto.sha256(utf8Encode(canonicalRssUrl(source.url,false))));}catch{/* Credentialed URLs have no public source key. */}}
  const ids=new Set(out.filter(d=>d.kind==='rss-state').map(d=>d.value.sourceId+':'+d.value.articleIdHash));for(const [id,doc]of this.pendingReading)if(!ids.has(id)&&!blocked.has(doc.value.sourceId)){const current=combined.get(this.readingAliases.get(id)??'');out.push(current?{kind:doc.kind,value:mergeReadingValue(doc.value,current.value)}:doc);}
  const books=await this.repository.cloudBooks?.();this.cacheBooks(books);if(books){out.push(...books.books.map(value=>({kind:'book',value})),...books.reading.map(value=>({kind:'book-reading',value})));}
  return [...out,...protectedArticles];
 }
 async bookReplacement(legacy:RecordDocument){if(legacy.kind!=='article')return;if(!this.bookExport)this.cacheBooks(await this.repository.cloudBooks?.());if(!this.bookExport)return;const exact=this.bookMappings.get('id:'+legacy.value.articleId)??[],candidates=exact.length?exact:this.bookMappings.get('url:'+legacy.value.url)??[];if(new Set(candidates.map(m=>m.bookId+':'+m.chapterIndex)).size!==1)return;const mapping=candidates[0]!;const book=this.bookStates.get(mapping.bookId);if(!book)return;const reading=this.bookReading.get(book.bookId+':'+mapping.chapterIndex);const interacted=legacy.value.isRead||legacy.value.readingProgress||legacy.value.readingPositionChangedAt||legacy.value.favoriteChangedAt||legacy.value.watchLaterChangedAt||legacy.value.favoriteSaved||legacy.value.watchLaterSaved;
  if(interacted&&(!reading||['readingPositionChangedAt','favoriteChangedAt','watchLaterChangedAt'].some(k=>((reading as unknown as Record<string,any>)[k]??0)<(legacy.value[k]??0))))return;
  return {book:{kind:'book',value:book},...(reading?{reading:{kind:'book-reading',value:reading}}:{})};
 }
 /** Rebuild the ephemeral lookup tables from an authenticated, durably applied
  * local projection. Never replay SQL side effects merely to warm a new session. */
 async hydrateRecords(documents:RecordDocument[]){await this.applyRecords(documents,true);}
 async applyRecords(documents:RecordDocument[],hydrateOnly=false,work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T)=>Promise<T>){
  this.guard.require();const measure=work??(async<T>(_stage:string,_units:number,run:()=>Promise<T>|T)=>run());let changed=0;const protectedDocs=documents.filter(hasArticleRegisters);if(protectedDocs.length&&!hydrateOnly){if(!this.repository.mergeCloudArticleRegisters)throw Error('cloud_format_article_storage_unavailable');changed+=await this.repository.mergeCloudArticleRegisters(protectedDocs);}documents=documents.filter(d=>!hasArticleRegisters(d));const articles:ExportedArticle[]=[],sources:SyncedSource[]=[];
  for(const doc of documents.filter(d=>d.kind==='source')){const v=doc.value;if(v.sourceId)this.sourceIds.set(v.url,v.sourceId);}
  const books=documents.filter(d=>d.kind==='book').map(d=>d.value as BookState),reading=documents.filter(d=>d.kind==='book-reading').map(d=>d.value as BookReading);if(!hydrateOnly&&(books.length||reading.length)){if(!this.repository.mergeCloudBooks)throw Error('book_storage_unavailable');changed+=await measure('apply-books',books.length+reading.length,()=>this.repository.mergeCloudBooks!(books,reading));}
  // Imported books cannot materialize public RSS articles. Replaying a book-only
  // page must not rescan/hash the public library for previously queued RSS state.
  // Source/article pages and inventory/body restores still apply that state.
  if(documents.length&&documents.every(d=>d.kind==='book'||d.kind==='book-reading'))return changed;
  for(const doc of documents){const v=doc.value;if(v.bookIndexRetired===true)continue;
   if(doc.kind==='source'){this.retainedSources.set(v.url,v);if(v.sourceId)this.sourceIds.set(v.url,v.sourceId);sources.push(...parseSources({rssSources:[v]}));}
   else if(doc.kind==='rss-state'){const id=v.sourceId+':'+v.articleIdHash,old=this.pendingReading.get(id);this.matchedReading.delete(id);this.pendingReading.set(id,old?{kind:doc.kind,value:mergeReadingValue(old.value,v)}:doc);}
   else if(doc.kind==='article'){
    if(v.deleted&&!privateCloudBody(v as ExportedArticle))continue;
    // Old public index tombstones retire cloud metadata, never delete cached pool articles.
    if(!privateCloudBody(v as ExportedArticle)&&!v.deleted){if(isLocalOnlyRssSource(v.rssSourceUrl))continue;const articleId=await tryRssArticleId({link:v.url,guid:v.guid,title:v.title,contentHash:v.contentHash},this.crypto.sha256);if(!articleId)continue;const sourceId=await rssSourceKey(v.rssSourceUrl,this.crypto.sha256);if(v.isRead||v.readingProgress||v.readingPositionChangedAt||v.favoriteChangedAt||v.watchLaterChangedAt||v.favoriteSaved||v.watchLaterSaved){const hash=await this.crypto.sha256(utf8Encode(articleId)),id=sourceId+':'+hash,value={...Object.fromEntries(Object.entries(v).filter(([k])=>k.startsWith('reading')||k.startsWith('favorite')||k.startsWith('watchLater')||['isRead','sourceDeviceId','deleted','deletedAt'].includes(k))),sourceId,articleIdHash:hash,readingPositionChangedAt:v.readingPositionChangedAt||(v.isRead||v.readingProgress?v.updatedAt:0)||0},old=this.pendingReading.get(id);this.matchedReading.delete(id);this.pendingReading.set(id,{kind:'rss-state',value:old?mergeReadingValue(old.value,value):value});}if(!v.favoriteSaved&&!v.watchLaterSaved&&!v.isRead&&!v.readingProgress&&!v.readingPositionChangedAt)continue;}
    const clean=Object.fromEntries(Object.entries(v).filter(([,v])=>v!==null));const a=parseChunkedArticles({articles:[{...clean,body:{}}]})[0]?.article;if(!a)throw Error('cloud_record_invalid');const publicId=privateCloudBody(a)?undefined:await tryRssArticleId({link:v.url,guid:v.guid,title:v.title,contentHash:v.contentHash},this.crypto.sha256),metadata={...a,contentHtml:null,contentText:''};articles.push(metadata);if(publicId&&!a.deleted&&(a.isRead||a.readingProgress||a.readingPositionChangedAt))this.retainedReadingMetadata.set(a.rssSourceUrl+'\0'+publicId,metadata);
   }
  }
  if(hydrateOnly)return 0;
  if(sources.length||articles.length)changed+=await measure('apply-metadata',sources.length+articles.length,()=>this.mergeCloud(sources,articles,'cloud-records',()=>this.guard.require(),work));return changed+await this.applyReadingStates(work);
 }
 async applyReadingStates(work?:<T>(stage:RecordWorkProgress['stage'],units:number,run:()=>Promise<T>|T)=>Promise<T>){
  this.guard.require();if(!this.pendingReading.size)return 0;await this.checkReadingRevision();
  const measure=work??(async<T>(_stage:string,_units:number,run:()=>Promise<T>|T)=>run());let changed=0;const readCandidates=()=>this.repository.cloudReadingCandidates?this.repository.cloudReadingCandidates(()=>this.guard.require(),[...this.pendingReading.entries()].filter(([id])=>!this.matchedReading.has(id)).map(([,d])=>d.value.articleIdHash),work):this.repository.cloudSnapshot(false,()=>this.guard.require()).then(s=>s.stateArticles);
  let candidates=await measure('reading-candidates',1,readCandidates);const articles:ExportedArticle[]=[];
  // Old clients ACKed public reading records after discarding their metadata.
  // A hydrated ACK certifies authentication, not physical entity presence.
  // Repair absent metadata through the receiver, then replay its reading tuple.
  if(this.retainedReadingMetadata.size){
   const present=new Set<string>();for(const a of candidates){if(!a.rssSourceUrl||isLocalOnlyRssSource(a.rssSourceUrl))continue;const identity=await measure('identity',1,()=>this.readingIdentity(a));if(identity)for(const id of [identity.canonical,...identity.aliases])present.add(id);}
   const missing:ExportedArticle[]=[];for(const [key,a]of this.retainedReadingMetadata){const identity=await measure('identity',1,()=>this.readingIdentity(a));if(identity){if(![identity.canonical,...identity.aliases].some(id=>present.has(id)))missing.push(a);else this.retainedReadingMetadata.delete(key);}}
   for(let at=0;at<missing.length;at+=20)changed+=await this.mergeCloud([],missing.slice(at,at+20),'cloud-records',()=>this.guard.require());
   if(missing.length)candidates=await measure('reading-candidates',1,readCandidates);
  }
  for(const a of candidates){
   if(!a.rssSourceUrl||isImportedContentUrl(a.rssSourceUrl)||isLocalOnlyRssSource(a.rssSourceUrl))continue;
   const identity=await measure('identity',1,()=>this.readingIdentity(a));if(!identity)continue;
   for(const alias of identity.aliases)this.readingAliases.set(alias,identity.canonical);
   let merged:Record<string,any>|undefined;
   // Pool IDs can change independently of an immutable article identity.
   for(const key of [identity.canonical,this.sourceIds.get(a.rssSourceUrl)+':'+identity.hash,...identity.aliases]){const remote=this.pendingReading.get(key);if(remote){this.matchedReading.add(key);merged=merged?mergeReadingValue(merged,remote.value):remote.value;}}
   if(merged){const next=mergeReadingValue(a,merged,true);
    // Retain pending records/aliases for future inventory materialization, but
    // do not replay every already-applied reading/save clock through the body
    // receiver again for each incoming record page.
    if(['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','sourceDeviceId','favoriteSaved','favoriteChangedAt','favoriteSortOrder','watchLaterSaved','watchLaterChangedAt','watchLaterSortOrder'].some(k=>(a as unknown as Record<string,unknown>)[k]!==next[k]))articles.push({...a,...next,articleId:a.articleId,contentHtml:null,contentText:''});
   }
   if(articles.length>=20){const batch=articles.splice(0);changed+=await measure('reading-merge',batch.length,()=>this.mergeReading(batch));}
  }
  return changed+(articles.length?await measure('reading-merge',articles.length,()=>this.mergeReading(articles)):0);
 }
 private async mergeReading(articles:readonly ExportedArticle[]){if(!this.repository.mergeCloudReading)return this.mergeCloud([],articles,'cloud-records');const changed=await this.repository.mergeCloudReading(articles,()=>this.guard.require());this.readingRevision=await this.repository.cloudReadingRevision?.();return changed;}
 /** Hash-only states cannot fabricate a missing article. Expand the normal
  * inventory only for sources with authenticated states still awaiting entries. */
 async readingInventoryMode(url:string,requested:'all'|'recent128'){
  this.guard.require();if(requested==='all'||isLocalOnlyRssSource(url))return requested;
  const sources=new Set([await rssSourceKey(url,this.crypto.sha256),this.sourceIds.get(url)]);
  for(const [id,doc]of this.pendingReading)if(sources.has(doc.value.sourceId)&&!this.matchedReading.has(id))return 'all' as const;
  return requested;
 }
 async exportPayloads(full:boolean):Promise<{objects:LogicalObject[];fingerprint:string;articleIds?:string[];bookIds?:string[];removedArticleIds?:string[];removedArticleUrls?:string[];removedObjectNames?:string[];pendingPrivateArticles?:number}>{
  this.guard.require();if(!full)return {objects:[],fingerprint:''};const s=await this.repository.cloudSnapshot(true,()=>this.guard.require());const pending=new Set(s.pendingPrivateArticleIds??(s.pendingPrivateBodies?s.articles.filter(a=>!a.contentText.trim()&&!a.contentHtml?.trim()).map(a=>a.articleId):[]));
  const retired=new Set(s.stateArticles.filter(a=>a.deleted||!(a.independentSaved||a.favoriteSaved||a.watchLaterSaved)&&Math.max(a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt)>0).map(a=>a.articleId));for(const id of retired)pending.delete(id);
  const rows=s.articles.filter(a=>!retired.has(a.articleId)&&!pending.has(a.articleId)&&!a.deleted&&(privateCloudBody(a)||a.favoriteSaved||a.watchLaterSaved)).sort((a,b)=>a.articleId<b.articleId?-1:a.articleId>b.articleId?1:0);
  const entries=new Map<string,Uint8Array>(),metadata:Record<string,any>[]=[],fingerprints:any[]=[];
  for(const a of rows){const stem='bodies/'+await this.crypto.sha256(utf8Encode(a.articleId)),text=utf8Encode(a.contentText),html=a.contentHtml===null?undefined:utf8Encode(a.contentHtml);entries.set(stem+'.txt',text);if(html)entries.set(stem+'.html',html);
   const m:Record<string,any>={...stateJson(a),sourceDeviceId:a.bodySourceDeviceId??a.sourceDeviceId,updatedAt:a.importedAt,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false,contentTextEntry:stem+'.txt',contentHtmlEntry:html?stem+'.html':null};metadata.push(m);
   // Reading/reordering clocks are records state, not a reason to republish bodies.
   fingerprints.push([a.articleId,a.url,a.title,a.siteName,a.excerpt,a.imageUrl,a.rssSourceUrl,a.rssSourceTitle,a.contentHash,a.importedAt,await this.crypto.sha256(text),html?await this.crypto.sha256(html):null]);
  }
  const archive=new Map<string,Uint8Array>();archive.set('manifest.json',utf8Encode(canonical({format:'watchrss-library-backup',version:3,cloudContentOnly:true,exportedAt:Math.max(1,...metadata.map(a=>a.importedAt)),sourceCount:0,articleCount:rows.length,savedItemCount:0,readerPresetCount:0,readerFontCount:0,readerBackgroundCount:0,appMetaCount:0})));for(const name of ['sources.json','saved_items.json','app_meta.json'])archive.set(name,utf8Encode('[]'));archive.set('articles.json',utf8Encode(canonical(metadata)));for(const e of entries)archive.set(...e);
  const objects:LogicalObject[]=rows.length?[{name:'private-library.wrss',bytes:writeWrss(archive),compress:false}]:[],bookIds:string[]=[],removedObjectNames:string[]=[];let missingBooks=0;
  for(const book of (await this.repository.cloudBooks?.())?.books??[]){if(book.deleted){removedObjectNames.push('books/'+book.bookId+'.jsonl');continue;}fingerprints.push(['book',book.bookId,book.fingerprint]);let bytes:Uint8Array|undefined;try{bytes=await this.repository.cloudBookBody?.(book.bookId);}catch{missingBooks++;continue;}if(!bytes){missingBooks++;continue;}const header=parseBookHeader(utf8Decode(bytes.subarray(0,bytes.indexOf(10))));const privateBook={bookId:book.bookId,fingerprint:book.fingerprint,title:header.title,chapterCount:header.chapterCount,sourceUrl:header.sourceUrl,kind:header.kind,packagePath:'books/'+book.bookId+'.jsonl'};objects.push({name:privateBook.packagePath,bytes,privateBook,contentSha256:await this.crypto.sha256(bytes)});bookIds.push(book.bookId);}
  return {objects,removedObjectNames,removedArticleUrls:s.stateArticles.filter(a=>a.deleted||!(a.independentSaved||a.favoriteSaved||a.watchLaterSaved)&&Math.max(a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt)>0).map(a=>a.url),removedArticleIds:s.stateArticles.filter(a=>a.deleted||!(a.independentSaved||a.favoriteSaved||a.watchLaterSaved)&&Math.max(a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt)>0).map(a=>a.articleId),fingerprint:await this.crypto.sha256(utf8Encode(canonical(fingerprints))),articleIds:[...new Set(rows.flatMap(a=>[a.articleId,...(a.cloudLegacyArticleIds??[])]))],bookIds,pendingPrivateArticles:pending.size+missingBooks};
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
 private restoreArticles?:Map<string,ExportedArticle>;
 private restoreMetadataAfter=0;private restoreMetadataEnded=false;
 private restoreReaderIndex=new Map<string,ExportedArticle[]>();private restoreReaderTail?:IterableIterator<ExportedArticle>;private restoreReaderPending:ExportedArticle[]=[];private restoreReaderPendingAt=0;private restoreReaderSeen=new Set<string>();
 async restorePayloads(payload:Map<string,Uint8Array>,remote:string,descriptors:readonly CloudObject[]=[],options?:{checkpoint:RestoreApplyCheckpoint;skipReading?:boolean;archiveReader?:WrssRangeReader}){
  this.guard.require();const decoded:{sources:SyncedSource[];articles:ExportedArticle[]}[]=[],warnings:string[]=[];let pending=0,abandoned=0;
  let bookChanged=0;const bookBodies:{descriptor:Record<string,any>;bytes?:Uint8Array;loadBytes?:()=>Promise<Uint8Array|undefined>}[]=[];for(const o of descriptors)if(o.privateBook)bookBodies.push({descriptor:o.privateBook,bytes:payload.get(o.name)});
  const currentArticles=options?(this.restoreArticles??=new Map<string,ExportedArticle>()):new Map<string,ExportedArticle>();
  if(!this.repository.cloudRestoreMetadata&&!currentArticles.size)for(const a of (await this.repository.cloudSnapshot(false,()=>this.guard.require())).stateArticles)currentArticles.set(a.articleId,a);
  const loadCurrent=async(rows:readonly {articleId?:string;url?:string}[])=>{if(!this.repository.cloudRestoreMetadata)return;const all=rows.filter(a=>typeof a?.articleId==='string'&&!currentArticles.has(a.articleId));if(!all.length)return;for(let at=0;at<all.length;at+=50){const missing=all.slice(at,at+50);let after=0;for(;;){await options?.checkpoint.check();const page=await this.repository.cloudRestoreMetadata({ids:missing.map(a=>a.articleId!),urls:missing.flatMap(a=>a.url?[a.url]:[]),after,limit:100},()=>this.guard.require());for(const a of page.articles){currentArticles.set(a.articleId,a);for(const alias of a.cloudLegacyArticleIds??[])if(!currentArticles.has(alias))currentArticles.set(alias,a);}if(page.next===undefined)break;after=page.next;}}};
  if(!options){this.restoreMetadataAfter=0;this.restoreMetadataEnded=false;this.restoreReaderPending=[];this.restoreReaderPendingAt=0;}
  const remember=(articles:ExportedArticle[])=>{if(options)for(const a of articles)if(!currentArticles.has(a.articleId)){const metadata={...a,contentText:'',contentHtml:null};currentArticles.set(a.articleId,metadata);this.restoreReaderPending.push(metadata);}};
  // Legacy reader descriptors have no privateArticle metadata. Index names once
  // per restore, rather than hashing every candidate for every missing object.
  // Keep collision order: descriptors use the first live candidate; unmatched
  // payloads use the first candidate allowed by the current overlay.
  let readerIndex:Map<string,ExportedArticle[]>|undefined=options?this.restoreReaderIndex:undefined,readerTail:IterableIterator<ExportedArticle>|undefined=options?(this.restoreReaderTail??=currentArticles.values()):undefined,readerWork=0;
  const findReader=async(name:string,requireAllowed=false)=>{
   this.guard.require();
   readerIndex??=new Map();readerTail??=currentArticles.values();
   const allowed=(a:ExportedArticle)=>!requireAllowed||this.overlay.allow('article',a.articleId,remote);
   const cached=readerIndex.get(name)?.find(allowed);if(cached)return cached;
   // Scan only the unseen suffix, stopping at the same first match as before.
   // An unrelated later hash failure must not invalidate an earlier match.
   const owner=this;const candidates=function*(){yield* readerTail!;while(owner.restoreReaderPendingAt<owner.restoreReaderPending.length)yield owner.restoreReaderPending[owner.restoreReaderPendingAt++];};
   for(const a of candidates())if(!a.deleted){
    const seen=a.articleId+'\0'+a.contentHash;if(options&&this.restoreReaderSeen.has(seen))continue;
    const key=`reader/${(await this.crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await this.crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`,values=readerIndex.get(key)??[];values.push(a);readerIndex.set(key,values);if(options)this.restoreReaderSeen.add(seen);
    if(++readerWork%32===0)await this.crypto.yieldTurn?.();
    this.guard.require();
    if(key===name&&allowed(a))return a;
   }
   if(this.repository.cloudRestoreMetadata&&!this.restoreMetadataEnded){await options?.checkpoint.check();const page=await this.repository.cloudRestoreMetadata({after:this.restoreMetadataAfter,limit:100},()=>this.guard.require());for(const a of page.articles){currentArticles.set(a.articleId,a);this.restoreReaderPending.push(a);}if(page.next===undefined)this.restoreMetadataEnded=true;else this.restoreMetadataAfter=page.next;return findReader(name,requireAllowed);}
   if(options){this.restoreReaderPending=[];this.restoreReaderPendingAt=0;}return undefined;
  };
  const lost=()=>{abandoned++;warnings.push('已放弃结构不完整、无法恢复的私有条目');};
  const retry=()=>{pending++;warnings.push('私有条目缺少正文，等待重试');};
  for(const [name,state]of [['library-sync.json',false],['rss-state.json',true]] as const){const bytes=payload.get(name);if(bytes){
   if(options){const cp=options.checkpoint,root=JSON.parse(utf8Decode(bytes));if(!root||!Array.isArray(root.articles)||root.articles.length>100000)throw Error('无效云资料');
    // Bound legacy per-article gzip work. Already committed rows never decode again.
    for(let offset=0;offset<Math.max(1,root.articles.length);offset++){await cp.check();const unit='legacy:'+name+':'+offset;if(cp.has(unit)){cp.progress?.(offset+1,root.articles.length);continue;}await loadCurrent(root.articles.slice(offset,offset+1));const part=await this.decode(utf8Encode(JSON.stringify({...root,...(state?{sources:offset?[]:root.sources}:{rssSources:offset?[]:root.rssSources}),articles:root.articles.slice(offset,offset+1)})),state);part.articles=part.articles.map(a=>{const known=currentArticles.get(a.articleId);return known&&known.contentHash!==a.contentHash?{...a,contentHash:known.contentHash,contentHtml:null,contentText:''}:a;});bookChanged+=await this.mergeCloud(part.sources,part.articles,remote,()=>this.guard.require());remember(part.articles);await cp.commit(unit);cp.progress?.(offset+1,root.articles.length);}
    continue;
   }
   const value=await this.decode(bytes,state);await loadCurrent(value.articles);value.articles=value.articles.map(a=>{const known=currentArticles.get(a.articleId);return known&&known.contentHash!==a.contentHash?{...a,contentHash:known.contentHash,contentHtml:null,contentText:''}:a;});decoded.push(value);}}
  const metadata=(raw:any)=>{if(!raw||typeof raw.articleId!=='string'||!raw.articleId.trim()||typeof raw.url!=='string'||!raw.url.trim()||typeof raw.title!=='string'||!raw.title.trim()||typeof raw.contentHash!=='string'||!raw.contentHash.trim())throw Error('cloud_private_metadata_missing');const a=parseChunkedArticles({articles:[{...Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==null)),body:{}}]})[0]?.article;if(!a)throw Error('cloud_private_metadata_missing');return a;};
  const keepReading=(a:ReturnType<typeof metadata>)=>{const base=currentArticles.get(a.articleId);return base&&!base.deleted?{...a,...mergeReadingValue(a,base)} as typeof a:a;};
  const overlayBytes=payload.get(PRIVATE_OVERLAY_NAME);if(overlayBytes)pending+=(await this.observePrivateOverlay(payload,remote,descriptors)).pending;
  const overlays=overlayBytes?(await decodePrivateOverlay(overlayBytes,this.crypto.sha256)).entries:[];
  const archiveNames=['private-library.wrss',...overlays.filter(e=>e.kind==='article'&&e.object).map(e=>e.object!)];
  for(const archiveName of [...new Set(archiveNames)]){const archive=payload.get(archiveName);if(archive){
   if(options){
    const cp=options.checkpoint;await cp.check();let directory:{has(name:string):boolean},entry:(name:string)=>Promise<Uint8Array|undefined>;try{if(options.archiveReader&&archiveName==='private-library.wrss'){const reader=await openWrssRange(options.archiveReader,(b,max)=>this.crypto.gunzip(b,max),{yield:this.crypto.yieldTurn});directory=reader;entry=reader.get;}else{const index=indexWrss(archive);directory=index;entry=name=>readWrssEntry(archive,name,(b,max)=>this.crypto.gunzip(b,max),{yield:this.crypto.yieldTurn},index);}}catch(error){await cp.check();if(String(error).includes('cloud_snapshot_projection_missing'))throw error;lost();continue;}
    let rows:any[];try{const header=JSON.parse(utf8Decode(await entry('manifest.json')??new Uint8Array()));if(header.format!=='watchrss-library-backup'||![1,2,3].includes(header.version))throw Error('cloud_archive_invalid');rows=JSON.parse(utf8Decode(await entry('articles.json')??new Uint8Array()));if(!Array.isArray(rows)||rows.length>100000)throw Error('cloud_archive_invalid');}catch(error){await cp.check();if(error instanceof SyntaxError||String(error).includes('cloud_archive_invalid'))lost();else retry();continue;}
    if(archiveName==='private-library.wrss'&&directory.has('books.json')){try{const books=JSON.parse(utf8Decode((await entry('books.json'))!));if(!Array.isArray(books)||books.length>100000)throw Error('cloud_archive_invalid');for(const descriptor of books){await cp.check();if(!cp.has('book:'+descriptor.bookId))bookBodies.push({descriptor,loadBytes:()=>entry(descriptor.packagePath)});}}catch{await cp.check();lost();}}
    for(let offset=0;offset<rows.length;offset+=20){await cp.check();const unit='archive:'+archiveName+':'+offset;if(cp.has(unit)){abandoned+=cp.result(unit);cp.progress?.(Math.min(rows.length,offset+20),rows.length);continue;}const articles:ExportedArticle[]=[];let broken=0;await loadCurrent(rows.slice(offset,offset+20).filter((_r:any,j:number)=>!cp.has(unit+':row:'+(offset+j))));
     for(let j=offset;j<Math.min(rows.length,offset+20);j++){await cp.check();const rowUnit=unit+':row:'+j;if(cp.has(rowUnit)){broken+=cp.result(rowUnit);continue;}const raw=rows[j];let a:ReturnType<typeof metadata>|undefined,bad=0;
      if(!raw?.deleted&&this.overlay.allow('article',raw?.articleId,remote,archiveName==='private-library.wrss'?undefined:archiveName)){
       try{const base=currentArticles.get(raw?.articleId);a=metadata(raw?.url?raw:base&&base.contentHash===raw?.contentHash&&!base.deleted?base:raw);}catch{bad=1;}
       if(a){const stem='bodies/'+await this.crypto.sha256(utf8Encode(a.articleId));if(raw.contentTextEntry!==stem+'.txt'||raw.contentHtmlEntry!=null&&raw.contentHtmlEntry!==stem+'.html')bad=1;
        if(!bad){const text=await entry(raw.contentTextEntry),html=raw.contentHtmlEntry?await entry(raw.contentHtmlEntry):undefined;if(!text||raw.contentHtmlEntry&&!html)bad=1;else{const value={...keepReading(a),contentText:utf8Decode(text),contentHtml:html?utf8Decode(html):null};bookChanged+=await this.mergeCloud([], [value],remote,()=>this.guard.require());remember([value]);}}
       }
      }
      await cp.commit(rowUnit,bad);broken+=bad;cp.progress?.(j+1,rows.length);
     }
     await cp.commit(unit,broken);abandoned+=broken;cp.progress?.(Math.min(rows.length,offset+20),rows.length);
    }
    continue;
   }
   let zip:Map<string,Uint8Array>|undefined,rows:any[]=[];
   try{zip=await readWrss(archive,(b,max)=>this.crypto.gunzip(b,max));const manifest=JSON.parse(utf8Decode(zip.get('manifest.json')??new Uint8Array()));if(manifest.format!=='watchrss-library-backup'||![1,2,3].includes(manifest.version))throw Error('cloud_archive_invalid');rows=JSON.parse(utf8Decode(zip.get('articles.json')??new Uint8Array()));if(!Array.isArray(rows)||rows.length>100000)throw Error('cloud_archive_invalid');}catch(error){if(error instanceof SyntaxError||String(error).includes('cloud_archive_invalid'))lost();else retry();zip=undefined;}
   if(archiveName==='private-library.wrss'&&zip?.has('books.json')){try{const directory=JSON.parse(utf8Decode(zip.get('books.json')!));if(!Array.isArray(directory)||directory.length>100000)throw Error('invalid books directory');for(const descriptor of directory)bookBodies.push({descriptor,bytes:zip.get(descriptor.packagePath)});}catch{lost();}}
   const articles:ExportedArticle[]=[];if(zip)await loadCurrent(rows);if(zip)for(const raw of rows){if(raw?.deleted||!this.overlay.allow('article',raw?.articleId,remote,archiveName==='private-library.wrss'?undefined:archiveName))continue;let a:ReturnType<typeof metadata>;
    try{const base=currentArticles.get(raw?.articleId);a=metadata(raw?.url?raw:base&&base.contentHash===raw?.contentHash&&!base.deleted?base:raw);}catch{lost();continue;}
    const stem='bodies/'+await this.crypto.sha256(utf8Encode(a.articleId));
    if(raw.contentTextEntry!==stem+'.txt'||raw.contentHtmlEntry!=null&&raw.contentHtmlEntry!==stem+'.html'){lost();continue;}
    const text=zip.get(raw.contentTextEntry),html=raw.contentHtmlEntry?zip.get(raw.contentHtmlEntry):undefined;
    // A successfully authenticated immutable ZIP cannot grow missing entries.
    if(!text||raw.contentHtmlEntry&&!html){lost();continue;}articles.push({...keepReading(a),contentText:utf8Decode(text),contentHtml:html?utf8Decode(html):null});
   }decoded.push({sources:[],articles});
  }}
  const readers:ExportedArticle[]=[],seen=new Set<string>();
  for(const object of descriptors.filter(o=>o.name.startsWith('reader/'))){seen.add(object.name);let raw=object.privateArticle;
   if(!raw){const candidate=await findReader(object.name);if(candidate)raw={...candidate};}
   let a:ReturnType<typeof metadata>;try{a=metadata(raw);}catch{lost();continue;}
   const name=`reader/${(await this.crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await this.crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`;
   if(name!==object.name){lost();continue;}if(!this.overlay.allow('article',a.articleId,remote))continue;const body=payload.get(name);if(!body){retry();continue;}
   if(object.contentSha256&&await this.crypto.sha256(body)!==object.contentSha256){lost();continue;}
   readers.push({...keepReading(a),contentHtml:null,contentText:utf8Decode(body)});
  }
  for(const [name,body]of payload)if(name.startsWith('reader/')&&!seen.has(name)){const a=await findReader(name,true);if(a)readers.push({...keepReading(a),contentHtml:null,contentText:utf8Decode(body)});else lost();}
  for(const body of bookBodies){const d=body.descriptor;let bytes=body.bytes;await options?.checkpoint.check();if(options?.checkpoint.has('book:'+d?.bookId))continue;if(d?.bookId&&!this.overlay.allow('book',d.bookId,remote,overlays.some(e=>e.kind==='book'&&e.id===d.bookId)?d.packagePath:undefined))continue;if(!d||!/^([a-f0-9]{64})$/.test(d.bookId)||d.packagePath!=='books/'+d.bookId+'.jsonl'||!Number.isSafeInteger(d.chapterCount)||d.chapterCount<1){lost();continue;}if(!bytes&&body.loadBytes)bytes=await body.loadBytes();if(!bytes){retry();continue;}if(!this.repository.receiveCloudBook){retry();continue;}try{const header=parseBookHeader(utf8Decode(bytes.subarray(0,bytes.indexOf(10))));if(header.chapterCount!==d.chapterCount)throw Error('book_count_mismatch');await validateBook({bookId:d.bookId,fingerprint:d.fingerprint,title:d.title,chapterCount:d.chapterCount,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:0,sourceDeviceId:remote,sourceUrl:d.sourceUrl,kind:d.kind},this.crypto.sha256);bookChanged+=await this.repository.receiveCloudBook(d.bookId,bytes);await options?.checkpoint.commit('book:'+d.bookId);}catch(error){await options?.checkpoint.check();if(/book_sync_invalid|fingerprint|identity|directory|count_mismatch|invalid_book|JSON|SyntaxError/.test(String(error)))lost();else retry();}}
  if(readers.length)decoded.push({sources:[],articles:readers});let changed=bookChanged;for(const value of decoded){changed+=await this.mergeCloud(value.sources,value.articles,remote,()=>this.guard.require());remember(value.articles);}if(!options?.skipReading)changed+=await this.applyReadingStates();return {changed,pending,abandoned,warnings};
 }
 async mergeInventory(inventory:RssInventory,options?:{checkpoint:RestoreApplyCheckpoint;skipReading?:boolean}){
  this.guard.require();if(isImportedContentUrl(inventory.url)||!/^https?:\/\//i.test(inventory.url))throw Error('非公共 RSS');
  if(inventory.sourceId)this.sourceIds.set(inventory.url,inventory.sourceId);
  const sources=this.repository.cloudSources?await this.repository.cloudSources():(await this.repository.cloudSnapshot(false,()=>this.guard.require())).sources;
  const userTitle=sources.find(s=>s.url===inventory.url)?.title||inventory.title||inventory.url;
  const articles:ExportedArticle[]=[];let changed=0;
  for(let offset=0;offset<inventory.items.length;offset+=20){await options?.checkpoint.check();const unit='inventory-rows:'+offset;if(options?.checkpoint.has(unit)){options.checkpoint.progress?.(Math.min(inventory.items.length,offset+20),inventory.items.length);continue;}
  for(const item of inventory.items.slice(offset,offset+20)){
   const id=await tryRssArticleId({link:item.identityLink===undefined?item.url:item.identityLink,guid:item.guid,title:item.title,contentHash:item.contentHash,dedupKey:item.dedupKey},this.crypto.sha256);if(!id)continue;const hash=item.contentHash??await this.crypto.sha256(utf8Encode(item.contentHtml??item.contentText??item.url));
   // Inventories supply no save/reading mutation clocks. The repository
   // preserves existing publication timestamps across repeated fetches.
   articles.push(Object.assign({articleId:id,cloudRssArticleId:id,sourceDeviceId:'cloud-rss-inventory',url:item.url,title:item.title||item.url,siteName:inventory.title||inventory.url,excerpt:item.excerpt,contentHtml:item.contentHtml,contentText:item.contentText||item.excerpt,imageUrl:item.imageUrl,contentHash:hash,importedAt:0,updatedAt:0,rssSourceUrl:inventory.url,rssSourceTitle:userTitle,independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false},{cloudMedia:{audioUrl:item.audioUrl??null,videoUrl:item.videoUrl??null,publishedAt:item.publishedAt??null}}));
  }
  if(options){changed+=await this.mergeCloud([],articles.splice(0),'cloud-rss-inventory');await options.checkpoint.commit(unit);options.checkpoint.progress?.(Math.min(inventory.items.length,offset+20),inventory.items.length);}
  }
  if(!options)changed+=await this.mergeCloud([],articles,'cloud-rss-inventory');for(const a of articles){const identity=await this.readingIdentity(a);if(identity)for(const key of [identity.canonical,...identity.aliases])this.matchedReading.delete(key);}return changed+(options?.skipReading?0:await this.applyReadingStates());
 }
}

/** Reading LWW never uses the public feed refresh clock. Exact ties prefer unread. */
export function mergeReadingValue(local:Record<string,any>,remote:Record<string,any>,replaySameOperation=false){
 const out={...local},lc=local.readingPositionChangedAt||0,rc=remote.readingPositionChangedAt||0,ld=local.sourceDeviceId||'',rd=remote.sourceDeviceId||'';
 // Authenticated records replay can repair an older body's accidental local
 // rewind. Equal writer/clock/read flag identifies the same reading operation;
 // a newer local operation and an explicit unread tie still take precedence.
 if(rc>lc||rc===lc&&(rd>ld||rd===ld&&(remote.isRead===false||replaySameOperation&&remote.isRead===local.isRead))){for(const k of ['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','sourceDeviceId'])if(k in remote)out[k]=remote[k];}
 for(const type of ['favorite','watchLater']){const k=type+'ChangedAt';if((remote[k]??0)>(local[k]??0)||(remote[k]??0)===(local[k]??0)&&rd>=ld)for(const suffix of ['Saved','ChangedAt','SortOrder'])if(type+suffix in remote)out[type+suffix]=remote[type+suffix];}return out;
}
