import type {SqlDatabase} from '../core/types';
import {buildArticleBlocksAsync} from './media';
import {resolveUrl} from '../core/parser';
import {readOfflineMedia,offlineMediaPath} from './offline-media';
export interface OfflineQueuePort {
 body(id:number):Promise<string|null>;
 stat(path:string):Promise<{file:boolean;size:number}>;
 download(url:string,path:string,maxBytes:number):{result:Promise<unknown>;cancel():void};
 remove(path:string):Promise<unknown>;
 clearItem(id:number):Promise<void>;
 schedule(ms:number,run:()=>void):()=>void;
 now?():number;
}
type Job={item_id:number;generation:number;desired:string;attempts:number;next_at:number};
/** Serial, durable, bounded retries. Saved-state SQL and job intent commit together. */
export class OfflineMediaQueue {
 private running:Promise<void>|undefined;private wakeAgain=false;private active:{job:Job;cancel:()=>void}|undefined;
 private cancelTimer=()=>{};private paused=false;
 /** Quiesce before destructive local cleanup. Keep paused until its durable intent completes. */
 pause():Promise<void>{this.paused=true;this.cancelTimer();this.active?.cancel();return this.running??Promise.resolve();}
 resume(){this.paused=false;void this.wake().catch(()=>{});}
 private readonly now:()=>number;
 constructor(private readonly db:SqlDatabase,private readonly port:OfflineQueuePort){this.now=port.now??Date.now;}
 wake():Promise<void>{
  this.cancelTimer();
  if(this.paused)return this.running??Promise.resolve();
  if(this.running){this.wakeAgain=true;void this.cancelStale().catch(()=>{});return this.running;}
  return this.running=this.drain().finally(()=>{this.running=undefined;if(this.wakeAgain){this.wakeAgain=false;void this.wake().catch(()=>{});}});
 }
 private async current(job:Job):Promise<boolean>{if(this.paused)return false;const row=(await this.db.query('SELECT generation,desired FROM offline_media_jobs WHERE item_id=?',[job.item_id]))[0];return !!row&&Number(row.generation)===job.generation&&String(row.desired)===job.desired;}
 private async cancelStale(){const active=this.active;if(active&&!await this.current(active.job))active.cancel();}
 async status(id:number){const row=(await this.db.query('SELECT desired,attempts,next_at,last_error FROM offline_media_jobs WHERE item_id=?',[id]))[0];return row?{desired:String(row.desired),attempts:Number(row.attempts),nextAt:Number(row.next_at),error:row.last_error==null?null:String(row.last_error)}:null;}
 async retry(id:number){
  await this.db.execute(`INSERT INTO offline_media_jobs(item_id,generation,desired,attempts,next_at,last_error) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM article_saved_states WHERE article_id=? AND saved=1) THEN 'download' ELSE 'cleanup' END,0,0,NULL WHERE EXISTS(SELECT 1 FROM article_saved_states WHERE article_id=? AND saved=1) OR EXISTS(SELECT 1 FROM offline_media_jobs WHERE item_id=?) ON CONFLICT(item_id) DO UPDATE SET generation=generation+1,desired=excluded.desired,attempts=0,next_at=0,last_error=NULL`,[id,id,id,id]);
  await this.wake();return readOfflineMedia(this.db,this.port,id);
 }
 private async drain(){
  for(;;){
   if(this.paused)return;
   const row=(await this.db.query('SELECT * FROM offline_media_jobs WHERE next_at<=? AND attempts<6 ORDER BY item_id LIMIT 1',[this.now()]))[0];
   if(!row){const next=(await this.db.query('SELECT min(next_at) AS next FROM offline_media_jobs WHERE attempts<6'))[0]?.next;if(next!=null)this.cancelTimer=this.port.schedule(Math.max(1000,Number(next)-this.now()),()=>{void this.wake().catch(()=>{});});return;}
   const job:Job={item_id:Number(row.item_id),generation:Number(row.generation),desired:String(row.desired),attempts:Number(row.attempts),next_at:Number(row.next_at)};
   try{
    if(job.desired==='cleanup'){
     await this.port.clearItem(job.item_id);
     await this.db.execute('DELETE FROM offline_media WHERE item_id=?',[job.item_id]);
    }else await this.download(job);
    if(await this.current(job))await this.db.execute('DELETE FROM offline_media_jobs WHERE item_id=? AND generation=?',[job.item_id,job.generation]);
   }catch{
    if(this.paused)return;
    await this.db.execute(`UPDATE offline_media_jobs SET attempts=attempts+1,next_at=?,last_error='media_unavailable' WHERE item_id=? AND generation=?`,[this.now()+Math.min(3600000,30000*2**job.attempts),job.item_id,job.generation]);
   }finally{this.active=undefined;}
  }
 }
 private async download(job:Job){
  const id=job.item_id,row=(await this.db.query('SELECT a.link,a.image_url,a.video_url,c.url AS source_url FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id=? AND EXISTS(SELECT 1 FROM article_saved_states WHERE article_id=a.id AND saved=1)',[id]))[0];
  if(!row||!await this.current(job))return;
  const body=await this.port.body(id);if(!await this.current(job))return;
  const blocks=await buildArticleBlocksAsync(body??'',{enclosureImageUrl:row.image_url?String(row.image_url):undefined,videoUrl:row.video_url?String(row.video_url):undefined});
  const base=/^https?:\/\//i.test(String(row.link??''))?String(row.link):String(row.source_url??'');
  const media=new Map<string,'IMAGE'|'VIDEO'>();
  for(const b of blocks){if(b.type==='text')continue;const url=resolveUrl(b.url,base);if(url&&/^https?:\/\//i.test(url))media.set(b.url,b.type==='video'?'VIDEO':'IMAGE');}
  if(!await this.current(job))return;
  // Persist every extracted record BEFORE IO, including failures, for reader retry UI.
  await this.db.transaction([...media].map(([url,kind])=>({sql:'INSERT OR IGNORE INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) SELECT ?,?,?,NULL,? WHERE EXISTS(SELECT 1 FROM offline_media_jobs WHERE item_id=? AND generation=?)',params:[id,kind,url,this.now(),id,job.generation]})));
  let failed=false;const byUrl=new Map<string,string|null>();
  for(const media of await this.db.query('SELECT id,origin_url,media_type,relative_path FROM offline_media WHERE item_id=? ORDER BY id',[id])){
   if(!await this.current(job))return;
   const downloadUrl=resolveUrl(String(media.origin_url),base);
   if(!downloadUrl||!/^https?:\/\//i.test(downloadUrl)){failed=true;continue;}
   const old=offlineMediaPath(id,media.relative_path==null?null:String(media.relative_path));
   if(old){const info=await this.port.stat(old).catch(()=>null);if(info?.file&&Number.isSafeInteger(info.size)&&info.size>0){byUrl.set(downloadUrl,old);continue;}}
   const shared=byUrl.get(downloadUrl);
   if(shared){await this.db.execute("UPDATE offline_media SET relative_path=? WHERE id=? AND EXISTS(SELECT 1 FROM offline_media_jobs WHERE item_id=? AND generation=? AND desired='download')",[shared,media.id,id,job.generation]);continue;}
   if(byUrl.has(downloadUrl)){failed=true;continue;}
   const ext=(downloadUrl.split(/[?#]/,1)[0]??'').match(/\.([a-z0-9]{1,6})$/i)?.[1]?.toLowerCase()??(media.media_type==='VIDEO'?'mp4':'jpg');
   const path=`offline/rss/${id}/${String(media.media_type).toLowerCase()}_${Number(media.id)}_g${job.generation}.${ext}`;
   try{
    const task=this.port.download(downloadUrl,path,32*1024*1024);this.active={job,cancel:()=>task.cancel()};
    if(!await this.current(job)){task.cancel();await task.result.catch(()=>{});await this.port.remove(path);return;}
    await task.result;const info=await this.port.stat(path);
    if(!await this.current(job)){await this.port.remove(path);return;}
    if(!info.file||!Number.isSafeInteger(info.size)||info.size<=0)throw Error('media_empty');
    byUrl.set(downloadUrl,path);
    await this.db.execute(`UPDATE offline_media SET relative_path=? WHERE id=? AND EXISTS(SELECT 1 FROM offline_media_jobs WHERE item_id=? AND generation=? AND desired='download')`,[path,media.id,id,job.generation]);
   }catch{failed=true;byUrl.set(downloadUrl,null);await this.port.remove(path).catch(()=>{});}
   finally{this.active=undefined;}
  }
  if(failed)throw Error('offline_media_failed');
 }
}
