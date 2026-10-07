import {traceServiceWork} from "@podjs/framework/service-trace";
import {notifyLibrarySqlCommit} from './core/library-mutations';
import {startupMark,startupStep} from "./core/startup-trace.ts";
import {appLogger} from './logs/app-logger.ts';
import {migrateDouyinOriginalMode} from "./douyin/original-mode.ts";
import {ImportedArticleDeletion} from "./core/imported-article-deletion.ts";
import {ExternalSavedStore} from "./core/external-saved.ts";
import {DouyinSavedStore} from "./douyin/saved.ts";
import {readTokenUsageForSync} from './sync/token-usage.ts';
import {builtinForInput,type BuiltinChannel} from './core/builtin-channels.ts';
import {managedCache} from './cache/host.ts';
import {readSavedLinks,type SavedLinkType} from './sync/saved-links.ts';
import {SqlLibrarySessionRepository,type RemovedLibraryContent} from "./sync/library-repository.ts";
import {importedTextWriter} from "./reader/imported-text-storage.ts";
import {SqlSourceSyncStore} from "./sync/source-store.ts";
import {SqlLocalRssActions} from "./sync/local-rss-actions.ts";
import {ensureSyncDevice,prepareLocalSaveAlias} from "./sync/local-identity.ts";
import {hostArticleBodyCodec,hostSyncText} from "./sync/article-body-host.ts";
import {SqlReadingProgressStore} from "./reader/sql-progress.ts";
import {ReadingProgressStore} from "./reader/progress.ts";
import {hasCapability} from "@podjs/framework/watch";
import {kv} from "@podjs/framework/watch";
import {readUsage,clearUsage,subscribeUsageChanges} from "./llm/usage.ts";
import { ImportedTextStore, importedTextFileName } from "./reader/imported-text.ts";
import { importedSpeechSource, importedReaderHandle } from "./reader/imported-speech.ts";
import {createSummarySession,summaryAccountStore} from "./llm/runtime.ts";
import {readCloudAccountStatus,subscribeCloudAccountStatus} from './cloud/status';
import {accountStatusSnapshot} from "./account/status.ts";
import { buildArticleBlocksAsync } from "./reader/media.ts";
import {readOfflineMedia,retryOfflineMedia as retryStoredOfflineMedia} from "./reader/offline-media.ts";
import { isDeletableLocalContentChannel, isImportedContentUrl } from "./core/imported-content.ts";
import { OriginalContentCache, type OriginalDownload } from "./reader/original-cache.ts";
import { parseContent, contentText } from "./reader/content.ts";
import { ReaderSpeech } from "./reader/speech.ts";
import {ConfiguredSpeechPort} from './tts/speech-port.ts';
import {TtsConfigStore} from './tts/config-store.ts';
import {ttsTransport} from './tts/transport.ts';
import { articlePreview } from "./core/preview.ts";
import { searchSnippet } from "./rss/search-snippet.ts";
import {normalizeAddChannelUrl,validAddChannelUrl} from "./rss/add-channel.ts";
import { MemoRepository } from "./notes/index.ts";
import { uri, sqlite, textInput, http, hostOperation, type DownloadResult, fileChunks, base64ToBytes, utf8ToString, delay } from "@podjs/framework/services";
import { initializeSchema, WatchRssRepository, htmlToText, parseFeed, resolveUrl } from "./core/index.ts";
import type { SqlDatabase } from "./core/types.ts";
import type { AppServices, Article, ArticleQuery, Note, AddChannelPreview } from "./ui/service.ts";

export async function getTokenUsageForSync(limit:number){await init();return readTokenUsageForSync(db,limit);}
export async function getSavedLinksForSync(type:SavedLinkType):Promise<string[]> {
  await init();
  return readSavedLinks(db,type);
}

