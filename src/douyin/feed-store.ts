import {projectJsonAsync} from "@podjs/framework/json";
import {yieldWorkTurn} from "@podjs/framework/text-layout";
import {traceServiceWork} from "@podjs/framework/service-trace";
import {appLogger} from '../logs/app-logger.ts';
import {logPlatformId} from '../logs/fields.ts';
import type { DouyinFeedSnapshot, DouyinItem, DouyinSecureStorage } from "./types.ts";

export interface RecentFeed extends DouyinFeedSnapshot { anchorAwemeId: string | null; savedAtMillis: number; resolved: Record<string, number> }
const EMPTY = (): RecentFeed => ({ items: [], cursor: null, hasMore: false, anchorAwemeId: null, savedAtMillis: 0, resolved: {} });
export const QUEUE_KEY = "douyin.playback-queue.v1";
export const FEED_KEY = "douyin.feed.v1", RECENT_KEY = "douyin.recent-window.v1";
export function normalizeItems(items: DouyinItem[]): DouyinItem[] {
  const seen = new Set<string>();
  return items.filter(item => { const id = typeof item?.awemeId === "string" ? item.awemeId.trim() : ""; if (!id || typeof item.playUrl !== "string" || !item.playUrl.trim() || seen.has(id)) return false; seen.add(id); return true; }).map(item => ({ ...item, awemeId: item.awemeId.trim(), playUrl: item.playUrl.trim() }));
}
export class DouyinFeedStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private storage: DouyinSecureStorage) {}
  async read(key: string): Promise<RecentFeed> {
    // Leave the cookie completion before synchronous KV decoding, then leave
    // that completion before adopting cached JSON. No storage lifetime cache.
    await yieldWorkTurn().result;
    const raw = await traceServiceWork("douyin.store.get",()=>this.storage.get(key));
    try { const value = await projectJsonAsync(raw ?? "null",{items:[null],cursor:null,hasMore:null,anchorAwemeId:null,savedAtMillis:null,resolved:null}) as Record<string,any> | null; if (!value || !Array.isArray(value.items)) return EMPTY(); const items = traceServiceWork("douyin.store.normalize",()=>normalizeItems(value.items)).slice(0, key === QUEUE_KEY ? 200 : 40); return { items, cursor: typeof value.cursor === "string" ? value.cursor : null, hasMore: value.hasMore === true, anchorAwemeId: items.some(x => x.awemeId === value.anchorAwemeId) ? value.anchorAwemeId : null, savedAtMillis: Number(value.savedAtMillis) || 0, resolved: value.resolved && typeof value.resolved === "object" ? value.resolved : {} }; } catch { return EMPTY(); }
  }
  async bootstrap(): Promise<RecentFeed> {
    await this.writes;
    const [feed, recent] = await Promise.all([this.read(FEED_KEY), this.read(RECENT_KEY)]);
    return traceServiceWork("douyin.store.bootstrapResult",()=>{const resolved:Record<string,number>={}, freshest=new Map<string,DouyinItem>();
    for(const snapshot of [recent,feed])for(const item of snapshot.items){const timestamp=Number(snapshot.resolved[item.awemeId])||0;if(!freshest.has(item.awemeId)||timestamp>resolved[item.awemeId]){freshest.set(item.awemeId,item);resolved[item.awemeId]=timestamp;}}
    const ordered=normalizeItems([...recent.items,...feed.items]).map(item=>freshest.get(item.awemeId)!);
    const anchor=Math.max(0,ordered.findIndex(item=>item.awemeId===recent.anchorAwemeId));
    const items=ordered.slice(anchor,anchor+40);
    appLogger.d("DouyinFeedVM",`read bootstrap pinned=0 feed=${feed.items.length} recent=${recent.items.length} merged=${ordered.length} restored=${items.length} anchor=${logPlatformId(recent.anchorAwemeId)}`);
    return { ...(recent.items.length ? recent : feed), items, anchorAwemeId: recent.anchorAwemeId, resolved };});
  }
  save(key: string, snapshot: RecentFeed): Promise<void> {
    const value = traceServiceWork("douyin.store.serialize",()=>JSON.stringify(snapshot),snapshot.items.length);
    const write = this.writes.catch(() => {}).then(() => traceServiceWork("douyin.store.write",()=>this.storage.set(key, value),value.length));
    this.writes = write; return write;
  }
  clear(): Promise<void> { const write = this.writes.catch(() => {}).then(async () => { await this.storage.remove(FEED_KEY); await this.storage.remove(RECENT_KEY); await this.storage.remove(QUEUE_KEY); }); this.writes = write; return write; }
}
