import { CommentScreen } from "./CommentScreen.tsx";
import { BiliDetailController, type DetailState, type DetailTarget } from "../../bili/detail.ts";
import { BiliFeedBrowser, BiliSearchHistory, favoritePager, historyPager, searchPager, type BrowseState } from "../../bili/browse.ts";
import {biliShareLink,biliActionTitle,type ShareHandler} from "../../sharing/policy.ts";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { kv } from "@podjs/framework/watch";
import type { BiliClient, BiliFavoriteFolder, BiliHistoryItem, BiliItem, BiliPlayUrl, BiliSearchResult, BiliSession, QrLoginRequest, QrPollResult } from "../../bili/index.ts";
import { layoutUiText } from "../../reader/line-break.ts";
import { measuredLines } from "../../reader/measured-text.ts";
import { getOps } from "@pocketjs/framework/host";
import { ScrollEntries, type ScrollEntry } from "../ScrollEntries.tsx";
import { RemoteImage } from "../RemoteImage.tsx";
import { SafeQrScreen } from "../SafeQrScreen.tsx";
import { ShareQrScreen as SharedShareQrScreen } from "../ShareQrScreen.tsx";

const infoIcon = "../assets/icons/info.svg";
const playIcon = "../assets/icons/play-circle.svg";
const starIcon = "../assets/icons/star.svg";

type Id = number | string;
export type BiliRoute =
  | { name: "entry" } | { name: "feed" } | { name: "channel-info" } | { name: "login" }
  | { name: "search" } | { name: "results"; query: string }
  | { name: "history" } | { name: "watch-later" } | { name: "favorites" } | { name: "favorite-folder"; mediaId: number; title?: string }
  | { name: "detail"; aid?: Id; bvid?: string; cid?: Id }
  | { name: "comments"; oid: Id; uploaderMid?: Id }
  | { name: "replies"; oid: Id; root: Id; uploaderMid?: Id }
  | { name: "actions"; aid?: Id; bvid?: string; cid?: Id; title?: string; owner?:string; cover?:string }
  | { name: "share"; aid?: Id; bvid?: string; title?: string }
  | { name: "settings" }
  | { name: "player"; aid?: Id; bvid?: string; cid: Id; source?: BiliPlayUrl; title?: string };

export type BiliInput = (title: string, value?: string) => Promise<string | null>;
export interface BiliScreenRef { scroller?: Scroller; onRootBack?: () => boolean }
export interface BiliScreenProps {
  onShare?:ShareHandler;
  loadLocalDetail?: (target: DetailTarget) => Promise<import("../../bili/types.ts").BiliVideoDetail | undefined>;
  height: number; width?: number; route: BiliRoute; client: BiliClient;
  onNavigate: (route: BiliRoute) => void; onBack: () => void;
  input?: BiliInput; onOpenUrl?: (url: string) => void; onError?: (message: string) => void;
  settings?: { showOriginalContent?: boolean; originalContentEnabled?: boolean; onOriginalContentChange?: (enabled: boolean) => void; showContinuePlaybackInBackground?: boolean; continuePlaybackInBackgroundEnabled?: boolean; onContinuePlaybackInBackgroundChange?: (enabled: boolean) => void; onSyncWatchRecords?: () => void; deleteEnabled?: boolean; onDeleteChannel?: () => void | Promise<void> };
  ref?: (value: BiliScreenRef) => void;
}

const num = (value: unknown) => typeof value === "number" ? value : Number(value || 0);
const fail = (props: BiliScreenProps, error: unknown) => props.onError?.(error instanceof Error ? error.message : String(error));
const authenticated = (session: BiliSession | null | undefined) => !!(session?.cookies.SESSDATA && session.cookies.bili_jct && session.cookies.DedeUserID);
const formatCount = (value: unknown) => { const n = num(value); return n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n); };
// Real glyph measurement and native-like UI line breaking (was a fixed-advance estimate).
const FONT_SLOT: Record<number, number> = { 8: 29, 9: 19, 11: 20, 12: 0, 13: 21, 14: 1, 16: 2, 17: 22, 21: 23, 23: 30 };
const measureFor = (size: number) => (text: string) => getOps().measureText(text, FONT_SLOT[size] ?? 1);
const lines = (text: string, width: number, size = 13) => layoutUiText(text, { width, measure: measureFor(size) });

interface AsyncData<T> { value: Accessor<T | undefined>; loading: Accessor<boolean>; error: Accessor<unknown>; refetch: () => void }
function asyncData<T>(fetcher: () => Promise<T>): AsyncData<T>;
function asyncData<S, T>(source: () => S, fetcher: (source: S) => Promise<T>): AsyncData<T>;
function asyncData<S, T>(first: (() => S) | (() => Promise<T>), second?: (source: S) => Promise<T>): AsyncData<T> {
  const [value, setValue] = createSignal<T>(), [loading, setLoading] = createSignal(true), [error, setError] = createSignal<unknown>(), [retry, setRetry] = createSignal(0);
  let generation = 0;
  createEffect(() => { retry(); const source = second ? (first as () => S)() : undefined; const current = ++generation; setLoading(true); setError(undefined); const request = second ? second(source as S) : (first as () => Promise<T>)(); void request.then(result => { if (current === generation) setValue(() => result); }, reason => { if (current === generation) setError(reason); }).finally(() => { if (current === generation) setLoading(false); }); });
  onCleanup(() => { generation++; });
  return { value, loading, error, refetch: () => setRetry(value => value + 1) };
}