export const db: SqlDatabase = {
  query: (sql, params, traceLabel) => sqlite.query(sql, params as (string | number | null)[],traceLabel),
  execute: async (sql, params, traceLabel) => {await sqlite.execute(sql, params as (string | number | null)[],traceLabel);notifyLibrarySqlCommit([{sql}]);},
  transaction: async statements => {await sqlite.transaction(statements as { sql: string; params?: (string | number | null)[] }[]);notifyLibrarySqlCommit(statements);},
  transactionChanges: async statements => {const changes=await sqlite.transactionChanges(statements as { sql: string; params?: (string | number | null)[] }[]);if(changes.some(n=>n>0))notifyLibrarySqlCommit(statements);return changes;},
};
const externalSavedStore=new ExternalSavedStore(db,id=>prepareLocalSaveAlias(db,id,hostSyncText,hostArticleBodyCodec));
const douyinSavedStore=new DouyinSavedStore({get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);},remove:async key=>{kv.delete(key);}},Date.now,externalSavedStore);
/** Start database setup at JS start, in parallel with the startup gate; later calls share it. */
export function warmServices():void{void init().catch(()=>{});}
export async function getExternalSavedStore(){await init();return externalSavedStore;}
export async function getDouyinSavedStore(){await init();return douyinSavedStore;}
export const memoRepository = new MemoRepository(db, "podjs-watch");
let ready: Promise<void> | undefined;
function init(): Promise<void> { return ready ??= (async()=>{
  const fresh=await startupStep('init.probe',async()=>!(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'")).length);
  await startupStep('init.schema',()=>initializeSchema(db,{seedBuiltinChannels:fresh}));
  await startupStep('init.syncDevice',()=>ensureSyncDevice(db,async()=>base64ToBytes((await hostOperation<{bytesBase64:string}>("crypto.random",{bytes:16}).result).bytesBase64)));
  // Retry committed deletions after process interruption; keep failed work queued.
  await startupStep('init.deletionCleanup',()=>new ImportedArticleDeletion(db,hostSyncText,hostArticleBodyCodec,fileChunks,itemId=>originalCache.cancelItems([String(itemId)])).cleanupPending().catch(()=>{}));
  // Native seeds only on database creation. Never revive a channel deleted from an existing library.
  const legacyHidden=kv.get<unknown>('media.hidden-channels');
  if(Array.isArray(legacyHidden)){
    for(const platform of ['bili','douyin']){
      if(!legacyHidden.includes(platform))continue;
      const url=`builtin:${platform}`,row=(await db.query('SELECT id FROM channels WHERE url=?',[url]))[0];
      if(row){const id=Number(row.id),itemIds=(await db.query('SELECT id FROM articles WHERE channel_id=?',[id])).map(item=>Number(item.id));await repo.removeChannel(id);await cleanupRemovedContent({itemIds,channels:[{id,url}]});}
    }
    kv.delete('media.hidden-channels');
  }
  await startupStep('init.douyinMode',()=>migrateDouyinOriginalMode(db,kv));
  await startupStep('init.douyinSaved',()=>douyinSavedStore.migrate());
  startupMark('services.ready');
})().catch(error => { ready = undefined; throw error; }); }
async function insertBuiltin(builtin:BuiltinChannel,now=Date.now()):Promise<import('./ui/service.ts').Channel>{
  const existing=(await db.query("SELECT id,url,title,description FROM channels WHERE url=?",[builtin.url]))[0];
  if(existing)return {id:String(existing.id),url:String(existing.url),title:String(existing.title),description:existing.description==null?null:String(existing.description)};
  await db.transaction([
    {sql:"INSERT OR IGNORE INTO channels(url,title,description,created_at,sort_order,is_pinned) VALUES(?,?,?,?,?,0)",params:[builtin.url,builtin.title,builtin.description,now,now]},
    {sql:"INSERT OR IGNORE INTO source_preferences(channel_id,use_original_content) SELECT id,1 FROM channels WHERE url=?",params:[builtin.url]},
  ]);
  const row=(await db.query("SELECT id,url,title,description FROM channels WHERE url=?",[builtin.url]))[0];
  return {id:String(row.id),url:String(row.url),title:String(row.title),description:String(row.description)};
}
let downloadSequence = 0;
let addPreviewSequence=0;
const pendingAddPreviews=new Map<string,{url:string;xml:string|null;builtin:BuiltinChannel|undefined}>();
async function fetchFeedText(url: string, job?:OriginalDownload): Promise<string> {
  appLogger.d('Network','RSS fetch');
  const path = `feeds/fetch-${Date.now()}-${++downloadSequence}.xml`;
  try {
    const request=http.download(url,path,8*1024*1024);
    if(job){job.cancel=()=>request.cancel();if(job.cancelled)request.cancel();}
    const response = await request.result;
    if(job?.cancelled)throw new Error("刷新已取消");
    const bytes = new Uint8Array(response.size);
    let offset = 0;
    while(offset < bytes.length) {
      if(job?.cancelled)throw new Error("刷新已取消");
      const chunk = await fileChunks.read(path,offset);
      const value = base64ToBytes(chunk.dataBase64);
      if(!value.length) throw new Error("订阅下载不完整");
      bytes.set(value,offset); offset += value.length;
    }
    appLogger.d('Network',`download bytes=${bytes.length}`);
    return utf8ToString(bytes);
  } catch(error){appLogger.e('Network','RSS fetch failed');throw error;} finally { await fileChunks.remove(path).catch(() => {}); }
}
const sourceSync = new SqlSourceSyncStore(db,{parseUri:hostSyncText.parseUri,parseAndroid:value=>uri.parse(value,"android")});
const repo = new WatchRssRepository(db, fetchFeedText, hydrateStoredContent,id=>prepareLocalSaveAlias(db,id,hostSyncText,hostArticleBodyCodec),async id=>{const device=(await db.query("SELECT device_id FROM sync_local_identity WHERE id=1"))[0];if(!device)throw new Error("同步身份未初始化");return sourceSync.localDeleteStatements(id,String(device.device_id));});
const localRssActions = new SqlLocalRssActions(db,hostSyncText,hostArticleBodyCodec);
const importedTextStore = new ImportedTextStore({
  stat: path => fileChunks.stat(path),
  read: async (path,offset,maxBytes) => base64ToBytes((await fileChunks.read(path,offset,maxBytes)).dataBase64),
  readText: (path,offset,maxBytes) => fileChunks.readText(path,offset,maxBytes),
});

async function hydrateStoredContent(text:string):Promise<string>{
  if(!importedTextFileName(text))return text;
  const handle=await importedTextStore.handle(text);if(!handle)throw new Error("正文文件不可用");
  const chunks:string[]=[];for(let i=0;i<handle.chunkCount;i++){const chunk=await importedTextStore.chunk(handle,i);if(chunk===null)throw new Error("正文文件不可用");chunks.push(chunk);}
  return chunks.join("");
}

function mapArticle(row: Record<string, unknown>): Article {
  const preview=articlePreview(row.preview_content==null?undefined:String(row.preview_content),row.description==null?undefined:String(row.description),String(row.image_url??""),String(row.link??""));
  return { id: String(row.id), channelId: String(row.channel_id), channelTitle: String(row.channel_title ?? "RSS"),
    title: String(row.title),enclosureImageUrl:row.image_url?String(row.image_url):undefined,videoUrl:row.video_url?String(row.video_url):undefined,audioUrl:row.audio_url?String(row.audio_url):undefined, content: htmlToText(String(row.content ?? row.description ?? "")), savedAt:row.saved_at==null?undefined:Number(row.saved_at),saveSortOrder:row.save_sort_order==null?undefined:Number(row.save_sort_order),
    excerpt: String(row.summary ?? preview.summary ?? ""), link: String(row.link ?? ""), imageUrl: String(row.preview_image_url ?? preview.imageUrl ?? ""), watchLater: !!Number(row.is_watch_later),
    publishedAt: String(row.pub_date ?? ""), read: !!row.is_read, saved: !!row.is_saved };
}
function mapNote(row: Record<string, unknown>): Note {
  return { id: String(row.id), articleId: String(row.article_id), title: String(row.title ?? "笔记"), body: String(row.body), updatedAt: String(row.updated_at) };
}
const readerSpeech = new ReaderSpeech(new ConfiguredSpeechPort(new TtsConfigStore(),ttsTransport,()=>summaryAccountStore.read()),()=>delay(200).result);
const sqlReadingProgress = new SqlReadingProgressStore({query:async(q,p)=>{await init();return db.query(q,p);},execute:async(q,p)=>{await init();return db.execute(q,p);},transaction:async(s)=>{await init();return db.transaction(s);}},new ReadingProgressStore({get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);}}));
export const services: AppServices = {
  async readAccountStatus(){return accountStatusSnapshot(await summaryAccountStore.read(),Date.now(),readCloudAccountStatus());},
  subscribeAccountStatus(listener){const account=summaryAccountStore.subscribe(listener),cloud=subscribeCloudAccountStatus(listener);return ()=>{account();cloud();};},
  readingProgress: sqlReadingProgress,
  async retryOfflineMedia(id){await init();return retryStoredOfflineMedia(db,{stat:path=>fileChunks.stat(path),download:async(url,path,maxBytes)=>{await http.download(url,path,maxBytes).result;},remove:path=>fileChunks.remove(path)},Number(id));},
  loadImportedTextChunk(handle,index) {return importedTextStore.chunk(handle,index);},
  async getSpeechSource(article,anchor) { await init();return importedSpeechSource(db,importedTextStore,article,anchor); },
  async readSummaryUsage(){await init();return readUsage(db);},
  async clearSummaryUsage(){await init();await clearUsage(db);},
  subscribeSummaryUsage(listener){return subscribeUsageChanges(listener);},
  async hasSummaryAccount(){return !!(await summaryAccountStore.read())?.watchDeviceToken;},
  createSummary(id,preset,changed){return createSummarySession({query:async(sql,params)=>{await init();return db.query(sql,params);},execute:async(sql,params)=>{await init();return db.execute(sql,params);},transaction:db.transaction},id,preset,()=>originalArticle(id),changed);},
  async getChannelPlaybackSettings(id) {await init();const row=(await db.query("SELECT EXISTS(SELECT 1 FROM articles WHERE channel_id=? AND (COALESCE(audio_url,'')<>'' OR COALESCE(video_url,'')<>'')) has_media,COALESCE((SELECT continue_in_background FROM source_media_preferences WHERE channel_id=?),0) enabled",[Number(id),Number(id)]))[0];return {hasPlayableMedia:!!Number(row.has_media),continuePlaybackInBackground:!!Number(row.enabled)};},
  async setChannelBackgroundPlayback(id,enabled) {await init();await db.execute("INSERT INTO source_media_preferences(channel_id,continue_in_background) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET continue_in_background=excluded.continue_in_background",[Number(id),enabled?1:0]);},
  async getChannelOriginalMode(id) { await init(); return (await repo.getSourcePreferences(Number(id))).useOriginalContent; },
  async setChannelOriginalMode(id,enabled) { await init(); await repo.setSourcePreferences(Number(id),{useOriginalContent:enabled}); void refreshChannel(id,true).catch(error=>emitChannel({id,kind:"error",message:String(error)})); },
  async moveChannelToTop(id) { await init(); await localRssActions.moveChannelToTop(Number(id)); },
  async setChannelPinned(id,pinned) { await init(); await localRssActions.setChannelPinned(Number(id),pinned); },
  async markChannelRead(id) { await init(); await localRssActions.markChannelRead(Number(id)); },
  async deleteChannel(id) { await init(); const channel=(await db.query('SELECT id,url FROM channels WHERE id=?',[Number(id)]))[0];if(!channel)return;const itemIds=(await db.query('SELECT id FROM articles WHERE channel_id=?',[Number(id)])).map(row=>Number(row.id));const job=refreshJobs.get(id);if(job){job.cancelled=true;job.cancel?.();}originalCache.cancelChannel(id);await repo.removeChannel(Number(id));await cleanupRemovedContent({itemIds,channels:[{id:Number(channel.id),url:String(channel.url)}]}); },
  async deleteArticle(id) { await init();await new ImportedArticleDeletion(db,hostSyncText,hostArticleBodyCodec,fileChunks,itemId=>originalCache.cancelItems([String(itemId)])).delete(Number(id));emitChannel({id:"*",kind:"library"}); },
  async clearLocalContent(id) {
    await init();
    const row=(await db.query("SELECT url FROM channels WHERE id=?",[Number(id)]))[0];
    if(!row||!isDeletableLocalContentChannel(String(row.url)))return;
    const job=refreshJobs.get(id);
    if(job){job.cancelled=true;job.cancel?.();await job.promise.catch(()=>{});}
    originalCache.cancelChannel(id);
    const itemIds=(await db.query('SELECT id FROM articles WHERE channel_id=?',[Number(id)])).map(row=>Number(row.id));
    await repo.clearLocalContent(Number(id));
    await cleanupRemovedContent({itemIds,channels:[]});
    emitChannel({id,kind:"refresh"});
  },
  setOriginalUpdatesPaused(id,paused) { originalCache.setPaused(id,paused); },
  async requestOriginalContents(id,articles) { await init();const channel=(await db.query('SELECT url FROM channels WHERE id=?',[Number(id)]))[0];if(!channel||isImportedContentUrl(String(channel.url)))return;await originalCache.prefetch(id,articles); },
  subscribeChannel(listener) { channelListeners.add(listener);return ()=>channelListeners.delete(listener); },
  async listChannels() { await init(); return (await db.query(`SELECT c.*,COALESCE(p.use_original_content,0) use_original_content,
    CASE WHEN s.sort_order IS NOT NULL THEN s.sort_order WHEN c.sort_order<0 THEN -c.sort_order ELSE c.sort_order END logical_sort_order,
    (SELECT COUNT(*) FROM articles a WHERE a.channel_id=c.id AND a.is_read=0) unread_count
    FROM channels c LEFT JOIN source_preferences p ON p.channel_id=c.id
    LEFT JOIN sync_source_states s ON s.url=c.url AND s.deleted=0
    ORDER BY c.is_pinned DESC,logical_sort_order DESC,c.created_at DESC`)).map(r => ({ id:String(r.id),title:String(r.title),url:String(r.url),description:r.description == null ? null : String(r.description),imageUrl:r.image_url == null ? null : String(r.image_url),isPinned:Boolean(Number(r.is_pinned)),sortOrder:Number(r.logical_sort_order),createdAt:Number(r.created_at),useOriginalContent:Boolean(Number(r.use_original_content)),lastFetchedAt:r.last_fetched_at == null ? null : Number(r.last_fetched_at),unreadCount:Number(r.unread_count) })); },
  async listArticles(query: ArticleQuery = {}) {
    await init();
    const conditions: string[] = [], params: unknown[] = [];
    if(query.channelId) { conditions.push("a.channel_id=?"); params.push(Number(query.channelId)); }
    const saveType=query.saveType ?? (query.saved ? "favorite" : undefined);
    if(saveType) { conditions.push("s.saved=1 AND s.save_type=?"); params.push(saveType); }
    if(query.query?.trim()) {
      const pattern=`%${query.query.trim().replace(/\\/g,'\\\\').replace(/%/g,'\\%').replace(/_/g,'\\_')}%`;
      conditions.push("(a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM article_body_chunks b WHERE b.article_id=a.id AND b.body LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM article_original_chunks o WHERE o.article_id=a.id AND o.body LIKE ? ESCAPE '\\'))");
      params.push(pattern,pattern,pattern,pattern,pattern,pattern);
    }
    // The native feed exposes up to 200 rows plus one lookahead row for hasMore.
    const pageSize = Math.max(1,Math.min(201,Math.floor(query.pageSize ?? 30)));
    const offset = Math.max(0,Math.floor(query.offset ?? Math.max(0,Math.floor(query.page ?? 0))*pageSize));
    params.push(pageSize,offset);
    return (await db.query(`SELECT a.id,a.channel_id,a.title,a.pub_date,a.is_read,a.is_saved,a.link,a.image_url,a.audio_url,a.video_url,p.summary,p.image_url preview_image_url,CASE WHEN p.article_id IS NULL THEN substr(a.content,1,4096) END preview_content,EXISTS(SELECT 1 FROM article_saved_states w WHERE w.article_id=a.id AND w.save_type='watchLater' AND w.saved=1) is_watch_later,substr(a.description,1,2048) description,c.title channel_title${saveType ? ",COALESCE(t.created_at,s.changed_at) saved_at,s.sort_order save_sort_order" : ""} FROM articles a JOIN channels c ON c.id=a.channel_id LEFT JOIN article_previews p ON p.article_id=a.id ${saveType ? "JOIN article_saved_states s ON s.article_id=a.id LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type" : ""} ${conditions.length ? "WHERE "+conditions.join(" AND "):""} ORDER BY ${saveType ? "s.sort_order,s.changed_at DESC," : ""} a.fetched_at DESC,a.id DESC LIMIT ? OFFSET ?`, params)).map(mapArticle);
  },
  async searchArticles(channelId,keyword){
    await init();const term=keyword.trim();if(!term||!channelId)return [];
    const pattern=`%${term.replace(/\\/g,'\\\\').replace(/%/g,'\\%').replace(/_/g,'\\_')}%`;
    // Native Room searches the complete content/originalContent string. Our long bodies
    // are chunked, so an adjacent-chunk join must also inspect the seam.
    const seam=`substr(b.body,-(length(q.term)-1)) || substr(n.body,1,length(q.term)-1) LIKE q.pattern ESCAPE '\\'`;
    const originalSeam=seam.replaceAll('b.body','o.body').replaceAll('n.body','onext.body');
    const rows=await db.query(`WITH q(term,pattern) AS (VALUES(?,?))
      SELECT a.id,a.channel_id,a.title,a.pub_date,a.is_read,a.is_saved,a.link,a.image_url,a.audio_url,a.video_url,
      substr(p.summary,1,256) summary,p.image_url preview_image_url,substr(a.content,1,256) preview_content,
      EXISTS(SELECT 1 FROM article_saved_states w WHERE w.article_id=a.id AND w.save_type='watchLater' AND w.saved=1) is_watch_later,
      substr(a.description,1,256) description,c.title channel_title,
      CASE WHEN a.description LIKE q.pattern ESCAPE '\\' THEN substr(a.description,max(1,instr(lower(a.description),lower(q.term))-35),210) END description_match,
      CASE WHEN a.content LIKE q.pattern ESCAPE '\\' THEN substr(a.content,max(1,instr(lower(a.content),lower(q.term))-35),210) END content_match,
      CASE WHEN p.summary LIKE q.pattern ESCAPE '\\' THEN substr(p.summary,max(1,instr(lower(p.summary),lower(q.term))-35),210) END summary_match,
      (SELECT substr(o.body,1,256) FROM article_original_chunks o WHERE o.article_id=a.id ORDER BY o.chunk_index LIMIT 1) original_preview,
      (SELECT substr(o.body,max(1,instr(lower(o.body),lower(q.term))-35),210) FROM article_original_chunks o WHERE o.article_id=a.id AND o.body LIKE q.pattern ESCAPE '\\' ORDER BY o.chunk_index LIMIT 1) original_match,
      (SELECT substr(o.body,-(length(q.term)+35)) || substr(onext.body,1,length(q.term)+175)
         FROM article_original_chunks o JOIN article_original_chunks onext ON onext.article_id=o.article_id AND onext.chunk_index=o.chunk_index+1
         WHERE o.article_id=a.id AND length(q.term)>1 AND ${originalSeam} ORDER BY o.chunk_index LIMIT 1) original_seam_match,
      (SELECT substr(b.body,max(1,instr(lower(b.body),lower(q.term))-35),210) FROM article_body_chunks b WHERE b.article_id=a.id AND b.body LIKE q.pattern ESCAPE '\\' ORDER BY b.chunk_index LIMIT 1) body_match,
      (SELECT substr(b.body,-(length(q.term)+35)) || substr(n.body,1,length(q.term)+175)
         FROM article_body_chunks b JOIN article_body_chunks n ON n.article_id=b.article_id AND n.chunk_index=b.chunk_index+1
         WHERE b.article_id=a.id AND length(q.term)>1 AND ${seam} ORDER BY b.chunk_index LIMIT 1) body_seam_match
      FROM articles a JOIN channels c ON c.id=a.channel_id LEFT JOIN article_previews p ON p.article_id=a.id CROSS JOIN q
      WHERE a.channel_id=? AND (a.title LIKE q.pattern ESCAPE '\\' OR a.description LIKE q.pattern ESCAPE '\\' OR a.content LIKE q.pattern ESCAPE '\\' OR p.summary LIKE q.pattern ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM article_body_chunks b WHERE b.article_id=a.id AND b.body LIKE q.pattern ESCAPE '\\')
        OR EXISTS(SELECT 1 FROM article_original_chunks o WHERE o.article_id=a.id AND o.body LIKE q.pattern ESCAPE '\\')
        OR EXISTS(SELECT 1 FROM article_body_chunks b JOIN article_body_chunks n ON n.article_id=b.article_id AND n.chunk_index=b.chunk_index+1 WHERE b.article_id=a.id AND length(q.term)>1 AND ${seam})
        OR EXISTS(SELECT 1 FROM article_original_chunks o JOIN article_original_chunks onext ON onext.article_id=o.article_id AND onext.chunk_index=o.chunk_index+1 WHERE o.article_id=a.id AND length(q.term)>1 AND ${originalSeam}))
      ORDER BY a.fetched_at DESC,a.id DESC LIMIT 120`,
      [term,pattern,Number(channelId)]);
    const value=(row:Record<string,unknown>,key:string)=>row[key]==null?'':String(row[key]);
    return rows.map(row=>{const article=mapArticle(row),description=value(row,'description_match')||value(row,'description');
      const original=value(row,'original_match')||value(row,'original_seam_match')||value(row,'original_preview');
      const body=original||value(row,'content_match')||value(row,'body_match')||value(row,'body_seam_match')||value(row,'preview_content');
      const content=importedTextFileName(body)?'':body;
      article.searchSnippet=searchSnippet(term,description,content,value(row,'summary_match')||value(row,'summary'));
      return article;});
  },
  async getArticle(id) { appLogger.d('DetailScreen','Load article'); await init(); const rows=await db.query("SELECT a.id,a.channel_id,a.title,a.pub_date,a.is_read,a.is_saved,a.link,a.image_url,a.audio_url,a.video_url,p.summary,p.image_url preview_image_url,CASE WHEN p.article_id IS NULL THEN substr(a.content,1,4096) END preview_content,EXISTS(SELECT 1 FROM article_saved_states w WHERE w.article_id=a.id AND w.save_type='watchLater' AND w.saved=1) is_watch_later,substr(a.description,1,2048) description,c.title channel_title FROM articles a JOIN channels c ON c.id=a.channel_id LEFT JOIN article_previews p ON p.article_id=a.id WHERE a.id=?",[Number(id)],"reader.metadata"); if(!rows[0]) return null; const imported=await importedReaderHandle(db,importedTextStore,id); rows[0].content = imported.hasMarker ? "" : await repo.getArticleBody(Number(id)) ?? rows[0].description; const article=traceServiceWork("reader.mapArticle",()=>mapArticle(rows[0])); if(imported.handle)article.importedText=imported.handle; article.rawContent=String(rows[0].content??""); article.contentBlocks=await buildArticleBlocksAsync(article.rawContent!,article); article.content=traceServiceWork("reader.contentText",()=>contentText(article.contentBlocks!)); article.useOriginalContent=(await repo.getSourcePreferences(Number(article.channelId))).useOriginalContent; const offline=await readOfflineMedia(db,{stat:path=>fileChunks.stat(path)},Number(id));article.offlineMedia=offline.available;article.offlineMediaFailures=offline.failed;return article; },
  getOriginalArticle(id) { return originalArticle(id); },
  async addChannel(url) {
    await init();
    const input=normalizeAddChannelUrl(url);
    const parsedUri=await uri.parse(input,'android');
    if(!validAddChannelUrl(input,parsedUri?.scheme??null,parsedUri?.host??null))throw new Error('URL 不合法');
    const builtin=builtinForInput(input,parsedUri.host);
    if(builtin)return insertBuiltin(builtin);
    const existing=(await db.query('SELECT id,url,title,description FROM channels WHERE url=?',[input]))[0];
    if(existing)return {id:String(existing.id),url:String(existing.url),title:String(existing.title),description:existing.description==null?null:String(existing.description)};
    const xml=await fetchFeedText(input);
    const parsed=parseFeed(xml,Date.now(),input);
    const channel=await repo.addChannel(input,parsed.title);
    const result=await repo.refreshChannel(channel.id,xml);
    // Native addChannel uses its preview/confirm path: initial items are read.
    await db.execute('UPDATE articles SET is_read=1 WHERE channel_id=?',[channel.id]);
    return {id:String(channel.id),title:result.channel.title,url:channel.url,description:result.channel.description};
  },
  async previewChannel(url):Promise<AddChannelPreview> {
    await init();
    const input=normalizeAddChannelUrl(url);
    const parsedUri=await uri.parse(input,'android');
    if(!validAddChannelUrl(input,parsedUri?.scheme??null,parsedUri?.host??null))throw new Error('URL 不合法');
    const builtin=builtinForInput(input,parsedUri?.host??null);
    const target=builtin?.url??input;
    const existing=(await db.query('SELECT id,url,title,description FROM channels WHERE url=?',[target]))[0];
    if(existing)return {kind:'existing',channel:{id:String(existing.id),url:String(existing.url),title:String(existing.title),description:existing.description==null?null:String(existing.description)}};
    const xml=builtin?null:await fetchFeedText(input);
    const parsed=xml?parseFeed(xml,Date.now(),input):null;
    const token=`add-${++addPreviewSequence}`;
    if(pendingAddPreviews.size>=3)pendingAddPreviews.delete(pendingAddPreviews.keys().next().value!);
    pendingAddPreviews.set(token,{url:target,xml,builtin});
    return {kind:'ready',token,url:target,title:builtin?.title??parsed!.title,description:builtin?.description??parsed!.description};
  },
  async confirmAddChannel(token) {
    await init();
    const preview=pendingAddPreviews.get(token);
    if(!preview)throw new Error('预览已失效，请重新解析地址');
    const existing=(await db.query('SELECT id,url,title,description FROM channels WHERE url=?',[preview.url]))[0];
    if(existing){pendingAddPreviews.delete(token);return {id:String(existing.id),url:String(existing.url),title:String(existing.title),description:existing.description==null?null:String(existing.description)};}
    if(preview.builtin){const channel=await insertBuiltin(preview.builtin);pendingAddPreviews.delete(token);return channel;}
    const channel=await repo.addChannel(preview.url);
    const result=await repo.refreshChannel(channel.id,preview.xml!);
    // Native confirmAddChannel inserts the preview's initial articles as read.
    await db.execute('UPDATE articles SET is_read=1 WHERE channel_id=?',[channel.id]);
    pendingAddPreviews.delete(token);
    return {id:String(channel.id),url:channel.url,title:result.channel.title,description:result.channel.description};
  },
  async refresh(channelId) {
    await init();
    if(channelId){await refreshChannel(channelId);return;}
    let firstError:unknown;
    for(const channel of await repo.listChannels()){
      if(channel.url.startsWith("builtin:"))continue;
      try{await refreshChannel(String(channel.id));}catch(error){firstError??=error;}
    }
    if(firstError!==undefined)throw firstError;
  },
  async markRead(id) { await init(); await repo.setRead(Number(id)); },
  async toggleSaved(id,saved) { await init(); if(saved === undefined) { const rows=await db.query("SELECT is_saved FROM articles WHERE id=?",[Number(id)]); saved=!rows[0]?.is_saved; } await repo.setSaved(Number(id),saved); },
  async setSaveState(id,type,saved) { await init(); await repo.setSaveState(Number(id),type,saved); },
  async reorderSavedArticles(type,orderedIds) { await init();await repo.reorderSavedItems(type,orderedIds.map(Number)); },
  async listNotes(articleId) { await init(); return (await db.query(`SELECT n.*,a.title FROM notes n JOIN articles a ON a.id=n.article_id ${articleId ? "WHERE article_id=?":""} ORDER BY n.updated_at DESC LIMIT 100`,articleId?[Number(articleId)]:[])).map(mapNote); },
  async saveNote(note) { await init(); if(!note.articleId) throw new Error("请从文章页面创建笔记"); await repo.saveNote(Number(note.articleId),note.body); const rows=await db.query("SELECT n.*,a.title FROM notes n JOIN articles a ON a.id=n.article_id WHERE n.article_id=? ORDER BY n.id DESC LIMIT 1",[Number(note.articleId)]); return mapNote(rows[0]); },
  async speak(text: string, rate=1, started?:()=>void, progress?:(event:import("./reader/speech-highlight.ts").SpeechProgress)=>void) { await readerSpeech.speak(text,rate,started,progress); },
  async stopSpeech() { await readerSpeech.stop(); },
  input(title,value,options) { return textInput.prompt(title,value,options && hasCapability('input.text.state')?options:undefined).result; },
  inputRecovery:{
    pending:key=>hasCapability('input.text.state')?textInput.pending(key).result:Promise.resolve(false),
    dismiss:key=>hasCapability('input.text.state')?textInput.dismiss(key).result:Promise.resolve(),
  },
  openInlineInput(value,bounds,onChange,onSubmit,options) { return textInput.openInline(value,bounds,onChange,onSubmit,options); },
};


