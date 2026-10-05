import type {SqlDatabase,SqlParams} from './types.ts';
import {isDeletableLocalContentChannel} from './imported-content.ts';
import {importedTextFileName} from '../reader/imported-text.ts';
import {stableArticleId,nativeTrim,type SyncTextPort} from '../sync/local-manifest.ts';
import type {SyncBodyCodec} from '../sync/article-body.ts';
import {deviceOrder} from '../sync/saved-state.ts';
import {libraryRevision,revisionGuard} from '../sync/revision.ts';
import {changeLogStatement} from '../sync/sequence-store.ts';

export interface ArticleDeletionFiles {
 list(path:string):Promise<{entries:{path:string;file:boolean;directory?:boolean}[]}>;
 remove(path:string):Promise<unknown>;
 stat(path:string):Promise<{exists:boolean}>;
}
/** Local imported-item deletion; never permits a normal RSS item through the service API. */
export class ImportedArticleDeletion {
 constructor(private readonly db:SqlDatabase,private readonly text:Pick<SyncTextPort,'parseUri'>,private readonly codec:Pick<SyncBodyCodec,'sha256'>,private readonly files:ArticleDeletionFiles,private readonly cancel:(id:number)=>Promise<void>,private readonly now=Date.now){}
 async delete(id:number):Promise<void>{
  if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid article id');
  await this.cancel(id);
  const revision=await libraryRevision(this.db);
  const row=(await this.db.query(`SELECT a.id,a.link,a.dedup_key,substr(a.content,1,256) content,c.url channel_url FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id=?`,[id]))[0];
  if(row){
   if(!isDeletableLocalContentChannel(String(row.channel_url)))return;
   const identity=(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];
   if(!identity)throw new Error('同步身份未初始化');
   const device=String(identity.device_id),at=this.now(),url=nativeTrim(String(row.link??''))?String(row.link):String(row.dedup_key);
   const articleId=await stableArticleId(url,this.text.parseUri,this.codec),marker=importedTextFileName(String(row.content??''))?String(row.content):null;
   const statements:{sql:string;params?:SqlParams}[]=[revisionGuard(revision),
    {sql:`INSERT OR REPLACE INTO sync_article_deletions(article_id,url,changed_at,source_device_id,source_order) VALUES(?,?,?,?,?)`,params:[articleId,url,at,device,deviceOrder(device)]},
    {sql:`INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
      SELECT ?,save_type,NULL,?,0,?,0,?,? FROM article_saved_states WHERE article_id=? AND saved=1
      ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=NULL,url=excluded.url,saved=0,changed_at=excluded.changed_at,sort_order=0,source_device_id=excluded.source_device_id,source_order=excluded.source_order`,params:[articleId,url,at,device,deviceOrder(device),id]},
    {sql:'INSERT OR REPLACE INTO article_deletion_cleanup(item_id,content_marker) VALUES(?,?)',params:[id,marker]},
    {sql:'DELETE FROM articles WHERE id=?',params:[id]},changeLogStatement('article',articleId,at,device,'delete',at)];
   await this.db.transaction(statements);
  }
  await this.cleanup(id);
 }
 private async removeFile(path:string):Promise<void>{
  await this.files.remove(path);
  if((await this.files.stat(path)).exists)throw new Error('删除文件失败：'+path);
 }
 async cleanupPending():Promise<void>{
  const rows=await this.db.query('SELECT item_id FROM article_deletion_cleanup');
  for(const row of rows)await this.cleanup(Number(row.item_id));
 }
 async cleanup(id:number):Promise<void>{
  const pending=(await this.db.query('SELECT content_marker FROM article_deletion_cleanup WHERE item_id=?',[id]))[0];
  if(!pending)return;
  // SQLite can reuse deleted row IDs. Never remove a replacement item's media.
  if(!(await this.db.query('SELECT id FROM articles WHERE id=?',[id])).length){
   const root=`offline/rss/${id}`;
   for(const entry of (await this.files.list(root)).entries){
    if(entry.file&&entry.path.startsWith(root+'/')&&!entry.path.slice(root.length+1).includes('/')&&!entry.path.includes('..'))await this.removeFile(entry.path);
   }
  }
  const marker=pending.content_marker==null?null:String(pending.content_marker),name=importedTextFileName(marker);
  if(name&&!(await this.db.query('SELECT id FROM articles WHERE content=? LIMIT 1',[marker])).length)await this.removeFile(`article_content/${name}`);
  await this.db.execute('DELETE FROM article_deletion_cleanup WHERE item_id=?',[id]);
 }
}
