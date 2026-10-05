const RESUME_KEY = "watchrss.resume-state.v1";

export type ResumeTarget =
  | { version: 1; kind: "home" }
  | { version: 1; kind: "articles"; channelId: string }
  | { version: 1; kind: "reader"; articleId: string }
  | { version: 1; kind: "bili"; route: Record<string, unknown> }
  | { version: 1; kind: "douyin"; route: Record<string, unknown> };

export type ResolvedResumeTarget<TArticle> =
  | Exclude<ResumeTarget, { kind: "reader" }>
  | { version: 1; kind: "reader"; articleId: string; article: TArticle };

export interface ResumeStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface ResumeStackEntry {
  page: string;
  channelId?: string;
  readerArticle?: { id?: string };
  biliRoute?: Record<string, unknown>;
  douyinRoute?: Record<string, unknown>;
  playback?: { platform?: string; immersive?: boolean; detailPlayback?: boolean };
  queue?: { snapshot(): { item: { awemeId: string } | null } };
}

const biliRoutes = new Set([
  "entry", "feed", "channel-info", "search", "results", "history", "watch-later", "favorites",
  "favorite-folder", "detail", "comments", "replies", "actions", "share", "settings",
]);
const douyinRoutes = new Set(["entry", "feed", "detail", "history", "actions", "share", "settings"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizedBiliRoute(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const originalName = text(raw.name);
  const name = originalName === "player" ? "detail" : originalName;
  if (!name || !biliRoutes.has(name)) return null;
  const route: Record<string, unknown> = { name };
  for (const key of ["aid", "bvid", "cid", "oid", "root", "uploaderMid", "mediaId"] as const) {
    const id = finiteId(raw[key]);
    if (id !== undefined) route[key] = id;
  }
  for (const key of ["query", "title", "owner", "cover"] as const) {
    const value = text(raw[key]);
    if (value !== undefined) route[key] = value;
  }
  if (name === "detail" && route.aid === undefined && route.bvid === undefined) return null;
  if (name === "results" && route.query === undefined) return null;
  if (name === "favorite-folder" && typeof route.mediaId !== "number") return null;
  if ((name === "comments" || name === "replies") && route.oid === undefined) return null;
  if (name === "replies" && route.root === undefined) return null;
  return route;
}

function sanitizedDouyinRoute(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const originalName = text(raw.name);
  if (originalName === "player" && raw.savedQueue === true && text(raw.awemeId)) {
    return { name: "player", awemeId: text(raw.awemeId)!, savedQueue: true, immersive: raw.immersive === true, detailPlayback: raw.detailPlayback === true };
  }
  const name = originalName === "player" ? "detail" : originalName;
  if (!name || !douyinRoutes.has(name)) return null;
  const route: Record<string, unknown> = { name };
  const awemeId = text(raw.awemeId);
  if (awemeId) route.awemeId = awemeId;
  if (["detail", "actions", "share"].includes(name) && !awemeId) return null;
  return route;
}

export function validateResumeTarget(value: unknown): ResumeTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (raw.kind === "home") return { version: 1, kind: "home" };
  if (raw.kind === "articles") {
    const channelId = text(raw.channelId);
    return channelId ? { version: 1, kind: "articles", channelId } : null;
  }
  if (raw.kind === "reader") {
    const articleId = text(raw.articleId);
    return articleId ? { version: 1, kind: "reader", articleId } : null;
  }
  if (raw.kind === "bili") {
    const route = sanitizedBiliRoute(raw.route);
    return route ? { version: 1, kind: "bili", route } : null;
  }
  if (raw.kind === "douyin") {
    const route = sanitizedDouyinRoute(raw.route);
    return route ? { version: 1, kind: "douyin", route } : null;
  }
  return null;
}

const NATIVE_RESUMABLE_DOUYIN = new Set(["entry", "feed", "detail", "history"]);

export function resumeTargetForStack(entries: readonly ResumeStackEntry[]): ResumeTarget {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.page === "video" && entry.playback?.platform === "douyin") {
      const awemeId = text(entry.queue?.snapshot().item?.awemeId);
      if (awemeId) return { version: 1, kind: "douyin", route: {
        name: "player", awemeId, savedQueue: true, immersive: entry.playback.immersive === true, detailPlayback: entry.playback.detailPlayback === true,
      } };
    }
    if (entry.page === "reader") {
      const articleId = text(entry.readerArticle?.id);
      if (articleId) return { version: 1, kind: "reader", articleId };
    }
    // Native only records activities overriding buildResumeIntent(): DetailActivity,
    // BiliDetail/BiliPlayer, DouyinEntry/Detail/Player/History, RssPlayer and HomeFeedList.
    // FeedActivity (channel article list) and BiliEntryActivity are not resumable.
    if (entry.page === "bili") {
      const route = sanitizedBiliRoute(entry.biliRoute);
      if (route && route.name === "detail") return { version: 1, kind: "bili", route };
    }
    if (entry.page === "douyin") {
      const route = sanitizedDouyinRoute(entry.douyinRoute);
      if (route && NATIVE_RESUMABLE_DOUYIN.has(String(route.name))) return { version: 1, kind: "douyin", route };
    }
    if (entry.page === "home") return { version: 1, kind: "home" };
  }
  return { version: 1, kind: "home" };
}

export async function resolveResumeTarget<TArticle>(
  target: ResumeTarget | null,
  resolver: { hasChannel(id: string): boolean | Promise<boolean>; getArticle(id: string): Promise<TArticle | null> },
): Promise<ResolvedResumeTarget<TArticle>> {
  if (!target || target.kind === "home") return { version: 1, kind: "home" };
  if (target.kind === "articles") {
    return await resolver.hasChannel(target.channelId) ? target : { version: 1, kind: "home" };
  }
  if (target.kind === "reader") {
    const article = await resolver.getArticle(target.articleId);
    return article ? { ...target, article } : { version: 1, kind: "home" };
  }
  return target;
}

export class AppResumeStore {
  constructor(private readonly storage: ResumeStorage) {}

  read(): ResumeTarget | null {
    const target = validateResumeTarget(this.storage.get<unknown>(RESUME_KEY));
    if (!target) this.storage.delete(RESUME_KEY);
    return target;
  }

  save(target: ResumeTarget): void {
    this.storage.set(RESUME_KEY, target);
  }
}
