import type {SqlDatabase, SqlParams} from './types.ts';
import {BUILTIN_CHANNELS} from './builtin-channels.ts';
import {articlePreview} from './preview.ts';
import {localSavedStateStatements, type SyncSaveType} from '../sync/saved-state.ts';
import type {BiliItem} from '../bili/types.ts';
import type {DouyinItem} from '../douyin/types.ts';

export interface ExternalSavedItem {
  channelUrl: string; title: string; description: string | null; link: string;
  guid: string; imageUrl: string | null; videoUrl: string | null;
}
export function biliExternalItem(item:BiliItem):ExternalSavedItem {
  const bvid=item.bvid?.trim(), base=bvid?`https://www.bilibili.com/video/${bvid}`:item.aid!=null?`https://www.bilibili.com/video/av${item.aid}`:'';
  if(!base)throw new Error('当前内容暂不支持保存');
  const link=base+(item.cid!=null?`?cid=${item.cid}`:'');
  return {channelUrl:'builtin:bili',title:item.title?.trim()|| (bvid?`BV号 ${bvid}`:`av${item.aid}`),description:item.owner?.name?.trim()?`UP主：${item.owner.name.trim()}`:null,link,guid:`bili:${bvid||`av${item.aid}`}`,imageUrl:item.cover?.trim()||null,videoUrl:link};
}
export function douyinExternalItem(item:DouyinItem):ExternalSavedItem {
  const id=item.awemeId.trim();
  if(!id)throw new Error('当前内容暂不支持保存');
  const description=[item.authorName?.trim()?`作者：${item.authorName.trim()}`:'',item.likeCount>0?`点赞 ${item.likeCount}`:''].filter(Boolean).join(' · ')||null;
  return {channelUrl:'builtin:douyin',title:item.description?.trim()||'抖音视频',description,link:`https://www.douyin.com/video/${id}`,guid:`douyin:${id}`,imageUrl:item.coverUrl?.trim()||null,videoUrl:item.playUrl?.trim()||null};
}

/** External saves use the same article, saved-state and sync journal as RSS.
 * Native updates content only on dedup hits, retaining title/link/read/fetch time. */
