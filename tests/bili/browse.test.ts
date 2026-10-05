import { describe, expect, test } from 'bun:test';
import { BiliFeedBrowser, BiliSearchHistory, BrowsePager, favoritePager, historyPager, originalContentEnabled, searchPager, type BrowseStore } from '../../src/bili/browse.ts';
import { BiliClient } from '../../src/bili/client.ts';
import type { BiliFeedPage, BiliItem } from '../../src/bili/types.ts';
class Store implements BrowseStore {
  values = new Map<string, unknown>();
  get<T>(key: string) { return this.values.get(key) as T | undefined; }
  set<T>(key: string, value: T) { this.values.set(key, value); }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const items = (...ids: number[]): BiliItem[] => ids.map(aid => ({ aid, bvid: `BV${aid}`, title: `Video ${aid}` }));
const feed = (...ids: number[]): BiliFeedPage => ({ items: items(...ids), source: 'web' });

describe('B3 recommendation browsing', () => {
  test('persist fresh feed, show five cached entries before network, merge and deduplicate', async () => {
    const store = new Store();
    await new BiliFeedBrowser({ feed: async () => feed(1, 2, 3, 4, 5, 6) }, store).refresh();
    const next = deferred<BiliFeedPage>();
    const browser = new BiliFeedBrowser({ feed: () => next.promise }, store);
    const pending = browser.refresh();
    expect(browser.state.items).toEqual(items(1, 2, 3, 4, 5));
    expect(browser.state.loading).toBe(true);
    next.resolve(feed(5, 7, 7, 8)); await pending;
    expect(browser.state.items).toEqual(items(1, 2, 3, 4, 5, 7, 8));
    expect(store.get<BiliItem[]>('watchrss.bili.feed-cache.v1')).toEqual(items(5, 7, 8));
  });
  test('failed or empty refresh restores full cached list; explicit fresh refresh replaces it', async () => {
    const store = new Store(); store.set('watchrss.bili.feed-cache.v1', items(1, 2, 3, 4, 5, 6));
    let mode = 'fail'; const browser = new BiliFeedBrowser({ feed: async () => { if (mode === 'fail') throw Error('offline'); return mode === 'empty' ? feed() : feed(9); } }, store);
    await browser.refresh(); expect(browser.state.items).toHaveLength(6); expect(browser.state.error).toBeDefined();
    mode = 'empty'; await browser.refresh(); expect(browser.state.items).toHaveLength(6);
    mode = 'fresh'; await browser.refresh(); expect(browser.state.items).toEqual(items(9));
  });
  test('append guards concurrent loads, retries failure, and stops on duplicate-only page', async () => {
    const pending = deferred<BiliFeedPage>(); let calls = 0;
    const browser = new BiliFeedBrowser({ feed: async () => { calls++; if (calls === 1) return feed(1); if (calls === 2) return pending.promise; return feed(1); } }, new Store());
    await browser.refresh(); const loading = browser.loadMore(); await browser.loadMore(); expect(calls).toBe(2);
    pending.reject(Error('offline')); await loading; expect(browser.state.items).toEqual(items(1)); expect(browser.state.canLoadMore).toBe(true);
    await browser.loadMore(); expect(browser.state.canLoadMore).toBe(false); await browser.loadMore(); expect(calls).toBe(3);
  });
  test('new refresh invalidates pending append and disposal prevents cache writes', async () => {
    const old = deferred<BiliFeedPage>(), late = deferred<BiliFeedPage>(); let calls = 0;
    const store = new Store(); const browser = new BiliFeedBrowser({ feed: async () => { calls++; return calls === 1 ? feed(1) : calls === 2 ? old.promise : calls === 3 ? feed(9) : late.promise; } }, store);
    await browser.refresh(); const loading = browser.loadMore(); await browser.refresh(); old.resolve(feed(2)); await loading; expect(browser.state.items).toEqual(items(9));
    const disposed = browser.refresh(); browser.dispose(); late.resolve(feed(99)); await disposed; expect(store.get<BiliItem[]>('watchrss.bili.feed-cache.v1')).toEqual(items(9));
  });
  test('cache has native 50-item limit', async () => {
    const store = new Store(); await new BiliFeedBrowser({ feed: async () => feed(...Array.from({ length: 70 }, (_, i) => i + 1)) }, store).refresh();
    expect(store.get<BiliItem[]>('watchrss.bili.feed-cache.v1')).toHaveLength(50);
  });
});
describe('B3 search history and paging', () => {
  test('normalizes whitespace, persists newest-first unique 20 entries, clears across instances', () => {
    const store = new Store(), history = new BiliSearchHistory(store);
    expect(history.submit(' \n\u00a0 ')).toBeUndefined(); expect(history.submit(' 猫\t\n 视频\u3000')).toEqual({ name: 'results', query: '猫 视频' });
    for (let i = 0; i < 25; i++) history.submit(`q${i}`);
    history.submit('q20'); expect(history.read()[0]).toBe('q20'); expect(history.read()).toHaveLength(20); expect(history.read().filter(v => v === 'q20')).toHaveLength(1);
    const restarted = new BiliSearchHistory(store); expect(restarted.read()).toEqual(history.read()); restarted.clear(); expect(history.read()).toEqual([]);
  });
  test('AV/BV opens details without keyword history and avoids unsafe numeric IDs', () => {
    const history = new BiliSearchHistory(new Store());
    expect(history.submit(' AV00123 ')).toEqual({ name: 'detail', aid: 123 });
    expect(history.submit('bv1AbCd')).toEqual({ name: 'detail', bvid: 'BV1AbCd' });
    expect(history.submit('av99999999999999999999999')).toBeUndefined(); expect(history.read()).toEqual([]);
    expect(history.submit('video BV1AbCd')).toEqual({ name: 'results', query: 'video BV1AbCd' });
  });
  test('search keeps paging past non-video page, retries same page, resets to page one', async () => {
    const calls: number[] = []; let fail = true;
    const pager = searchPager({ search: async (query, page = 1) => { expect(query).toBe('cat'); calls.push(page); if (page === 2 && fail) { fail = false; throw Error('retry'); } return { numPages: 3, results: page === 1 ? [{ kind: 'user', name: 'UP' }] : [{ kind: 'video', aid: page, title: 'Cat' }] }; } }, 'cat');
    await pager.refresh(); expect(pager.state.items).toEqual([]); expect(pager.state.canLoadMore).toBe(true);
    await pager.loadMore(); await pager.loadMore(); await pager.loadMore(); expect(calls).toEqual([1, 2, 2, 3]); expect(pager.state.items).toHaveLength(2); expect(pager.state.canLoadMore).toBe(false);
    await pager.refresh(); expect(calls.at(-1)).toBe(1); expect(pager.state.items).toEqual([]);
  });
  test('route disposal drops late results', async () => {
    const pending = deferred<{ items: number[]; next?: number }>(); const pager = new BrowsePager(1, () => pending.promise, String);
    const request = pager.refresh(); pager.dispose(); pending.resolve({ items: [1], next: 2 }); await request; expect(pager.state.items).toEqual([]);
  });
});
describe('B3 history and favorites', () => {
  test('real client forwards all history cursor fields, stops repeated cursor', async () => {
    const urls: string[] = [];
    const client = new BiliClient({ transport: { request: async request => { urls.push(request.url); return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ code: 0, data: { cursor: { max: 8, view_at: 100, business: 'archive', ps: 2 }, list: [{ history: { oid: urls.length, bvid: `BV${urls.length}`, business: 'archive' } }] } })) }; } } });
    const pager = historyPager(client); await pager.refresh(); await pager.loadMore();
    const query = new URL(urls[1]!).searchParams; expect(query.get('max')).toBe('8'); expect(query.get('view_at')).toBe('100'); expect(query.get('business')).toBe('archive'); expect(query.get('ps')).toBe('2');
    expect(pager.state.items).toHaveLength(2); expect(pager.state.canLoadMore).toBe(false);
    await pager.refresh(); expect(new URL(urls[2]!).searchParams.has('max')).toBe(false);
  });
  test('history retries same cursor and ends on empty page', async () => {
    let calls = 0; const cursors: unknown[] = [];
    const pager = historyPager({ history: async request => { cursors.push(request?.cursor); calls++; if (calls === 2) throw Error('offline'); return calls === 1 ? { cursor: { max: 10, viewAt: 20 }, items: [{ history: { oid: 1 } }] } : { cursor: { max: 9 }, items: [] }; } });
    await pager.refresh(); await pager.loadMore(); expect(pager.state.items).toHaveLength(1); await pager.loadMore(); expect(cursors[1]).toEqual(cursors[2]); expect(pager.state.canLoadMore).toBe(false);
  });
  test('favorites retry page two, append uniquely, stop at hasMore false and refresh', async () => {
    const calls: number[] = []; let failed = false;
    const pager = favoritePager({ favoriteResources: async request => { expect(request.mediaId).toBe(42); calls.push(request.page!); if (request.page === 2 && !failed) { failed = true; throw Error('offline'); } return { hasMore: request.page === 1, medias: request.page === 1 ? items(1) : items(1, 2) }; } }, 42);
    await pager.refresh(); await pager.loadMore(); expect(pager.state.items).toEqual(items(1)); await pager.loadMore(); expect(pager.state.items).toEqual(items(1, 2)); await pager.loadMore(); expect(calls).toEqual([1, 2, 2]);
    await pager.refresh(); expect(pager.state.items).toEqual(items(1)); expect(calls.at(-1)).toBe(1);
  });
  test('channel mode defaults true and explicit false remains false', () => {
    expect(originalContentEnabled()).toBe(true); expect(originalContentEnabled({})).toBe(true);
    expect(originalContentEnabled({ useOriginalContent: false })).toBe(false); expect(originalContentEnabled({ useOriginalContent: true })).toBe(true);
  });
});
