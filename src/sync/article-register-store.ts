import {querySyncPages} from './sql-pages';
import type {SqlDatabase,SqlParams} from '../core/types';
import type {RecordDocument} from '../cloud/records';
import {ARTICLE_REGISTER_FEATURE,readArticleRegisters,normalizeArticleRegisters,mergeArticleRegisters,articleKnownCanonical} from '../cloud/article-register';
import {cloudRaw,rawJsonText} from '../cloud/compatibility';
import {utf8Encode} from '../cloud/types';
import {deviceOrder} from './saved-state';
import {libraryRevision,revisionGuard} from './revision';
import type {PreparedArticle,ExportedArticle} from './article-export';
import type {ArticleReceiveFiles} from './article-receiver';
export const ARTICLE_REGISTER_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS article_register_state(article_id TEXT PRIMARY KEY,item_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,state_json TEXT NOT NULL,legacy_json TEXT,materialized_json TEXT,pending_json TEXT,raw_json TEXT NOT NULL,raw_conflict INTEGER NOT NULL DEFAULT 0,body_pending INTEGER NOT NULL DEFAULT 0)`,
 `CREATE INDEX IF NOT EXISTS article_register_state_item ON article_register_state(item_id)`,
 `CREATE TABLE IF NOT EXISTS article_register_conflicts(article_id TEXT NOT NULL REFERENCES article_register_state(article_id) ON DELETE CASCADE,version_hash TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(article_id,version_hash))`,
];
type Statement={sql:string;params?:SqlParams};
/** Business evidence, not an encoding cache. A legacy witness is frozen only
 * once, on the first protected receipt. No startup scan/re-encryption occurs. */
export class ArticleRegisterStore {
 constructor(private db:SqlDatabase,private hash:(b:Uint8Array)=>Promise<string>){}
 async documents():Promise<RecordDocument[]>{const rows=await querySyncPages(this.db,'SELECT state_json,pending_json,raw_conflict FROM article_register_state ORDER BY article_id');return rows.map(r=>({...readArticleRegisters(String(r.state_json)),pendingEdit:r.pending_json!=null||Number(r.raw_conflict)===1}));}
 async protected(articleId:string){return (await this.db.query('SELECT article_id FROM article_register_state WHERE article_id=?',[articleId])).length>0;}
 /** Already authenticated archive/body input may fill only the selected version.
  * It never carries a reading/save/deletion operation into the register merge. */
 async restoreBody(article:ExportedArticle,prepared:PreparedArticle,files:ArticleReceiveFiles){
  const revision=await libraryRevision(this.db),row=(await this.db.query('SELECT * FROM article_register_state WHERE article_id=?',[article.articleId]))[0];
  if(!row||row.pending_json!=null||!Number(row.body_pending)||!row.item_id)return 0;
  const v=readArticleRegisters(String(row.state_json)).value;
  if(v.deleted||article.contentHash!==v.contentHash||!(article.contentText.trim()||article.contentHtml?.trim()))return 0;
  const store=async(text:string|null,suffix:string)=>text===null?null:text.length<=50000?text:files.storeText(article.articleId+'-'+suffix,text);
  const text=await store(article.contentText,'text'),html=await store(article.contentHtml,'html'),body=html??text;
  const manifest=prepared.manifest,id=Number(row.item_id),signature=JSON.parse(String(row.materialized_json));
  if(!Array.isArray(signature)||signature.length<9)throw Error('cloud_format_article_witness_invalid');signature[8]=manifest.bodyHash;
  await this.db.transaction([revisionGuard(revision),
   {sql:'UPDATE articles SET content=? WHERE id=?',params:[body,id]},
   ...['article_body_chunks','article_original_chunks'].map(table=>({sql:`DELETE FROM ${table} WHERE article_id=?`,params:[id]})),
   {sql:'INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,0,?)',params:[id,body]},
   {sql:'INSERT INTO article_original_meta(article_id,source_url,fetched_at) VALUES(?,?,?) ON CONFLICT(article_id) DO UPDATE SET source_url=excluded.source_url,fetched_at=excluded.fetched_at',params:[id,v.url,v.updatedAt]},
   {sql:'INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET content_html=excluded.content_html,content_text=excluded.content_text,body_hash=excluded.body_hash,body_bytes=excluded.body_bytes,chunk_size=excluded.chunk_size,chunk_hashes=excluded.chunk_hashes,content_bytes=excluded.content_bytes',params:[id,html,text,manifest.bodyHash,manifest.bodyByteCount,manifest.chunkSize,JSON.stringify(manifest.chunkHashes),utf8Encode(article.contentHtml??article.contentText).length]},
   {sql:'UPDATE article_register_state SET body_pending=0,materialized_json=? WHERE article_id=? AND state_json=?',params:[JSON.stringify(signature),article.articleId,row.state_json]},
  ]);return 1;
 }
 private async projection(articleId:string){
  const row=(await this.db.query(`SELECT a.id,a.title,a.description,a.image_url,a.link,a.is_read,a.is_saved,a.reading_progress,a.fetched_at,c.body_hash,e.content_hash AS accepted_hash FROM articles a LEFT JOIN article_sync_content c ON c.item_id=a.id LEFT JOIN article_sync_encoding_cache e ON e.item_id=a.id AND e.body_hash=c.body_hash WHERE a.id=COALESCE((SELECT item_id FROM article_register_state WHERE article_id=?),(SELECT item_id FROM sync_article_ids WHERE article_id=?),(SELECT item_id FROM cloud_rss_article_ids WHERE article_id=?))`,[articleId,articleId,articleId]))[0];
  const id=Number(row?.id??0),reading=(await this.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state WHERE article_id=?',[id]))[0];
  const saved=await this.db.query('SELECT save_type,saved,changed_at,sort_order FROM article_saved_states WHERE article_id=? ORDER BY save_type',[id]);
  const deletion=(await this.db.query('SELECT changed_at,source_device_id FROM sync_article_deletions WHERE article_id=?',[articleId]))[0];
  const sig=this.signature(row,reading,saved,deletion);return {row,reading,saved,deletion,sig};
 }
 private signature(row:Record<string,unknown>|undefined,reading:Record<string,unknown>|undefined,saved:Record<string,unknown>[],deletion:Record<string,unknown>|undefined){
  const save=(p:string)=>{const s=saved.find(r=>r.save_type===p);return [Number(s?.saved??(p==='favorite'?row?.is_saved:0)??0),Number(s?.changed_at??0),Number(s?.sort_order??0)];};
  return JSON.stringify([!!row,row?.title??null,row?.description??null,row?.image_url??null,row?.link??null,Number(row?.is_read??0),Number(row?.reading_progress??0),Number(row?.fetched_at??0),row?.body_hash??null,Number(reading?.progress??row?.reading_progress??0),Number(reading?.changed_at??0),Number(reading?.position_bytes??0),reading?.position_hash??'',...save('favorite'),...save('watchLater'),Number(deletion?.changed_at??0),deletion?.source_device_id??'']);
 }
 async apply(incoming:RecordDocument,legacy?:RecordDocument){
  const revision=await libraryRevision(this.db),id=incoming.value.articleId;
  const old=(await this.db.query('SELECT * FROM article_register_state WHERE article_id=?',[id]))[0],local=await this.projection(id);
  let frozen=old?.legacy_json==null?undefined:String(old.legacy_json),basis=old?readArticleRegisters(String(old.state_json)):undefined;
  if(!old&&legacy){
   const seed=readArticleRegisters(JSON.stringify(legacy.value),true);
   // Existing accepted sources are stronger witnesses than the legacy alias.
   for(const row of await this.db.query('SELECT save_type,saved,changed_at,sort_order,source_device_id FROM sync_saved_states WHERE article_id=?',[id]))if(['favorite','watchLater'].includes(String(row.save_type))&&Number(row.changed_at)===seed.value[String(row.save_type)+'ChangedAt']&&!!Number(row.saved)===seed.value[String(row.save_type)+'Saved']&&Number(row.sort_order)===seed.value[String(row.save_type)+'SortOrder'])seed.value.registerSources[String(row.save_type)]=String(row.source_device_id);
   const readSource=(await this.db.query('SELECT source_device_id FROM native_reading_sources WHERE item_id=? AND changed_at=?',[Number(local.row?.id??0),seed.value.readingPositionChangedAt]))[0];if(readSource)seed.value.registerSources.reading=String(readSource.source_device_id);
   // A bare materialized body/default unread is not a legacy reading operation.
   if(!local.reading&&!seed.value.isRead&&!seed.value.readingProgress&&legacy.value.sourceDeviceId==='cloud-rss-inventory'){seed.value.readingPositionChangedAt=0;seed.value.registerSources.reading='';}
   basis=normalizeArticleRegisters(seed);frozen=articleKnownCanonical(basis);
  }
  const merged=basis?mergeArticleRegisters(basis,incoming):{doc:readArticleRegisters(cloudRaw(incoming)?rawJsonText(cloudRaw(incoming)!):JSON.stringify({format:'watchrss-rss-record',version:1,...incoming})),conflict:false},v=merged.doc.value;
  const staleLegacy=!!legacy&&(!local.row||!!local.deletion||Number(local.row.fetched_at)>legacy.value.updatedAt||(Number(local.row.fetched_at)>=legacy.value.updatedAt&&(local.row.title!==legacy.value.title||local.row.link!==legacy.value.url))||!!local.reading&&(Number(local.reading.changed_at)!==legacy.value.readingPositionChangedAt||Number(local.reading.position_bytes)!==legacy.value.readingPositionBytes||String(local.reading.position_hash)!==legacy.value.readingPositionContentHash||Math.fround(Number(local.reading.progress))!==Math.fround(legacy.value.readingProgress)||!!Number(local.row.is_read)!==legacy.value.isRead)||local.saved.some(s=>Number(s.changed_at)!==legacy.value[String(s.save_type)+'ChangedAt']||!!Number(s.saved)!==legacy.value[String(s.save_type)+'Saved']||-Number(s.sort_order)!==legacy.value[String(s.save_type)+'SortOrder']));
  const changedLocally=old?old.materialized_json!==local.sig:staleLegacy,pending=changedLocally?local.sig:old?.pending_json==null?undefined:String(old.pending_json),conflict=merged.conflict||Number(old?.raw_conflict)===1;
  const raw=cloudRaw(incoming),rawText=raw?rawJsonText(raw):articleKnownCanonical(incoming),state=cloudRaw(merged.doc)?rawJsonText(cloudRaw(merged.doc)!):articleKnownCanonical(merged.doc);
  if(old&&old.state_json===state&&old.raw_json===rawText&&old.pending_json===(pending??null)&&!merged.conflict)return {changed:0,removed:[] as number[]};
  const statements:Statement[]=[revisionGuard(revision)];
  // The protected body receipt binds version + actual body hash. Never rewrite
  // a legacy encoding receipt to make its old metadata certify a new body.
  const oldBodyReceipt=old&&Number(old.body_pending)===0&&old.materialized_json?JSON.parse(String(old.materialized_json)):undefined;
  const boundBody=oldBodyReceipt&&readArticleRegisters(String(old.state_json)).value.contentHash===v.contentHash&&oldBodyReceipt[8]===local.row?.body_hash;
  const bodyReady=!!local.row?.body_hash&&(!!boundBody||(local.row.accepted_hash??local.row.body_hash)===v.contentHash);
  const bodyPending=pending?Number(old?.body_pending??0):v.deleted?0:bodyReady?0:1;
  const channel=v.rssSourceUrl&&/^https?:\/\//i.test(v.rssSourceUrl)?v.rssSourceUrl:'watchrss://phone-imports';
  if(!pending&&!v.deleted&&!local.row){
   statements.push({sql:'INSERT OR IGNORE INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,?)',params:[channel,v.rssSourceTitle??'独立文章',v.importedAt,0]},
    {sql:'INSERT OR IGNORE INTO articles(channel_id,title,description,content,link,image_url,is_read,is_saved,reading_progress,dedup_key,fetched_at) SELECT id,?,?,NULL,?,?,?,?,?,?,? FROM channels WHERE url=?',params:[v.title,v.excerpt,v.url,v.imageUrl,v.isRead?1:0,v.favoriteSaved?1:0,v.readingProgress,id,v.updatedAt,channel]},
    {sql:'INSERT INTO sync_article_ids(article_id,item_id,url) SELECT ?,a.id,? FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url=? AND a.dedup_key=? ON CONFLICT(article_id) DO UPDATE SET item_id=excluded.item_id,url=excluded.url WHERE sync_article_ids.item_id IS NULL',params:[id,v.url,channel,id]});
  }
  const nextRow=v.deleted?undefined:{title:v.title,description:v.excerpt,image_url:v.imageUrl,link:v.url,is_read:v.isRead?1:0,is_saved:v.favoriteSaved?1:0,reading_progress:v.readingProgress,fetched_at:v.updatedAt,body_hash:local.row?.body_hash??null};
  const nextReading=v.deleted?undefined:{progress:v.readingProgress,changed_at:v.readingPositionChangedAt,position_bytes:v.readingPositionBytes,position_hash:v.readingPositionContentHash};
  const nextSaved=v.deleted?[]:['favorite','watchLater'].map(p=>({save_type:p,saved:v[p+'Saved']?1:0,changed_at:v[p+'ChangedAt'],sort_order:-v[p+'SortOrder']}));
  const nextDeletion=v.deleted?{changed_at:v.deletedAt,source_device_id:v.registerSources.deletion}:undefined;
  const materialized=pending?String(old?.materialized_json??local.sig):this.signature(nextRow,nextReading,nextSaved,nextDeletion);
  statements.push({sql:`INSERT INTO article_register_state(article_id,item_id,state_json,legacy_json,materialized_json,pending_json,raw_json,raw_conflict,body_pending) VALUES(?,COALESCE(?,(SELECT item_id FROM sync_article_ids WHERE article_id=?)),?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET item_id=excluded.item_id,state_json=excluded.state_json,materialized_json=excluded.materialized_json,pending_json=excluded.pending_json,raw_json=excluded.raw_json,raw_conflict=excluded.raw_conflict,body_pending=excluded.body_pending`,params:[id,local.row?.id??null,id,state,frozen??null,materialized,pending??null,rawText,conflict?1:0,bodyPending]});
  if(conflict){for(const text of [old?.raw_json&&String(old.raw_json),rawText].filter((s):s is string=>!!s))statements.push({sql:'INSERT OR IGNORE INTO article_register_conflicts VALUES(?,?,?)',params:[id,await this.hash(utf8Encode(text)),text]});}
  const item='(SELECT item_id FROM article_register_state WHERE article_id=?)';
  if(!pending){
   for(const p of ['favorite','watchLater'])statements.push({sql:`INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,?,${item},?,?,?,?,?,?) ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=excluded.item_id,url=excluded.url,saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order,source_device_id=excluded.source_device_id,source_order=excluded.source_order`,params:[id,p,id,v.url,v[p+'Saved']?1:0,v[p+'ChangedAt'],v[p+'SortOrder'],v.registerSources[p],deviceOrder(v.registerSources[p])]});
   if(v.deleted){statements.push({sql:'INSERT INTO sync_article_deletions VALUES(?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET url=excluded.url,changed_at=excluded.changed_at,source_device_id=excluded.source_device_id,source_order=excluded.source_order',params:[id,v.url,v.deletedAt,v.registerSources.deletion,deviceOrder(v.registerSources.deletion)]},{sql:`DELETE FROM articles WHERE id=${item}`,params:[id]});}
   else {
    statements.push({sql:'DELETE FROM sync_article_deletions WHERE article_id=?',params:[id]},
     {sql:`UPDATE articles SET title=?,description=?,image_url=?,link=?,is_read=?,is_saved=?,reading_progress=?,fetched_at=? WHERE id=${item}`,params:[v.title,v.excerpt,v.imageUrl,v.url,v.isRead?1:0,v.favoriteSaved?1:0,v.readingProgress,v.updatedAt,id]},
     {sql:`INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) VALUES(${item},?,?,?,?,NULL) ON CONFLICT(article_id) DO UPDATE SET progress=excluded.progress,changed_at=excluded.changed_at,position_bytes=excluded.position_bytes,position_hash=excluded.position_hash,state_json=NULL`,params:[id,v.readingProgress,v.readingPositionChangedAt,v.readingPositionBytes,v.readingPositionContentHash]},
     {sql:`INSERT INTO native_reading_sources VALUES(${item},?,?) ON CONFLICT(item_id) DO UPDATE SET source_device_id=excluded.source_device_id,changed_at=excluded.changed_at`,params:[id,v.registerSources.reading,v.readingPositionChangedAt]});
    for(const p of ['favorite','watchLater'])statements.push({sql:`INSERT INTO article_saved_states VALUES(${item},?,?,?,?) ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order`,params:[id,p,v[p+'Saved']?1:0,v[p+'ChangedAt'],-v[p+'SortOrder']]});
   }
  }
  await this.db.transaction(statements);return {changed:1,removed:!pending&&v.deleted&&local.row?[Number(local.row.id)]:[]};
 }
}