type ChannelEvent={id:string;kind:"refresh"|"original"|"error"|"library"|"notes";message?:string};
const channelListeners=new Set<(event:ChannelEvent)=>void>();
function emitChannel(event:ChannelEvent){for(const listener of channelListeners)try{listener(event);}catch{}}
type RefreshJob=OriginalDownload&{promise:Promise<void>};
const refreshJobs=new Map<string,RefreshJob>();
function refreshChannel(id:string,replace=false):Promise<void> {
  const previous=refreshJobs.get(id);if(previous&&!replace)return previous.promise;
  if(previous){previous.cancelled=true;previous.cancel?.();}
  const job:RefreshJob={cancelled:false,promise:Promise.resolve()};
  refreshJobs.set(id,job);
  job.promise=(async()=>{
    await init();
    const row=(await db.query("SELECT url FROM channels WHERE id=?",[Number(id)]))[0];if(!row)throw new Error("频道不存在");
    const url=String(row.url);if(isImportedContentUrl(url)||!/^https?:\/\//i.test(url))return;
    const xml=await fetchFeedText(url,job);if(job.cancelled)return;
    const current=(await db.query("SELECT url FROM channels WHERE id=?",[Number(id)]))[0];
    if(job.cancelled||String(current?.url??"")!==url)return;
    await repo.refreshChannel(Number(id),xml);if(!job.cancelled)emitChannel({id,kind:"refresh"});
  })().catch(error=>{if(!job.cancelled)throw error;}).finally(()=>{if(refreshJobs.get(id)===job)refreshJobs.delete(id);});
  return job.promise;
}
const originalCache=new OriginalContentCache(db,async(sourceUrl,job)=>{
  const path=`original/fetch-${Date.now()}-${++downloadSequence}.html`;
  try {
    const request=hostOperation<DownloadResult>("http.download",{url:sourceUrl,path,temporary:true,text:true,maxBytes:8*1024*1024,timeoutMs:30000,headers:{"User-Agent":"Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"}});
    job.cancel=()=>request.cancel();if(job.cancelled)request.cancel();
    const response=await request.result;
    const bytes=new Uint8Array(response.size);let offset=0;
    while(offset<bytes.length){if(job.cancelled)throw new Error("原文请求已取消");const chunk=await fileChunks.read(path,offset);const data=base64ToBytes(chunk.dataBase64);if(!data.length||data.length>bytes.length-offset||chunk.size!==bytes.length)throw new Error("原文下载不完整");bytes.set(data,offset);offset+=data.length;}
    appLogger.d('Network',`download bytes=${bytes.length}`);
    return utf8ToString(bytes);
  }finally{await fileChunks.remove(path).catch(()=>{});}
},2,id=>emitChannel({id,kind:"original"}));
const originalRequests=new Map<string,Promise<Article>>();
function originalArticle(id:string):Promise<Article>{
  const current=originalRequests.get(id);if(current)return current;
  const request=loadOriginalArticle(id).finally(()=>originalRequests.delete(id));originalRequests.set(id,request);return request;
}
async function loadOriginalArticle(id:string):Promise<Article>{
 appLogger.d('DetailScreen','Load original article');
  const article=await services.getArticle(id);if(!article)throw new Error("文章不存在");
  if(article.importedText||isImportedContentUrl(article.link))return article;
  const cached=await originalCache.get(id),sourceUrl=cached.sourceUrl,html=await hydrateStoredContent(cached.html);
  const contentBlocks=await buildArticleBlocksAsync(html,article);return {...article,rawContent:html,contentBlocks,content:contentText(contentBlocks),link:sourceUrl};
}

let librarySyncRepository:SqlLibrarySessionRepository|undefined;
/** Shared production adapter; the radio/IP session owners obtain it only after
 * schema and durable device identity initialization. */
export async function getLibrarySyncRepository():Promise<SqlLibrarySessionRepository>{
 await init();
 return librarySyncRepository??=new SqlLibrarySessionRepository(db,{
  codec:hostArticleBodyCodec,text:hostSyncText,uri:{parseUri:hostSyncText.parseUri,parseAndroid:value=>uri.parse(value,"android")},
  files:{storeText:(key,text)=>importedTextWriter.storeText(key,text),hydrate:hydrateStoredContent},
  migrateReading:id=>sqlReadingProgress.migrate(id),migrateReadingMany:ids=>sqlReadingProgress.migrateMany(ids),cleanupRemovedContent,
 });
}
async function cleanupRemovedContent(content:RemovedLibraryContent):Promise<void>{
 const refreshing:Promise<void>[]=[];
 for(const channel of content.channels){
  const id=String(channel.id),job=refreshJobs.get(id);if(job){job.cancelled=true;job.cancel?.();refreshing.push(job.promise);}
  originalCache.cancelChannel(id);
 }
 await originalCache.cancelItems(content.itemIds.map(String));
 for(const id of content.itemIds){
  if(!Number.isSafeInteger(id)||id<=0)continue;
  if(typeof fileChunks.list!=='function')continue;
  const directory=`offline/rss/${id}`;
  const listing=await fileChunks.list(directory).catch(()=>null);
  for(const entry of listing?.entries??[]){
   if(entry.file&&entry.path.startsWith(directory+'/')&&entry.path.slice(directory.length+1).indexOf('/')<0)
    await fileChunks.remove(entry.path).catch(()=>{});
  }
 }
 await Promise.allSettled(refreshing);
 if(content.channels.some(channel=>channel.url==='builtin:bili'))await managedCache.clearBucket('bili-preview');
 if(content.channels.some(channel=>channel.url==='builtin:douyin'))await managedCache.clearBucket('douyin-preload');
 for(const channel of content.channels)emitChannel({id:String(channel.id),kind:"refresh"});
}

/** Notify visible collections after a completed phone-library action. */
export function notifyLibraryChanged(){emitChannel({id:"*",kind:"library"});}

export function notifyNotesChanged(){emitChannel({id:"*",kind:"notes"});}
