import {idleHit} from '../diagnostics/idle-counters';
import {cpuWorkAsyncIterable} from '@podjs/framework/cpu-work';
import {repositoryWork} from './repository-work';
import {memoizeSmallDigest} from '../core/digest-cache';
import {HostWorkBudget} from '@podjs/framework/async';
import {ArticleKeepStore} from './article-keep';
import {projectionGuard,DOMAIN_ENCODERS} from './domain-definitions';
import {PROTOCOL_VERSION} from './protocol';
import {orderImportedRows} from './import-order';
import {matchGzipHash} from '@podjs/framework/crypto';
import {articleState} from './article-provenance';
import {utf8Encode} from '../cloud/types';
import {tryRssArticleId,legacyWebArticleId,canonicalRssUrl,isLocalOnlyRssSource} from '../cloud/rss-identity';
import {readSyncSqlText} from "./sql-text.ts";
import {libraryRevision,revisionGuard} from "./revision.ts";
import {querySyncPages,querySyncKeysetPages} from './sql-pages.ts';
import type {SqlDatabase,SqlParams} from "../core/types.ts";
import type {ArticleReceiveFiles,IncomingArticle,LocalReceiveBody} from "./article-receiver.ts";
import {javaUtf8Chunks} from "../reader/imported-text-writer.ts";
import type {SyncBodyCodec} from "./article-body.ts";
import {hashJavaText,prepareArticle,prepareCachedArticle,type CachedBodyManifest,type ExportedArticle,type PreparedArticle} from "./article-export.ts";
import {isImportedContentUrl} from "../core/imported-content.ts";
export interface SyncTextPort {
 parseUri(value:string):Promise<{valid:boolean;scheme:string|null;host:string|null;rawPath:string|null;rawQuery:string|null}>;
 htmlText(html:string):Promise<string>;
 yieldTurn?:()=>Promise<unknown>;
}
export {kotlinTrim as nativeTrim} from '@podjs/framework/text-compat';
import {kotlinTrim as nativeTrim} from '@podjs/framework/text-compat';
const blank=(s:string|null|undefined)=>!s||!nativeTrim(s);
// These phone-generated chapter URLs are already in Android Uri's stable-ID
// form: lowercase scheme/host, literal path and no query. Restrict the fast
// path to the exact generated shape; all other links still use host Uri.
const canonicalTxtChapter=/^https:\/\/watchrss\.local\/import-txt-novel\/[0-9a-f]{32}\/chapter\/[0-9]{4}-[0-9a-f]{16}$/;
export async function stableArticleId(value:string,uri:SyncTextPort['parseUri'],codec:Pick<SyncBodyCodec,'sha256'>):Promise<string>{
 const trimmed=nativeTrim(value),normalized=trimmed.startsWith('http://')||trimmed.startsWith('https://')?trimmed:'https://'+trimmed;
 if(canonicalTxtChapter.test(trimmed))return hashJavaText(trimmed,codec);
 let key=trimmed;
 const p=await uri(normalized);if(p.valid&&p.scheme!==null)key=p.scheme.toLowerCase()+'://'+(p.host??'').toLowerCase().replace(/^www\./,'')+(blank(p.rawPath)?'/':p.rawPath)+(blank(p.rawQuery)?'':'?'+p.rawQuery);
 return hashJavaText(key,codec);
}
export type ReencodedBody=CachedBodyManifest&{itemId:number};
export interface CloudRssIdentity {itemId:number;articleId:string;localArticleId:string;nativeArticleId:string;legacyMaterialized:boolean;canonicalBinding?:boolean;url:string;sourceUrl:string}
type Row=Record<string,unknown>;
const IDENTITY_SELECT=`SELECT a.id,a.title,a.link,a.guid,a.dedup_key,ch.url AS channel_url,m.article_id AS bound_id,m.url AS bound_url,i.article_id AS cloud_rss_id FROM articles a JOIN channels ch ON ch.id=a.channel_id LEFT JOIN sync_article_ids m ON m.item_id=a.id LEFT JOIN cloud_rss_article_ids i ON i.item_id=a.id`;


// Reading projection never needs chapter bodies, compression metadata or chunk
// probes. Opaque legacy identities load their one full row inside cloudIdentity.
const READING_SELECT=IDENTITY_SELECT.replace(' FROM articles a',`,a.is_read,a.reading_progress,a.fetched_at,a.image_url,ch.title AS channel_title,p.summary,p.image_url AS preview_image,
 COALESCE(NULLIF(c.body_hash,''),n.body_hash,'') AS cached_body_hash,r.progress,r.changed_at AS position_changed_at,r.position_bytes,r.position_hash,s.source_device_id AS native_reading_source FROM articles a`)+`
 LEFT JOIN article_previews p ON p.article_id=a.id LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_native_sync_hash n ON n.item_id=a.id
 LEFT JOIN article_reading_state r ON r.article_id=a.id LEFT JOIN native_reading_sources s ON s.item_id=a.id AND s.changed_at=COALESCE(r.changed_at,0)`;

const str=(v:unknown)=>v==null?'':String(v),nullable=(v:unknown)=>v==null?null:String(v),num=(v:unknown)=>Number(v??0);
const ROW_SELECT=`SELECT a.id,a.channel_id,a.title,a.link,a.guid,a.pub_date,a.image_url,a.audio_url,a.video_url,a.is_read,a.is_saved,a.reading_progress,a.dedup_key,a.fetched_at,
 (SELECT article_id FROM cloud_rss_article_ids WHERE item_id=a.id) AS cloud_rss_id,
 CASE WHEN a.content IS NULL OR length(CAST(a.content AS BLOB))<=4096 THEN 1 ELSE 0 END AS content_inline,
 CASE WHEN a.description IS NULL OR length(CAST(a.description AS BLOB))<=4096 THEN 1 ELSE 0 END AS description_inline,
 CASE WHEN length(CAST(a.content AS BLOB))<=4096 THEN a.content END AS content,
 CASE WHEN length(CAST(a.description AS BLOB))<=4096 THEN a.description END AS description,
 (SELECT article_id FROM sync_article_ids WHERE item_id=a.id) AS bound_id,(SELECT url FROM sync_article_ids WHERE item_id=a.id) AS bound_url,
 ch.url AS channel_url,ch.title AS channel_title,ch.is_pinned AS channel_pinned,ch.sort_order AS channel_sort,ch.created_at AS channel_created,p.summary,p.image_url AS preview_image,
 COALESCE(NULLIF(c.body_hash,''),n.body_hash,'') AS cached_body_hash,n.body_hash AS native_body_hash,c.body_hash AS encoded_body_hash,c.content_bytes AS cached_content_bytes,c.body_bytes,c.chunk_size,c.chunk_hashes,e.body_hash AS local_encoded_body_hash,
 e.content_hash AS received_content_hash,e.source_device_id AS received_source,e.updated_at AS received_updated_at,e.imported_at AS received_imported_at,e.metadata_state AS received_state,e.site_name AS received_site_name,e.rss_source_title AS received_source_title,
 CASE WHEN c.content_html IS NULL OR length(CAST(c.content_html AS BLOB))<=256 THEN 1 ELSE 0 END AS cache_inline_html,
 CASE WHEN length(CAST(c.content_html AS BLOB))<=256 THEN c.content_html END AS cache_html,
 CASE WHEN length(CAST(c.content_text AS BLOB))<=256 THEN c.content_text END AS cache_text,
 r.progress,r.changed_at AS position_changed_at,r.position_bytes,r.position_hash,
 (SELECT source_device_id FROM native_reading_sources WHERE item_id=a.id AND changed_at=COALESCE(r.changed_at,0)) AS native_reading_source,
 COALESCE((SELECT revision FROM sync_body_revision WHERE item_id=a.id),0) AS chunk_revision,
 EXISTS(SELECT 1 FROM article_original_chunks o WHERE o.article_id=a.id) AS has_original_chunks
 FROM articles a JOIN channels ch ON ch.id=a.channel_id LEFT JOIN article_previews p ON p.article_id=a.id
 LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash LEFT JOIN article_native_sync_hash n ON n.item_id=a.id LEFT JOIN article_reading_state r ON r.article_id=a.id`;
const LOCAL_CHANNEL=`ch.url LIKE '%watchrss://phone-imports%' OR
 ch.url LIKE '%https://watchrss.local/import-content%' OR
 ch.url LIKE '%https://watchrss.local/import-epub%' OR
 ch.url LIKE '%https://watchrss.local/import-txt-novel%'`;
const ROW_CONDITION=`EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id)
 OR EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=a.id)
 OR ${LOCAL_CHANNEL}`;
const SAVES=`SELECT s.*,m.article_id AS sync_id,COALESCE(t.created_at,s.changed_at) AS saved_at FROM article_saved_states s LEFT JOIN sync_article_ids m ON m.item_id=s.article_id LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type ORDER BY s.sort_order,saved_at DESC,s.article_id`;
const STATES='SELECT * FROM sync_saved_states ORDER BY article_id,save_type';
const DELETES='SELECT * FROM local_article_deletions ORDER BY changed_at,id';
const SYNC_DELETES='SELECT * FROM sync_article_deletions ORDER BY article_id';
interface State {articleId:string;type:string;url:string;saved:boolean;changedAt:number;sortOrder:number;device:string;itemId?:number|null}
/** Reads actual bodies and checks all source rows again after asynchronous work.
 * A changed snapshot fails instead of advertising mixed metadata generations. */
