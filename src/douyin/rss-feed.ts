import {traceServiceWork} from "@podjs/framework/service-trace";
import type { DouyinClient } from './client.ts';
import type { DouyinItem } from './types.ts';

export interface DouyinRssFeedSnapshot { items: DouyinItem[]; cursor?: string; hasMore: boolean }
export interface DouyinRssFeedState extends DouyinRssFeedSnapshot { loading: boolean; error: string }
export function appendDouyinItems(source: readonly DouyinItem[], incoming: readonly DouyinItem[]): DouyinItem[] {
  const seen = new Set(source.map(item => item.awemeId));
  return [...source, ...incoming.filter(item => !seen.has(item.awemeId) && !!seen.add(item.awemeId))];
}
/** Route-owned requests, with a session snapshot supplied by the caller. No data window cap. */
export class DouyinRssFeedController {
  state: DouyinRssFeedState;
  private disposed = false;
  constructor(private client: Pick<DouyinClient, 'fetchFeedPage'>, initial?: DouyinRssFeedSnapshot,
    private changed: (state: DouyinRssFeedState) => void = () => {},
    private saved: (snapshot: DouyinRssFeedSnapshot) => void = () => {}) {
    this.state = { items: initial?.items ?? [], cursor: initial?.cursor, hasMore: initial?.hasMore ?? true, loading: false, error: '' };
  }
  get loading() { return this.state.loading; }
  get hasMore() { return this.state.hasMore; }
  refresh() { return this.load(false); }
  loadMore() { return this.load(true); }
  dispose() { this.disposed = true; }
  private publish(patch: Partial<DouyinRssFeedState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; traceServiceWork("douyin.rss.publish",()=>this.changed(this.state)); } }
  private async load(append: boolean) {
    if (this.disposed || this.loading || append && !this.hasMore) return;
    this.publish({ loading: true, error: '' });
    try {
      const result = await this.client.fetchFeedPage({ cursor: append ? this.state.cursor : undefined, count: 12 });
      if (this.disposed) return;
      if (!result.ok) { this.publish({ error: result.message }); return; }
      const snapshot = { items: traceServiceWork("douyin.rss.append",()=>appendDouyinItems(append ? this.state.items : [], result.data.items)),
        cursor: result.data.nextCursor ?? (append ? this.state.cursor : undefined), hasMore: result.data.hasMore };
      traceServiceWork("douyin.rss.save",()=>this.saved(snapshot)); this.publish(snapshot);
    } catch (error) { this.publish({ error: String(error) }); }
    finally { this.publish({ loading: false }); }
  }
}
