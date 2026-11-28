import {stableSqlTriggers,type ProjectionSql} from '@podjs/framework/sql-projection';
export type BusinessRevision={epoch:string;revision:string};
// The columns are the native inputs to the Sync v2 business materializers.
const businessColumns:Record<string,string>={
 articles:'id channel_id title link guid dedup_key image_url is_read is_saved reading_progress',
 channels:'id url title description image_url created_at sort_order is_pinned',
 article_reading_state:'article_id progress changed_at position_bytes position_hash',
 article_saved_states:'article_id save_type saved changed_at sort_order',
 article_saved_entry_times:'article_id save_type created_at',
 article_previews:'article_id summary image_url',
 native_reading_sources:'item_id source_device_id changed_at',
 sync_saved_states:'article_id save_type item_id saved changed_at sort_order source_device_id',
 sync_article_ids:'article_id item_id url',
 cloud_rss_article_ids:'item_id article_id',
 article_sync_content:'item_id body_hash',
 article_native_sync_hash:'item_id body_hash',
 article_sync_encoding_cache:'item_id imported_at',
 cloud_article_state:'article_id content_hash body_hash reading_clock reading_source',
 sync_body_revision:'item_id revision',
 source_preferences:'channel_id use_original_content',
 source_media_preferences:'channel_id continue_in_background',
 sync_books:'book_id state_json registration_complete package_sha256 package_bytes package_path',
 sync_book_events:'book_id chapter_index changed_at',
 sync_book_reading:'book_id chapter_index state_json',
 sync_book_reading_dirty:'item_id revision',
 sync_book_aliases:'book_id chapter_index article_id item_id url',
 article_register_state:'article_id item_id state_json pending_json raw_conflict',
};
export const PROJECTION_SOURCE_TABLES:Record<string,string[]>={
 source_preferences:['channel_id'],source_media_preferences:['channel_id'],sync_book_events:['book_id','chapter_index'],sync_book_reading_dirty:['item_id'],syncv2_rss_states:['id'],sync_books:['book_id'],sync_book_reading:['book_id','chapter_index'],article_register_state:['article_id'],
 memo_assets:['asset_id'],memo_notes:['note_id'],memo_folders:['folder_id'],sync_source_states:['url'],
 articles:['id'],channels:['id'],article_reading_state:['article_id'],article_saved_states:['article_id','save_type'],
 sync_article_ids:['article_id'],cloud_rss_article_ids:['item_id'],article_sync_encoding_cache:['item_id'],article_sync_content:['item_id'],article_native_sync_hash:['item_id'],sync_body_revision:['item_id'],
 sync_saved_states:['article_id','save_type'],sync_article_deletions:['article_id'],note_merge_conflicts:['conflict_id'],
 article_saved_entry_times:['article_id','save_type'],article_previews:['article_id'],native_reading_sources:['item_id'],
 cloud_article_state:['article_id'],sync_book_aliases:['book_id','chapter_index','article_id'],syncv2_note_resolutions:['note_id','conflict_id'],
};
export const DIRTY_LIMIT=4096;
const DEFINITION_VERSION=3;
const INSTALLATION_SCHEMA='CREATE TABLE IF NOT EXISTS syncv2_dirty_installation(id INTEGER PRIMARY KEY CHECK(id=1),schema_cookie INTEGER NOT NULL,definition INTEGER NOT NULL)';
const installs=new WeakMap<ProjectionSql,{schema:number;definition:number}>();
const schemaVersion=async(db:ProjectionSql)=>Number((await db.query('PRAGMA schema_version'))[0]?.schema_version);
async function schemaEntries(db:ProjectionSql,type:'table'|'trigger',predicate:string,params:readonly unknown[]=[]){
 const entries:Record<string,unknown>[]=[];
 let after='';
 for(;;){
  const page=await db.query(`SELECT name,sql FROM sqlite_master WHERE type=? AND name>? AND (${predicate}) ORDER BY name LIMIT 32`,[type,after,...params]);
  entries.push(...page);
  if(page.length<32)return entries;
  after=String(page.at(-1)!.name);
 }
}
const locator=(columns:string[])=>"'hex-v1:'||"+columns.map(c=>`hex(CAST(${c} AS TEXT))`).join("||':'||");

