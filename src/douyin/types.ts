import type { HttpTransport } from "../cloud/types.ts";

export interface DouyinSecureStorage { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void>; }
export interface DouyinHistoryStorage extends DouyinSecureStorage {}
export interface DouyinSavedStorage extends DouyinSecureStorage {}
export interface DouyinSigner { sign(params: Readonly<Record<string, string>>): Promise<string> | string; }
export interface DouyinClientOptions {
  onLogout?:()=>Promise<void>; transport: HttpTransport; secureStorage: DouyinSecureStorage; signer?: DouyinSigner; historyStorage?: import("./state-storage.ts").DouyinStateStorage; savedStorage?: DouyinSavedStorage; savedStore?: Pick<import("./saved.ts").DouyinSavedStore,"list"|"state"|"set"|"toggle">; now?: () => number; }
export type DouyinCodec = "h264" | "h265" | "unknown";
export interface DouyinVideoVariant { playUrl: string; /** Optional for old persisted snapshots. Ordered same-track CDN candidates. */ playUrls?: string[]; codec: DouyinCodec; bitrate: number; width: number; height: number; definition?: string; quality?: string; gearName?: string; }
export interface DouyinItem { awemeId: string; description: string; createdAtSeconds: number; authorId: string; authorName: string; authorAvatar?: string; likeCount: number; commentCount: number; shareCount: number; collectCount: number; playUrl: string; coverUrl?: string; durationMs: number; variants: DouyinVideoVariant[]; }
export interface DouyinFeedPage { items: DouyinItem[]; nextCursor: string | null; hasMore: boolean; }
export interface DouyinFeedSnapshot { items: DouyinItem[]; cursor: string | null; hasMore: boolean; }
export type DouyinContent = { kind: "video"; item: DouyinItem } | { kind: "note"; awemeId: string; description: string; authorName: string; likeCount: number; imageUrls: string[] };
export interface DouyinHistoryEntry { item: DouyinItem; watchedAtMillis: number; }
export type DouyinSavedKind = "favorite" | "watchLater";
export interface DouyinSavedEntry { platform: "douyin"; awemeId: string; item: DouyinItem; kind: DouyinSavedKind; savedAtMillis: number; shareUrl: string; }
export interface DouyinSavedState { favorite: boolean; watchLater: boolean; }
export type DouyinErrorCode = "NOT_LOGGED_IN" | "REQUEST_FAILED" | "PARSE_FAILED" | "UNSUPPORTED" | "CANCELLED";
export type DouyinDataSource = "network" | "feed-cache";
export type DouyinResult<T> = { ok: true; data: T; source?: DouyinDataSource } | { ok: false; code: DouyinErrorCode; message: string };
export type DouyinInteraction = "like" | "unlike" | "favorite" | "unfavorite" | "follow" | "unfollow" | "comment";
