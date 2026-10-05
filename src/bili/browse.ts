import type { BiliClient } from './client.ts';
import type { BiliHistoryCursor, BiliItem } from './types.ts';

export interface BrowseStore { get<T>(key: string): T | undefined | null; set<T>(key: string, value: T): unknown }
const FEED_CACHE = 'watchrss.bili.feed-cache.v1';
const SEARCH_HISTORY = 'watchrss.bili.search-history.v1';
export const originalContentEnabled = (channel?: { useOriginalContent?: boolean }) => channel?.useOriginalContent ?? true;
export const videoKey = (item: Pick<BiliItem, "aid" | "bvid" | "title">) => item.bvid?.trim() ? `bvid:${item.bvid}` : item.aid != null ? `aid:${item.aid}` : `title:${item.title ?? ''}`;
export function appendUnique<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set(existing.map(key));
  return [...existing, ...incoming.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; })];
}
export type SearchTarget = { name: 'results'; query: string } | { name: 'detail'; aid?: number; bvid?: string };
export class BiliSearchHistory {
  constructor(private store: BrowseStore) {}
  read(): string[] { const value = this.store.get<unknown>(SEARCH_HISTORY); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 20) : []; }
  clear() { this.store.set(SEARCH_HISTORY, []); }
  submit(input: string): SearchTarget | undefined {
    const query = input.replace(/[\s\u0085]+/gu, ' ').trim();
    if (!query) return;
    if (/^(av|AV)\d+$/.test(query)) { const aid = Number(query.slice(2)); return Number.isSafeInteger(aid) && aid > 0 ? { name: 'detail', aid } : undefined; }
    if (/^(bv|BV)[a-zA-Z0-9]+$/.test(query)) return { name: 'detail', bvid: 'BV' + query.slice(2) };
    this.store.set(SEARCH_HISTORY, [query, ...this.read().filter(v => v !== query)].slice(0, 20));
    return { name: 'results', query };
  }
}
export interface BrowseState<T> { items: T[]; loading: boolean; error?: unknown; canLoadMore: boolean }
interface Page<T, C> { items: T[]; next?: C }
/** Cursor commits only on success. Refresh/dispose invalidate in-flight responses. */
export class BrowsePager<T, C> {
  state: BrowseState<T> = { items: [], loading: false, canLoadMore: true };
  private cursor?: C;
  private generation = 0;
  private disposed = false;
  constructor(private first: C, private fetch: (cursor: C) => Promise<Page<T, C>>, private key: (item: T) => string, private changed: (state: BrowseState<T>) => void = () => {}) { this.cursor = first; }
  private publish(update: Partial<BrowseState<T>>) { this.state = { ...this.state, ...update }; this.changed(this.state); }
  dispose() { this.disposed = true; this.generation++; }
  refresh = () => this.request(true);
  loadMore = () => this.request(false);
  private async request(reset: boolean) {
    if (this.disposed || (!reset && (this.state.loading || !this.state.canLoadMore))) return;
    const generation = ++this.generation, cursor = reset ? this.first : this.cursor;
    if (cursor === undefined) return;
    this.publish({ loading: true, error: undefined });
    try {
      const page = await this.fetch(cursor);
      if (this.disposed || generation !== this.generation) return;
      this.cursor = page.next;
      this.publish({ items: appendUnique(reset ? [] : this.state.items, page.items, this.key), canLoadMore: page.next !== undefined, loading: false });
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ loading: false, error }); }
  }
}
export function searchPager(client: Pick<BiliClient, 'search'>, query: string, changed?: (state: BrowseState<Extract<import('./types.ts').BiliSearchResult, { kind: 'video' }>>) => void) {
  return new BrowsePager<Extract<import('./types.ts').BiliSearchResult, { kind: 'video' }>, number>(1, async page => { const result = await client.search(query, page); return { items: result.results.filter((v): v is Extract<typeof v, { kind: 'video' }> => v.kind === 'video'), next: page < (result.numPages ?? 1) ? page + 1 : undefined }; }, videoKey, changed);
}
export function favoritePager(client: Pick<BiliClient, 'favoriteResources'>, mediaId: number, changed?: (state: BrowseState<BiliItem>) => void) {
  return new BrowsePager<BiliItem, number>(1, async page => { const result = await client.favoriteResources({ mediaId, page }); return { items: result.medias, next: result.hasMore ? page + 1 : undefined }; }, videoKey, changed);
}
export function historyPager(client: Pick<BiliClient, 'history'>, changed?: (state: BrowseState<import('./types.ts').BiliHistoryItem>) => void) {
  return new BrowsePager<import('./types.ts').BiliHistoryItem, BiliHistoryCursor>({}, async cursor => {
    const result = await client.history({ cursor }); const next = result.cursor;
    const advanced = next && (next.max !== cursor.max || next.viewAt !== cursor.viewAt || next.business !== cursor.business);
    return { items: result.items, next: result.items.length && advanced && ((next.max ?? 0) > 0 || (next.viewAt ?? 0) > 0) ? next : undefined };
  }, item => `${item.history?.business ?? 'archive'}:${videoKey({ aid: item.history?.oid, bvid: item.history?.bvid, title: item.title })}`, changed);
}
export class BiliFeedBrowser {
  state: BrowseState<BiliItem> = { items: [], loading: false, canLoadMore: true };
  private generation = 0;
  private disposed = false;
  constructor(private client: Pick<BiliClient, 'feed'>, private store: BrowseStore, private changed: (state: BrowseState<BiliItem>) => void = () => {}) {}
  private publish(update: Partial<BrowseState<BiliItem>>) { this.state = { ...this.state, ...update }; this.changed(this.state); }
  dispose() { this.disposed = true; this.generation++; }
  refresh = async () => {
    if (this.disposed) return;
    const generation = ++this.generation, current = this.state.items;
    const raw = current.length ? [] : this.store.get<unknown>(FEED_CACHE);
    const cached = Array.isArray(raw) ? raw.filter((v): v is BiliItem => !!v && typeof v === 'object').slice(0, 50) : [];
    const prefix = cached.slice(0, 5);
    this.publish({ loading: true, error: undefined, items: prefix.length ? prefix : current, canLoadMore: true });
    try {
      const page = await this.client.feed();
      if (this.disposed || generation !== this.generation) return;
      const fresh = appendUnique([], page.items, videoKey);
      const items = fresh.length ? appendUnique(prefix, fresh, videoKey) : cached.length ? cached : current;
      if (fresh.length) this.store.set(FEED_CACHE, fresh.slice(0, 50));
      this.publish({ items, loading: false, canLoadMore: items.length > 0 });
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ loading: false, error, items: cached.length ? cached : current }); }
  };
  loadMore = async () => {
    if (this.disposed || this.state.loading || !this.state.canLoadMore) return;
    const generation = ++this.generation;
    this.publish({ loading: true, error: undefined });
    try {
      const page = await this.client.feed();
      if (this.disposed || generation !== this.generation) return;
      const items = appendUnique(this.state.items, page.items, videoKey);
      this.publish({ items, loading: false, canLoadMore: items.length > this.state.items.length });
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ loading: false, error }); }
  };
}
