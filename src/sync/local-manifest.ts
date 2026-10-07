import {readSyncSqlText} from "./sql-text.ts";
import {libraryRevision,revisionGuard} from "./revision.ts";
import {querySyncPages} from './sql-pages.ts';
import type {SqlDatabase} from "../core/types.ts";
import type {ArticleReceiveFiles,IncomingArticle,LocalReceiveBody} from "./article-receiver.ts";
import {javaUtf8Chunks} from "../reader/imported-text-writer.ts";
import type {SyncBodyCodec} from "./article-body.ts";
import {hashJavaText,prepareArticle,prepareCachedArticle,type CachedBodyManifest,type ExportedArticle,type PreparedArticle} from "./article-export.ts";
import {isImportedContentUrl} from "../core/imported-content.ts";
export interface SyncTextPort {
 parseUri(value:string):Promise<{valid:boolean;scheme:string|null;host:string|null;rawPath:string|null;rawQuery:string|null}>;
 htmlText(html:string):Promise<string>;
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
type Row=Record<string,unknown>;
const str=(v:unknown)=>v==null?'':String(v),nullable=(v:unknown)=>v==null?null:String(v),num=(v:unknown)=>Number(v??0);
const ROW_SELECT=`SELECT a.id,a.channel_id,a.title,a.link,a.guid,a.pub_date,a.image_url,a.audio_url,a.video_url,a.is_read,a.is_saved,a.reading_progress,a.dedup_key,a.fetched_at,
 (SELECT article_id FROM sync_article_ids WHERE item_id=a.id) AS bound_id,(SELECT url FROM sync_article_ids WHERE item_id=a.id) AS bound_url,
 ch.url AS channel_url,ch.title AS channel_title,ch.is_pinned AS channel_pinned,ch.sort_order AS channel_sort,ch.created_at AS channel_created,p.summary,p.image_url AS preview_image,
 COALESCE(NULLIF(c.body_hash,''),n.body_hash,'') AS cached_body_hash,n.body_hash AS native_body_hash,c.body_hash AS encoded_body_hash,c.body_bytes,c.chunk_size,c.chunk_hashes,e.body_hash AS local_encoded_body_hash,
 r.progress,r.changed_at AS position_changed_at,r.position_bytes,r.position_hash,
 EXISTS(SELECT 1 FROM article_original_chunks o WHERE o.article_id=a.id) AS has_original_chunks
 FROM articles a JOIN channels ch ON ch.id=a.channel_id LEFT JOIN article_previews p ON p.article_id=a.id
 LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash LEFT JOIN article_native_sync_hash n ON n.item_id=a.id LEFT JOIN article_reading_state r ON r.article_id=a.id`;
const LOCAL_CHANNEL=`ch.url LIKE '%watchrss://phone-imports%' OR
 ch.url LIKE '%https://watchrss.local/import-content%' OR
 ch.url LIKE '%https://watchrss.local/import-epub%' OR
 ch.url LIKE '%https://watchrss.local/import-txt-novel%'`;
const ROWS=ROW_SELECT+` WHERE EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id)
 OR EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=a.id)
 OR ${LOCAL_CHANNEL} ORDER BY a.fetched_at DESC,a.id DESC`;
const SAVES=`SELECT s.*,m.article_id AS sync_id,COALESCE(t.created_at,s.changed_at) AS saved_at FROM article_saved_states s LEFT JOIN sync_article_ids m ON m.item_id=s.article_id LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type ORDER BY s.sort_order,saved_at DESC,s.article_id`;
const STATES='SELECT * FROM sync_saved_states ORDER BY article_id,save_type';
const DELETES='SELECT * FROM local_article_deletions ORDER BY changed_at,id';
const SYNC_DELETES='SELECT * FROM sync_article_deletions ORDER BY article_id';
interface State {articleId:string;type:string;url:string;saved:boolean;changedAt:number;sortOrder:number;device:string;itemId?:number|null}
/** Reads actual bodies and checks all source rows again after asynchronous work.
 * A changed snapshot fails instead of advertising mixed metadata generations. */
export class LocalArticleManifestStore {
 private bodySourceIds=new Map<string,number>();
 private readonly stableIds=new Map<string,string>();
 constructor(private readonly db:SqlDatabase,private readonly codec:SyncBodyCodec,private readonly text:SyncTextPort,
  private readonly files:ArticleReceiveFiles,private readonly migrateReading:(id:number)=>Promise<void>,private readonly migrateReadingMany?:(ids:readonly number[])=>Promise<void>){ }
 private async stableId(value:string):Promise<string>{
  const cached=this.stableIds.get(value);if(cached)return cached;
  const id=await stableArticleId(value,this.text.parseUri,this.codec);
  if(this.stableIds.size>=8192)this.stableIds.delete(this.stableIds.keys().next().value!);
  this.stableIds.set(value,id);return id;
 }
 /** Native lookup uses each saved-type binding before source/dedup fallback. */
 async resolveIncomingBody(article:IncomingArticle):Promise<LocalReceiveBody|null>{
  const revision=await libraryRevision(this.db);let row:Row|undefined;
  const states=await this.db.query(`SELECT item_id FROM sync_saved_states WHERE article_id=? AND item_id IS NOT NULL ORDER BY CASE save_type WHEN 'favorite' THEN 0 ELSE 1 END`,[article.articleId]);
  for(const state of states){row=(await this.db.query(ROW_SELECT+` WHERE a.id=?`,[state.item_id]))[0];if(row)break;}
  if(!row){const source=article.rssSourceUrl&&/^https?:\/\//i.test(nativeTrim(article.rssSourceUrl))?article.rssSourceUrl:'watchrss://phone-imports';row=(await this.db.query(ROW_SELECT+` WHERE ch.url=? AND a.dedup_key=?`,[source,article.articleId]))[0];}
  if(!row)return null;await this.hydrateRow(row);const actual=await this.bodyFromRow(row);
  if(await libraryRevision(this.db)!==revision)throw new Error("Local library changed during body lookup");
  return {itemId:num(row.id),available:actual.available,hasStoredBody:!blank(nullable(row.actual_content))||!blank(nullable(row.original_content)),body:actual.available?{contentHtml:actual.contentHtml,contentText:actual.contentText}:null};
 }
 async prepareReadingForSnapshot():Promise<void> {
  const readingCandidates=await querySyncPages(this.db,`SELECT a.id,c.url AS channel_url,
   EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id) AS has_saved_state
   FROM articles a JOIN channels c ON c.id=a.channel_id
   WHERE c.url LIKE '%watchrss://phone-imports%' OR
    c.url LIKE '%https://watchrss.local/import-content%' OR
    c.url LIKE '%https://watchrss.local/import-epub%' OR
    c.url LIKE '%https://watchrss.local/import-txt-novel%' OR
    EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id)
   ORDER BY a.id`);
  const migrationIds=readingCandidates.filter(row=>num(row.has_saved_state)||isImportedContentUrl(str(row.channel_url))).map(row=>num(row.id));
  if(this.migrateReadingMany)await this.migrateReadingMany(migrationIds);
  else for(const id of migrationIds)await this.migrateReading(id);
 }
 /** Ordinary read RSS rows are absent from saved-article snapshots. */
 async cloudReadingStates():Promise<ExportedArticle[]>{
  const device=String((await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??'');
  const rows=await querySyncPages(this.db,ROW_SELECT+" WHERE (a.is_read=1 OR a.reading_progress>0 OR r.progress>0) AND (ch.url LIKE 'http://%' OR ch.url LIKE 'https://%') ORDER BY a.id",[],100);
  const out:ExportedArticle[]=[];
  for(const r of rows){if(isImportedContentUrl(str(r.channel_url)))continue;const url=str(r.link)||str(r.dedup_key);
   out.push({articleId:await this.stableId(url),sourceDeviceId:device,url,title:str(r.title)||url,siteName:str(r.channel_title),excerpt:str(r.summary),contentHtml:null,contentText:'',imageUrl:nullable(r.preview_image)??nullable(r.image_url),contentHash:str(r.cached_body_hash)||await hashJavaText(url,this.codec),importedAt:num(r.fetched_at),updatedAt:num(r.fetched_at),rssSourceUrl:str(r.channel_url),rssSourceTitle:str(r.channel_title),independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:num(r.progress??r.reading_progress),readingPositionBytes:num(r.position_bytes),readingPositionContentHash:str(r.position_hash),readingPositionChangedAt:num(r.position_changed_at),isRead:!!num(r.is_read)});
  }return out;
 }
 async snapshot(readingPrepared=false):Promise<PreparedArticle[]> {
  this.bodySourceIds.clear();
  const identity=(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];if(!identity)throw new Error('Initialize sync identity first');const device=str(identity.device_id);
  if(!readingPrepared)await this.prepareReadingForSnapshot();
  const revision=await libraryRevision(this.db);
  const queries=[ROWS,SAVES,STATES,DELETES,SYNC_DELETES],data:Row[][]=[];for(const q of queries)data.push(await querySyncPages(this.db,q,[],q===ROWS?100:400));
  const [metadata,saves,persisted,deletions,syncDeletions]=data as [Row[],Row[],Row[],Row[],Row[]],rows=metadata.map(r=>({...r}));
  const byItem=new Map(rows.map(r=>[num(r.id),r]));
  const sourceRows=new Map<string,Row|null>();
  const sourceRow=async(channel:string,id:string):Promise<Row|undefined>=>{
   const key=channel+'\0'+id,known=sourceRows.get(key);
   if(known!==undefined)return known??undefined;
   const row=rows.find(r=>str(r.channel_url)===channel&&str(r.dedup_key)===id)??
    (await this.db.query(ROW_SELECT+` WHERE ch.url=? AND a.dedup_key=? LIMIT 1`,[channel,id]))[0]??null;
   sourceRows.set(key,row);if(row)byItem.set(num(row.id),row);
   return row??undefined;
  };
  const neededIds=new Set<number>([...saves.map(row=>num(row.article_id)),...persisted.filter(row=>row.item_id!=null).map(row=>num(row.item_id)),
   ...rows.filter(row=>str(row.channel_url)==='watchrss://phone-imports'||isImportedContentUrl(str(row.channel_url))).map(row=>num(row.id))]);
  const ids=new Map<number,string>();for(const id of neededIds){const row=byItem.get(id);if(row)ids.set(id,row.link==null&&row.bound_id?str(row.bound_id):await this.stableId(row.link==null?str(row.dedup_key):str(row.link)));}
  const states=new Map<string,State>();
  const put=(s:State)=>{const key=s.articleId+'\0'+s.type,old=states.get(key);if(!old||s.changedAt>old.changedAt||(s.changedAt===old.changedAt&&s.device>old.device))states.set(key,s);};
  for(const s of saves){if(num(s.saved))continue;const r=byItem.get(num(s.article_id));if(r)put({articleId:ids.get(num(s.article_id))!,type:str(s.save_type),url:str(r.link),saved:!!num(s.saved),changedAt:num(s.changed_at),sortOrder:-num(s.sort_order),device});}
  // Persisted clocks retain remote provenance; UI rows only seed missing state.
  for(const s of persisted){const id=s.item_id==null?str(s.article_id):ids.get(num(s.item_id))??str(s.article_id);states.set(id+'\0'+str(s.save_type),{articleId:id,type:str(s.save_type),url:str(s.url),saved:!!num(s.saved),changedAt:num(s.changed_at),sortOrder:num(s.sort_order),device:str(s.source_device_id),itemId:s.item_id==null?null:num(s.item_id)});}
  for(const d of syncDeletions)put({articleId:str(d.article_id),type:'delete',url:str(d.url),saved:false,changedAt:num(d.changed_at),sortOrder:0,device:str(d.source_device_id)});
  for(const d of deletions){const id=await this.stableId(str(d.article_url));for(const type of ['delete',...(num(d.was_favorite)?['favorite']:[]),...(num(d.was_watch_later)?['watchLater']:[])])put({articleId:id,type,url:str(d.article_url),saved:false,changedAt:num(d.changed_at),sortOrder:0,device});}
  const groups=new Map<string,Row[]>();
  for(const type of ['favorite','watchLater'])for(const s of saves){if(str(s.save_type)!==type||!num(s.saved)||!byItem.has(num(s.article_id)))continue;const id=ids.get(num(s.article_id))!,list=groups.get(id)??[];list.push(s);groups.set(id,list);}
  const out:PreparedArticle[]=[],active=new Set<string>(),usedRows=new Set<number>(),preparedRowIds=new Map<string,number>();
  for(const [id,entries] of groups){let representative=entries[0]!;for(const s of entries)if(num(s.saved_at)>num(representative.saved_at))representative=s;
   const row=byItem.get(num(representative.article_id))!,favorite=entries.find(s=>s.save_type==='favorite'),later=entries.find(s=>s.save_type==='watchLater');usedRows.add(num(row.id));
   const f=states.get(id+'\0favorite'),l=states.get(id+'\0watchLater');
   let bodySource:Row|undefined;
   for(const type of ['favorite','watchLater']){const state=persisted.find(s=>s.article_id===id&&s.save_type===type);if(state?.item_id!=null)bodySource=byItem.get(num(state.item_id));if(bodySource)break;}
   if(!bodySource)bodySource=await sourceRow(str(row.channel_url),id);
   // Bound journal state governs relay flags across stale RSS aliases. Missing-
   // item tombstones keep native's separate saved-entry behavior.
   out.push(await this.prepareRow(row,id,device,{savedAt:num(representative.saved_at),favorite:f?.itemId!=null?f.saved:!!favorite,later:l?.itemId!=null?l.saved:!!later,favoriteChanged:f?.changedAt??num(favorite?.saved_at),favoriteOrder:f?.sortOrder??num(favorite?.saved_at),laterChanged:l?.changedAt??num(later?.saved_at),laterOrder:l?.sortOrder??num(later?.saved_at)},bodySource??row));this.bodySourceIds.set(id,num(bodySource?.id??row.id));preparedRowIds.set(id,num(row.id));active.add(id);
  }
  for(const independent of [true,false])for(const row of [...rows].sort((a,b)=>num(b.channel_pinned)-num(a.channel_pinned)||num(a.channel_sort)-num(b.channel_sort)||num(b.channel_created)-num(a.channel_created)||num(a.channel_id)-num(b.channel_id)||num(b.fetched_at)-num(a.fetched_at)||num(b.id)-num(a.id))){const channel=str(row.channel_url);if(independent?channel!=='watchrss://phone-imports':!isImportedContentUrl(channel))continue;const id=ids.get(num(row.id))!;if(active.has(id))continue;
   // Clearing the last saved list keeps these channel rows active, so their
   // cancellation cannot be exported by the separate tombstone branch.
   out.push(await this.prepareRow(row,id,device,undefined,row,{favorite:states.get(id+'\0favorite'),later:states.get(id+'\0watchLater')}));this.bodySourceIds.set(id,num(row.id));preparedRowIds.set(id,num(row.id));usedRows.add(num(row.id));active.add(id);}
  const tombstones=new Map<string,State[]>();for(const s of states.values()){if(s.saved||active.has(s.articleId))continue;const list=tombstones.get(s.articleId)??[];list.push(s);tombstones.set(s.articleId,list);}
  for(const [id,list] of tombstones){const url=list[0]!.url;if(blank(url))continue;let latest=list[0]!;for(const s of list)if(s.changedAt>latest.changedAt)latest=s;const deleted=list.find(s=>s.type==='delete');const normalized=nativeTrim(url),host=nativeTrim(((await this.text.parseUri(normalized.startsWith('http://')||normalized.startsWith('https://')?normalized:'https://'+normalized)).host??'').replace(/^www\./,''));
   const article:ExportedArticle={articleId:id,sourceDeviceId:latest.device||device,url,title:url,siteName:host,excerpt:'',contentHtml:null,contentText:'',imageUrl:null,contentHash:await hashJavaText(url,this.codec),importedAt:Math.min(...list.map(s=>s.changedAt)),updatedAt:latest.changedAt,independentSaved:false,independentChangedAt:deleted?.changedAt??0,independentSortOrder:0,rssSourceUrl:null,rssSourceTitle:null,favoriteSaved:false,favoriteChangedAt:list.find(s=>s.type==='favorite')?.changedAt??0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:list.find(s=>s.type==='watchLater')?.changedAt??0,watchLaterSortOrder:0,deleted:!!deleted,deletedAt:deleted?.changedAt??latest.changedAt,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false};out.push(await prepareArticle(article,this.codec));
  }
  const cacheUpdates:{row:Row;prepared:PreparedArticle}[]=[];
  // Native repairs metadata through saved-state item bindings before falling
  // back to source-channel/dedup identity; the resolved body can differ from
  // the saved-entry representative when one URL exists in several feeds.
  for(let i=0;i<out.length;i++){
   const current=out[i]!,a=current.article;if(a.deleted||!current.manifest.bodyAvailable)continue;
   let target:Row|undefined;
   for(const type of ['favorite','watchLater']){const state=persisted.find(s=>s.article_id===a.articleId&&s.save_type===type);if(state?.item_id!=null)target=byItem.get(num(state.item_id));if(target)break;}
   const localImport=!!a.rssSourceUrl?.toLowerCase().startsWith('https://watchrss.local/import-');
   if(!target&&localImport){
    // Imported chapter dedup keys need not equal the hashed sync ID. A native
    // body hash keeps contentHash stable when this derived cache is published.
    const itemId=this.bodySourceIds.get(a.articleId),candidate=itemId===undefined?undefined:byItem.get(itemId);
    if(candidate&&str(candidate.native_body_hash))target=candidate;
   }
   if(!target)target=await sourceRow(a.rssSourceUrl??'watchrss://phone-imports',a.articleId);
   if(target){const sameBodySource=this.bodySourceIds.get(a.articleId)===num(target.id);this.bodySourceIds.set(a.articleId,num(target.id));const cached=this.cachedBody(target);
    // prepareRow already hashed this exact cached source. Rehashing every
    // chapter here costs a second host SHA-256 round trip per manifest entry.
    if(cached){if(!(sameBodySource&&current.encodedBody===null&&current.manifest.bodyHash===cached.bodyHash))out[i]=await prepareCachedArticle({...a,contentHtml:null,contentText:''},this.codec,cached);}
    else if(localImport&&str(target.native_body_hash)&&preparedRowIds.get(a.articleId)===num(target.id)&&current.encodedBody){cacheUpdates.push({row:target,prepared:current});}
    else{await this.hydrateRow(target);const actual=await this.bodyFromRow(target);out[i]=await prepareArticle({...a,contentHtml:actual.contentHtml,contentText:actual.contentText},this.codec,actual.available);if(actual.available)cacheUpdates.push({row:target,prepared:out[i]!});}}
   // Production toManifest derives this default from deletedAt even for a
   // nondeleted saved-state tombstone; preserve that observed wire behavior.
   if(out[i]!.manifest.bodyAvailable)out[i]!.manifest.deleted=a.deletedAt>0;
  }
  // Source tables and identity have revision triggers. Cache tables are
  // deliberately excluded because publishing a derived body cache must not
  // invalidate the library snapshot. Recheck only cache rows used by this
  // manifest; the old full-library reread doubled host SQL bridge work.
  for(const id of this.bodySourceIds.values())usedRows.add(id);
  const cacheIds=[...usedRows].sort((a,b)=>a-b);
  for(let offset=0;offset<cacheIds.length;offset+=100){
   const part=cacheIds.slice(offset,offset+100),marks=part.map(()=>'?').join(',');
   const current=await querySyncPages(this.db,`SELECT a.id,COALESCE(NULLIF(c.body_hash,''),n.body_hash,'') AS cached_body_hash,
    c.body_hash AS encoded_body_hash,c.body_bytes,c.chunk_size,c.chunk_hashes,e.body_hash AS local_encoded_body_hash
    FROM articles a LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash
    LEFT JOIN article_native_sync_hash n ON n.item_id=a.id WHERE a.id IN (${marks}) ORDER BY a.id`,part,50);
   if(current.length!==part.length)throw new Error('Local library changed during sync snapshot');
   for(const now of current){const before=byItem.get(num(now.id));
    if(!before||['cached_body_hash','encoded_body_hash','body_bytes','chunk_size','chunk_hashes','local_encoded_body_hash'].some(key=>now[key]!==before[key]))
     throw new Error('Local library changed during sync snapshot');
   }
  }
  if(await libraryRevision(this.db)!==revision)throw new Error("Local library changed during sync snapshot");
  for(const update of cacheUpdates)await this.cacheMetadata(update.row,update.prepared,revision);
  return out;
 }
 async materializeRequested(prepared:PreparedArticle):Promise<PreparedArticle>{
  if(prepared.encodedBody||!prepared.manifest.bodyAvailable)return prepared;
  const itemId=this.bodySourceIds.get(prepared.article.articleId);if(itemId===undefined)throw new Error('Cached sync body source is missing');
  const row=(await this.db.query(ROW_SELECT+' WHERE a.id=?',[itemId]))[0];if(!row)throw new Error('Cached sync body source disappeared');
  await this.hydrateRow(row);const body=await this.bodyFromRow(row);if(!body.available)throw new Error('Cached sync body file is unavailable');
  const actual=await prepareArticle({...prepared.article,contentHtml:body.contentHtml,contentText:body.contentText},this.codec,true);
  actual.manifest.deleted=prepared.manifest.deleted;
  if(JSON.stringify(actual.manifest)!==JSON.stringify(prepared.manifest)){
   const changed=Object.keys(prepared.manifest).filter(key=>JSON.stringify((prepared.manifest as unknown as Record<string,unknown>)[key])!==JSON.stringify((actual.manifest as unknown as Record<string,unknown>)[key]));
   throw new Error('Cached sync body changed during export: '+changed.join(','));
  }
  return actual;
 }
 private cachedBody(row:Row):CachedBodyManifest|null{
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
  r.content=await readSyncSqlText(this.db,'SELECT content AS value FROM articles WHERE id=?',[r.id]);
  r.description=await readSyncSqlText(this.db,'SELECT description AS value FROM articles WHERE id=?',[r.id]);
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
 private async cacheMetadata(r:Row,p:PreparedArticle,revision:number):Promise<void>{
  const a=p.article,m=p.manifest,store=async(v:string|null,key:string)=>v===null||v.length<=50000?v:this.files.storeText(key,v);
  const html=await store(a.contentHtml,a.articleId+'-export-html'),text=await store(a.contentText,a.articleId+'-export-text');
  let contentBytes=0;for(const bytes of javaUtf8Chunks(a.contentHtml??a.contentText))contentBytes+=bytes.length;
  // Conditional publication cannot overwrite a body changed while filesystem
  // work was in progress. Reading/saved state are not modified here.
  await this.db.transaction([revisionGuard(revision),{sql:`INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes)
   SELECT a.id,?,?,?,?,?,?,? FROM articles a WHERE a.id=?
   ON CONFLICT(item_id) DO UPDATE SET content_html=excluded.content_html,content_text=excluded.content_text,body_hash=excluded.body_hash,body_bytes=excluded.body_bytes,chunk_size=excluded.chunk_size,chunk_hashes=excluded.chunk_hashes,content_bytes=excluded.content_bytes`,params:[html,text,m.bodyHash,m.bodyByteCount,m.chunkSize,JSON.stringify(m.chunkHashes),contentBytes,r.id]},
   {sql:`INSERT INTO article_sync_encoding_cache(item_id,body_hash) SELECT item_id,body_hash FROM article_sync_content WHERE item_id=? ON CONFLICT(item_id) DO UPDATE SET body_hash=excluded.body_hash`,params:[r.id]}]);
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
  const cached=blank(str(r.cached_body_hash))?null:this.cachedBody(bodySource);
  if(cached){if(r.summary==null)r.description=await readSyncSqlText(this.db,'SELECT description AS value FROM articles WHERE id=?',[r.id]);}
  else await this.hydrateRow(r);
  const {available,contentHtml,contentText}=cached?{available:true,contentHtml:null,contentText:''}:await this.bodyFromRow(r);
  const channel=str(r.channel_url),independent=channel==='watchrss://phone-imports',source=saved?(/^https?:\/\//i.test(nativeTrim(channel))?channel:null):independent?null:channel;
  const url=r.link==null&&r.bound_id?str(r.bound_url):saved?str(r.link):blank(nullable(r.link))?str(r.dedup_key):str(r.link),imported=saved?.savedAt??num(r.fetched_at);
  const article:ExportedArticle={articleId:id,sourceDeviceId:device,url,title:saved?str(r.title):blank(str(r.title))?url:str(r.title),siteName:str(r.channel_title),excerpt:r.summary==null?str(r.description):str(r.summary),contentHtml,contentText,imageUrl:nullable(r.preview_image??r.image_url),contentHash:blank(str(r.cached_body_hash))?await hashJavaText(!available?url:contentHtml??(blank(contentText)?url:contentText),this.codec):str(r.cached_body_hash),importedAt:imported,updatedAt:saved?Math.max(num(r.fetched_at),imported,saved.favoriteChanged,saved.laterChanged):num(r.fetched_at),independentSaved:independent,independentChangedAt:independent?imported:0,independentSortOrder:independent?imported:0,rssSourceUrl:source,rssSourceTitle:source===null?null:str(r.channel_title),favoriteSaved:saved?.favorite??false,favoriteChangedAt:saved?.favoriteChanged??clocks?.favorite?.changedAt??0,favoriteSortOrder:saved?.favoriteOrder??clocks?.favorite?.sortOrder??0,watchLaterSaved:saved?.later??false,watchLaterChangedAt:saved?.laterChanged??clocks?.later?.changedAt??0,watchLaterSortOrder:saved?.laterOrder??clocks?.later?.sortOrder??0,deleted:false,deletedAt:0,readingProgress:Math.fround(num(r.progress??r.reading_progress)),readingPositionBytes:num(r.position_bytes),readingPositionContentHash:str(r.position_hash),readingPositionChangedAt:num(r.position_changed_at),isRead:!!num(r.is_read)};
  return cached?prepareCachedArticle(article,this.codec,cached):prepareArticle(article,this.codec,available);
 }
}