function titleEntry(label: string, summary?: string): ScrollEntry { return { height: summary ? 48 : 34, render: () => <View class="absolute inset-0"><Text class="absolute left-[0] right-[0] top-[0] text-[21px] leading-[26] text-[#f5f5f5] text-center">{label}</Text><Show when={summary}><Text class="absolute left-[0] right-[0] top-[28] text-[9px] leading-[17] text-[#aaa] text-center">{summary}</Text></Show></View> }; }
function wrappedTitleEntry(label: string, width: number, summary?: string): ScrollEntry { const wrapped = lines(label, width - 44, 21); const titleHeight = wrapped.length * 25; return { height: titleHeight + (summary ? 18 : 4), render: () => <View class="absolute inset-0"><Text class="absolute left-[0] right-[0] top-[0] text-[21px] leading-[25] text-[#f5f5f5] text-center">{wrapped.join("\n")}</Text><Show when={summary}><Text style={{ insetT: titleHeight + 1 }} class="absolute left-[0] right-[0] text-[9px] leading-[17] text-[#aaa] text-center">{summary}</Text></Show></View> }; }
function buttonEntry(label: string, onPress?: () => void, accent = false): ScrollEntry { return { height: 48, render: () => <View onPress={onPress} focusable={!!onPress} class={accent ? "absolute inset-0 rounded-[24] bg-[#fb7299] items-center justify-center" : "absolute inset-0 rounded-[24] bg-[#292929] items-center justify-center"}><Text class="text-[17px] leading-[21] text-white">{label}</Text></View> }; }
function messageEntry(message: string, width: number): ScrollEntry { const wrapped = lines(message, width - 36); return { height: Math.max(42, wrapped.length * 18 + 18), render: () => <View class="absolute inset-0 rounded-[16] bg-[#1d1d1d] items-center justify-center"><Text class="absolute left-[12] right-[12] top-[9] text-[13px] leading-[18] text-[#bbb] text-center">{wrapped.join("\n")}</Text></View> }; }
function rssFeedEntry(item: BiliItem, width: number, onPress: () => void): ScrollEntry {
  const title = lines(item.title?.trim() || "未命名视频", width - 56, 13).slice(0, 2);
  const summary = lines([item.owner?.name?.trim() ? `作者：${item.owner.name.trim()}` : "", item.stat?.view != null ? `播放 ${formatCount(item.stat.view)}` : ""].filter(Boolean).join(" · ") || "哔哩哔哩推荐", width - 56, 11).slice(0, 2);
  return { height: 78, render: () => <View onPress={onPress} focusable class="absolute inset-0 rounded-[16] bg-[#202020] overflow-hidden">
    <Text class="absolute left-[12] right-[12] top-[10] h-[38] overflow-hidden text-[13px] leading-[18] text-white">{title.join("\n")}</Text>
    <Text class="absolute left-[12] right-[12] top-[52] h-[18] overflow-hidden text-[11px] leading-[15] text-[#999]">{summary.join("\n")}</Text>
  </View> };
}
function Scrolled(props: BiliScreenProps & { entries: ScrollEntry[]; onRefresh?: () => void }) { return <ScrollEntries onRefresh={props.onRefresh} height={props.height} entries={props.entries} gap={8} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />; }

function pagedData<T>(source: () => unknown, factory: (changed: (state: BrowseState<T>) => void) => { state: BrowseState<T>; refresh: () => Promise<void>; loadMore: () => Promise<void>; dispose: () => void }) {
  const [state, setState] = createSignal<BrowseState<T>>({ items: [], loading: true, canLoadMore: true });
  let pager: ReturnType<typeof factory> | undefined;
  createEffect(() => { source(); pager?.dispose(); pager = factory(value => setState(() => value)); setState(() => pager!.state); void pager.refresh(); });
  onCleanup(() => pager?.dispose());
  return { state, refetch: () => { void pager?.refresh(); }, more: () => { void pager?.loadMore(); } };
}
function pagingEntries<T>(page: ReturnType<typeof pagedData<T>>, width: number): ScrollEntry[] {
  return [...(page.state().error ? [messageEntry(String(page.state().error), width)] : []),
    ...(page.state().loading ? [messageEntry("加载中…", width)] : page.state().canLoadMore ? [buttonEntry(page.state().error ? "重试加载" : "加载更多", page.more)] : []),
    buttonEntry("刷新", page.refetch)];
}

function FeedScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession());
  const feed = pagedData<BiliItem>(() => authenticated(session.value()), changed => new BiliFeedBrowser({ feed: () => authenticated(session.value()) ? props.client.feed() : Promise.resolve({ items: [], source: "web" }) }, {
    get: <T,>(key: string) => authenticated(session.value()) ? kv.get<T>(key) : undefined,
    set: <T,>(key: string, value: T) => kv.set(key, value),
  }, changed));
  const entries = createMemo<ScrollEntry[]>(() => {
    const values = feed.state().items, loggedIn = authenticated(session.value());
    // Native BiliFeedHeader: "哔哩哔哩 ⓘ" (19sp bold #BDBDBD hint) then 6dp gap and the 9sp login caption.
    const contentWidth = (props.width ?? 233) - 36, titleWidth = measureFor(21)("哔哩哔哩"), hintGap = 7, hintBox = 19.2;
    const groupLeft = (contentWidth - (titleWidth + hintGap + 16)) / 2;
    return [{ height: 49, render: () => <View onPress={() => props.onNavigate({ name: "channel-info" })} focusable accessibilityRole="button" accessibilityLabel="哔哩哔哩频道信息" class="absolute inset-0">
      <Text style={{ insetL: groupLeft }} class="absolute top-[1] text-[21px] leading-[26] text-white">哔哩哔哩</Text>
      <Image src="../assets/icons/info-hint.svg" style={{ insetL: groupLeft + titleWidth + hintGap - 3.6, width: hintBox, height: hintBox }} class="absolute top-[3.9]" />
      <Text class="absolute left-[0] right-[0] top-[32.5] text-[9px] leading-[17] text-[#b6b6b6] text-center">{loggedIn ? "已登录" : "未登录"}</Text>
    </View> } as ScrollEntry,
      ...(!session.loading() && !loggedIn ? [buttonEntry("登录", () => props.onNavigate({ name: "login" }))] : []),
      ...(!session.loading() && loggedIn && !feed.state().loading && !feed.state().error && !values.length ? [messageEntry("暂无内容\n稍后再试或刷新", props.width ?? 233)] : []),
      ...(!session.loading() && !loggedIn ? [messageEntry("需要登录\n登录后获取推荐内容", props.width ?? 233)] : []),
      ...values.map(item => {
        const open = () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid });
        return (props.settings?.originalContentEnabled ?? true) ? listVideoEntry(item, item.owner?.name ?? "", props.width ?? 233, open) : rssFeedEntry(item, props.width ?? 233, open);
      }),
      ...(loggedIn ? pagingEntries(feed, props.width ?? 233) : [])];
  });
  return <Scrolled {...props} entries={entries()} onRefresh={feed.refetch} />;
}

function ChannelInfoScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession());
  const entries = createMemo<ScrollEntry[]>(() => { const loggedIn = authenticated(session.value()); return [titleEntry("哔哩哔哩"), messageEntry(`${loggedIn ? "进入以获取推荐内容" : "未登录，登录后获取推荐内容"}\nhttps://www.bilibili.com\n更新：${loggedIn ? "实时" : "--"}`, props.width ?? 233), buttonEntry("设置", () => props.onNavigate({ name: "settings" })), ...(!loggedIn ? [buttonEntry("登录", () => props.onNavigate({ name: "login" }))] : []), buttonEntry("搜索", loggedIn ? () => props.onNavigate({ name: "search" }) : undefined), buttonEntry("稍后再看", loggedIn ? () => props.onNavigate({ name: "watch-later" }) : undefined), buttonEntry("历史记录", loggedIn ? () => props.onNavigate({ name: "history" }) : undefined), buttonEntry("收藏夹", loggedIn ? () => props.onNavigate({ name: "favorites" }) : undefined)]; });
  return <Scrolled {...props} entries={entries()} />;
}

