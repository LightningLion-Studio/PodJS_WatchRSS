export interface BiliHttpRequest { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: Uint8Array }
export interface BiliHttpResponse { status: number; headers: Record<string, string | string[]>; body: Uint8Array }
export interface BiliTransport { request(request: BiliHttpRequest): Promise<BiliHttpResponse> }
export interface BiliSecureStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export interface AbortLike { readonly aborted: boolean; addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void; removeEventListener?(type: "abort", listener: () => void): void }

export interface BiliSession { cookies: Record<string, string>; refreshToken?: string; cookieRefreshCheckedAt?: number; updatedAt: number }
export interface BiliRsaOaepSha256 { encrypt(publicKeyPem: string, plaintext: Uint8Array): Promise<Uint8Array> }
export interface BiliCookieRefreshResult { refreshed: boolean; checked: boolean; forced: boolean; confirmed?: boolean }
export type BiliLoginState = { status: "anonymous" } | { status: "authenticated"; userId?: string };
export type QrStatus = "pending" | "scanned" | "expired" | "success" | "error";
export interface QrLoginRequest { qrcodeKey: string; url: string }
export interface QrPollResult { status: QrStatus; code: number; message?: string }
export interface BiliOwner { mid?: number; name?: string; face?: string }
export interface BiliStat { view?: number; like?: number; danmaku?: number; reply?: number; coin?: number; favorite?: number; share?: number }
export interface BiliItem { aid?: number; bvid?: string; cid?: number; title?: string; cover?: string; duration?: number; pubdate?: number; owner?: BiliOwner; stat?: BiliStat }
export interface BiliPage { cid?: number; page?: number; part?: string; duration?: number }
export interface BiliInteraction { like?: boolean; coin?: boolean; favorite?: boolean }
export interface BiliVideoDetail { item: BiliItem; desc?: string; pages: BiliPage[]; interaction?: BiliInteraction }
export interface BiliFeedPage { items: BiliItem[]; source: "web" }
export interface BiliTrendingWord { keyword: string; showName?: string; icon?: string; position?: number }
export type BiliSearchResult = { kind: "video"; aid?: number; bvid?: string; title?: string; author?: string; mid?: number; pic?: string; description?: string; duration?: string; play?: number; danmaku?: number; pubdate?: number; tag?: string } | { kind: "user"; mid?: number; name?: string; sign?: string; picture?: string; fans?: number; videos?: number } | { kind: "media"; mediaId?: number; seasonId?: number; title?: string; cover?: string; areas?: string; styles?: string; description?: string; pubtime?: number; score?: number };
export interface BiliSearchPage { numResults?: number; numPages?: number; page?: number; pageSize?: number; results: BiliSearchResult[] }
export interface BiliDashStream { id?: number; baseUrl?: string; backupUrl: string[]; bandwidth?: number; codecId?: number; width?: number; height?: number; frameRate?: string }
export interface BiliPlayUrl { quality?: number; format?: string; timeLength?: number; acceptQuality: number[]; acceptDescription: string[]; dash?: { video: BiliDashStream[]; audio: BiliDashStream[] }; durl: { order?: number; length?: number; size?: number; url?: string; backupUrl: string[] }[] }
export interface BiliFavoriteFolder { id?: number; fid?: number; mid?: number; title?: string; mediaCount?: number; attr?: number; favState?: number }
export interface BiliFavoritePage { mediaId?: number; title?: string; hasMore: boolean; medias: Array<BiliItem & { favTime?: number }> }
export interface BiliCommentContent {
  message?: string;
  emote?: Record<string, { id?: number; text?: string; url?: string; type?: number; size?: number }>;
  members?: Array<{ mid?: string; name?: string }>;
  jumpUrl?: Record<string, { title?: string; state?: number; prefixIcon?: string; clickable?: boolean }>;
  pictures?: Array<{ url?: string; width?: number; height?: number }>;
}
export interface BiliComment {
  rpid?: number; oid?: number; mid?: number; root?: number; parent?: number;
  count?: number; replyCount?: number; like?: number; ctime?: number;
  member?: { mid?: string; name?: string; avatar?: string; vip?: { nicknameColor?: string } };
  content?: BiliCommentContent; replies?: BiliComment[];
  replyControl?: { upReply?: boolean; isUpTop?: boolean; isNote?: boolean };
}
export interface BiliCommentPage { cursor?: { next?: number; isEnd?: boolean; mode?: number }; replies: BiliComment[]; topReplies: BiliComment[]; upperMid?: number }
export interface BiliReplyPage { root?: BiliComment; replies: BiliComment[]; cursor?: BiliCommentPage["cursor"] }
export interface BiliHistoryCursor { max?: number; viewAt?: number; business?: string; pageSize?: number }
export interface BiliHistoryItem { title?: string; cover?: string; viewAt?: number; duration?: number; progress?: number; authorName?: string; authorMid?: number; history?: { oid?: number; bvid?: string; cid?: number; page?: number; part?: string; business?: string } }
export interface BiliHistoryPage { cursor?: BiliHistoryCursor; items: BiliHistoryItem[] }
export interface BiliToViewPage { count: number; items: BiliItem[] }
export interface BiliTripleResult { like: boolean; coin: boolean; favorite: boolean }

export class BiliError extends Error {
  constructor(public readonly kind: "validation" | "transport" | "http" | "api" | "auth" | "cancelled" | "timeout" | "unsupported", message: string, public readonly code?: number, public readonly httpStatus?: number) { super(message); this.name = "BiliError"; }
}