export class LocalArticleManifestStore {
 private readonly identityHash=memoizeSmallDigest((bytes:Uint8Array)=>this.codec.sha256(bytes));
 private encodingGeneration?:string;
 setEncodingGeneration(value:string){if(this.encodingGeneration===value)return;this.encodingGeneration=value;this.rowCache.clear();this.rowCacheBytes=0;this.stableIds.clear();this.stableReady=undefined;this.reusableBodies.clear();this.bodySourceIds.clear();}
 private rowSelect(){return this.encodingGeneration?ROW_SELECT.replace(' FROM articles a JOIN channels ch',', (SELECT generation FROM sync_fast_encoded_cache g WHERE g.item_id=a.id AND g.body_hash=c.body_hash) AS body_generation FROM articles a JOIN channels ch'):ROW_SELECT;}
 private bodySourceIds=new Map<string,number>();
 private reusableBodies=new Map<number,PreparedArticle>();
 private completeReusable:((p:PreparedArticle)=>Promise<PreparedArticle>)|undefined;
 private async reusableMetadata(id:number){const p=this.reusableBodies.get(id);if(!p)return;const full=await this.completeReusable?.(p)??p;this.reusableBodies.set(id,full);return full;}
 private reencodedBodies=new Map<number,ReencodedBody>();
 private cacheRows=true;
 private rowCache=new Map<string,{stamp:string;prepared:PreparedArticle;bytes:number}>();
 private rowCacheBytes=0;
 private readonly stableIds=new Map<string,string>();private stableReady?:Promise<void>;private stablePending=0;private stableLast='';
 private preparationRevision?:number;private preparationTail:Promise<unknown>=Promise.resolve();
 private commitPreparation(unit:string){const next=this.preparationTail.then(()=>this.cloudProgress?.(unit));this.preparationTail=next.catch(()=>{});return next;}
 private async stableIndex(){if(!this.cloudProgress)return;return this.stableReady??=(async()=>{await this.db.execute('CREATE TABLE IF NOT EXISTS sync_stable_article_ids(definition TEXT NOT NULL,url TEXT NOT NULL,article_id TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(definition,url))');const key=`stable-v1:${PROTOCOL_VERSION}:${DOMAIN_ENCODERS.library}`;for(const r of await querySyncPages(this.db,'SELECT url,article_id,proof FROM sync_stable_article_ids WHERE definition=? ORDER BY url',[key])){const id=str(r.article_id);if(/^[a-f0-9]{64}$/.test(id)&&str(r.proof)===await this.identityHash(utf8Encode(JSON.stringify([key,str(r.url),id])))){if(this.stableIds.size>=8192)this.stableIds.delete(this.stableIds.keys().next().value!);this.stableIds.set(str(r.url),id);}}})().catch(e=>{this.stableReady=undefined;throw e;});}
 private async flushStableProgress(){if(!this.stablePending)return;const unit=this.stableLast;this.stablePending=0;await this.commitPreparation(unit);}

