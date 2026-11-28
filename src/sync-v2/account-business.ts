import {normalizeStoredNoteConflicts} from '../notes/conflict-migration';
import {conflictSet} from './note-conflict-set';
import {NOTE_ASSET_SCHEMA,NOTE_ASSET_WITNESS_SCHEMA} from './note-assets';
/** Prepared replacement of the authenticated account projection in the original
 * watch database. No LWW merge: explicit account choices can select older clocks.
 * Body files are retained; N07 and content pins own physical reclamation. */
import type {ProjectionSql,Statement} from '@podjs/framework/sql-projection';
import {canonical,bytes,entityKey,type Scope} from './protocol';
import {sha256Hex} from '@podjs/framework/crypto';
import {fromWire,toWire} from './business';
import type {WatchProjectionStore,SourceRecord} from './store';
import type {SyncState} from './state';
import type {AccountBusinessPort} from './account-control';
import type {WatchBusinessClosure} from './business-closure';
import {nativeTrim} from '../sync/local-manifest';
import {deviceOrder} from '../sync/saved-state';
import {ARTICLE_REGISTER_FEATURE,readArticleRegisters} from '../cloud/article-register';
import {articleProjectionSignature} from '../sync/article-register-store';
import {rssSourceKey,rssArticleId} from '../cloud/rss-identity';
import {noteUpsert,upsert} from './note-rows';
import {arrayRecordFeed,feedPages,wireDigest,type RecordFeed,type StatementFeed} from './record-feed';
export {noteUpsert};
export class WatchAccountBusinessSql implements AccountBusinessPort {
 constructor(private readonly db:ProjectionSql,private readonly projection:WatchProjectionStore,private readonly scope:Scope,private readonly idKey:Uint8Array,private readonly closures:Pick<WatchBusinessClosure,'recoveryValue'>,readonly verifyBody:AccountBusinessPort['verifyBody'],readonly reserve:AccountBusinessPort['reserve'],private readonly articleLocalRevision?:(id:string,entity:string)=>Promise<string|undefined>){}
 recoveryValue(id:string){return this.closures.recoveryValue(id);}
 /** Additive metadata table for interaction records which have no local article
  * yet. No body materialization or identity replacement occurs. */
 async initialize(){return WatchAccountBusinessSql.initializeSchema(this.db);}
 static async initializeSchema(db:ProjectionSql){await db.transaction([{sql:NOTE_ASSET_SCHEMA},{sql:NOTE_ASSET_WITNESS_SCHEMA},{sql:'CREATE TABLE IF NOT EXISTS syncv2_rss_states(id TEXT PRIMARY KEY,state_json TEXT NOT NULL)'},{sql:'CREATE TABLE IF NOT EXISTS note_merge_conflicts(conflict_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,base_markdown TEXT NOT NULL,local_markdown TEXT NOT NULL,remote_markdown TEXT NOT NULL,remote_device_id TEXT NOT NULL,created_at INTEGER NOT NULL)'},{sql:'CREATE TABLE IF NOT EXISTS syncv2_note_resolutions(note_id TEXT NOT NULL,conflict_id TEXT NOT NULL,resolved_at INTEGER NOT NULL,PRIMARY KEY(note_id,conflict_id))'}]);await normalizeStoredNoteConflicts(db);}
 async prepare(records:SourceRecord[],before:SyncState){const out:Statement[]=[];for await(const page of this.prepareFeed(arrayRecordFeed(records,r=>entityKey(this.idKey,this.scope.repoId,r.kind,r.logicalId)),before).run())out.push(...page);return out;}
 /** R4: the same statements as `prepare`, produced page by page. Each run reads
  * the records twice and the candidates once; across records it keeps only
  * identities and the small source/article/reading facts later steps need. */
 prepareFeed(feed:RecordFeed,before:SyncState):StatementFeed{return {run:()=>this.statements(feed,before)};}
 /** The old native snapshot is already applied. Sources with cascading deletes
  * and RSS state that resolves across articles still use the complete feed. */
 async prepareDelta(records:SourceRecord[],before:SyncState){
  if(records.some(r=>r.kind==='rss-state'||r.kind==='source'&&r.value.deleted))return null;
  const retired=new Set<string>();
  for(const url of new Set(records.filter(r=>r.kind==='article'&&r.value.rssSourceUrl).map(r=>r.value.rssSourceUrl as string))){
   if((await this.db.query('SELECT 1 FROM sync_source_states WHERE url=? AND deleted=1',[url])).length)retired.add(url);
  }
  const feed=arrayRecordFeed(records,r=>entityKey(this.idKey,this.scope.repoId,r.kind,r.logicalId)),out:Statement[]=[];
  for await(const page of this.statements(feed,before,retired))out.push(...page);
  return out;
 }
 private async *statements(feed:RecordFeed,before:SyncState,deltaRetired?:ReadonlySet<string>):AsyncGenerator<Statement[]>{
  const statements:Statement[]=[],unchanged=new Set<string>(),facts=feed.facts,count=facts.length;
  let keepsArticleBody=false;
  const sources=facts.flatMap(f=>f.source?[f.source]:[]),articles=facts.filter(f=>f.kind==='article'),readings=facts.filter(f=>f.kind==='book-reading');
  const current=before.cloud?.current,unchangedArticleRecipes=new Map<string,string>();
  const cloudArticleRevision=async(id:string,entity:string,contentHash:unknown):Promise<string|undefined>=>{
   if(!this.articleLocalRevision||!current||current.commitOid!==before.account?.oid)return;
   const cloud=await this.projection.cloudRow(current.treeRoot,entity);
   if(cloud?.meta.kind==='article'&&cloud.meta.logicalId===id&&cloud.meta.payload.contentHash===contentHash&&!cloud.row.deleted&&cloud.row.recipeOid)return cloud.row.bodyRevision;
  };
  for(const f of facts){
   const id=f.kind+'\0'+f.logicalId,entity=entityKey(this.idKey,this.scope.repoId,f.kind,f.logicalId);
   const c=await this.projection.readCandidate(entity);
   if(!c||c.meta.kind!==f.kind||c.meta.logicalId!==f.logicalId||wireDigest(f.kind,{meta:c.meta.payload,state:c.state.payload})!==f.wire)continue;
   unchanged.add(id);
   if(f.kind==='article'){
    const revision=await cloudArticleRevision(f.logicalId,entity,c.meta.payload.contentHash);
    if(revision)unchangedArticleRecipes.set(f.logicalId,revision);
   }
  }
  const removed:SourceRecord[]=[];
  if(!deltaRetired){
   const incoming=new Set(feed.keys);let after='';
   for(;;){
    const keys=await this.projection.candidateKeys(after);
    if(!keys.length)break;
    const missing=keys.filter(key=>!incoming.has(key));
    for(let at=0;at<missing.length;at+=32)for(const r of await this.projection.candidateBatch(missing.slice(at,at+32))){
     const c=r.candidate,v=c.meta.kind==='book-reading'?fromWire(c.meta.kind,c.meta.payload,c.state.payload):null;
     removed.push({kind:c.meta.kind,logicalId:c.meta.logicalId,value:v?{bookId:v.bookId,chapterIndex:v.chapterIndex}:{}});
    }
    after=keys.at(-1)!;
   }
  }
  if(!removed.length&&unchanged.size===count&&!unchangedArticleRecipes.size)return;
  const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  const requireTable=(table:string)=>{if(!tables.has(table))throw Error('unsupported_feature');};
  const retiredSources=new Set(deltaRetired??[...removed.filter(r=>r.kind==='source').map(r=>r.logicalId),...sources.filter(r=>r.value.deleted).map(r=>r.logicalId)]);
  // Detach retained articles before a source's FK cascade. Their physical IDs,
  // body receipts and reading rows must survive either record input order.
  for(const r of articles.filter(r=>retiredSources.has(r.rssSourceUrl as string))){requireTable('channels');requireTable('articles');statements.push({sql:"INSERT OR IGNORE INTO channels(url,title,created_at,sort_order) VALUES('watchrss://phone-imports','',0,0)"},{sql:"UPDATE articles SET channel_id=(SELECT id FROM channels WHERE url='watchrss://phone-imports') WHERE id=COALESCE((SELECT item_id FROM article_register_state WHERE article_id=?),(SELECT item_id FROM sync_article_ids WHERE article_id=?))",params:[r.logicalId,r.logicalId]});}

  if(tables.has('sync_book_context'))statements.push({sql:'UPDATE sync_book_context SET remote=1 WHERE id=1'});if(tables.has('sync_book_reading_projection'))statements.push({sql:'UPDATE sync_book_reading_projection SET active=1 WHERE id=1'});
  for(const r of removed){
   if(r.kind==='note'){requireTable('memo_notes');statements.push({sql:'DELETE FROM memo_notes WHERE note_id=?',params:[r.logicalId]});if(tables.has('note_merge_conflicts'))statements.push({sql:'DELETE FROM note_merge_conflicts WHERE note_id=?',params:[r.logicalId]});}
   else if(r.kind==='asset'){requireTable('memo_assets');statements.push({sql:'DELETE FROM memo_assets WHERE asset_id=?',params:[r.logicalId]});}
   else if(r.kind==='folder'){requireTable('memo_folders');statements.push({sql:'DELETE FROM memo_folders WHERE folder_id=?',params:[r.logicalId]});}
   else if(r.kind==='source'){requireTable('sync_source_states');statements.push({sql:'DELETE FROM sync_source_states WHERE url=?',params:[r.logicalId]},{sql:'DELETE FROM channels WHERE url=?',params:[r.logicalId]});}
   else if(r.kind==='article'){requireTable('article_register_state');statements.push({sql:'DELETE FROM articles WHERE id=COALESCE((SELECT item_id FROM article_register_state WHERE article_id=?),(SELECT item_id FROM sync_article_ids WHERE article_id=?))',params:[r.logicalId,r.logicalId]},{sql:'DELETE FROM article_register_state WHERE article_id=?',params:[r.logicalId]});}
   else if(r.kind==='book'){requireTable('sync_books');statements.push({sql:'DELETE FROM articles WHERE id IN(SELECT item_id FROM sync_book_aliases WHERE book_id=?)',params:[r.logicalId]});for(const table of ['sync_book_aliases','sync_book_chapters','sync_book_reading','sync_book_events','sync_book_delete_members','sync_book_lifecycle_clock','sync_book_display','sync_books'])if(tables.has(table))statements.push({sql:`DELETE FROM ${table} WHERE book_id=?`,params:[r.logicalId]});}
   else if(r.kind==='book-reading'){requireTable('sync_book_reading');statements.push({sql:'DELETE FROM sync_book_reading WHERE book_id=? AND chapter_index=?',params:[r.value.bookId,r.value.chapterIndex]});}
   else if(r.kind==='rss-state'){requireTable('syncv2_rss_states');statements.push({sql:'DELETE FROM syncv2_rss_states WHERE id=?',params:[r.logicalId]});}
   // Asset bytes remain in the content store until all authenticated pins allow
   // collection. Removing an account row never deletes a native attachment.
  }
  for await(const page of feedPages(feed)){for(const r of page){let v=r.value;toWire(r.kind,v);const onlyCheckBody=unchanged.has(r.kind+'\0'+r.logicalId);if(onlyCheckBody&&(r.kind!=='article'||!unchangedArticleRecipes.has(r.logicalId)))continue;
   // Use the frozen legacy interpretation only for the native representation.
   // The authenticated v2 candidate remains byte-for-byte unchanged.
   if(r.kind==='article'&&!Object.hasOwn(v,'registerSources')){if(!Object.hasOwn(v,'contentHash')||!Object.hasOwn(v,'updatedAt'))throw Error('closure_incomplete');v=readArticleRegisters(JSON.stringify({format:'watchrss-rss-record',version:1,kind:'article',value:v}),true).value;}
   if(r.kind==='note'){
    requireTable('memo_notes');statements.push(...noteUpsert(v));
    if(v.noteConflicts){requireTable('note_merge_conflicts');requireTable('syncv2_note_resolutions');statements.push({sql:'DELETE FROM note_merge_conflicts WHERE note_id=?',params:[v.noteId]},{sql:'DELETE FROM syncv2_note_resolutions WHERE note_id=?',params:[v.noteId]});for(const c of conflictSet(v.noteId,v.noteConflicts.records).records){statements.push(upsert('note_merge_conflicts','conflict_id note_id base_markdown local_markdown remote_markdown remote_device_id created_at'.split(' '),[c.conflictId,c.noteId,c.baseMarkdown,c.localMarkdown,c.remoteMarkdown,c.remoteDeviceId,c.createdAt],['conflict_id']),upsert('syncv2_note_resolutions',['note_id','conflict_id','resolved_at'],[v.noteId,c.conflictId,c.resolvedAt],['note_id','conflict_id']));}}
   }else if(r.kind==='folder'){
    requireTable('memo_folders');statements.push(upsert('memo_folders','folder_id name sort_order updated_at modified_by deleted deleted_at'.split(' '),[v.folderId,v.name,v.sortOrder,v.updatedAt,v.modifiedBy,+v.deleted,v.deletedAt],['folder_id']));
   }else if(r.kind==='source'){
    // The native tables require defaults for optional fields in the signed row.
    const createdAt=v.createdAt??0,sortOrder=v.sortOrder??0,isPinned=v.isPinned?1:0;
    requireTable('sync_source_states');statements.push(upsert('sync_source_states','url source_device_id title description site_url image_url created_at updated_at sort_order is_pinned deleted deleted_at'.split(' '),[v.url,v.sourceDeviceId??'',v.title,v.description,v.siteUrl??null,v.imageUrl??null,createdAt,v.updatedAt,sortOrder,isPinned,+v.deleted,v.deletedAt],['url']));
    if(v.deleted)statements.push({sql:'DELETE FROM channels WHERE url=?',params:[v.url]});else statements.push(upsert('channels','url title description image_url created_at sort_order is_pinned'.split(' '),[v.url,v.title,nativeTrim(v.description)?v.description:v.siteUrl??null,v.imageUrl??null,createdAt,-sortOrder,isPinned],['url']));
    if(Object.hasOwn(v,'useOriginalContent'))statements.push({sql:'INSERT INTO source_preferences(channel_id,use_original_content) SELECT id,? FROM channels WHERE url=? ON CONFLICT(channel_id) DO UPDATE SET use_original_content=excluded.use_original_content',params:[+v.useOriginalContent,v.url]});
    if(Object.hasOwn(v,'continuePlaybackInBackground'))statements.push({sql:'INSERT INTO source_media_preferences(channel_id,continue_in_background) SELECT id,? FROM channels WHERE url=? ON CONFLICT(channel_id) DO UPDATE SET continue_in_background=excluded.continue_in_background',params:[+v.continuePlaybackInBackground,v.url]});
   }else if(r.kind==='book'){
    requireTable('sync_books');statements.push(upsert('sync_books',['book_id','fingerprint','chapter_count','state_json'],[v.bookId,v.fingerprint,v.chapterCount,JSON.stringify(v)],['book_id']));if(v.lifecycle&&tables.has('sync_book_lifecycle_clock'))statements.push(upsert('sync_book_lifecycle_clock',['book_id','started_at'],[v.bookId,v.lifecycle.startedAt],['book_id']));
    statements.push({sql:"UPDATE channels SET title=? WHERE url!='https://watchrss.local/import-content' AND url IN(SELECT channel_url FROM sync_book_aliases WHERE book_id=?)",params:[v.title,v.bookId]},{sql:"UPDATE articles SET title=? WHERE id IN(SELECT item_id FROM sync_book_aliases WHERE book_id=? AND channel_url='https://watchrss.local/import-content')",params:[v.title,v.bookId]});
    if(tables.has('sync_book_events'))statements.push({sql:'DELETE FROM sync_book_events WHERE book_id=?',params:[v.bookId]});if(tables.has('sync_book_delete_members')){statements.push({sql:'DELETE FROM sync_book_delete_members WHERE book_id=?',params:[v.bookId]});for(const n of v.deletedChapters)statements.push({sql:'INSERT INTO sync_book_delete_members VALUES(?,?)',params:[v.bookId,n]});}
    if(tables.has('sync_book_display')){const display=await this.db.query("SELECT DISTINCT CASE WHEN channel_url='https://watchrss.local/import-content' THEN 'a:'||item_id ELSE 'c:'||(SELECT channel_id FROM articles WHERE id=m.item_id) END AS key FROM sync_book_aliases m WHERE book_id=? AND item_id IS NOT NULL ORDER BY key",[v.bookId]);statements.push(upsert('sync_book_display',['book_id','projection'],[v.bookId,canonical(display.map(r=>({key:r.key,title:v.title})))],['book_id']));if(tables.has('sync_book_display_dirty'))statements.push({sql:'DELETE FROM sync_book_display_dirty WHERE book_id=?',params:[v.bookId]});}
    for(const chapter of v.deletedChapters)statements.push({sql:'DELETE FROM articles WHERE id IN(SELECT item_id FROM sync_book_aliases WHERE book_id=? AND chapter_index=?)',params:[v.bookId,chapter]});if(v.deleted)statements.push({sql:'DELETE FROM articles WHERE id IN(SELECT item_id FROM sync_book_aliases WHERE book_id=?)',params:[v.bookId]});
   }else if(r.kind==='book-reading'){
    requireTable('sync_book_reading');const columns='book_id chapter_index state_json is_read progress clock position hash source'.split(' '),values:any[]=[v.bookId,v.chapterIndex,JSON.stringify(v),+v.isRead,v.readingProgress,v.readingPositionChangedAt,v.readingPositionBytes,v.readingPositionContentHash,v.sourceDeviceId];
    for(const p of ['favorite','watchLater']){columns.push(p+'_saved',p+'_clock',p+'_order',p+'_source',p+'_source_order');values.push(v[p+'Saved']===undefined?null:+v[p+'Saved'],v[p+'ChangedAt']??null,v[p+'SortOrder']??null,v[p+'SourceDeviceId']??v.sourceDeviceId,deviceOrder(v[p+'SourceDeviceId']??v.sourceDeviceId));}
    statements.push(upsert('sync_book_reading',columns,values,['book_id','chapter_index']));for(const row of await this.db.query('SELECT DISTINCT item_id FROM sync_book_aliases WHERE book_id=? AND chapter_index=? AND item_id IS NOT NULL',[v.bookId,v.chapterIndex]))statements.push(...this.reading(Number(row.item_id),v));
   }else if(r.kind==='article'){
    requireTable('article_register_state');
    const old=(await this.db.query(`SELECT a.id AS item_id,r.state_json,r.body_pending,r.materialized_json,c.body_hash,e.content_hash AS accepted_hash,
      (a.description IS NOT ? OR a.link IS NOT ?) AS invalidates_body
     FROM articles a LEFT JOIN article_register_state r ON r.article_id=?
     LEFT JOIN article_sync_content c ON c.item_id=a.id
     LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash
     WHERE a.id=COALESCE(r.item_id,(SELECT item_id FROM sync_article_ids WHERE article_id=?))`,[v.excerpt??'',v.url,v.articleId,v.articleId]))[0];
    const channel=retiredSources.has(v.rssSourceUrl)?'watchrss://phone-imports':v.rssSourceUrl??'watchrss://phone-imports';

    // A Bluetooth body may be installed before this article has a v2 register.
    // Its native receipt binds the accepted content hash to the installed body.
    const accepted=!!old?.body_hash&&/^[a-f0-9]{64}$/.test(v.contentHash)&&old.accepted_hash===v.contentHash;
    const sameRegister=old?.state_json!=null&&JSON.parse(String(old.state_json)).value?.contentHash===v.contentHash;
    const registered=sameRegister&&Number(old.body_pending)===0&&!!old.body_hash&&!!old.materialized_json&&JSON.parse(String(old.materialized_json))[8]===old.body_hash;
    let sameBody=accepted||sameRegister,ready=accepted||registered;
    if(old?.body_hash&&!v.deleted&&this.articleLocalRevision){
     const entity=entityKey(this.idKey,this.scope.repoId,'article',v.articleId);
     const revision=onlyCheckBody?unchangedArticleRecipes.get(r.logicalId):await cloudArticleRevision(v.articleId,entity,v.contentHash);
     // The authenticated account binding takes precedence over the v1 receipt.
     if(revision)sameBody=ready=await this.articleLocalRevision(v.articleId,entity)===revision;
    }
    if(onlyCheckBody&&(!old?.body_hash||ready&&sameRegister&&Number(old.body_pending)===0))continue;
    const updatedAt=v.updatedAt??0;
    const initialTime=updatedAt>0?updatedAt:v.importedAt>0?v.importedAt:null;
    const initialFetch="COALESCE(?,max(1,CAST(strftime('%s','now') AS INTEGER)*1000))";
    statements.push({sql:'INSERT OR IGNORE INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,0)',params:[channel,v.rssSourceTitle??'',v.importedAt??0]},{sql:`INSERT OR IGNORE INTO articles(channel_id,title,description,link,dedup_key,fetched_at) SELECT id,?,?,?,?,${initialFetch} FROM channels WHERE url=? AND NOT EXISTS(SELECT 1 FROM sync_article_ids WHERE article_id=? AND item_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM article_register_state WHERE article_id=? AND item_id IS NOT NULL)`,params:[v.title??'',v.excerpt??'',v.url,v.articleId,initialTime,channel,v.articleId,v.articleId]},
     {sql:'INSERT INTO sync_article_ids(article_id,item_id,url) SELECT ?,a.id,? FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url=? AND a.dedup_key=? ON CONFLICT(article_id) DO UPDATE SET item_id=excluded.item_id,url=excluded.url WHERE item_id IS NULL',params:[v.articleId,v.url,channel,v.articleId]});
    // Preview/link writes invalidate caches via the native trigger. Preserve
    // only the verified version in the same SQL transaction, without copying
    // the body through the script or exempting other writers from the trigger.
    const keepBody=ready&&!v.deleted&&!!Number(old.invalidates_body);
    if(keepBody){
     if(!keepsArticleBody){
      statements.push({sql:'CREATE TEMP TABLE syncv2_kept_article_body AS SELECT * FROM article_sync_content WHERE 0'});
      keepsArticleBody=true;
     }
     statements.push({sql:'INSERT INTO syncv2_kept_article_body SELECT * FROM article_sync_content WHERE item_id=? AND body_hash=?',params:[old.item_id,old.body_hash]});
    }
    const item='COALESCE((SELECT item_id FROM article_register_state WHERE article_id=?),(SELECT item_id FROM sync_article_ids WHERE article_id=?))';
    // A public RSS refresh can advance fetched_at even after preparation.
    statements.push({sql:`UPDATE articles SET title=?,description=?,link=?,image_url=?,guid=?,
     fetched_at=CASE WHEN fetched_at>0 THEN max(fetched_at,?) ELSE ${initialFetch} END WHERE id=${item}`,
     params:[v.title??'',v.excerpt??'',v.url,v.imageUrl??null,v.guid??null,updatedAt,initialTime,v.articleId,v.articleId]});
    const witness=articleProjectionSignature(v.deleted?undefined:{title:v.title??'',description:v.excerpt??'',image_url:v.imageUrl??null,link:v.url,is_read:+!!v.isRead,is_saved:+!!v.favoriteSaved,reading_progress:v.readingProgress??0,body_hash:sameBody?old?.body_hash??null:null},v.deleted?undefined:{progress:v.readingProgress??0,changed_at:v.readingPositionChangedAt??0,position_bytes:v.readingPositionBytes??0,position_hash:v.readingPositionContentHash??''},v.deleted?[]:['favorite','watchLater'].filter(p=>Object.hasOwn(v,p+'Saved')).map(p=>({save_type:p,saved:+v[p+'Saved'],changed_at:v[p+'ChangedAt'],sort_order:-v[p+'SortOrder']})),v.deleted?{changed_at:v.deletedAt,source_device_id:v.registerSources?.deletion??v.sourceDeviceId??''}:undefined);
    // Slot 7 of the native projection signature is the persisted fetched_at.
    const materialized=v.deleted?'?':`json_set(?, '$[7]', COALESCE((SELECT fetched_at FROM articles WHERE id=${item}),0))`;
    const doc=JSON.stringify({format:'watchrss-rss-record',version:1,kind:'article',value:v,...(Object.hasOwn(v,'registerSources')?{features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]}}:{})});
    statements.push({sql:`INSERT INTO article_register_state(article_id,item_id,state_json,raw_json,materialized_json,body_pending) VALUES(?,(SELECT item_id FROM sync_article_ids WHERE article_id=?),?,?,${materialized},?) ON CONFLICT(article_id) DO UPDATE SET item_id=COALESCE(article_register_state.item_id,excluded.item_id),state_json=excluded.state_json,raw_json=excluded.raw_json,pending_json=NULL,raw_conflict=0,materialized_json=excluded.materialized_json,body_pending=excluded.body_pending`,
     params:[v.articleId,v.articleId,doc,doc,witness,...(v.deleted?[]:[v.articleId,v.articleId]),v.deleted||ready?0:1]});
    if(keepBody)statements.push({sql:'INSERT OR IGNORE INTO article_sync_content SELECT * FROM syncv2_kept_article_body'},{sql:'DELETE FROM syncv2_kept_article_body'});
    statements.push({sql:'DELETE FROM article_register_conflicts WHERE article_id=?',params:[v.articleId]});
    if(old?.item_id){if(!sameBody)statements.push({sql:'UPDATE articles SET content=NULL WHERE id=?',params:[old.item_id]},...['article_body_chunks','article_original_chunks','article_sync_content','article_sync_encoding_cache'].map(table=>({sql:`DELETE FROM ${table} WHERE ${table.startsWith('article_sync_')?'item_id':'article_id'}=?`,params:[old.item_id]})));}statements.push(...this.articleReading(v.articleId,v));if(v.deleted)statements.push(upsert('sync_article_deletions',['article_id','url','changed_at','source_device_id','source_order'],[v.articleId,v.url,v.deletedAt,v.registerSources?.deletion??v.sourceDeviceId??'',deviceOrder(v.registerSources?.deletion??v.sourceDeviceId??'')],['article_id']));else statements.push({sql:'DELETE FROM sync_article_deletions WHERE article_id=?',params:[v.articleId]});if(v.deleted)statements.push({sql:'DELETE FROM articles WHERE id=(SELECT item_id FROM article_register_state WHERE article_id=?)',params:[v.articleId]});
   }else if(r.kind==='rss-state'){
    requireTable('syncv2_rss_states');statements.push(upsert('syncv2_rss_states',['id','state_json'],[r.logicalId,JSON.stringify(v)],['id']));
    const sha=async(b:Uint8Array)=>sha256Hex(b);let afterId=0;
    for(;;){const page=await this.db.query('SELECT a.id,a.link,a.guid,a.dedup_key,c.url FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id>? ORDER BY a.id LIMIT 32',[afterId]);if(!page.length)break;for(const a of page){const source=await rssSourceKey(String(a.url),sha);if(source!==v.sourceId&&!sources.some(s=>s.value.url===a.url&&s.value.sourceId===v.sourceId))continue;const article=await rssArticleId({link:String(a.link??''),guid:a.guid===null?null:String(a.guid),dedupKey:/^[a-f0-9]{64}$/.test(String(a.dedup_key))?String(a.dedup_key):undefined},sha);if(sha256Hex(bytes(article))===v.articleIdHash)statements.push(...this.reading(Number(a.id),v));}afterId=Number(page.at(-1)!.id);}
   }else if(r.kind==='asset'){requireTable('memo_assets');statements.push(upsert('memo_assets','asset_id mime original_filename updated_at source_device_id deleted deleted_at'.split(' '),[v.assetId,v.mime,v.originalFilename,v.updatedAt,v.sourceDeviceId,+v.deleted,v.deletedAt],['asset_id']));}
   else throw Error('unsupported_feature');
  }if(statements.length)yield statements.splice(0);}
  if(keepsArticleBody)statements.push({sql:'DROP TABLE syncv2_kept_article_body'});
  if(tables.has('sync_book_reading_dirty'))for(const r of readings)statements.push({sql:'DELETE FROM sync_book_reading_dirty WHERE item_id IN(SELECT item_id FROM sync_book_aliases WHERE book_id=? AND chapter_index=?)',params:[r.bookId,r.chapterIndex]});if(tables.has('sync_book_reading_projection'))statements.push({sql:'UPDATE sync_book_reading_projection SET active=0 WHERE id=1'});if(tables.has('sync_book_context'))statements.push({sql:'UPDATE sync_book_context SET remote=0 WHERE id=1'});
  if(statements.length)yield statements;
 }
 private articleReading(id:string,v:any):Statement[]{
  const out:Statement[]=[],source=v.registerSources?.reading??v.sourceDeviceId??'';
  if(Object.hasOwn(v,'readingPositionChangedAt'))out.push({sql:'UPDATE articles SET is_read=?,reading_progress=? WHERE id=(SELECT item_id FROM article_register_state WHERE article_id=?)',params:[+!!v.isRead,v.readingProgress??0,id]},
   {sql:'INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) SELECT item_id,?,?,?,?,NULL FROM article_register_state WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(article_id) DO UPDATE SET progress=excluded.progress,changed_at=excluded.changed_at,position_bytes=excluded.position_bytes,position_hash=excluded.position_hash,state_json=NULL',params:[v.readingProgress??0,v.readingPositionChangedAt,v.readingPositionBytes??0,v.readingPositionContentHash??'',id]},
   {sql:'INSERT INTO native_reading_sources(item_id,source_device_id,changed_at) SELECT item_id,?,? FROM article_register_state WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET source_device_id=excluded.source_device_id,changed_at=excluded.changed_at',params:[source,v.readingPositionChangedAt,id]});
  for(const p of ['favorite','watchLater'])if(Object.hasOwn(v,p+'Saved'))out.push({sql:'INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT item_id,?,?,?,? FROM article_register_state WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order',params:[p,+v[p+'Saved'],v[p+'ChangedAt'],-v[p+'SortOrder'],id]});
  for(const p of ['favorite','watchLater'])if(Object.hasOwn(v,p+'Saved')){const provenance=v.registerSources?.[p]??v.sourceDeviceId??'';out.push({sql:'INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) SELECT article_id,?,item_id,?,?,?,?,?,? FROM article_register_state WHERE article_id=? ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=excluded.item_id,url=excluded.url,saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order,source_device_id=excluded.source_device_id,source_order=excluded.source_order',params:[p,v.url,+v[p+'Saved'],v[p+'ChangedAt'],v[p+'SortOrder'],provenance,deviceOrder(provenance),id]});}
  if(Object.hasOwn(v,'favoriteSaved'))out.push({sql:'UPDATE articles SET is_saved=? WHERE id=(SELECT item_id FROM article_register_state WHERE article_id=?)',params:[+v.favoriteSaved,id]});return out;
 }
 private reading(itemId:number,v:any):Statement[]{const out:Statement[]=[];if(Object.hasOwn(v,'readingPositionChangedAt'))out.push({sql:'UPDATE articles SET is_read=?,reading_progress=? WHERE id=?',params:[+!!v.isRead,v.readingProgress??0,itemId]},upsert('article_reading_state',['article_id','progress','changed_at','position_bytes','position_hash','state_json'],[itemId,v.readingProgress??0,v.readingPositionChangedAt,v.readingPositionBytes??0,v.readingPositionContentHash??'',null],['article_id']));for(const p of ['favorite','watchLater'])if(Object.hasOwn(v,p+'Saved'))out.push(upsert('article_saved_states',['article_id','save_type','saved','changed_at','sort_order'],[itemId,p,+v[p+'Saved'],v[p+'ChangedAt'],-v[p+'SortOrder']],['article_id']));if(Object.hasOwn(v,'favoriteSaved'))out.push({sql:'UPDATE articles SET is_saved=? WHERE id=?',params:[+v.favoriteSaved,itemId]});for(const p of ['favorite','watchLater'])if(Object.hasOwn(v,p+'Saved')){const source=v.registerSources?.[p]??v[p+'SourceDeviceId']??v.sourceDeviceId??'';out.push({sql:'UPDATE sync_saved_states SET saved=?,changed_at=?,sort_order=?,source_device_id=?,source_order=? WHERE item_id=? AND save_type=?',params:[+v[p+'Saved'],v[p+'ChangedAt'],v[p+'SortOrder'],source,deviceOrder(source),itemId,p]});}return out;}
}