export async function installBusinessRevision(db:ProjectionSql){
 const schema=await schemaVersion(db),cached=installs.get(db);
 if(cached?.schema===schema&&cached.definition===DEFINITION_VERSION)return {ddl:0,unchanged:0,schema};
 const installed=(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_dirty_installation'")).length;
 if(installed&&(await db.query('SELECT 1 FROM syncv2_dirty_installation WHERE id=1 AND schema_cookie=? AND definition=?',[schema,DEFINITION_VERSION])).length){
  installs.set(db,{schema,definition:DEFINITION_VERSION});
  return {ddl:0,unchanged:0,schema};
 }
 const tableNames=[...Object.keys(PROJECTION_SOURCE_TABLES),'syncv2_dirty_window','syncv2_dirty'];
 const existing=new Set((await schemaEntries(db,'table',`name IN (${tableNames.map(()=>'?').join(',')})`,tableNames)).map(r=>String(r.name)));
 const definitions:string[]=[];
 const ddl=[
  {sql:'CREATE TABLE IF NOT EXISTS business_sync_revision(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,revision INTEGER NOT NULL)'},
  {sql:'INSERT OR IGNORE INTO business_sync_revision VALUES(1,lower(hex(randomblob(16))),0)'},
  {sql:'CREATE TABLE IF NOT EXISTS syncv2_dirty(table_name TEXT NOT NULL,locator TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(table_name,locator)) WITHOUT ROWID'},
  {sql:'CREATE INDEX IF NOT EXISTS syncv2_dirty_revision ON syncv2_dirty(revision,table_name,locator)'},
  {sql:'CREATE TABLE IF NOT EXISTS syncv2_dirty_window(id INTEGER PRIMARY KEY CHECK(id=1),floor INTEGER NOT NULL,size INTEGER NOT NULL)'},
  {sql:'INSERT OR IGNORE INTO syncv2_dirty_window VALUES(1,0,0)'},
  ...(existing.has('sync_saved_states')?[{sql:'CREATE INDEX IF NOT EXISTS syncv2_saved_by_item ON sync_saved_states(item_id,save_type)'}]:[]),
  ...(existing.has('cloud_rss_article_ids')?[{sql:'CREATE INDEX IF NOT EXISTS syncv2_rss_by_article ON cloud_rss_article_ids(article_id)'}]:[]),
 ];
 // Route auxiliary rows to their actual projection owner. OLD owners matter
 // when rows move or disappear, especially when a foreign key is set to NULL.
 const itemColumns:Record<string,string>={
  article_reading_state:'article_id',article_saved_states:'article_id',article_saved_entry_times:'article_id',article_previews:'article_id',
  cloud_rss_article_ids:'item_id',article_sync_encoding_cache:'item_id',article_sync_content:'item_id',article_native_sync_hash:'item_id',
  native_reading_sources:'item_id',sync_body_revision:'item_id',sync_saved_states:'item_id',sync_article_ids:'item_id',article_register_state:'item_id',
 };
 for(const [table,keys] of Object.entries(PROJECTION_SOURCE_TABLES))if(existing.has(table)){
  const columns=(await db.query('PRAGMA table_info('+table+')')).map(r=>String(r.name));
  if(columns.some(c=>!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)))throw Error('unsupported_feature');
  const requested=businessColumns[table]?.split(' ')??columns.filter(c=>c!=='local_sha256');
  const projected=[...new Set([...keys,...requested])].filter(c=>columns.includes(c));
  for(const op of ['INSERT','UPDATE','DELETE']){
   const select=(side:string)=>{
    const from=(column:string)=>side+'.'+column;
    const row=(target:string,fields:string[],where='1')=>`SELECT '${target}',${locator(fields)} WHERE ${where}`;
    const targets:string[]=[];
    if(table==='source_preferences'||table==='source_media_preferences')targets.push(row('source-options',[from('channel_id')]));
    else if(table==='sync_book_events')targets.push(row('sync_books',[from('book_id')]));
    else if(table==='note_merge_conflicts'||table==='syncv2_note_resolutions')targets.push(row('memo_notes',[from('note_id')]));
    else if(table==='sync_book_aliases')targets.push(row('sync_book_reading',[from('book_id'),from('chapter_index')]));
    else if(!itemColumns[table]||table==='article_register_state')targets.push(row(table,keys.map(from)));
    const item=itemColumns[table]??(table==='sync_book_aliases'?'item_id':undefined);
    if(item&&columns.includes(item))targets.push(row('articles',[from(item)],from(item)+' IS NOT NULL'));
    if(table==='cloud_article_state'){
     if(existing.has('sync_article_ids'))targets.push(`SELECT 'articles',${locator(['item_id'])} FROM sync_article_ids WHERE article_id=${from('article_id')} AND item_id IS NOT NULL`);
     if(existing.has('cloud_rss_article_ids'))targets.push(`SELECT 'articles',${locator(['item_id'])} FROM cloud_rss_article_ids WHERE article_id=${from('article_id')}`);
    }
    if(table==='channels'&&existing.has('articles')&&op==='UPDATE')
     targets.push(`SELECT 'articles',${locator(['id'])} FROM articles WHERE channel_id=${from('id')} AND (OLD.title IS NOT NEW.title OR OLD.url IS NOT NEW.url)`);
    return targets;
   };
   const changes=op==='UPDATE'?projected.map(c=>'OLD.'+c+' IS NOT NEW.'+c):[];
   // Native import clocks live in fetched_at. Public RSS refreshes use it only
   // as a cache timestamp (see the article record in materializer.ts).
   if(op==='UPDATE'&&table==='articles'&&existing.has('channels')&&columns.includes('channel_id')&&columns.includes('fetched_at'))
    changes.push(`(OLD.fetched_at IS NOT NEW.fetched_at AND EXISTS(SELECT 1 FROM channels ch WHERE ch.id=NEW.channel_id
     AND ((ch.url NOT LIKE 'http://%' AND ch.url NOT LIKE 'https://%') OR ch.url LIKE 'https://watchrss.local/import-%')))`);
   const guard=changes.join(' OR ');
   const cacheRelevant=table!=='article_sync_encoding_cache'||!columns.includes('imported_at')?'':op==='INSERT'?'NEW.imported_at>0':op==='DELETE'?'OLD.imported_at>0':'COALESCE(OLD.imported_at,0)>0 OR COALESCE(NEW.imported_at,0)>0';
   const when=[guard,cacheRelevant].filter(Boolean).map(expression=>'('+expression+')').join(' AND ');
   const targets=[...(op==='INSERT'?[]:select('OLD')),...(op==='DELETE'?[]:select('NEW'))];
   // A capped set retains the newest revision per locator. When coverage is
   // lost, roll the epoch in the same transaction as the business mutation.
   // Explicit UPSERT handling is needed when the outer write is itself an UPSERT.
   const enqueue=targets.length?`
 INSERT OR IGNORE INTO syncv2_dirty(table_name,locator,revision)
 SELECT dirty.*, (SELECT revision FROM business_sync_revision WHERE id=1) FROM (${targets.join(' UNION ')}) dirty WHERE 1 LIMIT ${DIRTY_LIMIT+1}
 ON CONFLICT(table_name,locator) DO NOTHING;
 UPDATE syncv2_dirty_window SET size=size+changes() WHERE id=1;
 UPDATE syncv2_dirty SET revision=(SELECT revision FROM business_sync_revision WHERE id=1)
 WHERE (table_name,locator) IN (${targets.join(' UNION ')} LIMIT ${DIRTY_LIMIT+1});
 UPDATE business_sync_revision SET epoch=lower(hex(randomblob(16))) WHERE id=1 AND (SELECT size FROM syncv2_dirty_window WHERE id=1)>${DIRTY_LIMIT};
 DELETE FROM syncv2_dirty WHERE (SELECT size FROM syncv2_dirty_window WHERE id=1)>${DIRTY_LIMIT};
 UPDATE syncv2_dirty_window SET floor=0,size=0 WHERE id=1 AND size>${DIRTY_LIMIT};`:'';
   definitions.push(`CREATE TRIGGER IF NOT EXISTS syncv2_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}${when?' WHEN '+when:''} BEGIN
 INSERT INTO business_sync_revision(id,epoch,revision) VALUES(1,lower(hex(randomblob(16))),1) ON CONFLICT(id) DO UPDATE SET epoch=CASE WHEN revision=9223372036854775807 THEN excluded.epoch ELSE epoch END,revision=CASE WHEN revision=9223372036854775807 THEN 1 ELSE revision+1 END;
 DELETE FROM syncv2_dirty WHERE (SELECT revision FROM business_sync_revision WHERE id=1)=1;
 UPDATE syncv2_dirty_window SET floor=0,size=0 WHERE id=1 AND (SELECT revision FROM business_sync_revision WHERE id=1)=1;${enqueue}END`);
  }
 }
 const triggers=new Map((await schemaEntries(db,'trigger',"name GLOB 'syncv2_*'")).map(row=>[row.name,row]));
 const result=await stableSqlTriggers({
  query:async(_sql,params)=>{const row=triggers.get(params?.[0]);return row?[row]:[];},
  transaction:statements=>db.transaction([
   // Fence schema discovery before replacing trigger definitions. Creating
   // the installation table changes the cookie once on the first migration.
   {sql:INSTALLATION_SCHEMA},
   {sql:'INSERT OR REPLACE INTO syncv2_dirty_installation SELECT 1,CASE WHEN schema_version=? THEN schema_version ELSE NULL END,? FROM pragma_schema_version',params:[schema+(installed?0:1),DEFINITION_VERSION]},
   ...statements,
   ...(!existing.has('syncv2_dirty_window')||!existing.has('syncv2_dirty')||statements.some(s=>s.sql.startsWith('CREATE TRIGGER '))?[
    {sql:'UPDATE business_sync_revision SET epoch=lower(hex(randomblob(16))) WHERE id=1'},
    {sql:'DELETE FROM syncv2_dirty'},{sql:'UPDATE syncv2_dirty_window SET floor=0,size=0 WHERE id=1'},
   ]:[]),
   {sql:'INSERT OR REPLACE INTO syncv2_dirty_installation SELECT 1,schema_version,? FROM pragma_schema_version',params:[DEFINITION_VERSION]},
  ]),
 },definitions,ddl);
 // Use the resulting cookie because this installation can change the schema.
 const schemaCookie=Number((await db.query('SELECT schema_cookie FROM syncv2_dirty_installation WHERE id=1'))[0]?.schema_cookie);
 installs.set(db,{schema:schemaCookie,definition:DEFINITION_VERSION});
 return {...result,schema:schemaCookie};
}
export async function businessRevision(db:ProjectionSql):Promise<BusinessRevision>{
 let row=(await db.query('SELECT epoch,CAST(revision AS TEXT) AS revision FROM business_sync_revision WHERE id=1'))[0];
 if(!row){await db.transaction([{sql:'INSERT OR IGNORE INTO business_sync_revision VALUES(1,lower(hex(randomblob(16))),0)'}]);row=(await db.query('SELECT epoch,CAST(revision AS TEXT) AS revision FROM business_sync_revision WHERE id=1'))[0];}
 return {epoch:String(row!.epoch),revision:String(row!.revision)};
}
export function sameBusinessRevision(a:BusinessRevision|null|undefined,b:BusinessRevision|null|undefined){return !!a&&!!b&&a.epoch===b.epoch&&a.revision===b.revision;}
/** This discovery also runs for a default-off instance after a previous opt-in.
 * A pristine default-off database only gets a read; no identity/crypto access. */