/** Native buildFeedSummary: "owner · 播放 N" or "哔哩哔哩推荐". */
function feedSummary(item: BiliItem): string {
  const parts = [item.owner?.name, item.stat?.view != null ? `播放 ${formatCount(item.stat.view)}` : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "哔哩哔哩推荐";
}

/** Native BiliFeedCard: 100dp cover, background gradient, 8dp padding, 14sp title + 9sp summary at the bottom. */
function listVideoEntry(item: BiliItem, _subtitle: string, width: number, onPress: () => void): ScrollEntry {
  const cardWidth = width - 36, padding = 8, textWidth = cardWidth - padding * 2;
  const title = measuredLines(item.title || "哔哩哔哩视频", textWidth, measureFor(14), 2);
  const summary = measuredLines(feedSummary(item), textWidth, measureFor(9), 2);
  const textHeight = title.length * 18 + 2 + summary.length * 9.9;
  const height = Math.max(100, textHeight + padding * 2), top = height - padding - textHeight;
  return { height, render: () => <View onPress={onPress} focusable accessibilityRole="button" accessibilityLabel={`视频：${item.title ?? ""}`} class="absolute inset-0 rounded-[16] bg-[#1c1f21] overflow-hidden">
    {item.cover ? <RemoteImage cacheBucket="bili-preview" url={item.cover} width={cardWidth} height={100} fit="cover" class="absolute left-[0] top-[0]" /> : null}
    <View class="absolute left-[0] right-[0] top-[0] h-[100] bg-gradient-to-b from-transparent to-[#0b1211b3]" />
    {title.map((line, index) => <Text class="absolute text-sm leading-[18] text-[#f5f5f5]" style={{ insetL: padding, insetR: padding, insetT: top + index * 18 }}>{line}</Text>)}
    <Text class="absolute text-[9px] leading-[9.9] text-[#b6b6b6cc]" style={{ insetL: padding, insetR: padding, insetT: top + 2 + title.length * 18 }}>{summary.join("\n")}</Text>
  </View> };
}

function HistoryScreen(props: BiliScreenProps) {
  const page = pagedData<BiliHistoryItem>(() => props.client, changed => historyPager(props.client, changed));
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("历史记录"), ...page.state().items.map(item => historyEntry(item, props.width ?? 233, props)), ...(!page.state().loading && !page.state().error && !page.state().items.length ? [messageEntry("暂无内容\n稍后再试", props.width ?? 233)] : []), ...pagingEntries(page, props.width ?? 233)]);
  return <Scrolled {...props} entries={entries()} onRefresh={page.refetch} />;
}
function historyEntry(item: BiliHistoryItem, width: number, props: BiliScreenProps) { const video: BiliItem = { aid: item.history?.oid, bvid: item.history?.bvid, cid: item.history?.cid, title: item.title, cover: item.cover, duration: item.duration, owner: { name: item.authorName } }; const progress = item.progress != null && item.duration ? `已看 ${Math.min(100, Math.round(item.progress / item.duration * 100))}%` : ""; return listVideoEntry(video, [item.authorName, progress].filter(Boolean).join(" · "), width, () => props.onNavigate({ name: "detail", aid: video.aid, bvid: video.bvid, cid: video.cid })); }

