import { BiliDetailPreload } from './detail-preload.ts';
import type { BiliClient } from './client.ts';
import type { BiliInteraction, BiliItem, BiliVideoDetail } from './types.ts';
import type { BrowseStore } from './browse.ts';
import { biliVideoTarget } from '../reader/media.ts';

export type DetailTarget = { aid?: number; bvid?: string; cid?: number };
const INTERACTIONS = 'watchrss.bili.interactions.v1';
const PROGRESS = 'watchrss.bili.playback-progress.v1';
export const sameVideo = (a: DetailTarget, b: DetailTarget) => !!(a.aid && a.aid === b.aid || a.bvid && a.bvid.toLowerCase() === b.bvid?.toLowerCase());
export function initialPage(detail: BiliVideoDetail, cid?: number, resumeCid?: number) {
  return Math.max(0, detail.pages.findIndex(page => page.cid === (resumeCid ?? cid)));
}
export function latestCid(store: BrowseStore, target: DetailTarget): number | undefined {
  try { const rows = JSON.parse(store.get<string>(PROGRESS) || '[]'); return Array.isArray(rows) ? rows.filter(r => r && sameVideo(r, target) && Number(r.cid) > 0).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.cid : undefined; } catch { return undefined; }
}
export function localBiliDetail(row: { title: string; link?: string | null; description?: string | null; content?: string | null; imageUrl?: string | null }, target: DetailTarget): BiliVideoDetail | undefined {
  const parsed = biliVideoTarget(row.link ?? undefined); if (!parsed || !sameVideo(parsed, target)) return;
  const description = row.description?.trim(), owner = description?.startsWith('UP主：') ? description.slice(4).trim() : undefined;
  return { item: { ...parsed, ...target, cid: target.cid ?? parsed.cid, title: row.title, cover: row.imageUrl ?? undefined, owner: owner ? { name: owner } : undefined }, desc: row.content?.trim() || (owner ? undefined : description), pages: [] };
}
export interface DetailState { detail?: BiliVideoDetail; selected: number; interaction: BiliInteraction; loading: boolean; busy: boolean; message?: string; error?: unknown; offline: boolean }
type Client = Pick<BiliClient, 'detail' | 'getSession' | 'relation' | 'like' | 'coin' | 'favoriteFolders' | 'favorite'> & Partial<Pick<BiliClient, 'resolvePlayback'>>;
/** Owns one detail route; late responses never replace a different route's state. */
export class BiliDetailController {
  state: DetailState = { selected: 0, interaction: {}, loading: true, busy: false, offline: false };
  private generation = 0;
  private disposed = false;
  private userSelected = false;
  private preload?: BiliDetailPreload;
  constructor(private client: Client, private store: BrowseStore, private target: DetailTarget, private local: (target: DetailTarget) => Promise<BiliVideoDetail | undefined>, private changed: (state: DetailState) => void = () => {}) {
    if (client.resolvePlayback) this.preload = new BiliDetailPreload({ resolvePlayback: input => client.resolvePlayback!(input) });
  }
  private publish(patch: Partial<DetailState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.changed(this.state); } }
  dispose() { this.disposed = true; this.generation++; this.preload?.dispose(); }
  private records(): Array<DetailTarget & BiliInteraction> { const rows = this.store.get<unknown>(INTERACTIONS); return Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : []; }
  private id() { return { ...this.target, ...this.state.detail?.item }; }
  private persist(interaction: BiliInteraction) { const id = this.id(); this.store.set(INTERACTIONS, [{ aid: id.aid, bvid: id.bvid, ...interaction }, ...this.records().filter(r => !sameVideo(r, id))].slice(0, 200)); }
  async load() {
    if (this.state.busy || this.disposed) return;
    const generation = ++this.generation, current = () => !this.disposed && generation === this.generation;
    this.publish({ loading: true, error: undefined });
    const localInteraction = this.records().find(r => sameVideo(r, this.target)) ?? {};
    this.publish({ interaction: localInteraction });
    try {
      const local = await this.local(this.target).catch(() => undefined);
      if (!current()) return;
      if (local && !this.state.detail) this.publish({ detail: local, offline: true });
      const detail = await this.client.detail({ aid: this.target.aid, bvid: this.target.bvid });
      if (!current()) return;
      this.publish({ detail, offline: false, selected: this.userSelected ? Math.min(this.state.selected, Math.max(0, detail.pages.length - 1)) : initialPage(detail, this.target.cid, latestCid(this.store, detail.item)) });
      this.schedulePreload();
      const session = await this.client.getSession();
      const loggedIn = !!session?.cookies.SESSDATA;
      const remote = loggedIn ? await this.client.relation({ aid: detail.item.aid, bvid: detail.item.bvid }).catch(() => undefined) : undefined;
      if (!current()) return;
      const interaction: BiliInteraction = {};
      for (const key of ['like', 'coin', 'favorite'] as const) interaction[key] = localInteraction[key] === true || loggedIn && (remote?.[key] === true || detail.interaction?.[key] === true);
      this.persist(interaction); this.publish({ interaction });
    } catch (error) { if (current()) this.publish({ error }); }
    finally { if (current()) this.publish({ loading: false }); }
  }
  select(index: number) { if (!Number.isInteger(index) || !this.state.detail?.pages[index]) return; this.userSelected = true; this.publish({ selected: index }); this.schedulePreload(); }
  selectedCid() { return this.state.detail?.pages[this.state.selected]?.cid ?? this.target.cid ?? this.state.detail?.item.cid; }
  private playbackTarget() { const item = this.savedItem(), cid = this.selectedCid(); return cid ? { aid: item.aid, bvid: item.bvid, cid } : undefined; }
  private schedulePreload() { this.preload?.select(this.playbackTarget()); }
  resolvePlayback() {
    const target = this.playbackTarget();
    if (!target || !this.preload) return Promise.reject(new Error('missing_playback_target'));
    return this.preload.resolve(target);
  }
  /** Warm C07 source for the selected part, if any; the playback controller resolves otherwise. */
  warmPlayback() { const target = this.playbackTarget(); return target ? this.preload?.warm(target) : undefined; }
  savedItem(): BiliItem { return { ...this.id(), cid: this.selectedCid() }; }
  async act(kind: 'like' | 'coin' | 'favorite') {
    if (this.disposed || this.state.busy || this.state.loading || !this.id().aid || kind === 'coin' && this.state.interaction.coin) return;
    const item = this.savedItem(), aid = item.aid!, next = !this.state.interaction[kind];
    this.publish({ busy: true, message: undefined });
    try {
      // Native like/coin are optimistic and stay in the local interaction cache on failure.
      if (kind !== 'favorite') { const interaction = { ...this.state.interaction, [kind]: next }; this.persist(interaction); this.publish({ interaction }); }
      if (kind === 'like') await this.client.like({ aid, bvid: item.bvid, liked: next });
      else if (kind === 'coin') await this.client.coin({ aid, bvid: item.bvid });
      else {
        const folders = await this.client.favoriteFolders({ rid: aid, type: 2 });
        const ids = (next ? folders.slice(0, 1) : folders.filter(f => !!f.favState)).map(f => f.id).filter((id): id is number => !!id);
        if (!ids.length) throw new Error(next ? '没有可用的收藏夹' : '未找到已收藏的文件夹，请刷新后重试');
        // B2 client onSaved writes the unified SQL saved/sync store after success.
        await this.client.favorite({ aid, bvid: item.bvid, savedItem: item, ...(next ? { addMediaIds: ids } : { removeMediaIds: ids }) });
        const interaction = { ...this.state.interaction, favorite: next }; this.persist(interaction); this.publish({ interaction });
      }
      this.publish({ message: kind === 'like' ? next ? '已点赞' : '已取消点赞' : kind === 'coin' ? '已投币' : next ? '已收藏' : '已取消收藏' });
    } catch (error) { this.publish({ message: String(error) }); }
    finally { this.publish({ busy: false }); }
  }
}
