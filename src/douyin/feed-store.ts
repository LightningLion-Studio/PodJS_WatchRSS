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
    const raw = await this.storage.get(key);
    try { const value = JSON.parse(raw ?? "null"); if (!value || !Array.isArray(value.items)) return EMPTY(); const items = normalizeItems(value.items).slice(0, key === QUEUE_KEY ? 200 : 40); return { items, cursor: typeof value.cursor === "string" ? value.cursor : null, hasMore: value.hasMore === true, anchorAwemeId: items.some(x => x.awemeId === value.anchorAwemeId) ? value.anchorAwemeId : null, savedAtMillis: Number(value.savedAtMillis) || 0, resolved: value.resolved && typeof value.resolved === "object" ? value.resolved : {} }; } catch { return EMPTY(); }
  }
  async bootstrap(): Promise<RecentFeed> {
    await this.writes;
    const [feed, recent] = await Promise.all([this.read(FEED_KEY), this.read(RECENT_KEY)]);
    const resolved:Record<string,number>={}, freshest=new Map<string,DouyinItem>();
    for(const snapshot of [recent,feed])for(const item of snapshot.items){const timestamp=Number(snapshot.resolved[item.awemeId])||0;if(!freshest.has(item.awemeId)||timestamp>resolved[item.awemeId]){freshest.set(item.awemeId,item);resolved[item.awemeId]=timestamp;}}
    const ordered=normalizeItems([...recent.items,...feed.items]).map(item=>freshest.get(item.awemeId)!);
    const anchor=Math.max(0,ordered.findIndex(item=>item.awemeId===recent.anchorAwemeId));
    const items=ordered.slice(anchor,anchor+40);
    return { ...(recent.items.length ? recent : feed), items, anchorAwemeId: recent.anchorAwemeId, resolved };
  }
  save(key: string, snapshot: RecentFeed): Promise<void> {
    const value = JSON.stringify(snapshot);
    const write = this.writes.catch(() => {}).then(() => this.storage.set(key, value));
    this.writes = write; return write;
  }
  clear(): Promise<void> { const write = this.writes.catch(() => {}).then(async () => { await this.storage.remove(FEED_KEY); await this.storage.remove(RECENT_KEY); await this.storage.remove(QUEUE_KEY); }); this.writes = write; return write; }
}
