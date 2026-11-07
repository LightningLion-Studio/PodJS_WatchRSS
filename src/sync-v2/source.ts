import {unhex,hex} from '@podjs/framework/crypto';
import {decodeUtf8Chunk,encodeUtf8} from '@podjs/framework/bytes';
import {readSqlKeysetPage,type ProjectionSql} from '@podjs/framework/sql-projection';
import {canonical,type Kind} from './protocol';
import type {SourceReader,SourceRecord} from './store';
/** A materializer consumes one existing business row plus its stable key. It
 * must return the complete frozen business record. It may not change the DB.
 * Missing metadata/identity/ancestry fails the page; no invented defaults. */
export type Materialize=(table:string,row:Record<string,unknown>)=>Promise<SourceRecord[]>;
export const BUSINESS_TABLE_KEYS:Readonly<Record<string,readonly string[]>>=Object.freeze({
 sync_books:['book_id'],sync_book_reading:['book_id','chapter_index'],article_register_state:['article_id'],memo_notes:['note_id'],memo_folders:['folder_id'],sync_source_states:['url'],articles:['id'],channels:['id'],sync_article_deletions:['article_id'],sync_book_reading_dirty:['item_id'],syncv2_rss_states:['id'],
});
export function encodeLocator(values:unknown[]){return 'hex-v1:'+values.map(value=>hex(encodeUtf8(String(value),'strict')).toUpperCase()).join(':');}
function decodeLocator(value:string){
 if(!value.startsWith('hex-v1:'))throw Error('invalid_locator');return value.slice(7).split(':').map(part=>{
  if(!/^(?:[0-9A-F]{2})*$/.test(part))throw Error('invalid_locator');const input=unhex(part.toLowerCase());let at=0,text='';while(at<input.length){const next=decodeUtf8Chunk(input,at);text+=next.text;at=next.next;}return text;
 });
}
const quote=(id:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(id))throw Error('invalid_sql_identifier');return id;};
export class SqlBusinessSource implements SourceReader {
 private constructor(private readonly db:ProjectionSql,private readonly tables:string[],private readonly materialize:Materialize){}
 static async open(db:ProjectionSql,materialize:Materialize=materializeFrozen){
  const existing=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)));
  return new SqlBusinessSource(db,Object.keys(BUSINESS_TABLE_KEYS).filter(t=>existing.has(t)),materialize);
 }
 async page(after:string,limit:number){
  const token=after?JSON.parse(after):{table:0,keys:null};if(!Number.isInteger(token.table)||token.table<0||token.keys!==null&&!Array.isArray(token.keys))throw Error('invalid_checkpoint');
  if(token.table>=this.tables.length)return {rows:[],after,done:true};
  const table=this.tables[token.table]!,keys=BUSINESS_TABLE_KEYS[table]!,values=token.keys as unknown[]|null;
  if(values&&values.length!==keys.length)throw Error('invalid_checkpoint');
  const attach=(row:Record<string,unknown>,records:SourceRecord[])=>records.map(record=>({...record,source:{table,locator:encodeLocator(keys.map(key=>row[key]))}}));
  if(token.pending){
   const row=(await this.db.query(`SELECT ${table==='articles'?'id':'*'} FROM ${quote(table)} WHERE ${keys.map(k=>quote(k)+' IS ?').join(' AND ')}`,token.pending.keys))[0],records=row?attach(row,await this.materialize(table,row)):[],end=Math.min(records.length,token.pending.offset+limit),pending=end<records.length?{keys:token.pending.keys,offset:end}:null;
   return {rows:records.slice(token.pending.offset,end),after:canonical(pending?{...token,pending}:{table:token.table,keys:token.pending.keys}),done:false};
  }
  const params:unknown[]=[],where=values?' WHERE '+keys.map((key,i)=>{for(let j=0;j<i;j++)params.push(values[j]);params.push(values[i]);return '('+[...keys.slice(0,i).map(k=>quote(k)+' IS ?'),quote(key)+'>?'].join(' AND ')+')';}).join(' OR '):'';
  const result=await readSqlKeysetPage(this.db,`SELECT ${table==='articles'?'id':'*'} FROM ${quote(table)}${where} ORDER BY ${keys.map(quote).join(',')}`,params,limit);
  const rows:SourceRecord[]=[];let last=values;
  for(const row of result.rows){const records=attach(row,await this.materialize(table,row)),space=limit-rows.length;if(records.length>space){rows.push(...records.slice(0,space));return {rows,after:canonical({table:token.table,keys:last,pending:{keys:keys.map(k=>row[k]),offset:space}}),done:false};}rows.push(...records);last=keys.map(k=>row[k]);}
  const next=result.rows.length===0?{table:token.table+1,keys:null}:{table:token.table,keys:last};
  return {rows,after:canonical(next),done:next.table>=this.tables.length};
 }

 async changed(table:string,locator:string){
  if(table==='note_merge_conflicts'){
   const values=decodeLocator(locator),incident=(await this.db.query('SELECT note_id FROM note_merge_conflicts WHERE conflict_id=?',values))[0];
   if(!incident)throw Error('source_reconciliation_required');
   const row=(await this.db.query('SELECT * FROM memo_notes WHERE note_id=?',[incident.note_id]))[0];if(!row)throw Error('source_identity_missing');
   return this.materialize('memo_notes',row);
  }
  if(['article_reading_state','article_saved_states','cloud_rss_article_ids','article_sync_encoding_cache','article_sync_content','article_native_sync_hash','sync_body_revision','sync_saved_states','sync_article_ids'].includes(table)){
   const values=decodeLocator(locator);let id:unknown=values[0];
   if(table==='sync_saved_states')id=(await this.db.query('SELECT item_id FROM sync_saved_states WHERE article_id=? AND save_type=?',values))[0]?.item_id;
   if(table==='sync_article_ids')id=(await this.db.query('SELECT item_id FROM sync_article_ids WHERE article_id=?',values))[0]?.item_id;
   const row=(await this.db.query('SELECT id FROM articles WHERE id=?',[id??null]))[0];if(!row)throw Error('source_tombstone_required');return this.materialize('articles',row);
  }

  const keys=BUSINESS_TABLE_KEYS[table];if(!keys)throw Error('source_reconciliation_required');
  const values=decodeLocator(locator);if(!Array.isArray(values)||values.length!==keys.length)throw Error('invalid_locator');
  const row=(await this.db.query(`SELECT ${table==='articles'?'id':'*'} FROM ${quote(table)} WHERE ${keys.map(k=>quote(k)+' IS ?').join(' AND ')}`,values))[0];
  // Physical removal is not a new logical tombstone. Preserve its previous
  // candidate until the business tombstone materializer supplies the value.
  if(!row)return this.materialize(table,{__removed:true,__locator:locator});return (await this.materialize(table,row)).map(record=>({...record,source:{table,locator}}));
 }
}
export async function materializeFrozen(table:string,row:Record<string,unknown>):Promise<SourceRecord[]>{
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
 if(table==='memo_folders'){const value={folderId:text('folder_id'),name:text('name'),sortOrder:number('sort_order'),updatedAt:number('updated_at'),modifiedBy:text('modified_by'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'folder',logicalId:value.folderId,value}];}
 if(table==='sync_source_states'){const value={url:text('url'),sourceDeviceId:text('source_device_id'),title:text('title'),description:text('description'),siteUrl:row.site_url===null?null:text('site_url'),imageUrl:row.image_url===null?null:text('image_url'),createdAt:number('created_at'),updatedAt:number('updated_at'),sortOrder:number('sort_order'),isPinned:bool('is_pinned'),deleted:bool('deleted'),deletedAt:number('deleted_at')};return [{kind:'source',logicalId:value.url,value,...(value.createdAt>0?{addedAtMillis:value.createdAt}:{})}];}
 throw Error('source_reconciliation_required');
}
