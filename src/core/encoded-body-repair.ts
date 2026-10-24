import {unwrapEscapedHtml} from '@podjs/framework/html';
import {yieldWorkTurn} from '@podjs/framework/text-layout';
import {isImportedContentUrl} from './imported-content';
import {articlePreview} from './preview';
import type {SqlDatabase} from './types';

/** Repair the RSS XML-envelope bug only. Preserve the exact original and all
 * identity/read/saved clocks. Imported books and received hash-addressed bodies
 * are excluded; their reader still has the non-mutating defensive decoder. */
export async function repairEncodedRssBodies(db:SqlDatabase,options:{id?:number;yieldTurn?:()=>Promise<unknown>}={}):Promise<number>{
 await db.execute('CREATE TABLE IF NOT EXISTS article_html_repair_backup(article_id INTEGER PRIMARY KEY,body TEXT NOT NULL,was_chunked INTEGER NOT NULL)');
 let cursor=0,repaired=0;
 for(;;){
  const rows=await db.query(`SELECT a.id,a.content,a.description,a.link,a.image_url,c.url FROM articles a JOIN channels c ON c.id=a.channel_id
    WHERE a.id>? ${options.id===undefined?'':'AND a.id=?'} AND NOT EXISTS(SELECT 1 FROM article_sync_content s WHERE s.item_id=a.id)
    AND (a.content LIKE '&lt;%' OR a.content LIKE '&amp;lt;%' OR (a.content IS NULL AND EXISTS(SELECT 1 FROM article_body_chunks b WHERE b.article_id=a.id AND b.chunk_index=0 AND (b.body LIKE '&lt;%' OR b.body LIKE '&amp;lt;%'))))
    ORDER BY a.id LIMIT 1`,options.id===undefined?[cursor]:[cursor,options.id]);
  if(!rows.length)return repaired;
  for(const row of rows){
   const id=Number(row.id);cursor=id;
   if(!/^https?:\/\//i.test(String(row.url))||isImportedContentUrl(String(row.url)))continue;
   const parts=row.content==null?await db.query('SELECT body FROM article_body_chunks WHERE article_id=? ORDER BY chunk_index',[id]):[];
   const before=row.content==null?parts.map(part=>String(part.body)).join(''):String(row.content),after=unwrapEscapedHtml(before);
   if(before===after)continue;
   const guard=`id=? AND content IS ? AND NOT EXISTS(SELECT 1 FROM article_sync_content s WHERE s.item_id=articles.id)${row.content==null?" AND (SELECT group_concat(body,'') FROM (SELECT body FROM article_body_chunks WHERE article_id=articles.id ORDER BY chunk_index)) IS ?":''}`;
   const guardParams=[id,row.content??null,...(row.content==null?[before]:[])];
   const preview=articlePreview(after,row.description==null?null:String(row.description),row.image_url==null?null:String(row.image_url),row.link==null?null:String(row.link));
   // CAS protects a concurrent refresh. Backup and repair share the transaction;
   // the old chunks remain intact, while content takes precedence on reads.
   await db.transaction([
    {sql:`INSERT OR IGNORE INTO article_html_repair_backup(article_id,body,was_chunked) SELECT id,?,? FROM articles WHERE ${guard}`,params:[before,row.content==null?1:0,...guardParams]},
    {sql:`UPDATE articles SET content=? WHERE ${guard}`,params:[after,...guardParams]},
    {sql:`INSERT INTO article_previews(article_id,summary,image_url) SELECT id,?,? FROM articles WHERE id=? AND content=? ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url`,params:[preview.summary,preview.imageUrl,id,after]},
   ]);
   if((await db.query('SELECT id FROM articles WHERE id=? AND content=?',[id,after])).length)repaired++;
  }
  if(options.id!==undefined)return repaired;
  await (options.yieldTurn?options.yieldTurn():yieldWorkTurn().result);
 }
}
