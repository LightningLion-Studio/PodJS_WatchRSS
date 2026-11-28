import {bookInteracted} from '../books/protocol';
import {mergeWireBookReading} from './business';
import {conflictSet} from './note-conflict-set';
import {importLegacy} from './notes-conflict';
import {uint,type Kind} from './protocol';
import {BUSINESS_FIELDS,fromWire} from './business';
import {decodeLocator,materializeFrozen,type Materialize} from './source';
import type {SourceRecord} from './store';
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
export function watchMaterializer(db:ProjectionSql,metadata:Pick<LocalArticleManifestStore,'cloudRestoreMetadata'>,previousBySource?:(table:string,locator:string)=>Promise<any>,previousById?:(kind:Kind,logicalId:string)=>Promise<any>,previousBatchById?:(kind:Kind,logicalIds:string[])=>Promise<Map<string,any>>,bookReferenced?:(id:string)=>Promise<boolean>):Materialize {
 const sourceOptions=async(value:any)=>{
  const previous=await previousById?.('source',value.url),tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('source_preferences','source_media_preferences')")).map(r=>String(r.name)));
  if(previous?.meta.payload.sourceId!==undefined)value.sourceId=previous.meta.payload.sourceId;
  if(tables.has('source_preferences')){const p=(await db.query('SELECT p.use_original_content FROM source_preferences p JOIN channels c ON c.id=p.channel_id WHERE c.url=?',[value.url]))[0];if(p)value.useOriginalContent=!!Number(p.use_original_content);}
  if(tables.has('source_media_preferences')){const p=(await db.query('SELECT p.continue_in_background FROM source_media_preferences p JOIN channels c ON c.id=p.channel_id WHERE c.url=?',[value.url]))[0];if(p)value.continuePlaybackInBackground=!!Number(p.continue_in_background);}
  // Applying sparse sources fills native defaults. Do not capture those
  // defaults as business edits when book hydration revisits the source.
  if(previous){
   const defaults={sourceDeviceId:'',siteUrl:null,imageUrl:null,createdAt:0,sortOrder:0,isPinned:false};
   for(const [field,fallback] of Object.entries(defaults)){
    if(value[field]===fallback&&!Object.hasOwn(previous.meta.payload,field)&&!Object.hasOwn(previous.state.payload,field))delete value[field];
   }
  }
  return value;
 };
 const articleRegister=async(row:Record<string,unknown>):Promise<SourceRecord[]>=>{
  const records=await materializeFrozen('article_register_state',row),record=records[0];
  if(!record||!row.item_id||record.value.deleted)return records;
  const value=record.value;
  // The register owns the protected article metadata. Local Reader and save
  // mutations update the native interaction tables without rewriting it.
  const item=row.item_id;
  const native=(await db.query(`SELECT a.is_read,a.is_saved,COALESCE(r.progress,a.reading_progress) AS progress,
   COALESCE(r.changed_at,0) AS clock,COALESCE(r.position_bytes,0) AS position,
   COALESCE(r.position_hash,'') AS hash,s.source_device_id AS source
   FROM articles a LEFT JOIN article_reading_state r ON r.article_id=a.id
   LEFT JOIN native_reading_sources s ON s.item_id=a.id AND s.changed_at=r.changed_at WHERE a.id=?`,[item]))[0];
  if(!native)return records;
  let device:string|undefined;
  const localDevice=async()=>device??=String((await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0]?.device_id??value.sourceDeviceId??'');
  const clock=Number(native.clock),reading={isRead:!!Number(native.is_read),readingProgress:Math.fround(Number(native.progress)),readingPositionChangedAt:clock,readingPositionBytes:Number(native.position),readingPositionContentHash:String(native.hash)};
  if(reading.isRead!==(value.isRead??false)||reading.readingProgress!==Math.fround(value.readingProgress??0)||
     clock!==(value.readingPositionChangedAt??0)||reading.readingPositionBytes!==(value.readingPositionBytes??0)||
     reading.readingPositionContentHash!==(value.readingPositionContentHash??'')){
   Object.assign(value,reading);
   if(value.registerSources)value.registerSources.reading=native.source??await localDevice();
  }
  const saved=await db.query(`SELECT save_type,saved,changed_at,sort_order,source_device_id FROM sync_saved_states WHERE item_id=?
   UNION ALL SELECT save_type,saved,changed_at,-sort_order,NULL FROM article_saved_states WHERE article_id=? ORDER BY changed_at DESC,source_device_id DESC`,[item,item]);
  for(const type of ['favorite','watchLater']){
   const state=saved.find(r=>r.save_type===type);
   const on=state?!!Number(state.saved):type==='favorite'&&!!Number(native.is_saved);
   const changedAt=Number(state?.changed_at??0),order=Number(state?.sort_order??0);
   if(on===(value[type+'Saved']??false)&&changedAt===(value[type+'ChangedAt']??0)&&order===(value[type+'SortOrder']??0))continue;
   value[type+'Saved']=on;value[type+'ChangedAt']=changedAt;value[type+'SortOrder']=order;
   if(value.registerSources)value.registerSources[type]=state?.source_device_id??await localDevice();
  }
  return records;
 };
 const applyBookEvents=async(value:Record<string,any>)=>{
  if(!(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_book_events'")).length)return;
  const events=(await db.query('SELECT chapter_index,changed_at FROM sync_book_events WHERE book_id=?',[value.bookId]))
   .filter(e=>!value.lifecycle||Number(e.changed_at)>value.lifecycle.startedAt);
  const whole=events.some(e=>Number(e.chapter_index)===0);
  value.deleted=value.deleted||whole;
  value.deletedChapters=[...new Set([...value.deletedChapters,...events.map(e=>Number(e.chapter_index)).filter(n=>n>0)])].sort((a,b)=>a-b);
  value.deletionClock=events.reduce((n,e)=>Math.max(n,Number(e.changed_at)),value.deletionClock);
  if(whole)value.deletedAt=events.reduce((n,e)=>Math.max(n,Number(e.changed_at)),value.deletedAt);
 };
 const single:Materialize=async(table,row)=>{
  if(table==='article_register_state')return articleRegister(row);
  if(table==='sync_books'){
   if(row.__removed){
    const [id]=decodeLocator(String(row.__locator)),previous=await previousById?.('book',id!);
    if(!previous)return [];
    const value=fromWire('book',previous.meta.payload,previous.state.payload);
    await applyBookEvents(value);
    if(!value.deleted){
     // Removing local storage alone does not erase an authenticated book.
     // A live cloud row needs the native whole-book deletion event.
     if(await bookReferenced?.(id!))return [];
     const clock=Math.max(value.updatedAt,value.deletionClock,value.lifecycle?.startedAt??0)+1;
     if(!Number.isSafeInteger(clock))throw Error('counter_exhausted');
     Object.assign(value,{deleted:true,deletedAt:clock,deletionClock:clock});
    }
    return [{kind:'book',logicalId:id!,value,...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
   }
   const records=await materializeFrozen(table,row);
   await applyBookEvents(records[0]!.value);
   return records;
  }
  if(table==='sync_book_reading_dirty'){
   const aliases=await db.query('SELECT DISTINCT m.book_id,m.chapter_index,r.state_json FROM sync_book_aliases m LEFT JOIN sync_book_reading r ON r.book_id=m.book_id AND r.chapter_index=m.chapter_index WHERE m.item_id=? ORDER BY m.book_id,m.chapter_index',[row.item_id]),out=[];
   for(const a of aliases){const value=await pendingBookReading(db,String(a.book_id),Number(a.chapter_index),a.state_json?JSON.parse(String(a.state_json)):undefined);if(value)out.push({kind:'book-reading' as const,logicalId:value.bookId+':'+value.chapterIndex,value});}return out;
  }
  if(table==='sync_book_reading'){
   if(row.__removed){
    const [id,chapter]=decodeLocator(String(row.__locator));
    if(!(await db.query('SELECT 1 FROM sync_books WHERE book_id=?',[id])).length)return [];
    const value=await pendingBookReading(db,id!,Number(chapter),undefined);
    return value?[{kind:'book-reading',logicalId:id+':'+chapter,value}]:[];
   }
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
   for(const record of records)record.value.noteConflicts=conflictSet(record.logicalId,conflicts.flatMap(row=>importLegacy('watch',record.logicalId,[row]).records.map(r=>({...r,resolvedAt:markers.get(r.conflictId)??0}))));
   return records;
  }
  if(table==='articles'){
   if(row.__removed){
    const previous=await previousBySource?.(table,String(row.__locator));if(!previous)return [];
    const tombstone=(await db.query('SELECT * FROM sync_article_deletions WHERE article_id=?',[previous.meta.logicalId]))[0];if(!tombstone)return [];
    const value={...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(tombstone.changed_at),sourceDeviceId:String(tombstone.source_device_id)};
    return [{kind:'article',logicalId:previous.meta.logicalId,value,...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
   }
   const registered=(await db.query('SELECT * FROM article_register_state WHERE item_id=?',[row.id]))[0];
   if(registered)return row.__locator?articleRegister(registered):[];
   if(row.__relevant===0&&!await previousBySource?.(table,String(row.__locator)))return [];
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
 single.batch=async(table,rows)=>{
  if(!rows.length)return [];
  if(table==='articles'){
   const ids=rows.map(r=>Number(r.id)),marks=ids.map(()=>'?').join(',');
   const tables=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('article_register_state','sync_book_aliases','article_sync_encoding_cache')")).map(r=>String(r.name)));
   const registered=tables.has('article_register_state')?new Set((await db.query(`SELECT item_id FROM article_register_state WHERE item_id IN (${marks})`,ids)).map(r=>Number(r.item_id))):new Set<number>();
   const aliased=tables.has('sync_book_aliases')?new Set((await db.query(`SELECT item_id FROM sync_book_aliases WHERE item_id IN (${marks})`,ids)).map(r=>Number(r.item_id))):new Set<number>();
   const needed=ids.filter(id=>!registered.has(id)&&!aliased.has(id));
   if(!needed.length)return rows.map(()=>[]);
   const byItem=new Map<number,Awaited<ReturnType<LocalArticleManifestStore['cloudRestoreMetadata']>>['articles'][number]>();
   for(let at=0;at<needed.length;at+=100){
    const slice=needed.slice(at,at+100);
    const page=await metadata.cloudRestoreMetadata({itemIds:slice,limit:slice.length},undefined,true);
    for(const article of page.articles)if(article.cloudReadingItemId!==undefined)byItem.set(article.cloudReadingItemId,article);
   }
   const importedAt=new Map<number,number>();
   if(tables.has('article_sync_encoding_cache')){
    const neededMarks=needed.map(()=>'?').join(',');
    for(const r of await db.query(`SELECT item_id,imported_at FROM article_sync_encoding_cache WHERE item_id IN (${neededMarks}) AND imported_at>0`,needed))importedAt.set(Number(r.item_id),Number(r.imported_at));
   }
   return ids.map(id=>{
    if(registered.has(id)||aliased.has(id))return [];
    const record=byItem.get(id);if(!record)throw Error('source_identity_missing');
    const value=Object.fromEntries(Object.entries(record).filter(([key])=>BUSINESS_FIELDS.article.includes(key)));
    const addedAt=importedAt.get(id)??0;value.importedAt=addedAt;
    return [{kind:'article' as const,logicalId:record.articleId,value,...(addedAt>0?{addedAtMillis:addedAt}:{})}];
   });
  }
  if(table==='sync_book_reading'){
   const hasDirty=(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_book_reading_dirty'")).length>0
    &&(await db.query('SELECT 1 FROM sync_book_reading_dirty LIMIT 1')).length>0;
   if(!hasDirty)return Promise.all(rows.map(row=>materializeFrozen(table,row)));
  }
  if(table==='sync_article_deletions'&&previousBatchById){
   const previousMap=await previousBatchById('article',rows.map(r=>String(r.article_id)));
   return Promise.all(rows.map(async row=>{
    const previous=previousMap.get(String(row.article_id));
    if(!previous)return materializeFrozen(table,row);
    return [{kind:'article' as const,logicalId:String(row.article_id),value:{...fromWire('article',previous.meta.payload,previous.state.payload),deleted:true,deletedAt:Number(row.changed_at),sourceDeviceId:String(row.source_device_id)},...(previous.meta.addedAtSource==='original'?{addedAtMillis:previous.addedAtMillis}:{})}];
   }));
  }
  const out:SourceRecord[][]=[];
  for(const row of rows)out.push(await single(table,row));
  return out;
 };
 return single;
}
