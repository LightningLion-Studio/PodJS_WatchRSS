import {admitDouyinItem} from "./playback-ingress.ts";
import {applyPreferredDouyinPlayback} from "./playback-selector.ts";
import {douyinExternalItem, type ExternalSavedStore} from "../core/external-saved.ts";
import type { DouyinItem, DouyinSavedEntry, DouyinSavedKind, DouyinSavedState, DouyinSavedStorage } from "./types.ts";

const KEY = "douyin.saved.v1";

export function buildDouyinShareUrl(awemeId: string): string | null {
  const id = awemeId.trim();
  return id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : null;
}

const VIDEO_LINK='https://www.douyin.com/video/';
const SAVED_COLUMNS=`SELECT a.title,a.description,a.link,a.video_url,a.image_url,s.save_type,
 COALESCE(t.created_at,s.changed_at) saved_at FROM articles a
 JOIN article_saved_states s ON s.article_id=a.id
 LEFT JOIN article_saved_entry_times t ON t.article_id=a.id AND t.save_type=s.save_type`;
const SAVE_ORDER='ORDER BY s.sort_order,s.changed_at DESC,a.id,s.save_type';
function savedEntry(row:Record<string,unknown>):DouyinSavedEntry {
  const shareUrl=String(row.link),awemeId=shareUrl.slice(VIDEO_LINK.length),description=String(row.description??'');
  const authorName=description.startsWith('作者：')?description.slice(3).split('·')[0]!.trim():'';
  return {platform:'douyin',awemeId,kind:row.save_type as DouyinSavedKind,savedAtMillis:Number(row.saved_at),shareUrl,
    item:{awemeId,description:String(row.title),authorName,likeCount:Number(/点赞 (\d+)/.exec(description)?.[1]??0),
      playUrl:String(row.video_url??''),coverUrl:row.image_url==null?undefined:String(row.image_url),
      createdAtSeconds:0,authorId:'',commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]}};
}

/** Local favorite/watch-later storage matching Android's two RSS SaveType lists. */
export class DouyinSavedStore {
  constructor(private readonly storage: DouyinSavedStorage, private readonly now: () => number = Date.now, private readonly sql?: ExternalSavedStore) {}

  private migration?:Promise<void>;
  migrate():Promise<void>{
    return this.migration??=this.migrateLegacy().catch(error=>{this.migration=undefined;throw error;});
  }
  private async migrateLegacy():Promise<void> {
    if(!this.sql)return;
    await this.sql.initializeMigration();
    if(await this.sql.migrated(KEY))return;
    const raw=await this.storage.get(KEY);
    const entries=raw?JSON.parse(raw):[];
    if(!Array.isArray(entries))throw new Error("抖音旧收藏数据格式错误");
    for(const entry of entries){
      if(entry?.platform!=="douyin"||(entry.kind!=="favorite"&&entry.kind!=="watchLater")||(typeof entry.item?.awemeId!=="string"||!entry.item.awemeId.trim())||!Number.isSafeInteger(Number(entry.savedAtMillis)))continue;
      const changedAt=Number(entry.changedAtMillis??entry.savedAtMillis);
      if(!Number.isSafeInteger(changedAt))continue;
      const item=admitDouyinItem(entry.item);
      if(!item&&entry.saved!==false)continue;
      await this.sql.sync(douyinExternalItem(item?applyPreferredDouyinPlayback(item):entry.item),entry.kind,entry.saved!==false,{key:`${KEY}:${entry.item.awemeId.trim()}:${entry.kind}`,changedAt,createdAt:Number(entry.savedAtMillis)});
    }
    await this.sql.markMigrated(KEY);
  }