function WatchLaterScreen(props: BiliScreenProps) {
  const page = asyncData(() => props.client.toView());
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("稍后再看", "下拉刷新"), ...(page.loading() ? [messageEntry("加载中…", props.width ?? 233)] : []), ...(page.error() ? [messageEntry(String(page.error()), props.width ?? 233)] : []), ...(page.value()?.items ?? []).map(item => listVideoEntry(item, [item.owner?.name, item.duration ? durationText(item.duration) : ""].filter(Boolean).join(" · "), props.width ?? 233, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid }))), ...(!page.loading() && !page.error() && !page.value()?.items.length ? [messageEntry("暂无内容\n稍后再试", props.width ?? 233)] : []), buttonEntry("刷新", page.refetch)]);
  return <Scrolled {...props} entries={entries()} />;
}
function durationText(seconds: number) { const minutes = Math.floor(seconds / 60), remain = Math.floor(seconds % 60); return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`; }

function FavoritesScreen(props: BiliScreenProps) {
  const folders = asyncData(() => props.client.favoriteFolders());
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("收藏夹", "下拉刷新"), ...(folders.loading() ? [messageEntry("加载中…", props.width ?? 233)] : []), ...(folders.error() ? [messageEntry(String(folders.error()), props.width ?? 233)] : []), ...(folders.value() ?? []).map(folder => { const mediaId = folder.id ?? folder.fid; return buttonEntry(`${folder.title || "未命名收藏夹"}${folder.mediaCount != null ? ` · ${folder.mediaCount}` : ""}`, mediaId ? () => props.onNavigate({ name: "favorite-folder", mediaId, title: folder.title }) : undefined); }), ...(!folders.loading() && !folders.error() && !folders.value()?.length ? [messageEntry("暂无收藏夹", props.width ?? 233)] : []), buttonEntry("刷新", folders.refetch)]);
  return <Scrolled {...props} entries={entries()} />;
}

function FavoriteFolderScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "favorite-folder" }> }) {
  const page = pagedData<BiliItem>(() => props.route.mediaId, changed => favoritePager(props.client, props.route.mediaId, changed));
  const entries = createMemo<ScrollEntry[]>(() => [wrappedTitleEntry(props.route.title || "收藏夹", props.width ?? 233), ...page.state().items.map(item => listVideoEntry(item, item.owner?.name ?? "", props.width ?? 233, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid }))), ...(!page.state().loading && !page.state().error && !page.state().items.length ? [messageEntry("暂无内容\n稍后再试", props.width ?? 233)] : []), ...pagingEntries(page, props.width ?? 233)]);
  return <Scrolled {...props} entries={entries()} onRefresh={page.refetch} />;
}

function LoginScreen(props: BiliScreenProps) {
  const [state, setState] = createSignal("正在申请二维码…"), [qr, setQr] = createSignal<QrLoginRequest>();
  let pollToken: { aborted: boolean } | undefined;
  async function request() { if (pollToken) pollToken.aborted = true; const token = { aborted: false }; pollToken = token; try { setState("正在申请二维码…"); const value = await props.client.requestQrLogin(); if (token.aborted) return; setQr(value); setState("等待扫码"); const result = await props.client.waitForQrLogin(value.qrcodeKey, { signal: token, onStatus: (status: QrPollResult) => setState(statusText(status)) }); if (!token.aborted && result.status === "success") props.onNavigate({ name: "feed" }); } catch (error) { if (!token.aborted) setState(error instanceof Error ? error.message : String(error)); } }
  onMount(() => void request());
  onCleanup(() => { if (pollToken) pollToken.aborted = true; });
  const qrUrl = createMemo(() => qr()?.url || "");
  return <SafeQrScreen width={props.width ?? 233} height={props.height} title="扫码登录" value={qrUrl()} status={state()} actionLabel="刷新" onAction={() => void request()} onRefresh={() => void request()} onError={error => setState(error)} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />;
}
function statusText(value: QrPollResult) { if (value.status === "scanned") return "已扫码，请在手机确认"; if (value.status === "expired") return "二维码已过期"; if (value.status === "success") return "登录成功"; if (value.status === "error") return "登录失败"; return "等待扫码"; }

function SearchScreen(props: BiliScreenProps) {
  const hot = asyncData(() => props.client.hotSearch()), history = new BiliSearchHistory(kv);
  const [historyItems, setHistoryItems] = createSignal(history.read());
  function submit(query: string) { try { const target = history.submit(query); setHistoryItems(history.read()); if (target) props.onNavigate(target); } catch (error) { fail(props, error); } }
  async function search() { if (!props.input) return fail(props, new Error("当前运行时未接入文字输入")); const query = await props.input("搜索哔哩哔哩"); if (query != null) submit(query); }
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("搜索"), buttonEntry("输入关键词 / AV / BV", () => void search(), true),
    ...(historyItems().length ? [titleEntry("搜索历史"), ...historyItems().map(query => buttonEntry(query, () => submit(query))), buttonEntry("清空历史", () => { try { history.clear(); setHistoryItems([]); } catch (error) { fail(props, error); } })] : []),
    ...(hot.value() ?? []).slice(0, 10).map(word => buttonEntry(word.showName || word.keyword, () => submit(word.keyword))), ...(hot.loading() ? [messageEntry("正在加载热门搜索…", props.width ?? 233)] : []), ...(hot.error() ? [messageEntry(String(hot.error()), props.width ?? 233)] : [])]);
  return <Scrolled {...props} entries={entries()} />;
}

function ResultsScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "results" }> }) {
  const results = pagedData<Extract<BiliSearchResult, { kind: "video" }>>(() => props.route.query, changed => searchPager(props.client, props.route.query, changed));
  async function revise() { const query = await props.input?.("搜索哔哩哔哩", props.route.query); if (query != null) { try { const target = new BiliSearchHistory(kv).submit(query); if (target) props.onNavigate(target); } catch (error) { fail(props, error); } } }
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("搜索", props.route.query), buttonEntry("修改关键词", props.input ? () => void revise() : undefined), ...results.state().items.map(item => searchResultEntry(item, props.width ?? 233, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid }))), ...(!results.state().loading && !results.state().error && !results.state().items.length ? [messageEntry("没有找到相关结果", props.width ?? 233)] : []), ...pagingEntries(results, props.width ?? 233)]);
  return <Scrolled {...props} entries={entries()} onRefresh={results.refetch} />;
}

function searchResultEntry(item: Extract<BiliSearchResult, { kind: "video" }>, width: number, onPress: () => void): ScrollEntry {
  const heading = (item.title || "未命名结果").replace(/<[^>]+>/g, ""), summary = [item.author, item.play != null ? `播放 ${formatCount(item.play)}` : "", item.danmaku != null ? `弹幕 ${formatCount(item.danmaku)}` : ""].filter(Boolean).join(" · ");
  const titleLines = lines(heading, width - 56, 13).slice(0, 2), summaryLines = lines(summary, width - 56, 11).slice(0, 1), imageWidth = width - 36;
  return { height: 174, render: () => <View onPress={onPress} focusable class="absolute inset-0 rounded-[16] bg-[#202020] overflow-hidden"><View class="absolute left-[8] right-[8] top-[8] h-[104] rounded-[12] bg-[#303030] overflow-hidden">{item.pic ? <RemoteImage cacheBucket="bili-preview" url={item.pic} width={imageWidth - 16} height={104} class="absolute inset-0" /> : null}<View class="absolute left-[77] top-[33] w-[38] h-[38] rounded-full bg-[#000000aa] items-center justify-center"><Image src={playIcon} style={{ width: 28, height: 28 }} /></View></View><Text class="absolute left-[12] right-[12] top-[119] text-[13px] leading-[18] text-white">{titleLines.join("\n")}</Text><Text class="absolute left-[12] right-[12] bottom-[5] text-[11px] leading-[15] text-[#999]">{summaryLines.join("\n")}</Text></View> };
}

function DetailScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "detail" }> }) {
  const [state, setState] = createSignal<DetailState>({ selected: 0, interaction: {}, loading: true, busy: false, offline: false });
  let controller: BiliDetailController;
  createEffect(() => {
    const target = { aid: num(props.route.aid) || undefined, bvid: props.route.bvid, cid: num(props.route.cid) || undefined };
    controller = new BiliDetailController(props.client, kv, target, props.loadLocalDetail ?? (async () => undefined), setState);
    const own = controller; setState(own.state); void own.load(); onCleanup(() => own.dispose());
  });
  const detail = { value: () => state().detail, loading: () => state().loading, error: () => state().error, refetch: () => void controller.load() };
  const [busy, setBusy] = createSignal("");
  let disposed = false; onCleanup(() => { disposed = true; });
  async function play() {
    if (busy()) return;
    const data = detail.value(), actual = controller.selectedCid(), own = controller;
    if (!actual) return fail(props, new Error("视频没有可播放的分 P"));
    try { setBusy("正在解析播放地址…"); const source = await props.client.resolvePlayback({ cid: actual, aid: data?.item.aid, bvid: data?.item.bvid, preferMp4: true });
      if (!disposed && controller === own) props.onNavigate({ name: "player", cid: actual, aid: data?.item.aid, bvid: data?.item.bvid, source, title: data?.item.title });
    } catch (error) { if (!disposed) fail(props, error); } finally { if (!disposed) setBusy(""); }
  }
  const original = () => props.settings?.originalContentEnabled ?? true;
  const entries = createMemo<ScrollEntry[]>(() => { const data = detail.value(), it = data?.item, title = it?.title?.trim() || (it?.bvid ? `BV号 ${it.bvid}` : it?.aid ? `av${it.aid}` : "哔哩哔哩视频"), owner = it?.owner?.name?.trim() || "未知作者", desc = data?.desc?.trim() || "暂无简介", titleLines = lines(title, (props.width ?? 233) - 36, 21), authorLines = lines(`作者：${owner}`, (props.width ?? 233) - 36, 13), descLines = lines(`简介：${desc}`, (props.width ?? 233) - 36, 13); const textEntries = data ? [{ height: Math.max(32, titleLines.length * 25), render: () => <Text class="absolute left-[0] right-[0] top-[0] text-[21px] leading-[25] text-white text-center">{titleLines.join("\n")}</Text> }, { height: Math.max(20, authorLines.length * 18), render: () => <Text class="absolute inset-0 text-[13px] leading-[18] text-[#aaa]">{authorLines.join("\n")}</Text> }, { height: Math.max(20, descLines.length * 18), render: () => <Text class="absolute inset-0 text-[13px] leading-[18] text-[#e8e8e8]">{descLines.join("\n")}</Text> }] as ScrollEntry[] : [];
    const [preview, ...actions] = data ? [{ height: 126, render: () => <View onPress={() => void play()} focusable class="absolute inset-0 rounded-[16] bg-[#242424] overflow-hidden items-center justify-center">{it?.cover ? <RemoteImage cacheBucket="bili-preview" url={it.cover} width={(props.width ?? 233) - 36} height={126} class="absolute inset-0" /> : null}<View style={{ insetL: ((props.width ?? 233) - 36 - 48) / 2 }} class="absolute top-[39] w-[48] h-[48] rounded-full bg-[#000000aa] items-center justify-center"><Image src={playIcon} style={{ width: 34, height: 34 }} /></View></View> } as ScrollEntry, { height: 40, render: () => <View class="absolute inset-0"><View onPress={() => props.onNavigate({ name: "actions", aid: it?.aid, bvid: it?.bvid, cid: controller.selectedCid(), title, owner:it?.owner?.name, cover:it?.cover })} focusable class="absolute left-[63] top-[4] w-[32] h-[32] rounded-full bg-[#292929] items-center justify-center"><Image src={starIcon} style={{ width: 21, height: 21 }} /></View><View onPress={() => {const qr=()=>props.onNavigate({ name:"share",aid:it?.aid,bvid:it?.bvid,title });if(props.onShare)props.onShare({origin:"bili-detail",title,link:biliShareLink(it?.bvid,it?.aid)},qr);else qr();}} focusable class="absolute right-[63] top-[4] w-[32] h-[32] rounded-full bg-[#292929] items-center justify-center"><Text class="text-[9px] leading-[13] text-white">分享</Text></View></View> } as ScrollEntry] : [];
    return [
      ...(detail.loading() ? [messageEntry("正在加载视频详情…", props.width ?? 233)] : []),
      ...(detail.error() ? [messageEntry(String(detail.error()), props.width ?? 233), buttonEntry("重试", detail.refetch)] : []),
      ...(original() && preview ? [preview] : []), ...textEntries,
      ...(!original() && preview ? [preview] : []), ...actions,
      ...(data && data.pages.length > 1 ? data.pages.map((page, index) => buttonEntry(`${index === state().selected ? "✓ " : ""}P${page.page ?? index + 1} ${page.part ?? ""}`, busy() ? undefined : () => controller.select(index), index === state().selected)) : []),
      ...(data ? [buttonEntry(state().interaction.like ? "已点赞 · 取消点赞" : "点赞", state().busy || state().loading ? undefined : () => void controller.act("like")), buttonEntry(state().interaction.coin ? "已投币" : "投币", state().busy || state().loading || state().interaction.coin ? undefined : () => void controller.act("coin")), buttonEntry(state().interaction.favorite ? "取消收藏" : "收藏", state().busy || state().loading ? undefined : () => void controller.act("favorite"))] : []),
      ...(original() && it?.aid ? [buttonEntry("评论", () => props.onNavigate({ name: "comments", oid: it.aid!, uploaderMid: it.owner?.mid }))] : []),
      ...(state().offline ? [messageEntry("本地已保存详情", props.width ?? 233)] : []),
      ...(state().message ? [messageEntry(state().message!, props.width ?? 233)] : []),
      ...(busy() ? [messageEntry(busy(), props.width ?? 233)] : []),
    ];
  });
  return <Scrolled {...props} entries={entries()} onRefresh={detail.refetch} />;
}

function ActionsScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "actions" }> }) {
  const aid = typeof props.route.aid === "number" ? props.route.aid : Number(props.route.aid || 0), folders = asyncData(() => props.client.favoriteFolders({ rid: aid })); const [message, setMessage] = createSignal("");
  async function add(folder: BiliFavoriteFolder) { const id = folder.id ?? folder.fid; if (!id || !aid) return; try { await props.client.favorite({ aid, bvid: props.route.bvid, addMediaIds: [id], savedItem: {aid, bvid:props.route.bvid, cid: typeof props.route.cid==="number"?props.route.cid:undefined, title:props.route.title,owner:{name:props.route.owner},cover:props.route.cover} }); setMessage("已收藏"); } catch (error) { fail(props, error); } }
  async function watchLater() { try { await props.client.addToView({ aid: aid || undefined, bvid: props.route.bvid, savedItem: {aid:aid||undefined,bvid:props.route.bvid,cid:typeof props.route.cid==="number"?props.route.cid:undefined,title:props.route.title,owner:{name:props.route.owner},cover:props.route.cover} }); setMessage("已加入稍后再看"); } catch (error) { fail(props, error); } }
  const entries = createMemo<ScrollEntry[]>(() => [titleEntry("视频操作"), buttonEntry("稍后再看", () => void watchLater()), buttonEntry("分享", () => {const title=biliActionTitle(props.route.title,props.route.bvid,props.route.aid),qr=()=>props.onNavigate({name:"share",aid:props.route.aid,bvid:props.route.bvid,title});if(props.onShare)props.onShare({origin:"detail",title,link:biliShareLink(props.route.bvid,props.route.aid)},qr);else qr();}), titleEntry("收藏到"), ...(folders.loading() ? [messageEntry("正在加载收藏夹…", props.width ?? 233)] : []), ...(folders.error() ? [messageEntry(String(folders.error()), props.width ?? 233)] : []), ...(folders.value() ?? []).map(folder => buttonEntry(folder.title || "未命名收藏夹", () => void add(folder))), ...(message() ? [messageEntry(message(), props.width ?? 233)] : []), buttonEntry("取消", props.onBack)]);
  return <Scrolled {...props} entries={entries()} />;
}

function ShareScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "share" }> }) {
  const url = biliShareLink(props.route.bvid,props.route.aid)??"";
  return <SharedShareQrScreen width={props.width ?? 233} height={props.height} title={props.route.title || "扫码分享"} url={url} onClose={props.onBack} onError={message => fail(props, new Error(message))} />;
}

function settingEntry(label: string, enabled: boolean, onPress?: () => void): ScrollEntry { return { height: 48, render: () => <View onPress={onPress} focusable={!!onPress} class="absolute inset-0 rounded-[24] bg-[#292929]"><Text class="absolute left-[14] top-[14] text-[17px] leading-[21] text-white">{label}</Text><View class={enabled ? "absolute right-[10] top-[10] w-[42] h-[28] rounded-[20] bg-[#fb7299] items-center justify-center" : "absolute right-[10] top-[10] w-[42] h-[28] rounded-[20] bg-[#4a4a4a] items-center justify-center"}><Text class="text-[11px] leading-[15] text-white">{enabled ? "开" : "关"}</Text></View></View> }; }
function SettingsScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession()), [original, setOriginal] = createSignal(props.settings?.originalContentEnabled ?? true), [background, setBackground] = createSignal(props.settings?.continuePlaybackInBackgroundEnabled ?? false), [confirmDelete, setConfirmDelete] = createSignal(false);
  createEffect(() => { const value = props.settings?.originalContentEnabled; if (typeof value === "boolean" && value !== original()) setOriginal(value); });
  createEffect(() => { const value = props.settings?.continuePlaybackInBackgroundEnabled; if (typeof value === "boolean" && value !== background()) setBackground(value); });
  function toggleOriginal() { const value = !original(); props.settings?.onOriginalContentChange?.(value); }
  function toggleBackground() { if (!props.settings?.onContinuePlaybackInBackgroundChange) return; const value = !background(); setBackground(value); props.settings.onContinuePlaybackInBackgroundChange(value); }
  const entries = createMemo<ScrollEntry[]>(() => confirmDelete() ? [titleEntry("删除频道"), messageEntry("删除后将移除本地缓存", props.width ?? 233), buttonEntry("确认删除", async () => { try { await props.settings?.onDeleteChannel?.(); setConfirmDelete(false); } catch(error) { fail(props,error); } }), buttonEntry("取消", () => setConfirmDelete(false))] : [titleEntry("设置", session.loading() ? "加载中…" : authenticated(session.value()) ? "已登录" : "未登录"), ...(props.settings?.showOriginalContent ? [settingEntry("原文阅读模式", original(), toggleOriginal), { height: 24, render: () => <Text class="absolute left-[10] right-[10] top-[0] text-[11px] leading-[15] text-[#999]">刷新时抓取原文正文与图片</Text> } as ScrollEntry] : []), ...(props.settings?.showContinuePlaybackInBackground ? [settingEntry("在后台继续播放", background(), props.settings.onContinuePlaybackInBackgroundChange ? toggleBackground : undefined)] : []), ...(props.settings?.onSyncWatchRecords ? [buttonEntry("开始同步B站观看记录", props.settings.onSyncWatchRecords)] : []), buttonEntry("退出登录", authenticated(session.value()) ? async () => { try { await props.client.logout(); props.onNavigate({ name: "feed" }); } catch (error) { fail(props, error); } } : undefined), buttonEntry("删除频道", props.settings?.deleteEnabled && props.settings.onDeleteChannel ? () => setConfirmDelete(true) : undefined)]);
  const rootBack = () => { if (!confirmDelete()) return false; setConfirmDelete(false); return true; };
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: rootBack })} />;
}
function PlayerScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "player" }> }) { const entries = [titleEntry("播放", props.route.title), messageEntry("播放器路由应由宿主接管，当前页面未取得原生播放边界。", props.width ?? 233), buttonEntry("返回", props.onBack)]; return <Scrolled {...props} entries={entries} />; }

export function BiliScreen(props: BiliScreenProps) {
  const route = () => props.route;
  return <Show when={route().name !== "entry" && route().name !== "feed"} fallback={<FeedScreen {...props} />}>
    <Show when={route().name !== "channel-info"} fallback={<ChannelInfoScreen {...props} />}><Show when={route().name !== "history"} fallback={<HistoryScreen {...props} />}><Show when={route().name !== "watch-later"} fallback={<WatchLaterScreen {...props} />}><Show when={route().name !== "favorites"} fallback={<FavoritesScreen {...props} />}><Show when={route().name !== "favorite-folder"} fallback={<FavoriteFolderScreen {...props} route={route() as Extract<BiliRoute, { name: "favorite-folder" }>} />}><Show when={route().name !== "login"} fallback={<LoginScreen {...props} />}><Show when={route().name !== "search"} fallback={<SearchScreen {...props} />}>
      <Show when={route().name !== "results"} fallback={<ResultsScreen {...props} route={route() as Extract<BiliRoute, { name: "results" }>} />}>
        <Show when={route().name !== "detail"} fallback={<DetailScreen {...props} route={route() as Extract<BiliRoute, { name: "detail" }>} />}>
          <Show when={route().name !== "comments" && route().name !== "replies"} fallback={<CommentScreen {...props} route={route() as Extract<BiliRoute, { name: "comments" | "replies" }>} />}>
            <Show when={route().name !== "actions"} fallback={<ActionsScreen {...props} route={route() as Extract<BiliRoute, { name: "actions" }>} />}><Show when={route().name !== "share"} fallback={<ShareScreen {...props} route={route() as Extract<BiliRoute, { name: "share" }>} />}><Show when={route().name !== "settings"} fallback={<SettingsScreen {...props} />}><PlayerScreen {...props} route={route() as Extract<BiliRoute, { name: "player" }>} /></Show></Show></Show>
          </Show>
        </Show>
      </Show>
    </Show></Show></Show></Show></Show></Show></Show>
  </Show>;
}

export default BiliScreen;