 constructor(private db:SqlDatabase,private codec:SyncBodyCodec,private text:SyncTextPort,
  private readonly files:ArticleReceiveFiles,private readonly migrateReading:(id:number)=>Promise<void>,private readonly migrateReadingMany?:(ids:readonly number[])=>Promise<void>,private readonly diagnostic?:(fields:Record<string,string|number>)=>void,private readonly reencodeStored?: (ids:readonly number[])=>Promise<readonly ReencodedBody[]>,private cloudProgress?:(unit:string)=>Promise<void>){ }
 setCloudProgress(sink?:(unit:string)=>Promise<void>){this.cloudProgress=sink;}
 private report(fields:Record<string,string|number>){try{this.diagnostic?.(fields);}catch{/* Diagnostics never change the snapshot. */}}
 private async stableId(value:string):Promise<string>{
  await this.stableIndex();const cached=this.stableIds.get(value);if(cached)return cached;
  const id=await stableArticleId(value,this.text.parseUri,this.codec);
  if(this.stableIds.size>=8192)this.stableIds.delete(this.stableIds.keys().next().value!);
  this.stableIds.set(value,id);if(this.cloudProgress){const definition=`stable-v1:${PROTOCOL_VERSION}:${DOMAIN_ENCODERS.library}`;await this.db.execute('INSERT OR REPLACE INTO sync_stable_article_ids VALUES(?,?,?,?)',[definition,value,id,await this.identityHash(utf8Encode(JSON.stringify([definition,value,id])))]);this.stablePending++;this.stableLast='identity:'+definition+':'+await this.identityHash(utf8Encode(value));if(this.stablePending>=16)await this.flushStableProgress();}return id;
 }
 /** Native lookup uses each saved-type binding before source/dedup fallback. */
 async resolveIncomingBody(article:IncomingArticle,targetItemId?:number):Promise<LocalReceiveBody|null>{
  const revision=await libraryRevision(this.db);let row:Row|undefined=targetItemId?(await this.db.query(this.rowSelect()+` WHERE a.id=?`,[targetItemId]))[0]:undefined;
  const states=await this.db.query(`SELECT item_id FROM sync_saved_states WHERE article_id=? AND item_id IS NOT NULL ORDER BY CASE save_type WHEN 'favorite' THEN 0 ELSE 1 END`,[article.articleId]);
  for(const state of row?[]:states){row=(await this.db.query(this.rowSelect()+` WHERE a.id=?`,[state.item_id]))[0];if(row)break;}
  if(!row){const source=article.rssSourceUrl&&/^https?:\/\//i.test(nativeTrim(article.rssSourceUrl))?article.rssSourceUrl:'watchrss://phone-imports';row=(await this.db.query(this.rowSelect()+` WHERE ch.url=? AND a.dedup_key=?`,[source,article.articleId]))[0];}
  if(!row)return null;
  // A received original and the independently fetched RSS original can differ.
  // The acknowledged wire manifest describes article_sync_content, not the
  // reader's original_chunks. Use the same source as materializeRequested;
  // requireMetadataOnlyBody still verifies every encoded byte/hash below.
  const cached=await this.readCachedBody(row,true);
  if(!cached)await this.hydrateRow(row);
  const actual=cached?{available:true,...cached}:await this.bodyFromRow(row);
  if(await libraryRevision(this.db)!==revision)throw new Error("Local library changed during body lookup");
  return {itemId:num(row.id),available:actual.available,hasStoredBody:cached?(!blank(cached.contentHtml)||!blank(cached.contentText)):!blank(nullable(row.actual_content))||!blank(nullable(row.original_content)),body:actual.available?{contentHtml:actual.contentHtml,contentText:actual.contentText}:null};
 }
 async prepareReadingForSnapshot(urls?:readonly string[]):Promise<void> {
  if(urls?.length===0)return;
  const readingCandidates=await querySyncPages(this.db,`SELECT a.id,c.url AS channel_url,
   EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id) AS has_saved_state
   FROM articles a JOIN channels c ON c.id=a.channel_id
   WHERE (c.url LIKE '%watchrss://phone-imports%' OR
    c.url LIKE '%https://watchrss.local/import-content%' OR
    c.url LIKE '%https://watchrss.local/import-epub%' OR
    c.url LIKE '%https://watchrss.local/import-txt-novel%' OR
    EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id))${urls?' AND COALESCE(a.link,a.dedup_key) IN ('+urls.map(()=>'?').join(',')+')':''}
   ORDER BY a.id`,urls??[]);
  const migrationIds=readingCandidates.filter(row=>num(row.has_saved_state)||isImportedContentUrl(str(row.channel_url))).map(row=>num(row.id));
  if(this.migrateReadingMany)await this.migrateReadingMany(migrationIds);
  else for(const id of migrationIds)await this.migrateReading(id);
 }
 /** Native hash/cache hits can settle synchronously. Budget the whole caller,
  * rather than assuming an await necessarily gives Android's looper a turn. */
 private workCheckpoint(check?:()=>void){let work=0,slice=Date.now();return async(weight=1)=>{check?.();work+=weight;if(work>=32||Date.now()-slice>=8){await (this.text.yieldTurn?.()??this.db.query('SELECT 1'));check?.();work=0;slice=Date.now();}};}
 /** Cloud identities remain separate from native-wire bindings. Pool IDs are authoritative. */
 private async cloudIdentity(r:Row,metadataOnly=false):Promise<CloudRssIdentity|undefined>{
  try{
  if(isImportedContentUrl(str(r.channel_url))||isLocalOnlyRssSource(str(r.channel_url)))return;
  const pool=nullable(r.cloud_rss_id);
  const legacyMaterialized=!!r.bound_id&&r.guid===r.bound_id&&r.dedup_key===r.bound_id&&!pool,guid=legacyMaterialized?null:nullable(r.guid);
  let contentHash:string|undefined;
  if(!pool&&!str(guid).trim()){let web=false;try{canonicalRssUrl(str(r.link),false);web=true;}catch{}if(!web){if(metadataOnly)return;const full=r.content_inline===undefined?(await this.db.query(this.rowSelect()+' WHERE a.id=?',[r.id]))[0]:r;if(!full)return;await this.hydrateRow(full);const body=await this.bodyFromRow(full);if(!body.available)return;if(body.contentHtml||body.contentText)contentHash=await this.identityHash(utf8Encode(body.contentHtml??body.contentText));}}
  const articleId=await tryRssArticleId({dedupKey:pool??undefined,link:nullable(r.link),guid,title:str(r.title),contentHash},this.identityHash);if(!articleId)return;
  const url=str(r.link)||str(r.guid)||str(r.dedup_key);
  // A transport binding can be retained even when its URL normalization predates R41.
  let nativeArticleId:string;try{nativeArticleId=metadataOnly?(str(r.bound_id)||articleId):await this.stableId(r.link==null?str(r.dedup_key):str(r.link));}catch{return;}const localArticleId=str(r.bound_id)||articleId;
  return {itemId:num(r.id),articleId,localArticleId,nativeArticleId,legacyMaterialized,canonicalBinding:!!pool,url,sourceUrl:str(r.channel_url)};
  }catch{return undefined;}
 }
 /** Independent read-only identity work shares four host requests. Ordered
  * collection preserves alias precedence; cancellation drains the current group. */
 private cloudIdentityBatches(rows:readonly Row[],check?:()=>void){return cpuWorkAsyncIterable('alias-match','items',rows.length,()=>this.cloudIdentityBatchSteps(rows,check));}
 private async *cloudIdentityBatchSteps(rows:readonly Row[],check?:()=>void){
  const checkpoint=this.workCheckpoint(check);
  for(let at=0;at<rows.length;at+=4){const part=rows.slice(at,at+4);await checkpoint(part.length);
   const identities=await Promise.all(part.map(row=>this.cloudIdentity(row)));check?.();yield {rows:part,identities};
  }
 }
 async cloudRssIdentities(filter?:{sourceUrl:string;url:string;ids:readonly string[]},check?:()=>void):Promise<CloudRssIdentity[]>{
  const marks=filter?.ids.map(()=>'?').join(',');
  const where=filter?`ch.url=? AND (a.link=? OR a.dedup_key IN (${marks}) OR a.id IN (SELECT item_id FROM sync_article_ids WHERE article_id IN (${marks})) OR a.id IN (SELECT item_id FROM cloud_rss_article_ids WHERE article_id IN (${marks})))`:"ch.url LIKE 'http://%' OR ch.url LIKE 'https://%'";
  const rows=await querySyncKeysetPages(this.db,IDENTITY_SELECT+" WHERE ("+where+") AND ch.url NOT LIKE 'https://watchrss.local/import-%' AND a.id>? ORDER BY a.id",filter?[filter.sourceUrl,filter.url,...filter.ids,...filter.ids,...filter.ids]:[],{key:'id'}),out:CloudRssIdentity[]=[];
  for await(const group of this.cloudIdentityBatches(rows,check))for(const identity of group.identities)if(identity)out.push(identity);return out;
 }
 async cloudRssIdentitiesForUrls(urls:readonly string[],check?:()=>void,itemIds:readonly number[]=[]):Promise<CloudRssIdentity[]>{const out=new Map<number,CloudRssIdentity>();for(let at=0;at<urls.length;at+=100){const part=urls.slice(at,at+100),marks=part.map(()=>'?').join(',');const rows=await querySyncKeysetPages(this.db,IDENTITY_SELECT+` WHERE (a.link IN (${marks}) OR a.guid IN (${marks}) OR a.dedup_key IN (${marks})) AND ch.url NOT LIKE 'https://watchrss.local/import-%' AND a.id>? ORDER BY a.id`,[...part,...part,...part],{key:'id'});for await(const group of this.cloudIdentityBatches(rows,check))for(const identity of group.identities)if(identity)out.set(identity.itemId,identity);}for(let at=0;at<itemIds.length;at+=100){const part=itemIds.slice(at,at+100),rows=await this.db.query(IDENTITY_SELECT+' WHERE a.id IN ('+part.map(()=>'?').join(',')+')',part);for await(const group of this.cloudIdentityBatches(rows,check))for(const identity of group.identities)if(identity)out.set(identity.itemId,identity);}return [...out.values()].sort((a,b)=>a.itemId-b.itemId);}
 /** Ordinary read RSS rows are absent from saved-article snapshots. */
 async cloudReadingStates(all=false,check?:()=>void):Promise<ExportedArticle[]>{
  const device=String((await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??'');
  const rows=await querySyncKeysetPages(this.db,READING_SELECT+" WHERE ("+(all?"1":"a.is_read=1 OR a.reading_progress>0 OR r.progress>0 OR r.changed_at>0")+") AND (ch.url LIKE 'http://%' OR ch.url LIKE 'https://%') AND lower(ch.url) NOT LIKE 'https://watchrss.local/import-content%' AND lower(ch.url) NOT LIKE 'https://watchrss.local/import-epub%' AND lower(ch.url) NOT LIKE 'https://watchrss.local/import-txt-novel%' AND a.id>? ORDER BY a.id",[],{key:'id'});
  const out:ExportedArticle[]=[];
  for await(const group of this.cloudIdentityBatches(rows,check))for(let at=0;at<group.rows.length;at++){const r=group.rows[at]!,identity=group.identities[at];if(!identity)continue;const {url,articleId}=identity;
   out.push({articleId,cloudRssArticleId:articleId,sourceDeviceId:str(r.native_reading_source)||device,url,title:str(r.title)||url,siteName:str(r.channel_title),excerpt:str(r.summary),contentHtml:null,contentText:'',imageUrl:nullable(r.preview_image)??nullable(r.image_url),contentHash:str(r.cached_body_hash)||await hashJavaText(url,this.codec),importedAt:num(r.fetched_at),updatedAt:num(r.fetched_at),rssSourceUrl:str(r.channel_url),rssSourceTitle:str(r.channel_title),independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:num(r.progress??r.reading_progress),readingPositionBytes:num(r.position_bytes),readingPositionContentHash:str(r.position_hash),readingPositionChangedAt:num(r.position_changed_at),isRead:!!num(r.is_read)});
  }return out;
 }
 /** Durable identity-only lookup; invalidation compares source columns, never a body witness. */
 private lookupReady?:Promise<void>;
 private initReadingLookup(){return this.lookupReady??=this.db.transaction([{sql:`CREATE TABLE IF NOT EXISTS cloud_reading_lookup(item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,link TEXT,guid TEXT,dedup TEXT,title TEXT,source TEXT,pool TEXT,bound TEXT,article_id TEXT NOT NULL,article_hash TEXT NOT NULL,url_hash TEXT NOT NULL,legacy_hash TEXT NOT NULL,bound_hash TEXT NOT NULL,opaque_revision INTEGER NOT NULL)`},...['article_hash','url_hash','legacy_hash','bound_hash'].map(column=>({sql:'CREATE INDEX IF NOT EXISTS cloud_reading_lookup_'+column+' ON cloud_reading_lookup('+column+')'}))]).catch(e=>{this.lookupReady=undefined;throw e;});}
 async cloudReadingItemIds(hashes?:readonly string[],check?:()=>void){idleHit(34);
  await this.initReadingLookup();
  for(;;){idleHit(35);check?.();const revision=await libraryRevision(this.db),rows=await this.db.query(IDENTITY_SELECT+` LEFT JOIN cloud_reading_lookup k ON k.item_id=a.id WHERE (ch.url LIKE 'http://%' OR ch.url LIKE 'https://%') AND ch.url NOT LIKE 'https://watchrss.local/import-%' AND NOT EXISTS(SELECT 1 FROM sync_book_aliases b JOIN sync_books s ON s.book_id=b.book_id WHERE b.item_id=a.id AND s.registration_complete=1) AND NOT (k.item_id IS NOT NULL AND k.link IS a.link AND k.guid IS a.guid AND k.dedup IS a.dedup_key AND k.title IS a.title AND k.source IS ch.url AND k.pool IS i.article_id AND k.bound IS m.article_id AND (k.opaque_revision<0 OR k.opaque_revision=${revision})) ORDER BY a.id LIMIT 100`);
   if(!rows.length)break;const statements:{sql:string;params:SqlParams}[]=[];for(const row of rows){check?.();const fast=await this.cloudIdentity(row,true),identity=fast??await this.cloudIdentity(row),id=identity?.articleId??'';let urlId='',legacyId='';try{urlId=await tryRssArticleId(str(row.link),this.identityHash)??'';legacyId=await legacyWebArticleId(str(row.link),this.identityHash);}catch{}const digest=(v:string)=>v?this.identityHash(utf8Encode(v)):Promise.resolve('');statements.push({sql:'INSERT OR REPLACE INTO cloud_reading_lookup VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[num(row.id),nullable(row.link),nullable(row.guid),nullable(row.dedup_key),nullable(row.title),nullable(row.channel_url),nullable(row.cloud_rss_id),nullable(row.bound_id),id,await digest(id),await digest(urlId),await digest(legacyId),await digest(str(row.bound_id)),fast?-1:revision ]});}
   for(let at=0;at<statements.length;at+=10){check?.();const part=statements.slice(at,at+10);await this.db.transaction(part);await this.cloudProgress?.('reading-index:'+await this.identityHash(utf8Encode(JSON.stringify(part.map(s=>s.params)))));check?.();}
  }
  if(hashes?.length===0)return [];const out=new Set<number>(),groups=hashes?[...new Set(hashes)]:undefined;
  if(groups)for(let at=0;at<groups.length;at+=100){const part=groups.slice(at,at+100);for(const row of await querySyncPages(this.db,'SELECT k.item_id FROM cloud_reading_lookup k JOIN articles a ON a.id=k.item_id WHERE k.article_hash IN ('+part.map(()=>'?').join(',')+') OR k.url_hash IN ('+part.map(()=>'?').join(',')+') OR k.legacy_hash IN ('+part.map(()=>'?').join(',')+') OR k.bound_hash IN ('+part.map(()=>'?').join(',')+') ORDER BY k.item_id',[...part,...part,...part,...part]))out.add(num(row.item_id));}
  else for(const row of await querySyncPages(this.db,"SELECT k.item_id FROM cloud_reading_lookup k JOIN articles a ON a.id=k.item_id WHERE k.article_id<>'' ORDER BY k.item_id"))out.add(num(row.item_id));
  return [...out];
 }
 async cloudReadingIndex(check?:()=>void){await this.cloudReadingItemIds(undefined,check);return querySyncPages(this.db,`SELECT k.item_id,k.article_hash,k.url_hash,k.legacy_hash,k.bound_hash FROM cloud_reading_lookup k JOIN articles a ON a.id=k.item_id WHERE k.article_id<>'' AND NOT EXISTS(SELECT 1 FROM sync_book_aliases b JOIN sync_books s ON s.book_id=b.book_id WHERE b.item_id=a.id AND s.registration_complete=1) AND NOT EXISTS(SELECT 1 FROM article_register_state p WHERE p.item_id=a.id) ORDER BY k.item_id`);}
 /** Body-free metadata page. Never initializes encoders, projections or domain definitions. */
 async cloudRestoreMetadata(request:{ids?:readonly string[];urls?:readonly string[];itemIds?:readonly number[];after?:number;limit?:number}={},check?:()=>void){
  const after=request.after??0,limit=request.limit??100;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('cloud_metadata_page_invalid');
  const ids=[...new Set(request.ids??[])],urls=[...new Set(request.urls??[])];if(ids.length>100||urls.length>100)throw Error('cloud_metadata_page_invalid');
  if(request.ids&&!ids.length&&!urls.length&&!request.itemIds?.length)return {articles:[] as ExportedArticle[],next:undefined};
  const marks=ids.map(()=>'?').join(','),urlMarks=urls.map(()=>'?').join(','),filters:string[]=[],params:(string|number|null)[]=[];
  if(ids.length){filters.push(`a.id IN (SELECT item_id FROM sync_article_ids WHERE article_id IN (${marks}) UNION SELECT item_id FROM cloud_rss_article_ids WHERE article_id IN (${marks}) UNION SELECT item_id FROM sync_saved_states WHERE article_id IN (${marks})) OR a.dedup_key IN (${marks})`);params.push(...ids,...ids,...ids,...ids);}
  if(request.itemIds?.length){if(request.itemIds.length>100)throw Error('cloud_metadata_page_invalid');filters.push('a.id IN ('+request.itemIds.map(()=>'?').join(',')+')');params.push(...request.itemIds);}
  if(urls.length){filters.push(`a.link IN (${urlMarks}) OR a.dedup_key IN (${urlMarks})`);params.push(...urls,...urls);}
  await this.initReadingLookup();const select=READING_SELECT.replace('SELECT a.id,','SELECT a.id,a.is_saved,k.article_id AS cached_public_id,')+` LEFT JOIN cloud_reading_lookup k ON k.item_id=a.id AND k.link IS a.link AND k.guid IS a.guid AND k.dedup IS a.dedup_key AND k.title IS a.title AND k.source IS ch.url AND k.pool IS i.article_id AND k.bound IS m.article_id AND (k.opaque_revision<0 OR k.opaque_revision=(SELECT revision FROM sync_library_revision WHERE id=1))`;
  const rows=await this.db.query(select+' WHERE '+(filters.length?'('+filters.join(' OR ')+') AND ':'')+'a.id>? ORDER BY a.id LIMIT ?',[...params,after,limit]);check?.();
  if(!rows.length)return {articles:[] as ExportedArticle[],next:undefined};
  const itemIds=rows.map(r=>num(r.id)),slots=itemIds.map(()=>'?').join(','),saved=await querySyncPages(this.db,`SELECT s.article_id item_id,s.save_type,s.saved,CASE WHEN s.saved=1 THEN COALESCE(t.created_at,s.changed_at) ELSE s.changed_at END changed_at,CASE WHEN s.saved=1 THEN COALESCE(t.created_at,s.changed_at) ELSE s.changed_at END sort_order FROM article_saved_states s LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type WHERE s.article_id IN (${slots}) UNION ALL SELECT item_id,save_type,saved,changed_at,sort_order FROM sync_saved_states WHERE item_id IN (${slots}) ORDER BY item_id,save_type,changed_at`,[...itemIds,...itemIds]);
  const states=new Map<string,Row>();for(const row of saved){const key=row.item_id+':'+row.save_type,old=states.get(key);if(!old||num(row.changed_at)>=num(old.changed_at))states.set(key,row);}
  const keys=rows.flatMap(r=>[str(r.bound_id),str(r.cloud_rss_id)]).filter(Boolean),meta=new Map<string,Row>();if(keys.length)for(const r of await this.db.query('SELECT * FROM cloud_article_state WHERE article_id IN ('+keys.map(()=>'?').join(',')+')',keys))meta.set(str(r.article_id),r);
  const device=str((await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id),articles:ExportedArticle[]=[];
  for(const r of rows){check?.();const publicRow=/^https?:\/\//i.test(str(r.channel_url))&&!isImportedContentUrl(str(r.channel_url));const identity=publicRow?(r.cached_public_id?{articleId:str(r.cached_public_id),localArticleId:str(r.bound_id)||str(r.cached_public_id),nativeArticleId:str(r.bound_id)||str(r.cached_public_id)}:await this.cloudIdentity(r,true)):undefined;
   if(publicRow&&!identity)continue;const url=str(r.link)||str(r.guid)||str(r.dedup_key),id=identity?.articleId||str(r.bound_id)||await this.stableId(url),m=meta.get(id)??meta.get(str(r.bound_id)),hash=str(r.cached_body_hash),favorite=states.get(r.id+':favorite'),later=states.get(r.id+':watchLater'),clock=num(r.position_changed_at);
   articles.push({cloudReadingItemId:num(r.id),articleId:id,...(identity?{cloudRssArticleId:id,cloudLegacyArticleIds:[identity.localArticleId,identity.nativeArticleId].filter(x=>x!==id)}:{}),sourceDeviceId:str(r.native_reading_source)||(m&&clock===num(m.reading_clock)?str(m.reading_source):device),url,title:str(r.title)||url,siteName:str(r.channel_title),excerpt:str(r.summary),contentHtml:null,contentText:'',imageUrl:nullable(r.preview_image)??nullable(r.image_url),contentHash:m&&hash&&hash===str(m.body_hash)?str(m.content_hash):hash||await hashJavaText(url,this.codec),importedAt:num(r.fetched_at),updatedAt:num(r.fetched_at),rssSourceUrl:str(r.channel_url)==='watchrss://phone-imports'?null:str(r.channel_url),rssSourceTitle:str(r.channel_url)==='watchrss://phone-imports'?null:str(r.channel_title),independentSaved:str(r.channel_url)==='watchrss://phone-imports',independentChangedAt:str(r.channel_url)==='watchrss://phone-imports'?num(r.fetched_at):0,independentSortOrder:0,favoriteSaved:!!num(favorite?.saved),favoriteChangedAt:num(favorite?.changed_at),favoriteSortOrder:num(favorite?.sort_order),watchLaterSaved:!!num(later?.saved),watchLaterChangedAt:num(later?.changed_at),watchLaterSortOrder:num(later?.sort_order),deleted:false,deletedAt:0,readingProgress:Math.fround(num(r.progress??r.reading_progress)),readingPositionBytes:num(r.position_bytes),readingPositionContentHash:str(r.position_hash),readingPositionChangedAt:clock,isRead:!!num(r.is_read)});
  }return {articles,next:rows.length===limit?num(rows.at(-1)!.id):undefined};
 }
 async snapshot(readingPrepared=false,canonicalIds=false,bookMode=false,check?:()=>void,urls?:readonly string[]):Promise<PreparedArticle[]>{return repositoryWork(f=>this.report(f),'localSnapshot',()=>this.snapshotValue(readingPrepared,canonicalIds,bookMode,check,urls));}
 private async snapshotValue(readingPrepared=false,canonicalIds=false,bookMode=false,check?:()=>void,urls?:readonly string[]):Promise<PreparedArticle[]> {
  if(urls?.length===0)return [];
  await new ArticleKeepStore(this.db).initialize();
  const marks=urls?.map(()=>'?').join(',');
  const previousPreparation=this.preparationRevision;
  const previousCacheRows=this.cacheRows;this.cacheRows=!canonicalIds;
  const started=Date.now(),stats={sqlMs:0,sqlCalls:0,sqlTransactionMs:0,sqlTransactionCalls:0,htmlMs:0,htmlCalls:0,hashMs:0,hashCalls:0,encodeMs:0,encodeCalls:0};
  const budget=new HostWorkBudget({yieldTurn:()=>this.text.yieldTurn?.()??this.db.query('SELECT 1'),check,stepLimit:32,budgetMs:8});
  const originalText=this.text;this.text={...originalText,parseUri:async value=>{try{return await originalText.parseUri(value);}finally{budget.boundary();}},htmlText:async html=>{const at=Date.now();try{return await originalText.htmlText(html);}finally{stats.htmlMs+=Date.now()-at;stats.htmlCalls++;budget.boundary();}}};
  const originalCodec=this.codec;this.codec={...originalCodec,sha256:async bytes=>{const at=Date.now();try{return await originalCodec.sha256(bytes);}finally{stats.hashMs+=Date.now()-at;stats.hashCalls++;}},encode:async body=>{const at=Date.now();try{return await originalCodec.encode(body);}finally{stats.encodeMs+=Date.now()-at;stats.encodeCalls++;budget.boundary();}}};
  const trace=(stage:string)=>this.report({stage,elapsedMs:Date.now()-started,...stats});
  const originalDb=this.db;this.db={...originalDb,query:async(q,p,label)=>{const at=Date.now();try{return await originalDb.query(q,p,label);}finally{stats.sqlMs+=Date.now()-at;stats.sqlCalls++;budget.boundary();}},execute:(q,p,label)=>originalDb.execute(q,p,label),transaction:async ss=>{const at=Date.now();try{return await originalDb.transaction(ss);}finally{stats.sqlTransactionMs+=Date.now()-at;stats.sqlTransactionCalls++;budget.boundary();}}};
  try{
  check?.();const checkpoint=(weight=1)=>budget.checkpoint(weight);
  if(!urls)this.bodySourceIds.clear();
  const identity=(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];if(!identity)throw new Error('Initialize sync identity first');const device=str(identity.device_id);
  if(!readingPrepared)await this.prepareReadingForSnapshot(urls);
  const revision=await libraryRevision(this.db);this.preparationRevision=revision;
  // Select cheap IDs once. OFFSET on the wide correlated SELECT repeatedly
  // evaluated every preceding chapter's body/cache joins on the watch SQLite.
  const orderedIds=await querySyncPages(this.db,'SELECT a.id FROM articles a JOIN channels ch ON ch.id=a.channel_id WHERE ('+ROW_CONDITION+')'+(urls?' AND COALESCE(a.link,a.dedup_key) IN ('+marks+')':'')+(bookMode?' AND NOT EXISTS(SELECT 1 FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE m.item_id=a.id AND b.registration_complete=1)':'')+' ORDER BY a.fetched_at DESC,a.id DESC',urls??[]);
  const selected=new Map<number,Row>();
  for(let at=0;at<orderedIds.length;at+=100){check?.();const ids=orderedIds.slice(at,at+100).map(r=>num(r.id));for(const row of await querySyncPages(this.db,this.rowSelect()+' WHERE a.id IN ('+ids.map(()=>'?').join(',')+')',ids,100))selected.set(num(row.id),row);}
  const metadataRows=orderedIds.map(r=>{const row=selected.get(num(r.id));if(!row)throw Error('Local library changed during sync snapshot');return row;});
  const queries=urls?[SAVES.replace(' ORDER BY',` WHERE s.article_id IN (SELECT id FROM articles WHERE COALESCE(link,dedup_key) IN (${marks})) ORDER BY`),STATES.replace(' ORDER BY',` WHERE url IN (${marks}) ORDER BY`),DELETES.replace(' ORDER BY',` WHERE article_url IN (${marks}) ORDER BY`),SYNC_DELETES.replace(' ORDER BY',` WHERE url IN (${marks}) ORDER BY`)]:[SAVES,STATES,DELETES,SYNC_DELETES],data:Row[][]=[metadataRows];for(const q of queries)data.push(await querySyncPages(this.db,q,urls??[]));
  const bookIds=bookMode?new Set((await querySyncPages(this.db,'SELECT m.article_id FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE b.registration_complete=1'+(urls?' AND m.url IN ('+marks+')':'')+' ORDER BY m.article_id',urls??[])).map(r=>str(r.article_id))):new Set<string>();
  if(bookMode){data[2]=data[2]!.filter(r=>!bookIds.has(str(r.article_id)));data[4]=data[4]!.filter(r=>!bookIds.has(str(r.article_id)));}
  const [metadata,saves,persisted,deletions,syncDeletions]=data as [Row[],Row[],Row[],Row[],Row[]],rows=metadata.map(r=>({...r}));
  this.reencodedBodies.clear();
  if(this.reencodeStored&&this.encodingGeneration){
   const nativeStarted=Date.now(),ids=metadataRows.filter(r=>!this.cachedBody(r)&&!!this.cachedBody(r,true)).map(r=>num(r.id));
   for(let at=0;at<ids.length;at+=32){check?.();for(const body of await this.reencodeStored(ids.slice(at,at+32)))this.reencodedBodies.set(body.itemId,body);}
   this.report({stage:'snapshot.nativeBodies',articles:this.reencodedBodies.size,batches:Math.ceil(ids.length/32),elapsedMs:Date.now()-nativeStarted});
  }
  trace('snapshot.rows');
  const persistedByKey=new Map(persisted.map(row=>[str(row.article_id)+'\0'+str(row.save_type),row]));
  const byItem=new Map(rows.map(r=>[num(r.id),r]));
  const rowsBySource=new Map(rows.map(r=>[str(r.channel_url)+'\0'+str(r.dedup_key),r]));
  const sourceRows=new Map<string,Row|null>();
  let sourceIds:Map<string,number>|undefined;
  const sourceRow=async(channel:string,id:string):Promise<Row|undefined>=>{
   const key=channel+'\0'+id,known=sourceRows.get(key);
   if(known!==undefined)return known??undefined;
   let row=rowsBySource.get(key);
   if(!row&&!urls){
    // Negative source/identity probes dominate cancelled-save inventories.
    // One light index includes unsaved source rows outside the body scan.
    if(!sourceIds)sourceIds=new Map((await querySyncPages(this.db,'SELECT a.id,a.dedup_key,ch.url FROM articles a JOIN channels ch ON ch.id=a.channel_id ORDER BY a.id')).map(r=>[str(r.url)+'\0'+str(r.dedup_key),num(r.id)]));
    const item=sourceIds.get(key);if(item!==undefined)row=(await this.db.query(this.rowSelect()+' WHERE a.id=?',[item]))[0];
   }else if(!row)row=(await this.db.query(this.rowSelect()+` WHERE ch.url=? AND a.dedup_key=? LIMIT 1`,[channel,id]))[0];
   const result=row??null;
   sourceRows.set(key,result);if(row)byItem.set(num(row.id),row);
   return row;
  };
  const neededIds=new Set<number>([...saves.map(row=>num(row.article_id)),...persisted.filter(row=>row.item_id!=null).map(row=>num(row.item_id)),
   ...rows.filter(row=>str(row.channel_url)==='watchrss://phone-imports'||isImportedContentUrl(str(row.channel_url))).map(row=>num(row.id))]);
  const publicIdentities:CloudRssIdentity[]=[];for(const r of rows)if(neededIds.has(num(r.id))&&/^https?:\/\//i.test(str(r.channel_url))){await checkpoint();const identity=await this.cloudIdentity(r);if(identity)publicIdentities.push(identity);}const nativeCounts=new Map<string,Set<string>>();for(const r of publicIdentities){const ids=nativeCounts.get(r.url)??new Set<string>();ids.add(r.articleId);nativeCounts.set(r.url,ids);}const publicByItem=new Map(publicIdentities.map(r=>[r.itemId,r]));
  const ids=new Map<number,string>();for(const id of neededIds){await checkpoint();const row=byItem.get(id);if(row)ids.set(id,canonicalIds||(nativeCounts.get(publicByItem.get(id)?.url??'')?.size??0)>1?(publicByItem.get(num(row.id))??await this.cloudIdentity(row))?.articleId??(row.link==null&&row.bound_id?str(row.bound_id):await this.stableId(row.link==null?str(row.dedup_key):str(row.link))):(row.link==null&&row.bound_id?str(row.bound_id):await this.stableId(row.link==null?str(row.dedup_key):str(row.link))));}
  // A confirmed keep can arrive under the normalized URL ID after an older
  // reader journaled its deletion under another ID. Re-advertising that stale
  // alias as deleted makes the phone ask for the same decision on a full sync.
  // Only a verified receive receipt and a unique URL identity establish this
  // supersession; feed fetch clocks and ambiguous same-URL RSS items cannot.
  const durableKeeps=new Map((await querySyncPages(this.db,'SELECT a.alias_id AS article_id,k.url,k.changed_at FROM sync_article_keeps k JOIN sync_article_keep_aliases a ON a.canonical_id=k.article_id AND a.url=k.url WHERE 1=(SELECT count(*) FROM sync_article_keep_aliases b WHERE b.alias_id=a.alias_id AND b.url=a.url)'+(urls?' AND a.url IN ('+marks+')':'')+' ORDER BY a.alias_id',urls??[])).map(r=>[str(r.article_id)+'\0'+str(r.url),num(r.changed_at)]));
  const receipts=new Map<string,{ids:Set<string>;clock:number;pooled:boolean}>();
  for(const row of rows){const url=str(row.link),id=ids.get(num(row.id));if(!url||!id)continue;
   const receipt=receipts.get(url)??{ids:new Set<string>(),clock:0,pooled:false};receipt.ids.add(id);receipt.pooled||=publicByItem.get(num(row.id))?.canonicalBinding===true;
   if(str(row.received_state)&&str(row.local_encoded_body_hash)===str(row.encoded_body_hash)&&str(row.encoded_body_hash))receipt.clock=Math.max(receipt.clock,num(row.received_updated_at));
   receipt.clock=Math.max(receipt.clock,durableKeeps.get(id+'\0'+url)??0);
   receipts.set(url,receipt);
  }
  const supersededAliases=new Set<string>();
  for(const d of syncDeletions){await checkpoint();const receipt=receipts.get(str(d.url));if(receipt?.ids.size===1&&!receipt.ids.has(str(d.article_id))&&receipt.clock>num(d.changed_at)&&(receipt.pooled||receipt.ids.has(await this.stableId(str(d.url)))))supersededAliases.add(str(d.article_id));}
  trace('snapshot.identities');
  const states=new Map<string,State>();
  const put=(s:State)=>{const key=s.articleId+'\0'+s.type,old=states.get(key);if(!old||s.changedAt>old.changedAt||(s.changedAt===old.changedAt&&s.device>old.device))states.set(key,s);};
  for(const s of saves){if(num(s.saved))continue;const r=byItem.get(num(s.article_id));if(r)put({articleId:ids.get(num(s.article_id))!,type:str(s.save_type),url:str(r.link),saved:!!num(s.saved),changedAt:num(s.changed_at),sortOrder:-num(s.sort_order),device});}
  // Persisted clocks retain remote provenance; UI rows only seed missing state.
  for(const s of persisted){if(supersededAliases.has(str(s.article_id))&&num(s.changed_at)<(receipts.get(str(s.url))?.clock??0))continue;const id=s.item_id==null?str(s.article_id):ids.get(num(s.item_id))??str(s.article_id);states.set(id+'\0'+str(s.save_type),{articleId:id,type:str(s.save_type),url:str(s.url),saved:!!num(s.saved),changedAt:num(s.changed_at),sortOrder:num(s.sort_order),device:str(s.source_device_id),itemId:s.item_id==null?null:num(s.item_id)});}
  for(const d of syncDeletions)if(!supersededAliases.has(str(d.article_id)))put({articleId:str(d.article_id),type:'delete',url:str(d.url),saved:false,changedAt:num(d.changed_at),sortOrder:0,device:str(d.source_device_id)});
  for(const d of deletions){await checkpoint();const id=await this.stableId(str(d.article_url));for(const type of ['delete',...(num(d.was_favorite)?['favorite']:[]),...(num(d.was_watch_later)?['watchLater']:[])])put({articleId:id,type,url:str(d.article_url),saved:false,changedAt:num(d.changed_at),sortOrder:0,device});}
  const groups=new Map<string,Row[]>();
  for(const type of ['favorite','watchLater'])for(const s of saves){if(str(s.save_type)!==type||!num(s.saved)||!byItem.has(num(s.article_id)))continue;const id=ids.get(num(s.article_id))!,list=groups.get(id)??[];list.push(s);groups.set(id,list);}
  const out:PreparedArticle[]=[],active=new Set<string>(),usedRows=new Set<number>(),preparedRowIds=new Map<string,number>();
  for(const [id,entries] of groups){await checkpoint();let representative=entries[0]!;for(const s of entries)if(num(s.saved_at)>num(representative.saved_at))representative=s;
   const row=byItem.get(num(representative.article_id))!,favorite=entries.find(s=>s.save_type==='favorite'),later=entries.find(s=>s.save_type==='watchLater');usedRows.add(num(row.id));
   const f=states.get(id+'\0favorite'),l=states.get(id+'\0watchLater');
   let bodySource:Row|undefined;
   for(const type of ['favorite','watchLater']){const state=persistedByKey.get(id+'\0'+type);if(state?.item_id!=null)bodySource=byItem.get(num(state.item_id));if(bodySource)break;}
   if(!bodySource)bodySource=await sourceRow(str(row.channel_url),id);
   // Bound journal state governs relay flags across stale RSS aliases. Missing-
   // item tombstones keep native's separate saved-entry behavior.
   out.push(await this.prepareRow(row,id,device,{savedAt:num(representative.saved_at),favorite:f?.itemId!=null?f.saved:!!favorite,later:l?.itemId!=null?l.saved:!!later,favoriteChanged:f?.changedAt??num(favorite?.saved_at),favoriteOrder:f?.sortOrder??num(favorite?.saved_at),laterChanged:l?.changedAt??num(later?.saved_at),laterOrder:l?.sortOrder??num(later?.saved_at)},bodySource??row));this.bodySourceIds.set(id,num(bodySource?.id??row.id));preparedRowIds.set(id,num(row.id));active.add(id);
  }
  const imports:{row:Row;id:string}[]=[];
  const importRows=await orderImportedRows(rows,{yieldTurn:()=>this.db.query('SELECT 1'),check});
  for(const independent of [true,false])for(const row of importRows){const channel=str(row.channel_url);if(independent?channel!=='watchrss://phone-imports':!isImportedContentUrl(channel))continue;const id=ids.get(num(row.id))!;if(active.has(id))continue;
   this.bodySourceIds.set(id,num(row.id));preparedRowIds.set(id,num(row.id));usedRows.add(num(row.id));active.add(id);imports.push({row,id});
  }
  // Only small inline bodies share a bounded host-service window. Large or
  // external text remains serialized; preserve native article order exactly.
  for(let start=0;start<imports.length;){let end=start+1;
   const small=(r:Row)=>num(r.content_inline)===1&&num(r.description_inline)===1&&!num(r.has_original_chunks);
   if(small(imports[start]!.row))while(end<imports.length&&end-start<4&&small(imports[end]!.row))end++;
   await checkpoint(end-start);out.push(...await Promise.all(imports.slice(start,end).map(({row,id})=>this.prepareRow(row,id,device,undefined,row,{favorite:states.get(id+'\0favorite'),later:states.get(id+'\0watchLater')}))));start=end;
  }
  const tombstones=new Map<string,State[]>();for(const s of states.values()){if(s.saved||active.has(s.articleId))continue;const list=tombstones.get(s.articleId)??[];list.push(s);tombstones.set(s.articleId,list);}
  for(const [id,list] of tombstones){await checkpoint();const url=list[0]!.url;if(blank(url))continue;let latest=list[0]!;for(const s of list)if(s.changedAt>latest.changedAt)latest=s;const deleted=list.find(s=>s.type==='delete');const normalized=nativeTrim(url),host=nativeTrim(((await this.text.parseUri(normalized.startsWith('http://')||normalized.startsWith('https://')?normalized:'https://'+normalized)).host??'').replace(/^www\./,''));
   const article:ExportedArticle={articleId:id,sourceDeviceId:latest.device||device,url,title:url,siteName:host,excerpt:'',contentHtml:null,contentText:'',imageUrl:null,contentHash:await hashJavaText(url,this.codec),importedAt:Math.min(...list.map(s=>s.changedAt)),updatedAt:latest.changedAt,independentSaved:false,independentChangedAt:deleted?.changedAt??0,independentSortOrder:0,rssSourceUrl:null,rssSourceTitle:null,favoriteSaved:false,favoriteChangedAt:list.find(s=>s.type==='favorite')?.changedAt??0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:list.find(s=>s.type==='watchLater')?.changedAt??0,watchLaterSortOrder:0,deleted:!!deleted,deletedAt:deleted?.changedAt??0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false};out.push(await prepareArticle(article,this.codec));
  }
  const cacheUpdates:{row:Row;prepared:PreparedArticle;reencoded?:boolean}[]=[],repairJobs:{index:number;target:Row}[]=[];
  // Native repairs metadata through saved-state item bindings before falling
  // back to source-channel/dedup identity; the resolved body can differ from
  // the saved-entry representative when one URL exists in several feeds.
  for(let i=0;i<out.length;i++){
   await checkpoint();const current=out[i]!,a=current.article;if(a.deleted||!current.manifest.bodyAvailable)continue;
   let target:Row|undefined;
   for(const type of ['favorite','watchLater']){const state=persistedByKey.get(a.articleId+'\0'+type);if(state?.item_id!=null)target=byItem.get(num(state.item_id));if(target)break;}
   const localImport=!!a.rssSourceUrl?.toLowerCase().startsWith('https://watchrss.local/import-');
   if(!target&&localImport){
    // Imported chapter dedup keys need not equal the hashed sync ID. A native
    // body hash keeps contentHash stable when this derived cache is published.
    const itemId=this.bodySourceIds.get(a.articleId),candidate=itemId===undefined?undefined:byItem.get(itemId);
    if(candidate)target=candidate;
   }
   if(!target)target=await sourceRow(a.rssSourceUrl??'watchrss://phone-imports',a.articleId);
   if(target){const sameBodySource=this.bodySourceIds.get(a.articleId)===num(target.id);this.bodySourceIds.set(a.articleId,num(target.id));const cached=this.cachedBody(target)??this.reusableBody(target);
    // prepareRow already hashed this exact cached source. Rehashing every
    // chapter here costs a second host SHA-256 round trip per manifest entry.
    if(cached){if(!(sameBodySource&&current.encodedBody===null&&current.manifest.bodyHash===cached.bodyHash))out[i]=await prepareCachedArticle({...a,contentHtml:null,contentText:''},this.codec,cached);}
    else if(sameBodySource&&current.encodedBody){if(!localImport||str(target.native_body_hash))cacheUpdates.push({row:target,prepared:current});}
    else repairJobs.push({index:i,target});}
  }
  if(this.reencodeStored&&this.encodingGeneration&&repairJobs.length){
   const ids=[...new Set(repairJobs.filter(j=>!!this.cachedBody(j.target,true)).map(j=>num(j.target.id)))],native=new Map<number,ReencodedBody>();
   for(let at=0;at<ids.length;at+=32){check?.();for(const body of await this.reencodeStored(ids.slice(at,at+32)))native.set(body.itemId,body);}
   for(let i=repairJobs.length-1;i>=0;i--){const job=repairJobs[i]!,body=native.get(num(job.target.id));if(!body)continue;
    out[job.index]=await prepareCachedArticle({...out[job.index]!.article,contentHtml:null,contentText:''},this.codec,body);
    cacheUpdates.push({row:job.target,prepared:out[job.index]!,reencoded:true});repairJobs.splice(i,1);
   }
   this.report({stage:'snapshot.nativeBodies',articles:native.size});
  }
  // Resolve identities first, then overlap small, independent host codec jobs.
  // Preserve publication order even when workers complete out of order. Large
  // originals remain serialized under a 256 KiB decoded-input window.
  for(let at=0;at<repairJobs.length;){
   let end=at,total=0;
   while(end<repairJobs.length&&end-at<4){const size=Math.max(1,num(repairJobs[end]!.target.cached_content_bytes)||512*1024);if(end>at&&total+size>256*1024)break;total+=size;end++;}
   const updates=await Promise.all(repairJobs.slice(at,end).map(async({index,target})=>{const actual=await this.bodyForReencode(target),a=out[index]!.article;out[index]=await prepareArticle({...a,contentHtml:actual.contentHtml,contentText:actual.contentText},this.codecForRow(target),actual.available);return actual.available?{row:target,prepared:out[index]!}:undefined;}));
   for(const update of updates)if(update)cacheUpdates.push(update);await checkpoint(end-at);at=end;
  }
  const queued=new Set(cacheUpdates.map(u=>num(u.row.id)));
  for(const prepared of out){const item=this.bodySourceIds.get(prepared.article.articleId);if(item===undefined||!this.reencodedBodies.has(item)||queued.has(item))continue;const row=byItem.get(item);if(row){cacheUpdates.push({row,prepared,reencoded:true});queued.add(item);}}
  trace('snapshot.manifests');
  // Source tables and identity have revision triggers. Cache tables are
  // deliberately excluded because publishing a derived body cache must not
  // invalidate the library snapshot. Recheck only cache rows used by this
  // manifest; the old full-library reread doubled host SQL bridge work.
  for(const p of out){const id=this.bodySourceIds.get(p.article.articleId);if(id!==undefined)usedRows.add(id);}
  const cacheIds=[...usedRows].sort((a,b)=>a-b);
  for(let offset=0;offset<cacheIds.length;offset+=100){
   const part=cacheIds.slice(offset,offset+100),marks=part.map(()=>'?').join(',');
   const current=await querySyncPages(this.db,`SELECT a.id,COALESCE(NULLIF(c.body_hash,''),n.body_hash,'') AS cached_body_hash,
    c.body_hash AS encoded_body_hash,c.content_bytes AS cached_content_bytes,c.body_bytes,c.chunk_size,c.chunk_hashes,e.body_hash AS local_encoded_body_hash
    FROM articles a LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash
    LEFT JOIN article_native_sync_hash n ON n.item_id=a.id WHERE a.id IN (${marks}) ORDER BY a.id`,part,50);
   if(current.length!==part.length)throw new Error('Local library changed during sync snapshot');
   for(const now of current){const before=byItem.get(num(now.id));
    if(!before||['cached_body_hash','encoded_body_hash','body_bytes','chunk_size','chunk_hashes','local_encoded_body_hash'].some(key=>now[key]!==before[key]))
     throw new Error('Local library changed during sync snapshot');
   }
  }
  if(await libraryRevision(this.db)!==revision)throw new Error("Local library changed during sync snapshot");
  for(let at=0;at<cacheUpdates.length;at+=100){const statements:{sql:string;params?:SqlParams}[]=[];for(const update of cacheUpdates.slice(at,at+100)){await checkpoint();statements.push(...await this.cacheMetadataStatements(update.row,update.prepared,update.reencoded));}await this.db.transaction([...(this.encodingGeneration?[projectionGuard(this.encodingGeneration)]:[]),revisionGuard(revision),...statements]);}
  trace('snapshot.complete');
  return out;
  }finally{try{await this.flushStableProgress();}finally{this.preparationRevision=previousPreparation;this.cacheRows=previousCacheRows;this.reencodedBodies.clear();this.db=originalDb;this.codec=originalCodec;this.text=originalText;}}
 }
 restoreReusableBodies(rows:readonly {prepared:PreparedArticle;sourceItem:number}[],complete?:((p:PreparedArticle)=>Promise<PreparedArticle>)){this.completeReusable=complete;this.reusableBodies=new Map(rows.filter(r=>r.sourceItem>0&&r.prepared.manifest.bodyAvailable).map(r=>[r.sourceItem,r.prepared]));}
 private reusableBody(row:Row):CachedBodyManifest|null{const p=this.reusableBodies.get(num(row.id));return p?{bodyHash:p.manifest.bodyHash,bodyByteCount:p.manifest.bodyByteCount,chunkSize:p.manifest.chunkSize,chunkHashes:[...p.manifest.chunkHashes]}:null;}
 projectionBindings(){return new Map(this.bodySourceIds);}
 restoreProjectionBindings(bindings:ReadonlyMap<string,number>){this.bodySourceIds=new Map([...bindings].filter(([,id])=>id>0));}
 async materializeRequested(prepared:PreparedArticle,prefetched?:Row):Promise<PreparedArticle>{
  if(prepared.encodedBody||!prepared.manifest.bodyAvailable)return prepared;
  const itemId=this.bodySourceIds.get(prepared.article.articleId);if(itemId===undefined)throw new Error('Cached sync body source is missing');
  const row=prefetched??(await this.db.query(this.rowSelect()+' WHERE a.id=?',[itemId]))[0];if(!row)throw new Error('Cached sync body source disappeared');
  let body:{available:boolean;contentHtml:string|null;contentText:string};
  if(this.cachedBody(row)?.bodyHash===prepared.manifest.bodyHash){
   // This cache was produced by local encoding, and body edits invalidate it.
   // Reuse its hydrated body rather than extracting/Jsoup-parsing every live
   // article a second time. Re-encoding and all manifest/hash checks still run.
   const cached=await this.readCachedBody(row);if(!cached)throw new Error('Cached sync body source disappeared');
   body={available:true,...cached};
  }else{await this.hydrateRow(row);body=await this.bodyFromRow(row);}
  if(!body.available)throw new Error('Cached sync body file is unavailable');
  const actual=await prepareArticle({...prepared.article,contentHtml:body.contentHtml,contentText:body.contentText},{...this.codec,encode:async body=>{const bytes=await this.codec.encode(body);return await matchGzipHash(bytes,prepared.manifest.bodyHash,this.codec.sha256)??bytes;}},true);
  actual.manifest.deleted=prepared.manifest.deleted;
  if(JSON.stringify(actual.manifest)!==JSON.stringify(prepared.manifest)){
   const changed=Object.keys(prepared.manifest).filter(key=>JSON.stringify((prepared.manifest as unknown as Record<string,unknown>)[key])!==JSON.stringify((actual.manifest as unknown as Record<string,unknown>)[key]));
   throw new Error('Cached sync body changed during export: '+changed.join(','));
  }
  return actual;
 }
 private async readCachedBody(row:Row,allowOlderEncoding=false):Promise<{contentHtml:string|null;contentText:string}|null>{
  if(!this.cachedBody(row,allowOlderEncoding))return null;
  const html=num(row.cache_inline_html)===1?nullable(row.cache_html):await readSyncSqlText(this.db,'SELECT content_html AS value FROM article_sync_content WHERE item_id=?',[row.id as number]);
  const text=typeof row.cache_text==='string'?row.cache_text:await readSyncSqlText(this.db,'SELECT content_text AS value FROM article_sync_content WHERE item_id=?',[row.id as number]);
  if(text===null)return null;
  return {contentHtml:html===null?null:await this.files.hydrate(html),contentText:await this.files.hydrate(text)};
 }
 async materializeRequestedBatch(prepared:readonly PreparedArticle[]):Promise<PreparedArticle[]> {
  if(prepared.length>32)throw new Error('Requested materialization batch too large');
  const ids=[...new Set(prepared.filter(p=>!p.encodedBody&&p.manifest.bodyAvailable).map(p=>{
   const id=this.bodySourceIds.get(p.article.articleId);if(id===undefined)throw new Error('Cached sync body source is missing');return id;
  }))];
  const select=this.rowSelect().replaceAll('CAST(c.content_html AS BLOB))<=256','CAST(c.content_html AS BLOB))<=8192').replaceAll('CAST(c.content_text AS BLOB))<=256','CAST(c.content_text AS BLOB))<=8192');
  const rows=ids.length?await querySyncPages(this.db,select+` WHERE a.id IN (${ids.map(()=>'?').join(',')})`,ids,16):[];
  const byId=new Map(rows.map(r=>[num(r.id),r]));const out:PreparedArticle[]=[];
  for(let start=0;start<prepared.length;){
   let end=start,bytes=0;
   while(end<prepared.length&&end-start<4){const p=prepared[end]!,row=byId.get(this.bodySourceIds.get(p.article.articleId)!);const size=row?Math.max(1,num(row.cached_content_bytes)):512*1024;
    if(end>start&&bytes+size>512*1024)break;bytes+=size;end++;
   }
   out.push(...await Promise.all(prepared.slice(start,end).map(p=>this.materializeRequested(p,byId.get(this.bodySourceIds.get(p.article.articleId)!)))));start=end;
  }return out;
 }
 private cachedBody(row:Row,allowOlderEncoding=false):CachedBodyManifest|null{
  if(!allowOlderEncoding&&this.reencodedBodies.has(num(row.id)))return this.reencodedBodies.get(num(row.id))!;
  if(!allowOlderEncoding&&this.encodingGeneration&&row.body_generation!==this.encodingGeneration)return null;
  const bodyHash=str(row.encoded_body_hash),bodyByteCount=num(row.body_bytes),chunkSize=num(row.chunk_size);
  if(!bodyHash||str(row.local_encoded_body_hash)!==bodyHash)return null;
  if(!/^[0-9a-f]{64}$/.test(bodyHash)||!Number.isSafeInteger(bodyByteCount)||bodyByteCount<=0||chunkSize!==128*1024)return null;
  try{const chunkHashes=JSON.parse(str(row.chunk_hashes));
   if(Array.isArray(chunkHashes)&&chunkHashes.length===Math.max(1,Math.ceil(bodyByteCount/chunkSize))&&chunkHashes.every(hash=>typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)))return {bodyHash,bodyByteCount,chunkSize,chunkHashes};
  }catch{}
  return null;
 }
 private async hydrateRow(r:Row):Promise<void>{
  if(r.body_hydrated)return;
  r.content=num(r.content_inline)===1?nullable(r.content):await readSyncSqlText(this.db,'SELECT content AS value FROM articles WHERE id=?',[r.id]);
  r.description=num(r.description_inline)===1?nullable(r.description):await readSyncSqlText(this.db,'SELECT description AS value FROM articles WHERE id=?',[r.id]);
  const chunks=async(table:'article_body_chunks'|'article_original_chunks')=>{
   const indexes=await querySyncPages(this.db,`SELECT chunk_index FROM ${table} WHERE article_id=? ORDER BY chunk_index`,[r.id]);
   if(!indexes.length)return null;const parts:string[]=[];
   for(const index of indexes){const value=await readSyncSqlText(this.db,`SELECT body AS value FROM ${table} WHERE article_id=? AND chunk_index=?`,[r.id,index.chunk_index]);if(value===null)throw new Error('Sync body chunk disappeared');parts.push(value);}
   return parts.join('');
  };
  r.actual_content=r.content??await chunks('article_body_chunks');
  r.original_content=num(r.has_original_chunks)?await chunks('article_original_chunks'):null;
  r.body_hydrated=true;
 }
 private async cacheMetadataStatements(r:Row,p:PreparedArticle,reencoded=false):Promise<{sql:string;params?:SqlParams}[]>{
  const generation=this.encodingGeneration;
  const a=p.article,m=p.manifest,old=this.cachedBody(r,true);
  if(old&&old.bodyHash===m.bodyHash&&old.bodyByteCount===m.bodyByteCount&&old.chunkSize===m.chunkSize&&JSON.stringify(old.chunkHashes)===JSON.stringify(m.chunkHashes))return generation?[{sql:'INSERT OR REPLACE INTO sync_fast_encoded_cache(item_id,generation,body_hash) VALUES(?,?,?)',params:[r.id,generation,m.bodyHash]}]:[];
  if(reencoded)return [
   {sql:'UPDATE article_sync_content SET body_hash=?,body_bytes=?,chunk_size=?,chunk_hashes=? WHERE item_id=?',params:[m.bodyHash,m.bodyByteCount,m.chunkSize,JSON.stringify(m.chunkHashes),r.id]},
   {sql:'UPDATE article_sync_encoding_cache SET body_hash=? WHERE item_id=?',params:[m.bodyHash,r.id]},
   ...(generation?[{sql:'INSERT OR REPLACE INTO sync_fast_encoded_cache(item_id,generation,body_hash) VALUES(?,?,?)',params:[r.id,generation,m.bodyHash]}]:[]),
  ];
  const store=async(v:string|null,key:string)=>v===null||v.length<=50000?v:this.files.storeText(key,v);
  const html=await store(a.contentHtml,a.articleId+'-export-html'),text=await store(a.contentText,a.articleId+'-export-text');
  let contentBytes=0;for(const bytes of javaUtf8Chunks(a.contentHtml??a.contentText))contentBytes+=bytes.length;
  // Conditional publication cannot overwrite a body changed while filesystem
  // work was in progress. Reading/saved state are not modified here.
  return [{sql:`INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes)
   SELECT a.id,?,?,?,?,?,?,? FROM articles a WHERE a.id=?
   ON CONFLICT(item_id) DO UPDATE SET content_html=excluded.content_html,content_text=excluded.content_text,body_hash=excluded.body_hash,body_bytes=excluded.body_bytes,chunk_size=excluded.chunk_size,chunk_hashes=excluded.chunk_hashes,content_bytes=excluded.content_bytes`,params:[html,text,m.bodyHash,m.bodyByteCount,m.chunkSize,JSON.stringify(m.chunkHashes),contentBytes,r.id]},
   {sql:`INSERT INTO article_sync_encoding_cache(item_id,body_hash) SELECT item_id,body_hash FROM article_sync_content WHERE item_id=? ON CONFLICT(item_id) DO UPDATE SET content_hash=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN content_hash ELSE NULL END,source_device_id=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN source_device_id ELSE NULL END,updated_at=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN updated_at ELSE NULL END,imported_at=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN imported_at ELSE NULL END,metadata_state=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN metadata_state ELSE NULL END,site_name=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN site_name ELSE NULL END,rss_source_title=CASE WHEN body_hash=excluded.body_hash OR ?=1 THEN rss_source_title ELSE NULL END,body_hash=excluded.body_hash`,params:[r.id,...Array(7).fill(p.article.bodySourceDeviceId?1:0)]},...(generation?[{sql:'INSERT OR REPLACE INTO sync_fast_encoded_cache(item_id,generation,body_hash) VALUES(?,?,?)',params:[r.id,generation,m.bodyHash]}]:[])];
 }

 /** Rebuild the current encoder from owned logical wire content. Body edits
  * invalidate article_sync_content through source triggers; a generation change
  * invalidates only its encoded projection, not the accepted original. */
 private async bodyForReencode(row:Row){
  const accepted=await this.readCachedBody(row,true);
  if(accepted)return {available:true,...accepted};
  await this.hydrateRow(row);return this.bodyFromRow(row);
 }
 private codecForRow(row:Row):SyncBodyCodec {
  const expected=this.cachedBody(row,true)?.bodyHash;
  return !expected?this.codec:{...this.codec,encode:async body=>{const bytes=await this.codec.encode(body);return await matchGzipHash(bytes,expected,this.codec.sha256)??bytes;}};
 }
 private async bodyFromRow(r:Row){
  let available=true,content=nullable(r.actual_content),original=nullable(r.original_content);
  const hydrated=new Map<string,string>();for(const value of [content,original])if(value!==null&&!hydrated.has(value)){try{hydrated.set(value,await this.files.hydrate(value));}catch{available=false;}}
  if(content!==null)content=hydrated.get(content)??content;if(original!==null)original=hydrated.get(original)??original;
  const body=!blank(original)?original!:!blank(content)?content!:!blank(nullable(r.description))?str(r.description):'';
  const html=/<\s*\/?\s*(html|head|body|article|section|main|div|p|br|h[1-6]|ul|ol|li|span|table|blockquote|pre|code)\b/i.test(body.slice(0,4096));
  const contentHtml=available&&html?body:null,contentText=!available?'':html?await this.text.htmlText(body):body;
  return {available,contentHtml,contentText};
 }

 private async prepareRow(r:Row,id:string,device:string,saved?:{savedAt:number;favorite:boolean;later:boolean;favoriteChanged:number;favoriteOrder:number;laterChanged:number;laterOrder:number},bodySource:Row=r,clocks?:{favorite?:State;later?:State}):Promise<PreparedArticle>{
  // Row fields cover metadata/inline text, and chunk_revision covers external
  // chunk mutations. Reuse body work across a one-article edit or source merge.
  if(!this.cacheRows)return this.buildRow(r,id,device,saved,bodySource,clocks);
  const reusable=await this.reusableMetadata(num(bodySource.id)),metadata=await this.reusableMetadata(num(r.id));
  const {cache_html:_html,cache_text:_text,...metadataRow}=r,{cache_html:_sourceHtml,cache_text:_sourceText,...sourceMetadata}=bodySource;
  const key=id+'\0'+str(r.id),stamp=await hashJavaText(JSON.stringify([metadataRow,id,device,saved,bodySource===r?null:sourceMetadata,clocks,reusable?[reusable.manifest.bodyHash,reusable.manifest.bodyByteCount,reusable.manifest.chunkHashes]:null,metadata?.article.contentHash??null]),this.codec);
  const previous=this.rowCache.get(key);if(previous?.stamp===stamp)return previous.prepared;
  const prepared=await this.buildRow(r,id,device,saved,bodySource,clocks);
  const bytes=128+(prepared.encodedBody?.length??0)+2*(prepared.article.contentText.length+(prepared.article.contentHtml?.length??0));
  if(previous){this.rowCacheBytes-=previous.bytes;this.rowCache.delete(key);}
  if(bytes<=32*1024*1024){
   while(this.rowCacheBytes+bytes>32*1024*1024||this.rowCache.size>=8192){const oldest=this.rowCache.keys().next().value!;this.rowCacheBytes-=this.rowCache.get(oldest)!.bytes;this.rowCache.delete(oldest);}
   this.rowCache.set(key,{stamp,prepared,bytes});this.rowCacheBytes+=bytes;
  }
  return prepared;
 }
 private async buildRow(r:Row,id:string,device:string,saved?:{savedAt:number;favorite:boolean;later:boolean;favoriteChanged:number;favoriteOrder:number;laterChanged:number;laterOrder:number},bodySource:Row=r,clocks?:{favorite?:State;later?:State}):Promise<PreparedArticle>{
  const persisted=await this.reusableMetadata(num(r.id)),cached=(blank(str(r.cached_body_hash))?null:this.cachedBody(bodySource))??this.reusableBody(bodySource);
  if(cached){if(r.summary==null)r.description=num(r.description_inline)===1?nullable(r.description):persisted?persisted.article.excerpt:await readSyncSqlText(this.db,'SELECT description AS value FROM articles WHERE id=?',[r.id]);}
  const {available,contentHtml,contentText}=cached?{available:true,contentHtml:null,contentText:''}:await this.bodyForReencode(bodySource);
  if(!cached&&r.summary==null)r.description=num(r.description_inline)===1?nullable(r.description):await readSyncSqlText(this.db,'SELECT description AS value FROM articles WHERE id=?',[r.id]);
  const channel=str(r.channel_url),independent=channel==='watchrss://phone-imports',source=saved?(/^https?:\/\//i.test(nativeTrim(channel))?channel:null):independent?null:channel;
  const url=r.link==null&&r.bound_id?str(r.bound_url):saved?str(r.link):blank(nullable(r.link))?str(r.dedup_key):str(r.link),imported=saved?.savedAt??num(r.fetched_at);
  let article:ExportedArticle={articleId:id,sourceDeviceId:device,url,title:saved?str(r.title):blank(str(r.title))?url:str(r.title),siteName:str(r.channel_title),excerpt:r.summary==null?str(r.description):str(r.summary),contentHtml,contentText,imageUrl:nullable(r.preview_image??r.image_url),contentHash:blank(str(r.cached_body_hash))?(persisted?.article.contentHash??await hashJavaText(!available?url:contentHtml??(blank(contentText)?url:contentText),this.codec)):str(r.cached_body_hash),importedAt:imported,updatedAt:saved?Math.max(num(r.fetched_at),imported,saved.favoriteChanged,saved.laterChanged):num(r.fetched_at),independentSaved:independent,independentChangedAt:independent?imported:0,independentSortOrder:independent?imported:0,rssSourceUrl:source,rssSourceTitle:source===null?null:str(r.channel_title),favoriteSaved:saved?.favorite??false,favoriteChangedAt:saved?.favoriteChanged??clocks?.favorite?.changedAt??0,favoriteSortOrder:saved?.favoriteOrder??clocks?.favorite?.sortOrder??0,watchLaterSaved:saved?.later??false,watchLaterChangedAt:saved?.laterChanged??clocks?.later?.changedAt??0,watchLaterSortOrder:saved?.laterOrder??clocks?.later?.sortOrder??0,deleted:false,deletedAt:0,readingProgress:Math.fround(num(r.progress??r.reading_progress)),readingPositionBytes:num(r.position_bytes),readingPositionContentHash:str(r.position_hash),readingPositionChangedAt:num(r.position_changed_at),isRead:!!num(r.is_read)};
  // Encoding/hash algorithm upgrades may change bytes without changing the
  // owned body. Preserve received origin/clocks only after comparing hydrated
  // logical content; metadata/reading differences still use existing clocks.
  let verifiedOrigin=!!cached||!!this.cachedBody(bodySource,true);
  if(!cached&&r.received_state&&r.local_encoded_body_hash===r.encoded_body_hash){
   const html=await readSyncSqlText(this.db,'SELECT content_html AS value FROM article_sync_content WHERE item_id=?',[r.id]);
   const oldHtml=html===null?null:await this.files.hydrate(html);
   if(contentHtml!==null)verifiedOrigin=contentHtml===oldHtml;
   else if(oldHtml===null){const text=await readSyncSqlText(this.db,'SELECT content_text AS value FROM article_sync_content WHERE item_id=?',[r.id]);verifiedOrigin=text!==null&&contentText===await this.files.hydrate(text);}
  }
  const receivedMatches=verifiedOrigin&&r.received_state&&articleState(article)===str(r.received_state);
  if(verifiedOrigin&&r.received_state)article={...article,bodySourceDeviceId:str(r.received_source)||device,importedAt:num(r.received_imported_at),siteName:str(r.received_site_name),rssSourceTitle:nullable(r.received_source_title)};
  if(receivedMatches)article={...article,sourceDeviceId:str(r.received_source)||device,updatedAt:num(r.received_updated_at),importedAt:num(r.received_imported_at),contentHash:str(r.received_content_hash)||article.contentHash,siteName:str(r.received_site_name),rssSourceTitle:nullable(r.received_source_title)};
  else if(r.received_state)article={...article,updatedAt:Math.max(article.updatedAt,num(r.received_updated_at)+1,article.readingPositionChangedAt)};
  if(str(r.native_reading_source))article.sourceDeviceId=str(r.native_reading_source);
  const prepared=await (cached?prepareCachedArticle(article,this.codec,cached):prepareArticle(article,this.codecForRow(bodySource),available));
  // A verified body is an independently durable derived unit. Keep the same
  // generation/source revision guards used by the final snapshot publication.
  if(this.cloudProgress&&this.preparationRevision!==undefined&&this.encodingGeneration&&prepared.encodedBody&&r.id===bodySource.id&&prepared.manifest.bodyAvailable){
   const revision=this.preparationRevision,statements=await this.cacheMetadataStatements(bodySource,prepared),bodyWrite=statements.some(s=>s.sql.includes('article_sync_content'));
   await this.db.transaction([projectionGuard(this.encodingGeneration),revisionGuard(revision),...statements]);
   if(bodyWrite){const m=prepared.manifest;Object.assign(bodySource,{cached_body_hash:m.bodyHash,encoded_body_hash:m.bodyHash,body_bytes:m.bodyByteCount,chunk_size:m.chunkSize,chunk_hashes:JSON.stringify(m.chunkHashes),local_encoded_body_hash:m.bodyHash});}
   bodySource.body_generation=this.encodingGeneration;await this.commitPreparation('body:'+this.encodingGeneration+':'+bodySource.id+':'+prepared.manifest.bodyHash);
   prepared.encodedBody=null;prepared.article={...prepared.article,contentHtml:null,contentText:''};
  }
  return prepared;
 }
}