  async list(kind?: DouyinSavedKind): Promise<DouyinSavedEntry[]> {
    if(this.sql){
      await this.migrate();
      const sql=`${SAVED_COLUMNS} WHERE s.saved=1 AND a.link LIKE 'https://www.douyin.com/video/%' ${kind?'AND s.save_type=?':''} ${SAVE_ORDER} LIMIT ? OFFSET ?`;
      const entries:DouyinSavedEntry[]=[];
      let pageSize=64;
      for(;;){
        let rows:Record<string,unknown>[];
        try{rows=await this.sql.db.query(sql,[...(kind?[kind]:[]),pageSize,entries.length]);}
        catch(error){
          if(pageSize===1||!String(error).includes('Query result too large'))throw error;
          pageSize=Math.max(1,Math.floor(pageSize/2));continue;
        }
        for(const row of rows)entries.push(savedEntry(row));
        if(rows.length<pageSize)return entries;
      }
    }
    const raw = await this.storage.get(KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.filter((entry): entry is DouyinSavedEntry =>
        entry != null && typeof entry === "object" &&
        entry.platform === "douyin" && (entry.kind === "favorite" || entry.kind === "watchLater") &&
        typeof entry.awemeId === "string" && entry.awemeId.trim() !== "" &&
        typeof entry.item?.awemeId === "string" && entry.item.awemeId.trim() !== "" &&
        typeof entry.item?.playUrl === "string" && entry.item.playUrl.trim() !== "" &&
        typeof entry.shareUrl === "string" && Number.isFinite(Number(entry.savedAtMillis))
      ).filter(entry => kind === undefined || entry.kind === kind).flatMap(entry=>{
        const item=admitDouyinItem(entry.item);
        if(!item)return [];
        const selected=applyPreferredDouyinPlayback(item);
        return selected.playUrl?[{...entry,item:selected}]:[];
      });
    } catch { return []; }
  }

  async find(awemeId:string):Promise<DouyinItem|undefined>{
    const id=awemeId.trim();if(!id)return;
    if(!this.sql)return (await this.list()).find(entry=>entry.awemeId===id)?.item;
    await this.migrate();
    const [row]=await this.sql.db.query(`${SAVED_COLUMNS} WHERE s.saved=1 AND a.link=? ${SAVE_ORDER} LIMIT 1`,[VIDEO_LINK+id]);
    return row?savedEntry(row).item:undefined;
  }

  async state(awemeId:string):Promise<DouyinSavedState>{
    const id=awemeId.trim();
    if(!id)return {favorite:false,watchLater:false};
    if(this.sql){
      await this.migrate();
      const rows=await this.sql.db.query(`SELECT DISTINCT s.save_type FROM articles a JOIN article_saved_states s ON s.article_id=a.id
        WHERE a.link=? AND s.saved=1 AND s.save_type IN ('favorite','watchLater') LIMIT 2`,[VIDEO_LINK+id]);
      return {favorite:rows.some(r=>r.save_type==='favorite'),watchLater:rows.some(r=>r.save_type==='watchLater')};
    }
    const entries=(await this.list()).filter(entry=>entry.awemeId===id);
    return {favorite:entries.some(e=>e.kind==='favorite'),watchLater:entries.some(e=>e.kind==='watchLater')};
  }

  async set(item: DouyinItem, kind: DouyinSavedKind, saved: boolean): Promise<boolean> {
    if(this.sql){await this.migrate();await this.sql.sync(douyinExternalItem(item),kind,saved);return saved;}
    const id = item.awemeId.trim(), playUrl = item.playUrl.trim(), shareUrl = buildDouyinShareUrl(id);
    if (!id || !playUrl || !shareUrl) throw new Error("当前内容暂不支持保存");
    const entries = (await this.list()).filter(entry => !(entry.kind === kind && entry.item.awemeId === id));
    if (saved) entries.unshift({ platform: "douyin", awemeId: id, item: { ...item, awemeId: id, playUrl }, kind, savedAtMillis: this.now(), shareUrl });
    await this.storage.set(KEY, JSON.stringify(entries));
    return saved;
  }

  async toggle(item: DouyinItem, kind: DouyinSavedKind): Promise<boolean> {
    const state = await this.state(item.awemeId);
    return this.set(item, kind, !(kind === "favorite" ? state.favorite : state.watchLater));
  }
}