export class ExternalSavedStore {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(readonly db:SqlDatabase,private readonly alias:(id:number)=>Promise<{sql:string;params:SqlParams}[]>,private readonly now:()=>number=Date.now){}
  async initializeMigration(){await this.db.execute('CREATE TABLE IF NOT EXISTS external_saved_migrations(key TEXT PRIMARY KEY)');}
  async migrated(key:string){return !!(await this.db.query('SELECT 1 FROM external_saved_migrations WHERE key=?',[key])).length;}
  async markMigrated(key:string){await this.db.execute('INSERT OR IGNORE INTO external_saved_migrations(key) VALUES(?)',[key]);}
  sync(item:ExternalSavedItem,type:SyncSaveType,saved:boolean,migration?:{key:string;changedAt:number;createdAt:number}):Promise<void>{
    const result=this.tail.then(()=>this.write(item,type,saved,migration));this.tail=result.catch(()=>{});return result;
  }
  private async write(item:ExternalSavedItem,type:SyncSaveType,saved:boolean,migration?:{key:string;changedAt:number;createdAt:number}) {
    if(migration&&await this.migrated(migration.key))return;
    let channel=(await this.db.query('SELECT id FROM channels WHERE url=?',[item.channelUrl]))[0];
    const now=migration?.changedAt??this.now();
    if(!channel){
      const builtin=BUILTIN_CHANNELS.find(c=>c.url===item.channelUrl);if(!builtin)throw new Error('频道不存在');
      await this.db.transaction([
        {sql:'INSERT OR IGNORE INTO channels(url,title,description,created_at,sort_order,is_pinned) VALUES(?,?,?,?,?,0)',params:[builtin.url,builtin.title,builtin.description,now,now]},
        {sql:'INSERT OR IGNORE INTO source_preferences(channel_id,use_original_content) SELECT id,1 FROM channels WHERE url=?',params:[builtin.url]},
      ]);
      channel=(await this.db.query('SELECT id FROM channels WHERE url=?',[item.channelUrl]))[0];
    }
    const channelId=Number(channel.id),key=`guid:${item.guid}`;
    let row=(await this.db.query('SELECT id FROM articles WHERE channel_id=? AND dedup_key=?',[channelId,key]))[0];
    // A missing cancellation has no article side effect in native. Explicit
    // legacy tombstones must be materialized to preserve their sync timestamp.
    if(!row&&!saved&&!migration)return;
    if(!row){await this.db.execute('INSERT OR IGNORE INTO articles(channel_id,title,description,content,link,guid,image_url,video_url,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[channelId,item.title,item.description,item.description,item.link,item.guid,item.imageUrl,item.videoUrl,key,migration?.createdAt??now]);row=(await this.db.query('SELECT id FROM articles WHERE channel_id=? AND dedup_key=?',[channelId,key]))[0];}
    const id=Number(row.id),preview=articlePreview(item.description,item.description,item.imageUrl,item.link);
    const ss:{sql:string;params:SqlParams}[]=[];
    // A pre-existing SQL state always wins over a legacy KV record (including
    // cancellations/phone replacements). The ledger survives clearLibrary.
    const existing=migration&&(await this.db.query(`SELECT 1 FROM article_saved_states WHERE article_id=? AND save_type=? UNION ALL SELECT 1 FROM sync_saved_states WHERE url=? AND save_type=?`,[id,type,item.link,type])).length;
    if(!existing){
      ss.push(...await this.alias(id),
        // Import the effective phone state before comparing a new local action.
        // Alias cleanup leaves inactive rows with saved=0; that is not a new
        // cancellation clock and must not suppress a later local cancellation.
        {sql:`INSERT INTO article_saved_entry_times(article_id,save_type,created_at)
          SELECT ?,s.save_type,COALESCE(t.created_at,s.changed_at) FROM sync_saved_states s JOIN sync_article_aliases al ON al.article_id=s.article_id LEFT JOIN article_saved_entry_times t ON t.article_id=s.item_id AND t.save_type=s.save_type WHERE al.item_id=? AND s.save_type=? AND s.item_id!=?
          ON CONFLICT(article_id,save_type) DO UPDATE SET created_at=excluded.created_at`,params:[id,id,type,id]},
        {sql:`INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order)
          SELECT ?,s.save_type,s.saved,s.changed_at,-s.sort_order FROM sync_saved_states s JOIN sync_article_aliases al ON al.article_id=s.article_id WHERE al.item_id=? AND s.save_type=? AND s.item_id!=?
          ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order`,params:[id,id,type,id]},
        {sql:'UPDATE articles SET description=?,content=?,image_url=?,audio_url=NULL,video_url=? WHERE id=?',params:[item.description,item.description,item.imageUrl,item.videoUrl,id]},
        {sql:'INSERT INTO article_previews(article_id,summary,image_url) VALUES(?,?,?) ON CONFLICT(article_id) DO UPDATE SET summary=excluded.summary,image_url=excluded.image_url',params:[id,preview.summary,preview.imageUrl]},
        {sql:'DELETE FROM article_body_chunks WHERE article_id=?',params:[id]},
        {sql:`INSERT INTO article_saved_entry_times(article_id,save_type,created_at) VALUES(?,?,?) ON CONFLICT(article_id,save_type) DO UPDATE SET created_at=excluded.created_at WHERE COALESCE((SELECT saved FROM article_saved_states WHERE article_id=? AND save_type=?),0)=0`,params:[id,type,migration?.createdAt??now,id,type]},
        {sql:`INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,?,?,?,?) ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=CASE WHEN article_saved_states.saved!=excluded.saved THEN excluded.changed_at ELSE article_saved_states.changed_at END,sort_order=CASE WHEN article_saved_states.saved!=excluded.saved THEN excluded.sort_order ELSE article_saved_states.sort_order END`,params:[id,type,saved?1:0,now,-now]},
        ...localSavedStateStatements(id,type));
      if(type==='favorite')ss.push({sql:'UPDATE articles SET is_saved=? WHERE id=?',params:[saved?1:0,id]});
    }
    if(migration)ss.push({sql:'INSERT OR IGNORE INTO external_saved_migrations(key) VALUES(?)',params:[migration.key]});
    // Recompute the legacy favorite flag after alias cleanup as well.
    ss.push({sql:"UPDATE articles SET is_saved=COALESCE((SELECT saved FROM article_saved_states WHERE article_id=articles.id AND save_type='favorite'),0) WHERE id=?",params:[id]});
    await this.db.transaction(ss);
  }
}
