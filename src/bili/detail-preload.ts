import {mediaSourceExpiry} from '@podjs/framework/media-policy';
import {videoNetworkEpoch,videoOptEnabled} from '../media/video-opt.ts';
import { delay as hostDelay } from '@podjs/framework/services';
import type { BiliClient } from './client.ts';
import type { BiliPlayUrl } from './types.ts';

type Target = { aid?: number; bvid?: string; cid: number };
export interface DetailPreloadClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
const defaultClock: DetailPreloadClock = { now: Date.now, schedule(callback, delay) { const timer = hostDelay(delay); void timer.result.then(callback, () => {}); return () => timer.cancel(); } };
const key = (target: Target) => `${target.aid ?? ''}:${target.bvid?.toLowerCase() ?? ''}:${target.cid}`;
/** Native timing: 750 ms delay, five minute source TTL. Cancellation discards in-flight results. */
export class BiliDetailPreload {
  private networkEpoch=videoNetworkEpoch();
  private checkNetwork(){if(videoOptEnabled('recovery')&&this.networkEpoch!==videoNetworkEpoch()){this.networkEpoch=videoNetworkEpoch();this.generation++;this.cache.clear();this.pending=undefined;}}
  private cancelTimer?: () => void;
  private generation = 0;
  private disposed = false;
  private selected?: string;
  private cache = new Map<string, { source: BiliPlayUrl; expires: number }>();
  private pending?: { key: string; promise: Promise<BiliPlayUrl> };
  constructor(private client: Pick<BiliClient, 'resolvePlayback'>, private clock: DetailPreloadClock = defaultClock) {}
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
    this.checkNetwork();
    const id = key(target), cached = this.cache.get(id);
    if (cached && this.clock.now() < cached.expires) return Promise.resolve(cached.source);
    this.cache.delete(id);
    if (this.pending?.key === id) return this.pending.promise;
    if (id === this.selected) { this.cancelTimer?.(); this.cancelTimer = undefined; }
    const generation = this.generation, networkEpoch=this.networkEpoch;
    const promise = this.client.resolvePlayback({ ...target, preferMp4: true }).then(source => {
      this.checkNetwork();
      if(videoOptEnabled('recovery')&&networkEpoch!==this.networkEpoch)throw new Error('playback_network_changed');
      if (!this.disposed && generation === this.generation) {
        const urls=[...source.durl.flatMap(v=>[v.url??'',...v.backupUrl]),...(source.dash?.video??[]).flatMap(v=>[v.baseUrl??'',...v.backupUrl]),...(source.dash?.audio??[]).flatMap(v=>[v.baseUrl??'',...v.backupUrl])];
        this.cache.set(id, { source, expires: videoOptEnabled('recovery')?mediaSourceExpiry(urls,this.clock.now()):this.clock.now()+300000 });
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      }
      return source;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { key: id, promise };
    return promise;
  }
  /** Already-warm source only (fresh cache or in-flight); never starts a request. */
  warm(target: Target): Promise<BiliPlayUrl> | undefined {
    if (this.disposed) return undefined;
    this.checkNetwork();
    const id = key(target), cached = this.cache.get(id);
    if (cached && this.clock.now() < cached.expires) return Promise.resolve(cached.source);
    return this.pending?.key === id ? this.pending.promise : undefined;
  }
  dispose() { this.disposed = true; this.generation++; this.cancelTimer?.(); this.pending = undefined; this.cache.clear(); }
}
