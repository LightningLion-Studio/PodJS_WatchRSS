import {stableSqlTriggers,type ProjectionSql} from '@podjs/framework/sql-projection';
export type BusinessRevision={epoch:string;revision:string};
export const PROJECTION_SOURCE_TABLES:Record<string,string[]>={
 source_preferences:['channel_id'],source_media_preferences:['channel_id'],sync_book_events:['book_id','chapter_index'],sync_book_reading_dirty:['item_id'],syncv2_rss_states:['id'],sync_books:['book_id'],sync_book_reading:['book_id','chapter_index'],article_register_state:['article_id'],
 memo_notes:['note_id'],memo_folders:['folder_id'],sync_source_states:['url'],
 // Native mutations that precede normalization still invalidate a captured
 // choice and create durable work. They cannot be silently omitted on resume.
 articles:['id'],channels:['id'],article_reading_state:['article_id'],article_saved_states:['article_id','save_type'],
 sync_article_ids:['article_id'],cloud_rss_article_ids:['item_id'],article_sync_encoding_cache:['item_id'],article_sync_content:['item_id'],article_native_sync_hash:['item_id'],sync_body_revision:['item_id'],
 sync_saved_states:['article_id','save_type'],sync_article_deletions:['article_id'],note_merge_conflicts:['conflict_id'],
};

/** The only extra work in the original business transaction is one tiny row.
 * No projection table, parsing, mapping, crypto or projection counter is used.
 * A new epoch makes a missing marker or counter rollover force a fresh scan. */
export async function installBusinessRevision(db:ProjectionSql){
 const existing=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name))),definitions:string[]=[];
 for(const table of Object.keys(PROJECTION_SOURCE_TABLES))if(existing.has(table)){
  const columns=(await db.query('PRAGMA table_info('+table+')')).map(r=>String(r.name));
  if(columns.some(c=>!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)))throw Error('unsupported_feature');
  for(const op of ['INSERT','UPDATE','DELETE'])definitions.push(`CREATE TRIGGER IF NOT EXISTS syncv2_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}${op==='UPDATE'?' WHEN '+columns.map(c=>'OLD.'+c+' IS NOT NEW.'+c).join(' OR '):''} BEGIN
 INSERT INTO business_sync_revision(id,epoch,revision) VALUES(1,lower(hex(randomblob(16))),1) ON CONFLICT(id) DO UPDATE SET epoch=CASE WHEN revision=9223372036854775807 THEN excluded.epoch ELSE epoch END,revision=CASE WHEN revision=9223372036854775807 THEN 1 ELSE revision+1 END;END`);
 }
 // The framework decides which definitions actually need replacement. Bind
 // this business-specific coverage change to that same native transaction:
 // restored SQL alone cannot prove that edits during a coverage gap were seen.
 return stableSqlTriggers({
  query:(sql,params)=>db.query(sql,params),
  transaction:statements=>db.transaction(statements.some(s=>s.sql.startsWith('CREATE TRIGGER '))
   ? [...statements,{sql:'UPDATE business_sync_revision SET epoch=lower(hex(randomblob(16))) WHERE id=1'}]
   : statements),
 },definitions,[{sql:'CREATE TABLE IF NOT EXISTS business_sync_revision(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,revision INTEGER NOT NULL)'},{sql:'INSERT OR IGNORE INTO business_sync_revision VALUES(1,lower(hex(randomblob(16))),0)'}]);
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
