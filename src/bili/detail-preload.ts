import type { BiliClient } from './client.ts';
import type { BiliPlayUrl } from './types.ts';

type Target = { aid?: number; bvid?: string; cid: number };
export interface DetailPreloadClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
const clock: DetailPreloadClock = { now: Date.now, schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
const key = (target: Target) => `${target.aid ?? ''}:${target.bvid?.toLowerCase() ?? ''}:${target.cid}`;
/** Native timing: 750 ms delay, five minute source TTL. Cancellation discards in-flight results. */
export class BiliDetailPreload {
  private cancelTimer?: () => void;
  private generation = 0;
  private disposed = false;
  private selected?: string;
  private cache = new Map<string, { source: BiliPlayUrl; expires: number }>();
  private pending?: { key: string; promise: Promise<BiliPlayUrl> };
  constructor(private client: Pick<BiliClient, 'resolvePlayback'>, private clock: DetailPreloadClock = clock) {}
  select(target?: Target) {
    if (this.disposed) return;
    const next = target && key(target);
    if (next === this.selected) return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.generation++; this.pending = undefined; this.selected = next;
    if (target) this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined;
      void this.resolve(target).catch(() => {});
    }, 750);
  }
  resolve(target: Target): Promise<BiliPlayUrl> {
    if (this.disposed) return Promise.reject(new Error('detail_preload_disposed'));
    const id = key(target), cached = this.cache.get(id);
    if (cached && this.clock.now() < cached.expires) return Promise.resolve(cached.source);
    this.cache.delete(id);
    if (this.pending?.key === id) return this.pending.promise;
    if (id === this.selected) { this.cancelTimer?.(); this.cancelTimer = undefined; }
    const generation = this.generation;
    const promise = this.client.resolvePlayback({ ...target, preferMp4: true }).then(source => {
      if (!this.disposed && generation === this.generation) {
        this.cache.set(id, { source, expires: this.clock.now() + 5 * 60 * 1000 });
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      }
      return source;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { key: id, promise };
    return promise;
  }
  dispose() { this.disposed = true; this.generation++; this.cancelTimer?.(); this.pending = undefined; this.cache.clear(); }
}