export async function stopExistingProjection(db:ProjectionSql){
 if(!(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_control'")).length)return;
 await db.transaction([{sql:'UPDATE syncv2_control SET enabled=0 WHERE id=1 AND enabled!=0'}]);
 await installBusinessRevision(db);
}
// Decimal arithmetic avoids loss above JS's safe integer range on the guest.
export function revisionDelta(before:BusinessRevision|null|undefined,after:BusinessRevision){
 if(!before||before.epoch!==after.epoch||before.revision.length>after.revision.length||before.revision.length===after.revision.length&&before.revision>after.revision)return '1';
 let borrow=0,out='';const a=after.revision,b=before.revision.padStart(a.length,'0');
 for(let i=a.length-1;i>=0;i--){let digit=Number(a[i])-Number(b[i])-borrow;borrow=digit<0?1:0;if(borrow)digit+=10;out=digit+out;}
 return out.replace(/^0+(?=.)/,'');
}
export function addRevision(a:string,b:string){let carry=0,out='';a=a.padStart(Math.max(a.length,b.length),'0');b=b.padStart(a.length,'0');for(let i=a.length-1;i>=0;i--){const digit=Number(a[i])+Number(b[i])+carry;out=String(digit%10)+out;carry=Math.floor(digit/10);}return (carry?'1':'')+out;}
