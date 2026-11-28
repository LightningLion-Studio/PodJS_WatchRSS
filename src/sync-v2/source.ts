import {unhex,hex} from '@podjs/framework/crypto';
import {decodeUtf8Chunk,encodeUtf8} from '@podjs/framework/bytes';
import {readSqlKeysetPage,readSqlTextPieces,type ProjectionSql} from '@podjs/framework/sql-projection';
import {canonical,type Kind} from './protocol';
import {publicRssChannel} from './business-revision';
import type {SourceReader,SourceRecord} from './store';
/** A materializer consumes one existing business row plus its stable key. It
 * must return the complete frozen business record. It may not change the DB.
 * Missing metadata/identity/ancestry fails the page; no invented defaults. */
export type Materialize=((table:string,row:Record<string,unknown>)=>Promise<SourceRecord[]>)&{batch?:(table:string,rows:Record<string,unknown>[])=>Promise<SourceRecord[][]>};
export const BUSINESS_TABLE_KEYS:Readonly<Record<string,readonly string[]>>=Object.freeze({
 sync_books:['book_id'],sync_book_reading:['book_id','chapter_index'],article_register_state:['article_id'],memo_notes:['note_id'],memo_assets:['asset_id'],memo_folders:['folder_id'],sync_source_states:['url'],articles:['id'],channels:['id'],sync_article_deletions:['article_id'],sync_book_reading_dirty:['item_id'],syncv2_rss_states:['id'],
});
export function encodeLocator(values:unknown[]){return 'hex-v1:'+values.map(value=>hex(encodeUtf8(String(value),'strict')).toUpperCase()).join(':');}
export function decodeLocator(value:string){
 if(!value.startsWith('hex-v1:'))throw Error('invalid_locator');return value.slice(7).split(':').map(part=>{
  if(!/^(?:[0-9A-F]{2})*$/.test(part))throw Error('invalid_locator');const input=unhex(part.toLowerCase());let at=0,text='';while(at<input.length){const next=decodeUtf8Chunk(input,at);text+=next.text;at=next.next;}return text;
 });
}
const quote=(id:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(id))throw Error('invalid_sql_identifier');return id;};
/** N1: a page reply carries a note's text only up to NOTE_INLINE_BYTES; longer
 * text is read in byte pieces, so no single SQL reply holds a long note. R1:
 * sizes and pieces count BLOB bytes, never TEXT length()/substr(), which stop
 * at U+0000. */
const NOTE_TEXT=['markdown','plain_text','base_markdown'],NOTE_INLINE_BYTES=8192;
const LONG_TEXT=NOTE_TEXT.map(c=>`coalesce(length(CAST(${c} AS BLOB)),0)`).join('+')+'>'+NOTE_INLINE_BYTES;
/** The memo_notes projection with long text left out, or `*` when the table
 * lacks the text columns. */
