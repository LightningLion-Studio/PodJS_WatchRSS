import type { DouyinItem, DouyinSavedEntry, DouyinSavedKind, DouyinSavedState, DouyinSavedStorage } from "./types.ts";

const KEY = "douyin.saved.v1";

export function buildDouyinShareUrl(awemeId: string): string | null {
  const id = awemeId.trim();
  return id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : null;
}

/** Local favorite/watch-later storage matching Android's two RSS SaveType lists. */
export class DouyinSavedStore {
  constructor(private readonly storage: DouyinSavedStorage, private readonly now: () => number = Date.now) {}

  async list(kind?: DouyinSavedKind): Promise<DouyinSavedEntry[]> {
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
