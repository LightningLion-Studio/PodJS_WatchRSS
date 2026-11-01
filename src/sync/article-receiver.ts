import {ArticleKeepStore} from './article-keep';
import {articleState} from './article-provenance';
import {projectionGuard} from './domain-definitions';
import {onlyChangedSql} from '@podjs/framework/sql-changes';
import {readSyncSqlText} from "./sql-text.ts";
import type {SqlDatabase,SqlParams} from "../core/types.ts";
import {isImportedContentUrl} from "../core/imported-content.ts";
import {javaUtf8Chunks} from "../reader/imported-text-writer.ts";
import {SyncSavedStateStore,deviceOrder,type RemoteSavedState} from "./saved-state.ts";
import {libraryRevision,revisionGuard} from './revision';
import {rebuildArticleBody,requireMetadataOnlyBody,type SyncArticleBody,type SyncBodyPayload,type SyncBodyCodec} from "./article-body.ts";

export interface IncomingArticle {
 articleId:string;sourceDeviceId:string;url:string;title:string;siteName:string;excerpt:string;imageUrl:string|null;
 importedAt:number;updatedAt:number;rssSourceUrl:string|null;rssSourceTitle:string|null;
 favoriteSaved:boolean;favoriteChangedAt:number;favoriteSortOrder:number;
 watchLaterSaved:boolean;watchLaterChangedAt:number;watchLaterSortOrder:number;
 readingProgress:number;readingPositionBytes:number;readingPositionContentHash:string;readingPositionChangedAt:number;isRead:boolean;
 deleted:boolean;
}
import type {FileCheckpoint} from '@podjs/framework/work-window';
export interface ArticleReceiveFiles {
 storeText(key:string,text:string,checkpoint?:FileCheckpoint):Promise<string>;
 hydrate(text:string):Promise<string>;
}
export interface LocalReceiveBody {itemId:number;body:SyncArticleBody|null;available:boolean;hasStoredBody:boolean}
export type LocalBodyResolver=(article:IncomingArticle,targetItemId?:number)=>Promise<LocalReceiveBody|null>;
type Statement={sql:string;params?:SqlParams};
const nonblank=(text:string)=>/[^\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(text);
function byteLength(text:string){let count=0;for(const bytes of javaUtf8Chunks(text))count+=bytes.length;return count;}

/** Receives one manifest-selected, nondeleted article. All bytes are verified
 * and durable before the article, reading position and saved states commit.
 * No transport ACK or deletion handling is implied by this entry point. */
export class SyncArticleReceiver {
 private readonly saved:SyncSavedStateStore;private readonly keeps:ArticleKeepStore;
 constructor(private readonly db:SqlDatabase,private readonly codec:SyncBodyCodec,private readonly files:ArticleReceiveFiles,
  private readonly migrateReading:(id:number)=>Promise<void>,private readonly now=Date.now,private readonly resolveLocal?:LocalBodyResolver,private readonly encodingGeneration?:()=>string|undefined,private readonly timing?:(stage:string,ms:number)=>void){this.saved=new SyncSavedStateStore(db);this.keeps=new ArticleKeepStore(db);}
 async receive(article:IncomingArticle,payload:SyncBodyPayload,remoteDeviceId:string,authoritative=false):Promise<void>{await this.apply(article,payload,remoteDeviceId,authoritative,false);}
 async receiveWithStats(article:IncomingArticle,payload:SyncBodyPayload,remoteDeviceId:string,authoritative=false,targetItemId?:number,verifiedTarget=false):Promise<number>{
  if(!this.db.transactionChanges)throw new Error("Counted article receive requires transactionChanges");
  return this.apply(article,payload,remoteDeviceId,authoritative,true,targetItemId,verifiedTarget);
 }
 private async apply(article:IncomingArticle,payload:SyncBodyPayload,remoteDeviceId:string,authoritative:boolean,counted:boolean,targetItemId?:number,verifiedTarget=false):Promise<number>{
  let mark=globalThis.performance?.now?.()??Date.now();const phase=(label:string)=>{const next=globalThis.performance?.now?.()??Date.now();this.timing?.(label,next-mark);mark=next;};
  await this.keeps.initialize();const generation=this.encodingGeneration?.();
  if(article.deleted)throw new Error("Deleted article requires the deletion coordinator");
  if(article.articleId!==payload.articleId)throw new Error("Article/body identity mismatch");
  for(const field of ["importedAt","updatedAt","favoriteChangedAt","favoriteSortOrder","watchLaterChangedAt","watchLaterSortOrder","readingPositionBytes","readingPositionChangedAt"] as const){if(!Number.isSafeInteger(article[field]))throw new Error(`Invalid ${field}`);}
  if(!Number.isFinite(article.readingProgress))throw new Error("Invalid reading progress");
  if(!(await this.db.query("SELECT device_id FROM sync_local_identity WHERE id=1")).length)throw new Error("Initialize sync identity first");
  const source=article.rssSourceUrl&&/^https?:\/\//i.test(article.rssSourceUrl.trim())?article.rssSourceUrl:null;
  const channelUrl=source??"watchrss://phone-imports",imported=isImportedContentUrl(channelUrl);
  // A schema migration may have folded the SHA materialization into its RSS
  // row. Reuse only that durable binding in the same source and at the same URL.
  // Only the local cloud coordinator can pass a verified target; transport callers cannot.
  const target=targetItemId&&(verifiedTarget||remoteDeviceId==='cloud-records'||remoteDeviceId==='cloud-rss-inventory'||remoteDeviceId.startsWith('cloud-'))?(await this.db.query('SELECT a.* FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id=? AND c.url=?',[targetItemId,channelUrl]))[0]:undefined;
  const existing=target??(await this.db.query(`SELECT a.* FROM articles a JOIN channels ch ON ch.id=a.channel_id
   WHERE ch.url=? AND (a.dedup_key=? OR ((a.link=? OR (a.link IS NULL AND EXISTS(SELECT 1 FROM sync_article_ids m WHERE m.item_id=a.id AND m.article_id=? AND m.url=?))) AND
    (a.dedup_key LIKE 'guid:%' OR a.dedup_key LIKE 'link:%' OR a.dedup_key LIKE 'title:%') AND
    EXISTS(SELECT 1 FROM sync_article_ids m WHERE m.item_id=a.id AND m.article_id=?)))
   ORDER BY CASE WHEN a.dedup_key=? THEN 0 ELSE 1 END,a.id LIMIT 1`,[channelUrl,article.articleId,article.url,article.articleId,article.url,article.articleId,article.articleId]))[0];
  const dedupKey=existing?String(existing.dedup_key):article.articleId;
  let local:SyncArticleBody|null=null,available=false,storedBody=false;
  if(this.resolveLocal){const resolved=await this.resolveLocal(article,target?Number(target.id):undefined);local=resolved?.body??null;available=resolved?.available??false;storedBody=resolved?.hasStoredBody??false;}
  else if(existing){
   try{const cachedText=await readSyncSqlText(this.db,'SELECT content_text AS value FROM article_sync_content WHERE item_id=?',[existing.id]);
    if(cachedText!==null){const cachedHtml=await readSyncSqlText(this.db,'SELECT content_html AS value FROM article_sync_content WHERE item_id=?',[existing.id]);local={contentHtml:cachedHtml===null?null:await this.files.hydrate(cachedHtml),contentText:await this.files.hydrate(cachedText)};available=true;storedBody=nonblank(local.contentHtml??"")||nonblank(local.contentText);}}
   catch{if(payload.metadataOnly)throw new Error("Metadata-only local body unavailable");}
  }
  phase('receive.lookup');
  const body=payload.metadataOnly?await requireMetadataOnlyBody(payload,local,available,storedBody,this.codec):await rebuildArticleBody(payload,local,this.codec);
  phase('receive.rebuild');
  const hasBody=nonblank(body.contentHtml??"")||nonblank(body.contentText),chosen=nonblank(body.contentHtml??"")?body.contentHtml!:nonblank(body.contentText)?body.contentText:nonblank(article.excerpt)?article.excerpt:null;
  // Publishing content-addressed files cannot damage an old DB reference. A
  // failed transaction may leave an unreferenced file for later GC.
  const cache=new Map<string,string>();
  if(body===local&&existing&&[chosen,body.contentHtml,body.contentText].some(value=>value!==null&&value.length>50000)){
   // Reuse committed file references for an identical verified body as well as
   // avoiding SQLite writes; a full legacy replay must not rewrite its files.
   const values=[existing.content,await readSyncSqlText(this.db,'SELECT content_html AS value FROM article_sync_content WHERE item_id=?',[existing.id]),await readSyncSqlText(this.db,'SELECT content_text AS value FROM article_sync_content WHERE item_id=?',[existing.id])];
   for(const raw of values)if(typeof raw==='string'){try{const value=await this.files.hydrate(raw);if(value.length>50000)cache.set(value,raw);}catch{}}
  }
  const store=async(text:string|null,key:string):Promise<string|null>=>{if(text===null||text.length<=50000)return text;let marker=cache.get(text);if(!marker){marker=await this.files.storeText(key,text);cache.set(text,marker);}return marker;};
  const stored=await store(chosen,`${article.articleId}-content`),html=await store(body.contentHtml,`${article.articleId}-html`),text=(await store(body.contentText,`${article.articleId}-text`))!;
  phase('receive.store');
  if(existing)await this.migrateReading(Number(existing.id));
  const revision=await libraryRevision(this.db),liveClock=Math.max(article.updatedAt,(article as IncomingArticle&{independentChangedAt?:number}).independentChangedAt??0,article.favoriteChangedAt,article.watchLaterChangedAt);
  const deleted=(await this.db.query('SELECT changed_at,source_order FROM sync_article_deletions WHERE article_id=?',[article.articleId]))[0];
  if(!authoritative&&deleted&&(Number(deleted.changed_at)>liveClock||Number(deleted.changed_at)===liveClock&&String(deleted.source_order)>=deviceOrder(article.sourceDeviceId||remoteDeviceId)))return 0;
  const now=this.now(),updated=Math.max(article.updatedAt,article.importedAt),fetched=updated>0?updated:now,progress=Math.fround(Math.max(0,Math.min(1,article.readingProgress)));
  const title=nonblank(article.title)?article.title:article.url,excerpt=nonblank(article.excerpt)?article.excerpt:null;
  const sourceTitle=source?(nonblank(article.rssSourceTitle??"")?article.rssSourceTitle!:nonblank(article.siteName)?article.siteName:source.replace(/^https?:\/\//i,"").split(/[/:?#]/)[0]!):"独立文章";
  const idSql="(SELECT a.id FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url=? AND a.dedup_key=?)";
  const idParams=[channelUrl,dedupKey];
  const statements:Statement[]=[revisionGuard(revision),
   // A confirmed newer keep consumes the old article tombstone atomically.
   {sql:'DELETE FROM sync_article_deletions WHERE article_id=?',params:[article.articleId]},
   {sql:`UPDATE source_preferences SET use_original_content=1 WHERE channel_id=(SELECT id FROM channels WHERE url=? AND ?=1 AND (title!=? OR description IS NOT ?))`,params:[channelUrl,source?0:1,"独立文章","从手机同步来的独立网页文章"]},
   {sql:`INSERT INTO channels(url,title,description,created_at,sort_order,last_fetched_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET
    title=CASE WHEN ?=1 THEN excluded.title ELSE channels.title END,description=CASE WHEN ?=1 THEN excluded.description ELSE channels.description END,
    sort_order=CASE WHEN ?=1 THEN channels.sort_order ELSE max(channels.sort_order,?) END,
    last_fetched_at=CASE WHEN ?=1 THEN channels.last_fetched_at WHEN ?=1 THEN max(COALESCE(channels.last_fetched_at,0),?) ELSE channels.last_fetched_at END`,params:[channelUrl,sourceTitle,source?null:"从手机同步来的独立网页文章",now,source?fetched:now,source?(imported&&updated>0?updated:null):now,nonblank(sourceTitle)?1:0,source?0:1,source?0:1,updated,source?0:1,imported?1:0,updated]},
   {sql:`INSERT INTO source_preferences(channel_id,use_original_content,read_preset) SELECT id,?,'default' FROM channels WHERE url=? ON CONFLICT(channel_id) DO UPDATE SET use_original_content=1 WHERE ?=1`,params:[imported?1:0,channelUrl,source&&imported?1:0]},
   {sql:`INSERT INTO articles(channel_id,title,description,content,link,guid,image_url,dedup_key,fetched_at,is_read,reading_progress)
    SELECT id,?,?,?,?,?,?,?,?,?,? FROM channels WHERE url=? ON CONFLICT(channel_id,dedup_key) DO UPDATE SET
    title=excluded.title,description=excluded.description,content=CASE WHEN ?=1 THEN excluded.content ELSE articles.content END,
    link=excluded.link,image_url=excluded.image_url,fetched_at=excluded.fetched_at,is_read=CASE WHEN ?=1 THEN excluded.is_read WHEN ?=2 THEN articles.is_read ELSE articles.is_read OR excluded.is_read END`,params:[title,excerpt,stored,article.url,existing?.guid??article.articleId,article.imageUrl,dedupKey,fetched,article.isRead?1:0,progress,channelUrl,hasBody?1:0,authoritative?1:0,remoteDeviceId==='cloud-records'?2:0]},
  ];
  // SQLite evaluates all SET expressions against the pre-update reading row.
  // Update reading before replacing the content hash used by this decision.
  let wins=`(?=1 OR (?=1 AND ?!=COALESCE((SELECT body_hash FROM article_sync_content WHERE item_id=article_reading_state.article_id),'')) OR excluded.changed_at>article_reading_state.changed_at OR (excluded.changed_at=0 AND article_reading_state.changed_at=0 AND excluded.progress>article_reading_state.progress))`;
  const cloud=remoteDeviceId==='cloud-records';
  const clock=article.readingPositionChangedAt||article.updatedAt;
  // Compare against the live SQL clock, not a pre-transaction JS read.
  const localSource=`COALESCE((SELECT reading_source FROM cloud_article_state WHERE article_id=? AND reading_clock=article_reading_state.changed_at),(SELECT device_id FROM sync_local_identity WHERE id=1),'')`;
  if(cloud)wins=`(excluded.changed_at>article_reading_state.changed_at OR (excluded.changed_at=article_reading_state.changed_at AND (? > ${localSource} OR (? = ${localSource} AND (?=0 OR ?=(SELECT is_read FROM articles WHERE id=article_reading_state.article_id))))))`;
  const flags=cloud?[article.sourceDeviceId,article.articleId,article.sourceDeviceId,article.articleId,article.isRead?1:0,article.isRead?1:0]:[authoritative?1:0,hasBody?1:0,payload.bodyHash];
  if(cloud)statements.push({sql:`UPDATE articles SET is_read=? WHERE id=${idSql} AND (NOT EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=articles.id) OR EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=articles.id AND (? > changed_at OR (?=changed_at AND (? > ${localSource} OR (?=${localSource} AND ?=0))))))`,params:[article.isRead?1:0,...idParams,clock,clock,article.sourceDeviceId,article.articleId,article.sourceDeviceId,article.articleId,article.isRead?1:0]});
  if(remoteDeviceId==='cloud-rss-inventory'&&!authoritative){
   // Feed bodies carry no reading operation. In particular, a different body
   // must not select the legacy "body changed" rewind below. Preserve an
   // existing structured row verbatim, or seed only the native legacy ratio.
   statements.push({sql:`INSERT OR IGNORE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
    SELECT id,reading_progress,0,0,'',NULL FROM articles WHERE id=${idSql}`,params:idParams});
  }else{
  statements.push({sql:`INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
   VALUES(${idSql},?,?,?,?,NULL) ON CONFLICT(article_id) DO UPDATE SET
   progress=CASE WHEN ${wins} THEN excluded.progress ELSE article_reading_state.progress END,
   position_bytes=CASE WHEN ${wins} THEN excluded.position_bytes ELSE article_reading_state.position_bytes END,
   position_hash=CASE WHEN ${wins} THEN excluded.position_hash ELSE article_reading_state.position_hash END,
   state_json=CASE WHEN ${wins} THEN NULL ELSE article_reading_state.state_json END,
   changed_at=CASE WHEN ?=1 THEN excluded.changed_at ELSE max(article_reading_state.changed_at,excluded.changed_at) END`,params:[...idParams,progress,cloud?clock:article.readingPositionChangedAt,article.readingPositionBytes,article.readingPositionContentHash,...flags,...flags,...flags,...flags,authoritative?1:0]});
  statements.push({sql:`UPDATE articles SET reading_progress=(SELECT progress FROM article_reading_state WHERE article_id=articles.id) WHERE id=${idSql}`,params:idParams});
  }
  if(cloud)statements.push({sql:`INSERT INTO cloud_article_state(article_id,content_hash,body_hash,reading_clock,reading_source) SELECT ?,?,'',?,? WHERE EXISTS(SELECT 1 FROM article_reading_state WHERE article_id=${idSql} AND changed_at=?) ON CONFLICT(article_id) DO UPDATE SET reading_clock=excluded.reading_clock,reading_source=excluded.reading_source WHERE excluded.reading_clock>cloud_article_state.reading_clock OR (excluded.reading_clock=cloud_article_state.reading_clock AND excluded.reading_source>=cloud_article_state.reading_source)`,params:[article.articleId,(article as IncomingArticle&{contentHash?:string}).contentHash??'',clock,article.sourceDeviceId,...idParams,clock]});
  const cacheStatement:Statement={sql:`INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes)
   VALUES(${idSql},?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET content_html=excluded.content_html,content_text=excluded.content_text,body_hash=excluded.body_hash,body_bytes=excluded.body_bytes,chunk_size=excluded.chunk_size,chunk_hashes=excluded.chunk_hashes,content_bytes=excluded.content_bytes WHERE ?=1`,params:[...idParams,html,text,payload.bodyHash,payload.bodyByteCount,payload.chunkSize,JSON.stringify(payload.chunkHashes),byteLength(chosen??""),hasBody?1:0]};
  statements.push({sql:`INSERT INTO article_previews(article_id,summary,image_url) VALUES(${idSql},?,?) ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url`,params:[...idParams,excerpt,article.imageUrl]});
  statements.push({sql:`INSERT INTO article_original_previews(article_id,summary,image_url) VALUES(${idSql},?,?) ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url`,params:[...idParams,excerpt,article.imageUrl]});
  if(hasBody&&body!==local){
   for(const table of ["article_body_chunks","article_original_chunks"])statements.push({sql:`DELETE FROM ${table} WHERE article_id=${idSql}`,params:idParams});
   if(stored!==null){
    statements.push({sql:`INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(${idSql},0,?)`,params:[...idParams,stored]});
    statements.push({sql:`INSERT INTO article_original_meta(article_id,source_url,fetched_at) VALUES(${idSql},?,?) ON CONFLICT(article_id) DO UPDATE SET source_url=excluded.source_url,fetched_at=excluded.fetched_at`,params:[...idParams,article.url,fetched]});
   }
  }
  statements.push(cacheStatement);
  if(hasBody)statements.push({sql:`INSERT INTO article_sync_encoding_cache(item_id,body_hash,content_hash,source_device_id,updated_at,imported_at,metadata_state,site_name,rss_source_title) SELECT item_id,body_hash,?,?,?,?,?,?,? FROM article_sync_content WHERE item_id=${idSql} ON CONFLICT(item_id) DO UPDATE SET body_hash=excluded.body_hash,content_hash=excluded.content_hash,source_device_id=excluded.source_device_id,updated_at=excluded.updated_at,imported_at=excluded.imported_at,metadata_state=excluded.metadata_state,site_name=excluded.site_name,rss_source_title=excluded.rss_source_title`,params:[(article as IncomingArticle&{contentHash?:string}).contentHash??payload.bodyHash,article.sourceDeviceId||remoteDeviceId,article.updatedAt,article.importedAt,articleState(article),article.siteName,article.rssSourceTitle,...idParams]});
  // A body verified by this runtime is already valid for its frozen encoder.
  // Mark it in the same transaction; metadata-only input cannot certify an old
  // cache, and a definition rotation cannot publish a stale generation.
  if(hasBody&&generation)statements.push(projectionGuard(generation),{sql:`INSERT INTO sync_fast_encoded_cache(item_id,generation,body_hash) SELECT item_id,?,body_hash FROM article_sync_content WHERE item_id=${idSql} ON CONFLICT(item_id) DO UPDATE SET generation=excluded.generation,body_hash=excluded.body_hash`,params:[generation,...idParams]});
  // Retain aliases for original RSS rows while promoting the materialized
  // canonical row. Ordinary bindArticle calls still cannot move an identity.
  for(const table of ['sync_article_ids','sync_saved_states'])statements.push({sql:`INSERT INTO sync_article_aliases(item_id,article_id) SELECT item_id,article_id FROM ${table} WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,params:[article.articleId]});
  statements.push({sql:`INSERT INTO sync_article_aliases(item_id,article_id) VALUES(${idSql},?) ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,params:[...idParams,article.articleId]});
  statements.push({sql:`UPDATE sync_article_ids SET item_id=${idSql},url=? WHERE article_id=?`,params:[...idParams,article.url,article.articleId]});
  statements.push({sql:`INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,${idSql},?) ON CONFLICT(article_id) DO UPDATE SET url=excluded.url`,params:[article.articleId,...idParams,article.url]});
  statements.push({sql:`INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
   SELECT m.article_id,s.save_type,s.article_id,m.url,s.saved,s.changed_at,-s.sort_order,i.device_id,i.device_order FROM article_saved_states s JOIN sync_article_ids m ON m.item_id=s.article_id CROSS JOIN sync_local_identity i WHERE m.article_id=? AND i.id=1 ON CONFLICT(article_id,save_type) DO NOTHING`,params:[article.articleId]});
  const countedIndexes:number[]=[];
  for(const type of ["favorite","watchLater"] as const){const state:RemoteSavedState={articleId:article.articleId,url:article.url,type,saved:article[`${type}Saved`],changedAt:article[`${type}ChangedAt`],sortOrder:article[`${type}SortOrder`],sourceDeviceId:cloud?article.sourceDeviceId:remoteDeviceId};const savedStatements=this.saved.remoteStatements(state,{authoritative});if(savedStatements.length)countedIndexes.push(statements.length);statements.push(...savedStatements);}
  const keepStart=statements.length;const keep=article as IncomingArticle&{independentChangedAt?:number;legacyArticleIds?:readonly string[]};
  statements.push(...this.keeps.record(article.articleId,article.url,Math.max(article.updatedAt,keep.independentChangedAt??0,article.favoriteChangedAt,article.watchLaterChangedAt),article.sourceDeviceId||remoteDeviceId,idSql,idParams,keep.legacyArticleIds??[]));
  phase('receive.statements');
  const guarded=statements.map(s=>({...s,sql:onlyChangedSql(s.sql)}));
  if(counted){const changes=await this.db.transactionChanges!(guarded);phase('receive.commit');if(changes.length!==statements.length)throw new Error("Invalid committed transaction change receipt");const saves=countedIndexes.reduce((n,i)=>n+(changes[i]!>0?1:0),0);return changes[1]!>0||saves||changes.slice(keepStart).some(n=>n>0)||changes.some((n,i)=>n>0&&/^(?:INSERT INTO articles\b|INSERT INTO article_reading_state\b|UPDATE articles\b)/.test(statements[i]!.sql))?Math.max(1,saves):0;}
  await this.db.transaction(guarded);return 0;
 }
}