const noteColumns=(names:string[])=>NOTE_TEXT.every(c=>names.includes(c))?[...names.filter(c=>!NOTE_TEXT.includes(c)).map(quote),...NOTE_TEXT.map(c=>`CASE WHEN ${LONG_TEXT} THEN NULL ELSE ${c} END AS ${c}`),`${LONG_TEXT} AS __long_text`].join(','):'*';
export async function completeNoteRow(db:Pick<ProjectionSql,'query'>,row:Record<string,unknown>){
 const long=row.__long_text;delete row.__long_text;if(!Number(long))return row;
 for(const c of NOTE_TEXT){let text:string|null;try{text=await readSqlTextPieces(db,{table:'memo_notes',column:c,key:{note_id:row.note_id}});}catch{throw Error('source_record_invalid');}if(text===null)throw Error('source_record_invalid');row[c]=text;}
 return row;
}
export class SqlBusinessSource implements SourceReader {
 private constructor(private readonly db:ProjectionSql,private readonly tables:string[],private readonly materialize:Materialize,private readonly notes:string,private readonly articleFilter:string,private readonly deletionFilter:string){}
 static async open(db:ProjectionSql,materialize:Materialize=materializeFrozen){
  const existing=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  const notes=existing.has('memo_notes')?noteColumns((await db.query('PRAGMA table_info(memo_notes)')).map(r=>String(r.name))):'*';
  const filters:string[]=[];
  if(existing.has('article_register_state'))filters.push('NOT EXISTS(SELECT 1 FROM article_register_state r WHERE r.item_id=articles.id)');
  if(existing.has('sync_book_aliases'))filters.push('NOT EXISTS(SELECT 1 FROM sync_book_aliases b WHERE b.item_id=articles.id)');
  if(existing.has('channels')){
   const relevant=[`EXISTS(SELECT 1 FROM channels ch WHERE ch.id=articles.channel_id AND NOT ${publicRssChannel('ch.url')})`,'articles.is_read!=0','articles.is_saved!=0','articles.reading_progress>0'];
   if(existing.has('article_saved_states'))relevant.push('EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=articles.id)');
   if(existing.has('sync_saved_states'))relevant.push('EXISTS(SELECT 1 FROM sync_saved_states s WHERE s.item_id=articles.id)');
   if(existing.has('article_reading_state'))relevant.push('EXISTS(SELECT 1 FROM article_reading_state rs WHERE rs.article_id=articles.id AND (rs.progress>0 OR rs.changed_at>0 OR rs.position_bytes>0))');
   filters.push('('+relevant.join(' OR ')+')');
  }
  const deletionFilter=existing.has('sync_book_aliases')&&existing.has('sync_books')?'NOT EXISTS(SELECT 1 FROM sync_book_aliases b JOIN sync_books s ON s.book_id=b.book_id WHERE (b.article_id=sync_article_deletions.article_id OR b.url=sync_article_deletions.url) AND s.registration_complete=1)':'';
  return new SqlBusinessSource(db,Object.keys(BUSINESS_TABLE_KEYS).filter(t=>existing.has(t)),materialize,notes,filters.join(' AND '),deletionFilter);
 }
 private columns(table:string){return table==='articles'?'id':table==='memo_notes'?this.notes:'*';}
 private complete(table:string,row:Record<string,unknown>|undefined){return row&&table==='memo_notes'?completeNoteRow(this.db,row):row;}
 async page(after:string,limit:number){
  const token=after?JSON.parse(after):{table:0,keys:null};if(!Number.isInteger(token.table)||token.table<0||token.keys!==null&&!Array.isArray(token.keys))throw Error('invalid_checkpoint');
  if(token.table>=this.tables.length)return {rows:[],after,done:true};
  const table=this.tables[token.table]!,keys=BUSINESS_TABLE_KEYS[table]!,values=token.keys as unknown[]|null;
  if(values&&values.length!==keys.length)throw Error('invalid_checkpoint');
  const complete=(row:Record<string,unknown>|undefined)=>this.complete(table,row);
  const attach=(row:Record<string,unknown>,records:SourceRecord[])=>records.map(record=>({...record,source:{table,locator:encodeLocator(keys.map(key=>row[key]))}}));
  if(token.pending){
   const row=await complete((await this.db.query(`SELECT ${this.columns(table)} FROM ${quote(table)} WHERE ${keys.map(k=>quote(k)+' IS ?').join(' AND ')}`,token.pending.keys))[0]),records=row?attach(row,await this.materialize(table,row)):[],end=Math.min(records.length,token.pending.offset+limit),pending=end<records.length?{keys:token.pending.keys,offset:end}:null;
   return {rows:records.slice(token.pending.offset,end),after:canonical(pending?{...token,pending}:{table:token.table,keys:token.pending.keys}),done:false};
  }
  const params:unknown[]=[],keyWhere=values?'('+keys.map((key,i)=>{for(let j=0;j<i;j++)params.push(values[j]);params.push(values[i]);return '('+[...keys.slice(0,i).map(k=>quote(k)+' IS ?'),quote(key)+'>?'].join(' AND ')+')';}).join(' OR ')+')':'';
  const extraWhere=table==='articles'?this.articleFilter:table==='sync_article_deletions'?this.deletionFilter:'';
  const where=keyWhere&&extraWhere?` WHERE ${extraWhere} AND ${keyWhere}`:keyWhere?` WHERE ${keyWhere}`:extraWhere?` WHERE ${extraWhere}`:'';
  const result=await readSqlKeysetPage(this.db,`SELECT ${this.columns(table)} FROM ${quote(table)}${where} ORDER BY ${keys.map(quote).join(',')}`,params,limit);
  const rows:SourceRecord[]=[];let last=values;
  for(const row of result.rows)await complete(row);
  const materialized=this.materialize.batch&&result.rows.length>1?await this.materialize.batch(table,result.rows):undefined;
  for(let i=0;i<result.rows.length;i++){const row=result.rows[i]!,records=attach(row,materialized?materialized[i]!:await this.materialize(table,row)),space=limit-rows.length;if(records.length>space){rows.push(...records.slice(0,space));return {rows,after:canonical({table:token.table,keys:last,pending:{keys:keys.map(k=>row[k]),offset:space}}),done:false};}rows.push(...records);last=keys.map(k=>row[k]);}
  const next=result.rows.length===0?{table:token.table+1,keys:null}:{table:token.table,keys:last};
  return {rows,after:canonical(next),done:next.table>=this.tables.length};
 }

