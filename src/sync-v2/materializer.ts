import {bookInteracted} from '../books/protocol';
import {mergeWireBookReading} from './business';
import {conflictSet} from './note-conflict-set';
import {importLegacy} from './notes-conflict';
import {uint,type Kind} from './protocol';
import {BUSINESS_FIELDS,fromWire} from './business';
import {materializeFrozen,type Materialize} from './source';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import {nativeTrim,type LocalArticleManifestStore} from '../sync/local-manifest';
/** Pure counterpart of SqlBookStore.captureReading. Source normalization must
 * not write business rows before the account choice's CAS. */
async function pendingBookReading(db:ProjectionSql,bookId:string,chapter:number,before:any){
 const aliases=await db.query(`SELECT m.item_id,a.is_read,COALESCE(r.progress,a.reading_progress,0) AS progress,COALESCE(r.changed_at,0) AS clock,COALESCE(r.position_bytes,0) AS position,COALESCE(r.position_hash,'') AS hash FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id JOIN articles a ON a.id=m.item_id LEFT JOIN article_reading_state r ON r.article_id=a.id WHERE m.book_id=? AND m.chapter_index=? AND b.registration_complete=1 ORDER BY m.item_id`,[bookId,chapter]);
 const device=String((await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??'');if(!device&&aliases.length)throw Error('source_identity_missing');let result=before;
 for(const r of aliases){const value:any={bookId,chapterIndex:chapter,isRead:!!Number(r.is_read),readingProgress:Math.floor(Number(r.progress)*1000000+.5)/1000000,readingPositionBytes:Number(r.position),readingPositionContentHash:String(r.hash),readingPositionChangedAt:Number(r.clock),sourceDeviceId:device};if(before&&['isRead','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt'].every(k=>before[k]===value[k]))value.sourceDeviceId=before.sourceDeviceId;
  for(const prefix of ['favorite','watchLater']){
   let chosen:any;for(const s of await db.query('SELECT saved,changed_at,sort_order FROM article_saved_states WHERE article_id=? AND save_type=?',[r.item_id,prefix]))chosen={saved:!!Number(s.saved),clock:Number(s.changed_at),order:-Number(s.sort_order),source:device};
   for(const s of await db.query('SELECT saved,changed_at,sort_order,source_device_id FROM sync_saved_states WHERE item_id=? AND save_type=? ORDER BY article_id',[r.item_id,prefix]))if(!chosen||Number(s.changed_at)>=chosen.clock)chosen={saved:!!Number(s.saved),clock:Number(s.changed_at),order:Number(s.sort_order),source:String(s.source_device_id)||device};
   if(chosen&&(chosen.saved||chosen.clock>0)){value[prefix+'Saved']=chosen.saved;value[prefix+'ChangedAt']=chosen.clock;value[prefix+'SortOrder']=chosen.order;value[prefix+'SourceDeviceId']=before&&before[prefix+'Saved']===chosen.saved&&before[prefix+'ChangedAt']===chosen.clock&&before[prefix+'SortOrder']===chosen.order?before[prefix+'SourceDeviceId']??before.sourceDeviceId:chosen.source;}
  }if(bookInteracted(value))result=mergeWireBookReading(result,value);
 }return result;
}
/** Uses the frozen legacy reader in its explicit read-only mode: no lookup
 * initialization, body scan, recipe computation, old cursor, or business writes. */
export function watchMaterializer(db:ProjectionSql,metadata:Pick<LocalArticleManifestStore,'cloudRestoreMetadata'>,previousBySource?:(table:string,locator:string)=>Promise<any>,previousById?:(kind:Kind,logicalId:string)=>Promise<any>):Materialize {
 const sourceOptions=async(value:any)=>{
  const previous=await previousById?.('source',value.url),tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('source_preferences','source_media_preferences')")).map(r=>String(r.name)));
  if(previous?.meta.payload.sourceId!==undefined)value.sourceId=previous.meta.payload.sourceId;
  if(tables.has('source_preferences')){const p=(await db.query('SELECT p.use_original_content FROM source_preferences p JOIN channels c ON c.id=p.channel_id WHERE c.url=?',[value.url]))[0];if(p)value.useOriginalContent=!!Number(p.use_original_content);}
  if(tables.has('source_media_preferences')){const p=(await db.query('SELECT p.continue_in_background FROM source_media_preferences p JOIN channels c ON c.id=p.channel_id WHERE c.url=?',[value.url]))[0];if(p)value.continuePlaybackInBackground=!!Number(p.continue_in_background);}
  return value;
 };
 return async(table,row)=>{
  if(table==='sync_books'){
   const records=await materializeFrozen(table,row),value=records[0]!.value,tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_book_events')")).map(r=>String(r.name)));
   if(tables.has('sync_book_events')){const events=(await db.query('SELECT chapter_index,changed_at FROM sync_book_events WHERE book_id=?',[value.bookId])).filter(e=>!value.lifecycle||Number(e.changed_at)>value.lifecycle.startedAt),whole=events.some(e=>Number(e.chapter_index)===0);value.deleted=value.deleted||whole;value.deletedChapters=[...new Set([...value.deletedChapters,...events.map(e=>Number(e.chapter_index)).filter(n=>n>0)])].sort((a,b)=>a-b);value.deletionClock=events.reduce((n,e)=>Math.max(n,Number(e.changed_at)),value.deletionClock);if(whole)value.deletedAt=events.reduce((n,e)=>Math.max(n,Number(e.changed_at)),value.deletedAt);}
   return records;
  }
  if(table==='sync_book_reading_dirty'){
   const aliases=await db.query('SELECT DISTINCT m.book_id,m.chapter_index,r.state_json FROM sync_book_aliases m LEFT JOIN sync_book_reading r ON r.book_id=m.book_id AND r.chapter_index=m.chapter_index WHERE m.item_id=? ORDER BY m.book_id,m.chapter_index',[row.item_id]),out=[];
   for(const a of aliases){const value=await pendingBookReading(db,String(a.book_id),Number(a.chapter_index),a.state_json?JSON.parse(String(a.state_json)):undefined);if(value)out.push({kind:'book-reading' as const,logicalId:value.bookId+':'+value.chapterIndex,value});}return out;
  }
  if(table==='sync_book_reading'){
   const tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_book_reading_dirty'")).map(r=>String(r.name)));
   if(tables.has('sync_book_reading_dirty')&&(await db.query('SELECT 1 FROM sync_book_reading_dirty d JOIN sync_book_aliases m ON m.item_id=d.item_id WHERE m.book_id=? AND m.chapter_index=? LIMIT 1',[row.book_id,row.chapter_index])).length){const value=await pendingBookReading(db,String(row.book_id),Number(row.chapter_index),JSON.parse(String(row.state_json)));return [{kind:'book-reading',logicalId:value.bookId+':'+value.chapterIndex,value}];}
  }

  if(table==='sync_source_states'){const records=await materializeFrozen(table,row);await sourceOptions(records[0]!.value);return records;}
  if(table==='memo_notes'){
   const records=await materializeFrozen(table,row);
   const tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_merge_conflicts','syncv2_note_resolutions')")).map(r=>String(r.name)));
   const conflicts=tables.has('note_merge_conflicts')?await db.query('SELECT * FROM note_merge_conflicts WHERE note_id=?',[row.note_id]):[];
   const resolved=tables.has('syncv2_note_resolutions')?await db.query('SELECT conflict_id,resolved_at FROM syncv2_note_resolutions WHERE note_id=?',[row.note_id]):[];
   const markers=new Map(resolved.map(r=>{if(typeof r.conflict_id!=='string')throw Error('invalid_schema');uint(r.resolved_at);return [r.conflict_id,r.resolved_at as number] as const;}));
   for(const record of records)record.value.noteConflicts=conflictSet(record.logicalId,importLegacy('watch',record.logicalId,conflicts).records.map(r=>({...r,resolvedAt:markers.get(r.conflictId)??0})));
   return records;
  }
  if(table==='articles'){
   if(row.__removed){
    const previous=await previousBySource?.(table,String(row.__locator));if(!previous)throw Error('source_tombstone_required');
    const tombstone=(await db.query('SELECT * FROM sync_article_deletions WHERE article_id=?',[previous.meta.logicalId]))[0];if(!tombstone)throw Error('source_tombstone_required');
    const value={...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(tombstone.changed_at),sourceDeviceId:String(tombstone.source_device_id)};
    return [{kind:'article',logicalId:previous.meta.logicalId,value,...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
   }
   if((await db.query('SELECT 1 FROM article_register_state WHERE item_id=?',[row.id])).length)return [];
   if((await db.query('SELECT 1 FROM sync_book_aliases WHERE item_id=?',[row.id])).length)return []; // Stable book/chapter identities have their own records.
   const page=await metadata.cloudRestoreMetadata({itemIds:[Number(row.id)],limit:1},undefined,true);
   if(page.articles.length!==1)throw Error('source_identity_missing');
   const record=page.articles[0]!,value=Object.fromEntries(Object.entries(record).filter(([key])=>BUSINESS_FIELDS.article.includes(key)));
   // fetched_at is refreshed by RSS acquisition and does not prove first
   // library admission. Only an existing explicit import witness supplies it.
   const historical=(await db.query('SELECT imported_at FROM article_sync_encoding_cache WHERE item_id=? AND imported_at>0',[row.id]))[0],addedAt=Number(historical?.imported_at??0);
   value.importedAt=addedAt;
   return [{kind:'article',logicalId:record.articleId,value,...(addedAt>0?{addedAtMillis:addedAt}:{})}];
  }
  if(table==='sync_article_deletions'){
   const previous=await previousById?.('article',String(row.article_id));if(!previous)return materializeFrozen(table,row);
   return [{kind:'article',logicalId:String(row.article_id),value:{...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(row.changed_at),sourceDeviceId:String(row.source_device_id)},...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
  }
  if(table==='channels'){
   const url=String(row.url);
   // Non-subscription builtin/import containers are represented by their
   // stable article/book entities, exactly as the old source protocol.
   if(!/^https?:\/\//i.test(url)||/^https?:\/\/watchrss\.local\/import-/.test(url))return [];
   const stored=(await db.query('SELECT * FROM sync_source_states WHERE url=?',[url]))[0];
   const device=String((await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??'');if(!device)throw Error('source_identity_missing');
   const same=stored&&Number(stored.deleted)===0&&stored.title===row.title&&(nativeTrim(String(stored.description))?stored.description:stored.site_url)===(row.description??'')&&stored.image_url===row.image_url&&Number(stored.sort_order)===-Number(row.sort_order)&&!!Number(stored.is_pinned)===!!Number(row.is_pinned);
   const value={url,sourceDeviceId:same?String(stored.source_device_id):device,title:String(row.title),description:same?String(stored.description):String(row.description??''),siteUrl:same?stored.site_url:null,imageUrl:row.image_url??null,createdAt:Number(row.created_at),updatedAt:same?Number(stored.updated_at):Math.max(Number(stored?.updated_at??-1)+1,-Number(row.sort_order),Number(row.created_at)),sortOrder:Number(row.sort_order)===0?0:-Number(row.sort_order),isPinned:!!Number(row.is_pinned),deleted:false,deletedAt:0};
   await sourceOptions(value);return [{kind:'source',logicalId:url,value,...(value.createdAt>0?{addedAtMillis:value.createdAt}:{})}];
  }
  return materializeFrozen(table,row);
 };
}
