import {douyinExternalItem, type ExternalSavedStore} from "../core/external-saved.ts";
import type { DouyinItem, DouyinSavedEntry, DouyinSavedKind, DouyinSavedState, DouyinSavedStorage } from "./types.ts";

const KEY = "douyin.saved.v1";

export function buildDouyinShareUrl(awemeId: string): string | null {
  const id = awemeId.trim();
  return id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : null;
}

/** Local favorite/watch-later storage matching Android's two RSS SaveType lists. */
export class DouyinSavedStore {
  constructor(private readonly storage: DouyinSavedStorage, private readonly now: () => number = Date.now, private readonly sql?: ExternalSavedStore) {}

  async migrate():Promise<void> {
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
      await this.sql.sync(douyinExternalItem(entry.item),entry.kind,entry.saved!==false,{key:`${KEY}:${entry.item.awemeId.trim()}:${entry.kind}`,changedAt,createdAt:Number(entry.savedAtMillis)});
    }
    await this.sql.markMigrated(KEY);
  }

  async list(kind?: DouyinSavedKind): Promise<DouyinSavedEntry[]> {
    if(this.sql){
      await this.migrate();
      const rows=await this.sql.db.query(`SELECT a.title,a.description,a.link,a.video_url,a.image_url,s.save_type,COALESCE(t.created_at,s.changed_at) saved_at FROM articles a JOIN article_saved_states s ON s.article_id=a.id LEFT JOIN article_saved_entry_times t ON t.article_id=a.id AND t.save_type=s.save_type WHERE s.saved=1 AND a.link LIKE 'https://www.douyin.com/video/%' ${kind?'AND s.save_type=?':''} ORDER BY s.sort_order,s.changed_at DESC`,kind?[kind]:[]);
      return rows.map(r=>{const awemeId=String(r.link).split('/video/')[1]!,description=String(r.description??'');return {platform:'douyin',awemeId,kind:r.save_type as DouyinSavedKind,savedAtMillis:Number(r.saved_at),shareUrl:String(r.link),item:{awemeId,description:String(r.title),authorName:description.startsWith('作者：')?description.slice(3).split('·')[0]!.trim():'',likeCount:Number(/点赞 (\d+)/.exec(description)?.[1]??0),playUrl:String(r.video_url??''),coverUrl:r.image_url==null?undefined:String(r.image_url),createdAtSeconds:0,authorId:'',commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]}};});
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
      ).filter(entry => kind === undefined || entry.kind === kind);
    } catch { return []; }
  }

  async state(awemeId: string): Promise<DouyinSavedState> {
    const id = awemeId.trim(), entries = await this.list();
    return { favorite: entries.some(e => e.kind === "favorite" && e.item.awemeId === id), watchLater: entries.some(e => e.kind === "watchLater" && e.item.awemeId === id) };
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