 get tracksBookRemovals(){return this.tables.includes('sync_books');}

 async changed(table:string,locator:string):Promise<SourceRecord[]>{
  const values=decodeLocator(locator);
  if(table==='source-options')return this.changed('channels',locator);
  const keys=BUSINESS_TABLE_KEYS[table];if(!keys||values.length!==keys.length)throw Error('invalid_locator');
  if(!this.tables.includes(table))return [];
  const extra=table==='articles'&&this.articleFilter?`,(${this.articleFilter}) AS __relevant`:'';
  const row=await this.complete(table,(await this.db.query(`SELECT ${this.columns(table)}${extra} FROM ${quote(table)} WHERE ${keys.map(k=>quote(k)+' IS ?').join(' AND ')}`,values))[0]);
  if(!row&&table!=='articles'&&table!=='sync_books'&&table!=='sync_book_reading')return [];
  if(table==='sync_article_deletions'&&this.deletionFilter&&!(await this.db.query(`SELECT 1 FROM sync_article_deletions WHERE article_id=? AND ${this.deletionFilter}`,values)).length)return [];
  const input={...(row??{__removed:true}),__locator:locator};
  return (await this.materialize(table,input)).map(record=>({...record,source:{table,locator}}));
 }

}
export async function materializeFrozen(table:string,row:Record<string,unknown>):Promise<SourceRecord[]>{
 if(row.__removed)return [];
 const json=(value:unknown)=>{if(typeof value!=='string')throw Error('source_record_invalid');return JSON.parse(value);};
 if(table==='syncv2_rss_states'){const value=json(row.state_json);return [{kind:'rss-state',logicalId:String(row.id),value}];}
 if(table==='sync_books'||table==='sync_book_reading'){
  const value=json(row.state_json),kind:Kind=table==='sync_books'?'book':'book-reading',logicalId=kind==='book'?value.bookId:value.bookId+':'+value.chapterIndex;
  return [{kind,logicalId,value}];
 }
 if(table==='sync_article_deletions')return [{kind:'article',logicalId:String(row.article_id),value:{articleId:String(row.article_id),url:String(row.url),sourceDeviceId:String(row.source_device_id),deleted:true,deletedAt:Number(row.changed_at)}}];
 if(table==='article_register_state'){const doc=json(row.state_json);if(doc.kind!=='article'||!doc.value)throw Error('source_record_invalid');return [{kind:'article',logicalId:doc.value.articleId,value:doc.value,...(doc.value.importedAt>0?{addedAtMillis:doc.value.importedAt}:{})}];}
 const number=(key:string)=>{const v=row[key];if(typeof v!=='number'||!Number.isSafeInteger(v))throw Error('source_record_invalid');return v;};
 const text=(key:string)=>{if(typeof row[key]!=='string')throw Error('source_record_invalid');return row[key] as string;};
 const bool=(key:string)=>{const n=number(key);if(n!==0&&n!==1)throw Error('source_record_invalid');return n===1;};
 if(table==='memo_notes'){const value={noteId:text('note_id'),folderId:row.folder_id===null?null:text('folder_id'),title:text('title'),markdown:text('markdown'),plainText:text('plain_text'),contentHash:text('content_hash'),baseContentHash:text('base_content_hash'),baseMarkdown:text('base_markdown'),pinned:bool('pinned'),createdAt:number('created_at'),updatedAt:number('updated_at'),modifiedBy:text('modified_by'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'note',logicalId:value.noteId,value,...(value.createdAt>0?{addedAtMillis:value.createdAt}:{})}];}
 if(table==='memo_assets'){const value={assetId:text('asset_id'),mime:text('mime'),originalFilename:text('original_filename'),updatedAt:number('updated_at'),sourceDeviceId:text('source_device_id'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'asset',logicalId:value.assetId,value}];}
 if(table==='memo_folders'){const value={folderId:text('folder_id'),name:text('name'),sortOrder:number('sort_order'),updatedAt:number('updated_at'),modifiedBy:text('modified_by'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'folder',logicalId:value.folderId,value}];}
 if(table==='sync_source_states'){const value={url:text('url'),sourceDeviceId:text('source_device_id'),title:text('title'),description:text('description'),siteUrl:row.site_url===null?null:text('site_url'),imageUrl:row.image_url===null?null:text('image_url'),createdAt:number('created_at'),updatedAt:number('updated_at'),sortOrder:number('sort_order'),isPinned:bool('is_pinned'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'source',logicalId:value.url,value,...(value.createdAt>0?{addedAtMillis:value.createdAt}:{})}];}
 throw Error('source_reconciliation_required');
}
