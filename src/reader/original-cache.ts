import type { SqlDatabase } from "../core/types.ts";
import { resolveUrl } from "../core/parser.ts";
import { articlePreview } from "../core/preview.ts";
import { extractReadableHtml } from "./content.ts";

export interface OriginalDownload { cancelled:boolean; cancel?:()=>void }
export interface OriginalContent { html:string; sourceUrl:string }
type Identity={id:number;channelId:number;channelUrl:string;link:string;key:string};
type Job=OriginalDownload&{id:string;channelId?:number;forced:boolean;started:boolean;promise:Promise<OriginalContent>;resolve:(value:OriginalContent)=>void;reject:(error:unknown)=>void};
/** One shared request per article; foreground reads join/promote visible-list prefetches. */
export class OriginalContentCache {
  private jobs=new Map<string,Job>();
  private queue:Job[]=[];
  private active=0;
  private paused=new Set<number>();
  private waiters=new Map<number,Set<()=>void>>();
  constructor(private db:SqlDatabase,private download:(url:string,job:OriginalDownload)=>Promise<string>,private concurrency=2,private onStored?:(channelId:string)=>void) {}
  get(id:string):Promise<OriginalContent> {return this.request(id,true);}
  async prefetch(channelId:string,ids:string[]):Promise<void> {
    // Only the requested channel and uncached articles qualify. Cached HTML is not hydrated for a list.
    const unique=[...new Set(ids)];
    const pending:Promise<void>[]=[];
    for(const id of unique) {
      const row=(await this.db.query(`SELECT a.id,m.article_id cached,o.article_id has_preview FROM articles a JOIN source_preferences p ON p.channel_id=a.channel_id LEFT JOIN article_original_meta m ON m.article_id=a.id LEFT JOIN article_original_previews o ON o.article_id=a.id WHERE a.id=? AND a.channel_id=? AND p.use_original_content=1`,[Number(id),Number(channelId)]))[0];
      if(!row||(row.cached&&row.has_preview))continue;
      if(row.cached&&await this.repairPreview(id,channelId))continue;
      pending.push(this.request(id,false,Number(channelId)).then(()=>{},()=>{}));
    }
    await Promise.allSettled(pending);
  }
  setPaused(channelId:string,paused:boolean) {
    const id=Number(channelId);if(paused){this.paused.add(id);return;}
    this.paused.delete(id);const waiters=this.waiters.get(id);this.waiters.delete(id);waiters?.forEach(resolve=>resolve());
  }
  private async waitUntilSettled(job:Pick<Job,"channelId"|"cancelled">){
    while(job.channelId!==undefined&&this.paused.has(job.channelId)){
      this.check(job);const id=job.channelId;
      await new Promise<void>(resolve=>{const group=this.waiters.get(id)??new Set<()=>void>();group.add(resolve);this.waiters.set(id,group);});
    }
    this.check(job);
  }
  cancelChannel(channelId:string) {
    for(const job of this.jobs.values())if(job.channelId===Number(channelId)){job.cancelled=true;job.cancel?.();}
    this.setPaused(channelId,false);
  }
  async cancelItems(ids:readonly string[]):Promise<void> {
    const removed=new Set(ids),jobs=[...this.jobs.values()].filter(job=>removed.has(job.id));
    for(const job of jobs){
      job.cancelled=true;job.cancel?.();
      if(!job.started){this.queue=this.queue.filter(queued=>queued!==job);this.jobs.delete(job.id);job.reject(new Error("文章已移除"));}
      if(job.channelId!==undefined)this.waiters.get(job.channelId)?.forEach(resolve=>resolve());
    }
    await Promise.allSettled(jobs.map(job=>job.promise));
  }
  /** One-time migration for caches written before original preview metadata existed; never read the whole body. */
  private async repairPreview(id:string,channelId:string):Promise<boolean> {
    const row=(await this.db.query(`SELECT a.dedup_key,a.image_url,m.source_url,substr(b.body,1,16384) snippet FROM articles a JOIN article_original_meta m ON m.article_id=a.id JOIN article_original_chunks b ON b.article_id=a.id AND b.chunk_index=0 WHERE a.id=? AND a.channel_id=?`,[Number(id),Number(channelId)]))[0];
    if(!row?.snippet)return false;
    const preview=articlePreview(String(row.snippet),"",null,String(row.source_url));
    await this.waitUntilSettled({channelId:Number(channelId),cancelled:false});
    const condition=`EXISTS(SELECT 1 FROM articles a JOIN article_original_meta m ON m.article_id=a.id WHERE a.id=? AND a.channel_id=? AND a.dedup_key=? AND m.source_url=?)`;
    const match=[Number(id),Number(channelId),String(row.dedup_key),String(row.source_url)];
    await this.db.transaction([
      {sql:`INSERT INTO article_original_previews(article_id,summary,image_url) SELECT ?,?,? WHERE ${condition} ON CONFLICT(article_id) DO NOTHING`,params:[Number(id),preview.summary,preview.imageUrl,...match]},
      {sql:`INSERT INTO article_previews(article_id,summary,image_url) SELECT ?,?,? WHERE ${condition} ON CONFLICT(article_id) DO UPDATE SET summary=CASE WHEN article_previews.summary IS NULL OR article_previews.summary='' THEN excluded.summary ELSE article_previews.summary END,image_url=CASE WHEN article_previews.image_url IS NULL OR article_previews.image_url='' THEN excluded.image_url ELSE article_previews.image_url END`,params:[Number(id),preview.summary,row.image_url?String(row.image_url):preview.imageUrl,...match]}
    ]);
    this.onStored?.(channelId);return true;
  }
  private request(id:string,forced:boolean,channelId?:number):Promise<OriginalContent> {
    const existing=this.jobs.get(id);
    if(existing){
      if(forced){existing.forced=true;if(!existing.started){const index=this.queue.indexOf(existing);if(index>=0){this.queue.splice(index,1);this.queue.unshift(existing);}}}
      return existing.promise;
    }
    let resolve!:(value:OriginalContent)=>void,reject!:(error:unknown)=>void;
    const promise=new Promise<OriginalContent>((yes,no)=>{resolve=yes;reject=no;});
    const job:Job={id,forced,channelId,started:false,cancelled:false,promise,resolve,reject};
    this.jobs.set(id,job);if(forced)this.queue.unshift(job);else this.queue.push(job);this.pump();return promise;
  }
  private pump() {
    while(this.active<this.concurrency&&this.queue.length){
      const job=this.queue.shift()!;this.active++;job.started=true;
      void this.load(job).then(value=>{this.finish(job);job.resolve(value);},error=>{this.finish(job);job.reject(error);});
    }
  }
  private finish(job:Job){this.jobs.delete(job.id);this.active--;this.pump();}
  private check(job:OriginalDownload){if(job.cancelled)throw new Error("原文请求已取消");}
  private async identity(job:Job):Promise<Identity> {
    this.check(job);
    const row=(await this.db.query(`SELECT a.id,a.channel_id,a.link,a.dedup_key,c.url,COALESCE(p.use_original_content,0) enabled FROM articles a JOIN channels c ON c.id=a.channel_id LEFT JOIN source_preferences p ON p.channel_id=c.id WHERE a.id=?`,[Number(job.id)]))[0];
    if(!row)throw new Error("文章不存在");
    if(job.channelId!==undefined&&job.channelId!==Number(row.channel_id))throw new Error("频道已改变");
    job.channelId=Number(row.channel_id);
    if(!job.forced&&!Number(row.enabled))throw new Error("原文预取已关闭");
    this.check(job);
    return {id:Number(row.id),channelId:Number(row.channel_id),channelUrl:String(row.url),link:String(row.link??""),key:String(row.dedup_key)};
  }
  private async load(job:Job):Promise<OriginalContent> {
    const identity=await this.identity(job);
    const meta=(await this.db.query("SELECT source_url FROM article_original_meta WHERE article_id=?",[identity.id]))[0];
    if(meta){
      const parts:string[]=[];
      for(let index=0;;index++){
        this.check(job);const rows=await this.db.query("SELECT body FROM article_original_chunks WHERE article_id=? AND chunk_index=? LIMIT 1",[identity.id,index]);
        if(!rows.length)break;parts.push(String(rows[0].body));
      }
      if(parts.length)return {html:parts.join(""),sourceUrl:String(meta.source_url)};
      // An incomplete cache is repaired by a new download below.
    }
    const sourceUrl=resolveUrl(identity.link,identity.channelUrl)??"";
    if(!/^https?:\/\//i.test(sourceUrl))throw new Error("文章没有可读取的网页链接");
    this.check(job);const raw=await this.download(sourceUrl,job);this.check(job);
    const html=extractReadableHtml(raw,sourceUrl)??"";
    if(!html)throw new Error("网页没有可读取的正文");
    await this.waitUntilSettled(job);
    const latest=await this.identity(job);
    if(latest.channelUrl!==identity.channelUrl||latest.link!==identity.link||latest.key!==identity.key)throw new Error("文章已改变");
    this.check(job);
    // Re-check identity inside every write: a delete/recreate may occur while the host transaction is queued.
    const condition=`EXISTS(SELECT 1 FROM articles a JOIN channels c ON c.id=a.channel_id WHERE a.id=? AND a.channel_id=? AND a.dedup_key=? AND COALESCE(a.link,'')=? AND c.url=?)`;
    const match=[identity.id,identity.channelId,identity.key,identity.link,identity.channelUrl];
    const statements:{sql:string;params:(string|number|null)[]}[]=[{sql:`DELETE FROM article_original_chunks WHERE article_id=? AND ${condition}`,params:[identity.id,...match]}];
    for(let start=0,index=0;start<html.length;index++){
      let end=Math.min(start+65536,html.length);if(end<html.length&&/[\uD800-\uDBFF]/.test(html[end-1]))end--;
      statements.push({sql:`INSERT INTO article_original_chunks(article_id,chunk_index,body) SELECT ?,?,? WHERE ${condition}`,params:[identity.id,index,html.slice(start,end),...match]});start=end;
    }
    const previewRow=(await this.db.query("SELECT substr(description,1,2048) description,image_url FROM articles WHERE id=?",[identity.id]))[0];
    const originalPreview=articlePreview(html.slice(0,16384),"",null,sourceUrl);
    statements.push({sql:`INSERT INTO article_original_previews(article_id,summary,image_url) SELECT ?,?,? WHERE ${condition} ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url`,params:[identity.id,originalPreview.summary,originalPreview.imageUrl,...match]});
    const preview=articlePreview(html.slice(0,16384),String(previewRow?.description??""),String(previewRow?.image_url??""),sourceUrl);
    statements.push({sql:`INSERT INTO article_previews(article_id,summary,image_url) SELECT ?,?,? WHERE ${condition} ON CONFLICT(article_id) DO UPDATE SET summary=CASE WHEN article_previews.summary IS NULL OR article_previews.summary='' THEN excluded.summary ELSE article_previews.summary END,image_url=CASE WHEN article_previews.image_url IS NULL OR article_previews.image_url='' THEN excluded.image_url ELSE article_previews.image_url END`,params:[identity.id,preview.summary??"",preview.imageUrl??"",...match]});
    statements.push({sql:`INSERT INTO article_original_meta(article_id,source_url,fetched_at) SELECT ?,?,? WHERE ${condition} ON CONFLICT(article_id) DO UPDATE SET source_url=excluded.source_url,fetched_at=excluded.fetched_at`,params:[identity.id,sourceUrl,Date.now(),...match]});
    await this.waitUntilSettled(job);this.check(job);await this.db.transaction(statements);this.check(job);this.onStored?.(String(identity.channelId));
    return {html,sourceUrl};
  }
}
