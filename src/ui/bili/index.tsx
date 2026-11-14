import {biliFeedScope} from '../../bili/recommendations.ts';
import {useModalInput} from '../modal-input.ts';
import type {ModalInput,ModalInputRecovery} from '../service.ts';
import {restoredSignal,booleanState,stringState} from '../route-activity.tsx';
import { CommentScreen } from "./CommentScreen.tsx";
import { BiliDetailController, type DetailState, type DetailTarget } from "../../bili/detail.ts";
import { BiliFeedBrowser, BiliSearchHistory, favoritePager, historyPager, searchPager, type BrowseState } from "../../bili/browse.ts";
import {biliShareLink,biliActionTitle,type ShareHandler} from "../../sharing/policy.ts";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { kv } from "@podjs/framework/watch";
import type { BiliClient, BiliFavoriteFolder, BiliHistoryItem, BiliItem, BiliPlayUrl, BiliSearchResult, BiliSession, QrLoginRequest, QrPollResult } from "../../bili/index.ts";
import { layoutUiText } from "../../reader/line-break.ts";
import { measuredLines } from "../../reader/measured-text.ts";
import { getOps } from "@pocketjs/framework/host";
import { ScrollEntries, type ScrollEntry } from "../ScrollEntries.tsx";
import { platformCardEntry, platformNoticeEntry } from "../PlatformNotice.tsx";
import { platformNotice, platformScope } from "../../announcement/platform.ts";
import { RemoteImage } from "../RemoteImage.tsx";
import { SwipeCard } from "../SwipeCard.tsx";
import { BiliSideMenu } from "./BiliSideMenu.tsx";
import { MediaReaderDetail } from "../MediaReaderDetail.tsx";
import { delay, hostOperation } from "@podjs/framework/services";
import { SafeQrScreen } from "../SafeQrScreen.tsx";
import { WatchSwitch } from "../AutoScrollSettingsScreen.tsx";
import { DeleteConfirmDialog } from "../DeleteConfirmDialog.tsx";
import { DownloadPhoneAppDialog } from "../DownloadPhoneAppDialog.tsx";
import { PlatformSettingsScreen, spacerEntry, switchRow, dangerEntry } from "../PlatformSettingsScreen.tsx";
import { ReaderBackground, useReaderBackgrounds } from "../ReaderBackground.tsx";
import { WatchProgressIndicator } from "../WatchProgressIndicator.tsx";
import { defaultReaderPreset, type ReaderPreset } from "../../reader/preset.ts";
import { presetContentFont, readerColor, readerTextClass } from "../../reader/content-layout.ts";
import { readerChrome } from "../../reader/chrome.ts";
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
  | { name: "player"; aid?: Id; bvid?: string; cid: Id; source?: BiliPlayUrl; title?: string; cover?: string; author?: string; description?: string };

export type BiliInput = ModalInput;
export interface BiliScreenRef { scroller?: Scroller; onRootBack?: () => boolean }
export interface BiliScreenProps {
  onShare?:ShareHandler;
  loadLocalDetail?: (target: DetailTarget) => Promise<import("../../bili/types.ts").BiliVideoDetail | undefined>;
  height: number; width?: number; route: BiliRoute; client: BiliClient; preset?: ReaderPreset; active?: boolean;
  onNavigate: (route: BiliRoute) => void; onBack: () => void;
  input?: BiliInput; inputRecovery?:ModalInputRecovery; onOpenUrl?: (url: string) => void; onError?: (message: string) => void;
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
function buttonEntry(label: string, onPress?: () => void, accent = false): ScrollEntry { return { height: 48, render: () => <View onPress={onPress} focusable={!!onPress} class={accent ? "absolute inset-0 rounded-[24] bg-[#fb7299] items-center justify-center active:scale-96" : "absolute inset-0 rounded-[24] bg-[#292929] items-center justify-center active:scale-96"}><Text class="text-[17px] leading-[21] text-white">{label}</Text></View> }; }
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

function FeedScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession());
  const feed = pagedData<BiliItem>(() => biliFeedScope(session.value()), changed => new BiliFeedBrowser({ feed: params => authenticated(session.value()) ? props.client.feed(params) : Promise.resolve({ items: [], source: "web" }) }, {
    get: <T,>(key: string) => kv.get<T>(key),
    set: <T,>(key: string, value: T) => kv.set(key, value),
  }, changed, {scope:()=>biliFeedScope(session.value())}));
  // Native BiliFeedItemEntry: swipe left reveals 收藏 / 稍后再看 (disabled while scrolling);
  // results surface as the bottom ToastMessage.
  const [openSwipeId, setOpenSwipeId] = createSignal<string | null>(null);
  const [scrolling, setScrolling] = createSignal(false);
  const [toast, setToast] = createSignal("");
  let sideMenu: { isEdge: (x: number) => boolean; edgeSwipe: (dx: number) => void } | undefined;
  let toastGeneration = 0;
  const showToast = (text: string) => { const own = ++toastGeneration; setToast(text); void delay(3000).result.then(() => { if (own === toastGeneration) setToast(""); }, () => {}); };
  const itemKey = (item: BiliItem) => String(item.bvid ?? item.aid ?? item.title ?? "");
  async function favorite(item: BiliItem) {
    try {
      const aid = num(item.aid); if (!aid) throw new Error("视频缺少 aid");
      const folders = await props.client.favoriteFolders({ rid: aid, type: 2 });
      const id = folders[0]?.id ?? folders[0]?.fid; if (!id) throw new Error("没有可用的收藏夹");
      await props.client.favorite({ aid, bvid: item.bvid, savedItem: item, addMediaIds: [id] });
      showToast("已收藏");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  }
  async function watchLater(item: BiliItem) {
    try { await props.client.addToView({ aid: num(item.aid) || undefined, bvid: item.bvid, savedItem: item }); showToast("已加入稍后再看"); }
    catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  }
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
      platformNoticeEntry(contentWidth, platformNotice("哔哩哔哩", true)),
      ...(!session.loading() && !loggedIn ? [buttonEntry("登录", () => props.onNavigate({ name: "login" }), true)] : []),
      ...(!session.loading() && loggedIn && !feed.state().loading && !values.length ? [emptyStateEntry("暂无内容", feed.state().error ? String(feed.state().error instanceof Error ? (feed.state().error as Error).message : feed.state().error) : "稍后再试或刷新", props.width ?? 233)] : []),
      ...(!session.loading() && !loggedIn ? [emptyStateEntry("需要登录", "登录后获取推荐内容", props.width ?? 233)] : []),
      ...values.map(item => {
        const open = () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid });
        if (!(props.settings?.originalContentEnabled ?? true)) return rssFeedEntry(item, props.width ?? 233, open);
        const card = listVideoCard(item, undefined, props.width ?? 233), key = itemKey(item);
        return { height: card.height, bounds: card.bounds, render: () => <SwipeCard cardClass="absolute inset-0 rounded-[16] bg-[#1c1f21] overflow-hidden"
          onOpen={() => { if (openSwipeId()) setOpenSwipeId(null); else open(); }}
          onActions={() => props.onNavigate({ name: "actions", aid: item.aid, bvid: item.bvid, cid: item.cid, title: item.title, owner: item.owner?.name, cover: item.cover })}
          onFavorite={() => { setOpenSwipeId(null); void favorite(item); }} onWatchLater={() => { setOpenSwipeId(null); void watchLater(item); }}
          open={openSwipeId() === key} swipeEnabled={!scrolling()} onStartSwipe={() => { if (openSwipeId() !== key) setOpenSwipeId(null); }}
          onOpenSwipe={() => setOpenSwipeId(key)} onCloseSwipe={() => { if (openSwipeId() === key) setOpenSwipeId(null); }}
          edgeSwipe={{ startX: x => sideMenu?.isEdge(x) ?? false, onSwipe: dx => sideMenu?.edgeSwipe(dx) }}>{card.content()}</SwipeCard> };
      }),
      ...(loggedIn && feed.state().loading && values.length ? [{ height: 21, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-[17px] leading-[21] text-center text-[#b6b6b6]">加载中...</Text> }] : [])];
  });
  // Native loads more once the last visible item is within 3 of the end.
  const settled = (_first: number, last: number) => { const state = feed.state(); if (last >= entries().length - 4 && state.canLoadMore && !state.loading && state.items.length) feed.more(); };
  return <>
    <ScrollEntries inputActive={() => props.active !== false} onRefresh={feed.refetch} height={props.height} entries={entries()} gap={8} onSettledRange={settled} onScrollStateChange={value => { setScrolling(value); if (value) setOpenSwipeId(null); }} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />
    <BiliSideMenu ref={handle => { sideMenu = handle; }} width={props.width ?? 233} height={props.height} active={() => props.active !== false && !openSwipeId()} items={() => {
      const loggedIn = authenticated(session.value()), go = (route: BiliRoute) => () => props.onNavigate(route);
      return [{ label: "频道信息", enabled: true, onPress: go({ name: "channel-info" }) },
        ...(!loggedIn ? [{ label: "登录", enabled: true, onPress: go({ name: "login" }) }] : []),
        { label: "搜索", enabled: loggedIn, onPress: go({ name: "search" }) },
        { label: "稍后再看", enabled: loggedIn, onPress: go({ name: "watch-later" }) },
        { label: "历史记录", enabled: loggedIn, onPress: go({ name: "history" }) },
        { label: "收藏夹", enabled: loggedIn, onPress: go({ name: "favorites" }) }];
    }} />
    <Show when={toast()}><View class="absolute left-[16] right-[16] bottom-[12] items-center"><View class="rounded-[10] bg-[#1c1f21] px-[10] py-[6]"><Text class="text-xs leading-[14] text-center text-[#f5f5f5]">{toast()}</Text></View></View></Show>
  </>;
}

/** Native ActionButton (watch_action_button 160x48dp, pill #2A2A2A, 17/23sp, disabled 60% text). */
function pillEntry(label: string, width: number, onPress?: () => void, gapBelow = 4, prominent = false): ScrollEntry {
  const pill = Math.min(160, width - 36 - 18);
  return { height: 48 + gapBelow, render: () => <View onPress={onPress} focusable={!!onPress} accessibilityRole="button" accessibilityLabel={label} class={prominent ? "absolute top-[0] h-[48] rounded-[24] bg-[#fb7299] items-center justify-center active:scale-96" : "absolute top-[0] h-[48] rounded-[24] bg-[#2a2a2a] items-center justify-center active:scale-96"} style={{ insetL: (width - 36 - pill) / 2, width: pill }}>
    <Text class={prominent ? "text-[17px] leading-[23] font-bold text-white" : onPress ? "text-[17px] leading-[23] text-[#f5f5f5]" : "text-[17px] leading-[23] text-[#f5f5f599]"}>{label}</Text>
  </View> };
}

/** Native BiliChannelInfoScreen: centred 17sp title, three 12/14sp info lines, then action pills. */
function ChannelInfoScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession());
  const entries = createMemo<ScrollEntry[]>(() => {
    const loggedIn = authenticated(session.value()), width = props.width ?? 233;
    const info = (text: string, color: string, gapBelow: number): ScrollEntry => ({ height: 14 + gapBelow, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-xs leading-[14] text-center" style={{ textColor: color }}>{text}</Text> });
    const go = (route: BiliRoute) => loggedIn ? () => props.onNavigate(route) : undefined;
    return [
      ((title: string[]) => ({ height: title.length * 20 + 6, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-[17px] leading-[20] text-[#f5f5f5] text-center">{title.join("\n")}</Text> }))(lines("腕上RSS · 哔哩哔哩频道", width - 36, 17)),
      info(loggedIn ? "进入以获取推荐内容" : "未登录，登录后获取推荐内容", "#b6b6b6", 4),
      info("https://www.bilibili.com", "#f5f5f5", 4),
      info(loggedIn ? "更新：实时" : "更新: --", "#b6b6b6", 4),
      platformCardEntry(width - 36, platformScope),
      { height: 8, render: () => null },
      pillEntry("设置", width, () => props.onNavigate({ name: "settings" })),
      ...(!loggedIn ? [pillEntry("登录", width, () => props.onNavigate({ name: "login" }), 4, true)] : []),
      pillEntry("搜索", width, go({ name: "search" })),
      pillEntry("稍后再看", width, go({ name: "watch-later" })),
      pillEntry("历史记录", width, go({ name: "history" })),
      pillEntry("收藏夹", width, go({ name: "favorites" }), 0),
    ];
  });
  return <ScrollEntries height={props.height} entries={entries()} gap={0} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />;
}

/** Native buildFeedSummary: "owner · 播放 N" or "哔哩哔哩推荐". */
function feedSummary(item: BiliItem): string {
  const parts = [item.owner?.name, item.stat?.view != null ? `播放 ${formatCount(item.stat.view)}` : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "哔哩哔哩推荐";
}

function listVideoCard(item: BiliItem, summaryText: string | undefined, width: number) {
  const cardWidth = width - 36, padding = 8, textWidth = cardWidth - padding * 2;
  const title = measuredLines(item.title || "哔哩哔哩视频", textWidth, measureFor(14), 2);
  const summary = measuredLines(summaryText ?? feedSummary(item), textWidth, measureFor(9), 2);
  const textHeight = title.length * 18 + 2 + summary.length * 9.9;
  const height = Math.max(100, textHeight + padding * 2), top = height - padding - textHeight;
  const content = () => <>
    {item.cover ? <RemoteImage cacheBucket="bili-preview" url={item.cover} width={cardWidth} height={100} fit="cover" class="absolute left-[0] top-[0]" /> : null}
    <View class="absolute left-[0] right-[0] top-[0] h-[100] bg-gradient-to-b from-transparent to-[#0b1211b3]" />
    {title.map((line, index) => <Text class="absolute text-sm leading-[18] text-[#f5f5f5]" style={{ insetL: padding, insetR: padding, insetT: top + index * 18 }}>{line}</Text>)}
    <Text class="absolute text-[9px] leading-[9.9] text-[#b6b6b6cc]" style={{ insetL: padding, insetR: padding, insetT: top + 2 + title.length * 18 }}>{summary.join("\n")}</Text>
  </>;
  // The cover may lose its corners to the round mask; the text must stay fully readable.
  const bounds = { x: padding, y: top, width: textWidth, height: textHeight };
  return { height, content, bounds };
}
/** Native BiliFeedCard: 100dp cover, background gradient, 8dp padding, 14sp title + 9sp summary at the bottom. */
function listVideoEntry(item: BiliItem, summaryText: string | undefined, width: number, onPress: () => void): ScrollEntry {
  const card = listVideoCard(item, summaryText, width);
  return { height: card.height, bounds: card.bounds, render: () => <View onPress={onPress} focusable accessibilityRole="button" accessibilityLabel={`视频：${item.title ?? ""}`} class="absolute inset-0 rounded-[16] bg-[#1c1f21] overflow-hidden">{card.content()}</View> };
}

/** Native buildListSummary: "UP 主 · mm:ss", or 哔哩哔哩. */
function listSummary(owner?: string, seconds?: number) { const parts = [owner?.trim() || undefined, seconds && seconds > 0 ? durationText(seconds) : undefined].filter(Boolean); return parts.length ? parts.join(" · ") : "哔哩哔哩"; }
function durationText(seconds: number) { const minutes = Math.floor(seconds / 60), remain = Math.floor(seconds % 60); return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`; }

/** Native EmptyStateCard: 14dp radius surface, 12/10dp padding, titleMedium 21/26 + bodySmall 12/14. */
function emptyStateEntry(title: string, subtitle: string, width: number): ScrollEntry {
  const lines = measuredLines(subtitle, width - 36 - 24, measureFor(12));
  return { height: 10 + 26 + 4 + lines.length * 14 + 10, render: () => <View class="absolute inset-0 rounded-[14] bg-[#1c1f21]">
    <Text class="absolute left-[12] right-[12] top-[10] text-[21px] leading-[26] text-[#f5f5f5]">{title}</Text>
    <Text class="absolute left-[12] right-[12] top-[40] text-xs leading-[14] text-[#b6b6b6]">{lines.join("\n")}</Text>
  </View> };
}

/** Native BiliListScreen: 21sp title + 9sp 下拉刷新 header, BiliFeedCard items 8dp apart, auto load-more near the end. */
function BiliListPage(props: BiliScreenProps & { title: string; items: ScrollEntry[]; loading: boolean; error?: unknown; canLoadMore?: boolean; onRefresh: () => void; onMore?: () => void }) {
  const width = () => props.width ?? 233;
  const entries = createMemo<ScrollEntry[]>(() => [
    { height: 48, render: () => <View class="absolute inset-0">
      <Text class="absolute left-[0] right-[0] top-[0] text-[21px] leading-[25] text-center text-[#f5f5f5]">{props.title}</Text>
      <Text class="absolute left-[0] right-[0] top-[31] text-[9px] leading-[17] text-center text-[#b6b6b6]">下拉刷新</Text>
    </View> },
    ...(!props.items.length && !props.loading ? [props.error ? emptyStateEntry("加载失败", String(props.error instanceof Error ? props.error.message : props.error), width()) : emptyStateEntry("暂无内容", "稍后再试", width())] : []),
    ...props.items,
    ...(props.loading && props.items.length ? [{ height: 21, render: () => <Text class="absolute left-[0] top-[0] text-[17px] leading-[21] text-[#b6b6b6]">加载中...</Text> }] : []),
    { height: 40, render: () => null },
  ]);
  const settled = (_first: number, last: number) => { if (last >= entries().length - 4 && props.canLoadMore && !props.loading && props.items.length) props.onMore?.(); };
  return <ScrollEntries onRefresh={props.onRefresh} height={props.height} entries={entries()} gap={8} onSettledRange={settled} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />;
}

function HistoryScreen(props: BiliScreenProps) {
  const page = pagedData<BiliHistoryItem>(() => props.client, changed => historyPager(props.client, changed));
  const items = createMemo(() => page.state().items.map(item => historyEntry(item, props.width ?? 233, props)));
  return <BiliListPage {...props} title="历史记录" items={items()} loading={page.state().loading} error={page.state().error} canLoadMore={page.state().canLoadMore} onRefresh={page.refetch} onMore={page.more} />;
}
function historyEntry(item: BiliHistoryItem, width: number, props: BiliScreenProps) { const video: BiliItem = { aid: item.history?.oid, bvid: item.history?.bvid, cid: item.history?.cid, title: item.title, cover: item.cover, duration: item.duration, owner: { name: item.authorName } }; return listVideoEntry(video, listSummary(item.authorName, item.duration), width, () => props.onNavigate({ name: "detail", aid: video.aid, bvid: video.bvid, cid: video.cid })); }

function WatchLaterScreen(props: BiliScreenProps) {
  const page = asyncData(() => props.client.toView());
  const items = createMemo(() => (page.value()?.items ?? []).map(item => listVideoEntry(item, listSummary(item.owner?.name, item.duration), props.width ?? 233, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid }))));
  return <BiliListPage {...props} title="稍后再看" items={items()} loading={page.loading()} error={page.error()} onRefresh={page.refetch} />;
}

/** Native FAVORITE list opens the first favorite folder directly. */
function FavoritesScreen(props: BiliScreenProps) {
  const folders = asyncData(() => props.client.favoriteFolders());
  const mediaId = createMemo(() => { const first = folders.value()?.[0]; return first ? first.id ?? first.fid : undefined; });
  return <Show when={mediaId()} keyed fallback={<BiliListPage {...props} title="收藏夹" items={[]} loading={folders.loading()} error={folders.error()} onRefresh={folders.refetch} />}>
    {id => <FavoriteFolderScreen {...props} route={{ name: "favorite-folder", mediaId: id, title: "收藏夹" }} />}
  </Show>;
}

function FavoriteFolderScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "favorite-folder" }> }) {
  const page = pagedData<BiliItem>(() => props.route.mediaId, changed => favoritePager(props.client, props.route.mediaId, changed));
  const items = createMemo(() => page.state().items.map(item => listVideoEntry(item, listSummary(item.owner?.name, item.duration), props.width ?? 233, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid, cid: item.cid }))));
  return <BiliListPage {...props} title={props.route.title || "收藏夹"} items={items()} loading={page.state().loading} error={page.state().error} canLoadMore={page.state().canLoadMore} onRefresh={page.refetch} onMore={page.more} />;
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

/** Native SearchInputBar: 56dp outlined field (30dp radius, 1dp #2C3135), 17sp text, trailing search icon. */
function searchBarEntry(keyword: string, width: number, onPress: () => void): ScrollEntry {
  const text = keyword ? measuredLines(keyword, width - 36 - 56, measureFor(17), 1).join("") : "搜索";
  return { height: 56, render: () => <View onPress={onPress} focusable accessibilityRole="button" accessibilityLabel={keyword ? `搜索关键词：${keyword}` : "输入关键词开始搜索"} class="absolute inset-0 rounded-[30] active:scale-96" style={{ borderWidth: 1, borderColor: "#2c3135" }}>
    <Text class={keyword ? "absolute left-[16] right-[40] top-[17.5] text-[17px] leading-[21] text-[#f5f5f5]" : "absolute left-[16] right-[40] top-[17.5] text-[17px] leading-[21] text-[#b6b6b6b3]"}>{text}</Text>
    <Image src="../assets/icons/search.svg" class="absolute right-[14] top-[16] w-[24] h-[24]" />
  </View> };
}
const searchTitleEntry: ScrollEntry = { height: 20, render: () => <Text accessibilityRole="header" class="absolute left-[0] right-[0] top-[1] text-[17px] leading-[20] text-center text-[#f5f5f5]">搜索</Text> };
/** Material3 SuggestionChip rows (32dp, 8dp radius, 1dp outline, 14sp label, 8dp gaps), laid out like FlowRow. */
function chipFlowEntry(labels: { label: string; onPress: () => void }[], width: number): ScrollEntry {
  const max = width - 36, measure = measureFor(14);
  const placed: { label: string; onPress: () => void; left: number; top: number; w: number }[] = [];
  let left = 0, top = 0;
  for (const chip of labels) {
    const text = measuredLines(chip.label, max - 16, measure, 1).join(""), w = Math.min(max, measure(text) + 16);
    if (left > 0 && left + w > max) { left = 0; top += 40; }
    placed.push({ ...chip, label: text, left, top, w }); left += w + 8;
  }
  return { height: placed.length ? top + 32 : 0, render: () => <View class="absolute inset-0">
    {placed.map(chip => <View onPress={chip.onPress} focusable accessibilityRole="button" accessibilityLabel={chip.label} class="absolute h-[32] rounded-[8] items-center justify-center active:scale-96" style={{ insetL: chip.left, insetT: chip.top, width: chip.w, borderWidth: 1, borderColor: "#2c3135" }}><Text class="text-sm leading-[20] text-[#f5f5f5]">{chip.label}</Text></View>)}
  </View> };
}

/** Native BiliSearchScreen: 搜索 title, SearchInputBar, 搜索历史 chips (+清空), 热门搜索 chips; 6dp spacing. */
function SearchScreen(props: BiliScreenProps) {
  const hot = asyncData(() => props.client.hotSearch()), history = new BiliSearchHistory(kv);
  const [historyItems, setHistoryItems] = createSignal(history.read());
  const [draft,setDraft]=restoredSignal('retained','bili-search-query','',stringState);
  function submit(query: string) { try { const target = history.submit(query); setHistoryItems(history.read()); if (target) props.onNavigate(target); } catch (error) { fail(props, error); } }
  const search=useModalInput({key:'bili-search',title:'搜索哔哩哔哩',value:draft,input:props.input,recovery:props.inputRecovery,active:()=>props.active!==false,onValue:query=>{setDraft(query);submit(query);},onError:error=>fail(props,error)});
  const entries = createMemo<ScrollEntry[]>(() => {
    const width = props.width ?? 233, hotWords = hot.value() ?? [];
    return [searchTitleEntry, searchBarEntry(draft(), width, () => void search()),
      ...(historyItems().length ? [{ height: 40, render: () => <View class="absolute inset-0">
        <Text class="absolute left-[0] top-[10] text-sm leading-[20] text-white">搜索历史</Text>
        <View onPress={() => { try { history.clear(); setHistoryItems([]); } catch (error) { fail(props, error); } }} focusable accessibilityRole="button" accessibilityLabel="清空搜索历史" class="absolute right-[0] top-[0] h-[40] w-[56] items-center justify-center active:scale-96"><Text class="text-sm leading-[20] text-[#ff6026]">清空</Text></View>
      </View> } as ScrollEntry, chipFlowEntry(historyItems().map(query => ({ label: query, onPress: () => submit(query) })), width)] : []),
      ...(hotWords.length ? [{ height: 34, render: () => <Text class="absolute left-[0] top-[0] text-[21px] leading-[26] text-[#f5f5f5]">热门搜索</Text> } as ScrollEntry, chipFlowEntry(hotWords.slice(0, 20).map(word => ({ label: word.showName || word.keyword, onPress: () => submit(word.keyword) })), width)] : []),
      { height: 26, render: () => null }];
  });
  return <ScrollEntries height={props.height} entries={entries()} gap={6} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />;
}

function searchSummary(item: Extract<BiliSearchResult, { kind: "video" }>) {
  const author = (item.author ?? "").replace(/<[^>]+>/g, "").trim();
  const parts = [author || undefined, item.play != null ? `播放 ${formatCount(item.play)}` : undefined, item.danmaku != null ? `弹幕 ${formatCount(item.danmaku)}` : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "哔哩哔哩视频";
}

/** Native BiliSearchResultScreen: same header/bar, BiliFeedCard results, 32dp spinner while loading, auto load-more. */
function ResultsScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "results" }> }) {
  const results = pagedData<Extract<BiliSearchResult, { kind: "video" }>>(() => props.route.query, changed => searchPager(props.client, props.route.query, changed));
  async function revise() { const query = await props.input?.("搜索哔哩哔哩", props.route.query); if (query != null) { try { const target = new BiliSearchHistory(kv).submit(query); if (target) props.onNavigate(target); } catch (error) { fail(props, error); } } }
  const spinner: ScrollEntry = { height: 64, render: () => <View class="absolute inset-0 items-center justify-center"><WatchProgressIndicator size={32} active={() => props.active ?? true} accessibilityLabel="加载中" /></View> };
  const hint = (text: string): ScrollEntry => ({ height: 14, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-xs leading-[14] text-center text-[#b6b6b6]">{text}</Text> });
  const entries = createMemo<ScrollEntry[]>(() => {
    const width = props.width ?? 233, state = results.state(), items = state.items;
    const error = state.error ? (state.error instanceof Error ? state.error.message : String(state.error)) : "";
    const failure: ScrollEntry = { height: 52, render: () => <View class="absolute inset-0 items-center justify-center"><Text class="text-sm leading-[17] text-center text-[#ffb4ab]">{`加载失败: ${error}`}</Text></View> };
    return [searchTitleEntry, searchBarEntry(props.route.query, width, () => void revise()),
      ...(!props.route.query.trim() ? [hint("输入关键词开始搜索")]
        : !items.length ? (state.loading ? [spinner] : error ? [failure] : [hint("没有找到相关结果")])
        : [...items.map(item => listVideoEntry({ aid: item.aid, bvid: item.bvid, title: (item.title || "").replace(/<[^>]+>/g, ""), cover: item.pic }, searchSummary(item), width, () => props.onNavigate({ name: "detail", aid: item.aid, bvid: item.bvid }))),
           ...(state.loading ? [spinner] : error ? [failure] : [])]),
      { height: 26, render: () => null }];
  });
  const settled = (_first: number, last: number) => { const state = results.state(); if (last >= entries().length - 4 && state.canLoadMore && !state.loading && !state.error && state.items.length) results.more(); };
  return <ScrollEntries onRefresh={results.refetch} height={props.height} entries={entries()} gap={6} onSettledRange={settled} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />;
}

// Native BiliDetailScreen.kt (original-content mode): reader background, 18dp side padding,
// 6dp item spacing, 3:2 cover, meta card, four 44dp action circles, 分P, 简介.
/** Native WatchDark/WatchLight colorScheme, chosen by the reader preset's background luminance. */
interface DetailPalette { dark: boolean; background: string; surface: string; surfaceVariant: string; onSurface: string; onSurfaceVariant: string; overlay: string; scrim: string }
function detailPalette(dark: boolean): DetailPalette {
  return dark
    ? { dark, background: "#0b1211", surface: "#1c1f21", surfaceVariant: "#23272a", onSurface: "#f5f5f5", onSurfaceVariant: "#b6b6b6", overlay: "#0b1211b3", scrim: "#0b121199" }
    : { dark, background: "#f7f4f0", surface: "#ffffff", surfaceVariant: "#ede6de", onSurface: "#1c1b1f", onSurfaceVariant: "#4a4a4a", overlay: "#f7f4f0b3", scrim: "#f7f4f099" };
}
// Native passes showCommentEntry = false; the 评论 section is kept but hidden like native.
const SHOW_COMMENT_ENTRY = false;

function sectionTitle(pal: DetailPalette, title: string, trailing?: string): ScrollEntry {
  return { height: 20, render: () => <View class="absolute inset-0">
    <Text class="absolute left-[0] top-[0.75] text-[17px] leading-[20]" style={{ textColor: pal.onSurfaceVariant }}>{title}</Text>
    {trailing ? <Text class="absolute right-[0] top-[2] text-[9px] leading-[17]" style={{ textColor: pal.onSurfaceVariant }}>{trailing}</Text> : null}
  </View> };
}

function surfaceCard(pal: DetailPalette, text: string, width: number, color = pal.onSurfaceVariant, onPress?: () => void): ScrollEntry {
  const wrapped = measuredLines(text, width - 12, measureFor(17));
  return { height: 12 + wrapped.length * 21, render: () => <View onPress={onPress} focusable={!!onPress} accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={text} class="absolute inset-0 rounded-[16]" style={{ bgColor: pal.surface }}>
    <Text class="absolute left-[6] right-[6] top-[6] text-[17px] leading-[21] text-center" style={{ textColor: color }}>{wrapped.join("\n")}</Text>
  </View> };
}

function detailDuration(seconds?: number) { if (!seconds || seconds <= 0) return undefined; return durationText(seconds); }

function DetailScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "detail" }> }) {
  const [selectedCid,saveSelectedCid]=restoredSignal<number>('retained','bili-selected-cid',num(props.route.cid),(v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0);
  const [state, setState] = createSignal<DetailState>({ selected: 0, interaction: {}, loading: true, busy: false, offline: false });
  let controller: BiliDetailController;
  createEffect(() => {
    const target = { aid: num(props.route.aid) || undefined, bvid: props.route.bvid, cid: untrack(selectedCid) || undefined };
    controller = new BiliDetailController(props.client, kv, target, props.loadLocalDetail ?? (async () => undefined), setState);
    const own = controller; setState(own.state); void own.load(); onCleanup(() => own.dispose());
  });
  const [busy, setBusy] = createSignal("");
  const [expanded, setExpanded] = restoredSignal('saved','bili-description-expanded',false,booleanState);
  let disposed = false; onCleanup(() => { disposed = true; });
  async function play() {
    if (busy()) return;
    const data = state().detail, actual = controller.selectedCid(), own = controller;
    if (!actual) return fail(props, new Error("视频没有可播放的分 P"));
    try { setBusy("正在解析播放地址…");
      // Reuse a warm C07 source if one exists; otherwise the playback controller resolves remotely
      // and falls back to the cached offline preview (M3). Never start a fresh resolve here.
      const source = await own.warmPlayback()?.catch(() => undefined);
      if (!disposed && controller === own && own.selectedCid() === actual) props.onNavigate({ name: "player", cid: actual, aid: data?.item.aid, bvid: data?.item.bvid, source, title: data?.item.title, cover: data?.item.cover, author: data?.item.owner?.name, description: data?.desc });
    } catch (error) { if (!disposed) fail(props, error); } finally { if (!disposed) setBusy(""); }
  }
  function share() {
    const it = state().detail?.item, title = biliActionTitle(it?.title, it?.bvid, it?.aid);
    const qr = () => props.onNavigate({ name: "share", aid: it?.aid, bvid: it?.bvid, title });
    if (props.onShare) props.onShare({ origin: "bili-detail", title, link: biliShareLink(it?.bvid, it?.aid) }, qr); else qr();
  }
  const preset = () => props.preset ?? defaultReaderPreset();
  const backgrounds = useReaderBackgrounds();
  const entries = createMemo<ScrollEntry[]>(() => {
    // Cards follow the preset's light/dark scheme; the reader TITLE/BODY colours then sit on a
    // matching surface (native kept a dark card even on light presets: dark-on-dark text).
    const pal = detailPalette(readerChrome(preset()).dark);
    const width = props.width ?? 233, cardWidth = width - 36, inner = cardWidth - 12;
    const data = state().detail, it = data?.item, st = state();
    const titleFont = presetContentFont(preset(), "title"), bodyFont = presetContentFont(preset(), "body");
    const measureScaled = (font: typeof titleFont) => (text: string) => getOps().measureText(text, font.fontSlot) * font.scale;
    const fontText = (font: typeof titleFont, text: string, top: number, w: number) => <Text class={readerTextClass(font.fontSlot)} style={{ insetT: top, width: w / font.scale, fontSlot: font.fontSlot, scale: font.scale, originX: -.5, originY: -.5, lineHeight: font.lineHeight / font.scale, textColor: font.color, tracking: (font.tracking ?? 0) / font.scale, textAlign: 0 }}>{text}</Text>;
    const cover: ScrollEntry = { height: cardWidth * 2 / 3, render: () => <View onPress={() => void play()} focusable accessibilityRole="button" accessibilityLabel="播放" class="absolute inset-0 rounded-[16] overflow-hidden" style={{ bgColor: pal.surface }}>
      {it?.cover ? <RemoteImage cacheBucket="bili-preview" url={it.cover} width={cardWidth} height={cardWidth * 2 / 3} fit="cover" class="absolute left-[0] top-[0]" /> : null}
      <View class={pal.dark ? "absolute inset-0 bg-gradient-to-b from-transparent to-[#0b1211b3]" : "absolute inset-0 bg-gradient-to-b from-transparent to-[#f7f4f0b3]"} />
      <View class="absolute w-[36] h-[36] rounded-full items-center justify-center" style={{ bgColor: pal.scrim, insetL: (cardWidth - 36) / 2, insetT: (cardWidth * 2 / 3 - 36) / 2 }}><Image src={pal.dark ? "../assets/icons/bili-action-play-circle.svg" : "../assets/icons/bili-action-play-circle-dark.svg"} style={{ width: 32, height: 32 }} /></View>
    </View> };
    const title = measuredLines(it?.title?.trim() || "加载中...", inner, measureScaled(titleFont), 3);
    const owner = it?.owner?.name?.trim();
    const chips = [it?.stat?.view != null ? `播放 ${formatCount(it.stat.view)}` : "", it?.stat?.like != null ? `点赞 ${formatCount(it.stat.like)}` : "", it?.stat?.danmaku != null ? `弹幕 ${formatCount(it.stat.danmaku)}` : ""].filter(Boolean);
    const titleHeight = title.length * titleFont.lineHeight;
    const ownerTop = 6 + titleHeight + 6, chipsTop = ownerTop + (owner ? 17 + 6 : 0);
    const metaHeight = chipsTop + (chips.length ? 21 + 6 : 0);
    let chipLeft = 6;
    const chipBoxes = chips.map(text => { const w = getOps().measureText(text, FONT_SLOT[9]) + 8, left = chipLeft; chipLeft += w + 4; return { text, left, w }; });
    const meta: ScrollEntry = { height: metaHeight, render: () => <View accessibilityLabel={[it?.title, owner && `UP 主：${owner}`, ...chips].filter(Boolean).join("，")} class="absolute inset-0 rounded-[16] overflow-hidden" style={{ bgColor: pal.surface }}>
      {title.map((line, index) => <View class="absolute" style={{ insetL: 6, insetT: 6 + index * titleFont.lineHeight, width: inner, height: titleFont.lineHeight }}>{fontText(titleFont, line, 1, inner)}</View>)}
      {owner ? <Text class="absolute left-[6] text-[9px] leading-[17]" style={{ insetT: ownerTop + 1, textColor: pal.onSurfaceVariant }}>{`UP 主：${owner}`}</Text> : null}
      {chipBoxes.filter(chip => chip.left + chip.w <= cardWidth - 6).map(chip => <View class="absolute h-[21] rounded-[10.5]" style={{ insetL: chip.left, insetT: chipsTop, width: chip.w, bgColor: pal.surfaceVariant }}><Text class="absolute left-[4] top-[2] text-[9px] leading-[17]" style={{ textColor: pal.onSurfaceVariant }}>{chip.text}</Text></View>)}
    </View> };
    const size = Math.max(36, Math.min(44, (cardWidth - 18) / 4)), rowLeft = (cardWidth - size * 4 - 18) / 2;
    const locked = st.busy || st.loading || !data;
    const actionButtons = [
      { icon: pal.dark ? "../assets/icons/bili-action-bili-thumb-up.svg" : "../assets/icons/bili-action-bili-thumb-up-dark.svg", label: "点赞", selected: !!st.interaction.like, onPress: locked ? undefined : () => void controller.act("like") },
      { icon: pal.dark ? "../assets/icons/bili-action-bili-coin.svg" : "../assets/icons/bili-action-bili-coin-dark.svg", label: "投币", selected: !!st.interaction.coin, onPress: locked || st.interaction.coin ? undefined : () => void controller.act("coin") },
      { icon: pal.dark ? "../assets/icons/bili-action-star.svg" : "../assets/icons/bili-action-star-dark.svg", label: "收藏", selected: !!st.interaction.favorite, onPress: locked ? undefined : () => void controller.act("favorite") },
      { icon: pal.dark ? "../assets/icons/bili-action-share.svg" : "../assets/icons/bili-action-share-dark.svg", label: "转发", selected: false, onPress: share },
    ];
    const iconSize = Math.min(24, Math.max(18, size * .55));
    const actions: ScrollEntry = { height: size, render: () => <View class="absolute inset-0">
      {actionButtons.map((button, index) => <View onPress={button.onPress} focusable={!!button.onPress} accessibilityRole="button" accessibilityLabel={button.label} class="absolute items-center justify-center active:scale-96" style={{ bgColor: button.selected ? "#ff6026" : pal.surfaceVariant, insetL: rowLeft + index * (size + 6), insetT: 0, width: size, height: size, radius: size / 2 }}>
        <Image src={button.icon} style={{ width: iconSize * 32 / 24, height: iconSize * 32 / 24 }} />
      </View>)}
    </View> };
    const pages = data?.pages ?? [];
    const pageEntries = pages.map((page, index): ScrollEntry => {
      const selected = st.selected === index, duration = detailDuration(page.duration);
      const textWidth = inner - (duration ? getOps().measureText(duration, FONT_SLOT[9]) + 6 : 0);
      const label = page.part?.trim() || `第${page.page ?? 1}集`, wrapped = measuredLines(label, textWidth, measureFor(17), 2);
      const height = 14.5 + wrapped.length * 17;
      return { height, render: () => <View onPress={busy() ? undefined : () => {controller.select(index);const cid=controller.selectedCid();if(cid)saveSelectedCid(cid);}} focusable accessibilityRole="button" accessibilityLabel={`${label}${duration ? `，${duration}` : ""}`}
        class={selected ? "absolute inset-0 rounded-[16] border-[#ff6026] border-[1]" : "absolute inset-0 rounded-[16]"} style={{ bgColor: selected ? pal.surfaceVariant : pal.surface }}>
        <Text class="absolute left-[6] top-[7.75] text-[17px] leading-[17]" style={{ width: textWidth, textColor: pal.onSurface }}>{wrapped.join("\n")}</Text>
        {duration ? <Text class="absolute right-[6] text-[9px] leading-[17]" style={{ insetT: (height - 17) / 2 + .5, textColor: pal.onSurfaceVariant }}>{duration}</Text> : null}
      </View> };
    });
    const desc = data?.desc?.trim();
    const description = (): ScrollEntry[] => {
      if (!desc) return [];
      const measure = measureScaled(bodyFont), arrow = 17;
      const all = measuredLines(desc, inner, measure), canExpand = all.length > 3;
      const shown = expanded() || !canExpand ? all : measuredLines(desc, inner - arrow, measure, 3);
      const height = 12 + shown.length * bodyFont.lineHeight;
      return [sectionTitle(pal, "简介"), { height, render: () => <View onPress={canExpand ? () => setExpanded(value => !value) : undefined} focusable={canExpand} accessibilityRole={canExpand ? "button" : undefined} accessibilityLabel={desc} class="absolute inset-0 rounded-[16] overflow-hidden" style={{ bgColor: pal.surface }}>
        {shown.map((line, index) => <View class="absolute" style={{ insetL: 6, insetT: 6 + index * bodyFont.lineHeight, width: inner, height: bodyFont.lineHeight }}>{fontText(bodyFont, line, 0, inner)}</View>)}
        {canExpand && !expanded() ? <Text class="absolute right-[6] text-[17px] leading-[21]" style={{ insetT: height - 6 - 21, textColor: pal.onSurface }}>▼</Text> : null}
      </View> }];
    };
    const message = st.error ? String(st.error) : busy() || st.message || (st.offline ? "本地已保存详情" : "");
    return [
      cover, meta, actions,
      ...(pages.length ? [sectionTitle(pal, "分P", `${pages.length} 个`), ...pageEntries] : []),
      ...description(),
      ...(SHOW_COMMENT_ENTRY && it?.aid ? [sectionTitle(pal, "评论"), surfaceCard(pal, "查看评论", cardWidth, pal.onSurface, () => props.onNavigate({ name: "comments", oid: it.aid!, uploaderMid: it.owner?.mid }))] : []),
      ...(message ? [surfaceCard(pal, message, cardWidth)] : []),
      { height: 50, render: () => <View class="absolute inset-0" /> },
    ];
  });
  return <View class="absolute inset-0 bg-[#000000]">
    <ReaderBackground background={preset().background} snapshot={backgrounds()} width={props.width ?? 233} height={props.height} active={props.active ?? true} />
    <ScrollEntries onRefresh={() => void controller.load()} height={props.height} entries={entries()} gap={6} verticalPadding={0} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: () => false })} />
  </View>;
}

const readerColorOf = (preset: ReaderPreset) => readerColor(preset.background.colorArgb);
/** RSS-mode (原文阅读模式 off) detail: native BiliRssDetailScreen, a reader page on the preset background. */
function RssDetailScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "detail" }> }) {
  const [state, setState] = createSignal<DetailState>({ selected: 0, interaction: {}, loading: true, busy: false, offline: false });
  let controller: BiliDetailController;
  createEffect(() => {
    const target = { aid: num(props.route.aid) || undefined, bvid: props.route.bvid, cid: num(props.route.cid) || undefined };
    controller = new BiliDetailController(props.client, kv, target, props.loadLocalDetail ?? (async () => undefined), setState);
    const own = controller; setState(own.state); void own.load(); onCleanup(() => own.dispose());
  });
  const [busy, setBusy] = createSignal("");
  let disposed = false; onCleanup(() => { disposed = true; });
  async function play() {
    if (busy()) return;
    const data = state().detail, actual = controller.selectedCid(), own = controller;
    if (!actual) return fail(props, new Error("视频没有可播放的分 P"));
    try { setBusy("正在解析播放地址…");
      // Reuse a warm C07 source if one exists; otherwise the playback controller resolves remotely
      // and falls back to the cached offline preview (M3). Never start a fresh resolve here.
      const source = await own.warmPlayback()?.catch(() => undefined);
      if (!disposed && controller === own && own.selectedCid() === actual) props.onNavigate({ name: "player", cid: actual, aid: data?.item.aid, bvid: data?.item.bvid, source, title: data?.item.title, cover: data?.item.cover, author: data?.item.owner?.name, description: data?.desc });
    } catch (error) { if (!disposed) fail(props, error); } finally { if (!disposed) setBusy(""); }
  }
  const preset = () => props.preset ?? defaultReaderPreset();
  const display = createMemo(() => {
    const it = state().detail?.item;
    return { title: it?.title?.trim() || (it?.bvid ? `BV号 ${it.bvid}` : it?.aid ? `av${it.aid}` : "哔哩哔哩视频"), owner: it?.owner?.name?.trim() || "未知作者", desc: state().detail?.desc?.trim() || "暂无简介", cover: it?.cover };
  });
  function share() {
    const it = state().detail?.item, title = biliActionTitle(it?.title, it?.bvid, it?.aid);
    const qr = () => props.onNavigate({ name: "share", aid: it?.aid, bvid: it?.bvid, title });
    if (props.onShare) props.onShare({ origin: "bili-detail", title, link: biliShareLink(it?.bvid, it?.aid) }, qr); else qr();
  }
  const message = () => busy() || state().message || (state().error ? String(state().error) : "");
  const chrome = () => readerChrome(preset());
  return <Show when={state().detail} fallback={<View class="absolute inset-0 items-center justify-center" style={{ bgColor: readerColorOf(preset()) }}>
      <Text class="text-[21px] leading-[26] text-center" style={{ textColor: chrome().content }}>{state().loading ? "加载中..." : message() || "加载中..."}</Text>
    </View>}>
    <MediaReaderDetail width={props.width ?? 233} height={props.height} preset={preset()} active={props.active ?? true}
      articleId={`bili-rss:${props.route.bvid ?? props.route.aid ?? ""}`} title={display().title} message={message()}
      blocks={[{ type: "text", text: `作者：${display().owner}`, style: "subtitle" }, { type: "text", text: `简介：${display().desc}`, style: "body" }, { type: "video", url: "bili-cover", poster: display().cover }]}
      favorite={() => !!state().interaction.favorite} onPlay={() => void play()} onFavorite={() => { if (!state().busy && !state().loading) void controller.act("favorite"); }} onShare={share}
      onError={message => fail(props, new Error(message))} ref={handle => props.ref?.({ scroller: handle.scroller, onRootBack: () => false })} />
  </Show>;
}

/** Native BiliVideoActionsActivity: ActionDialog with 收藏 (default folder) / 稍后再看 / 分享 / 取消;
 * success shows a system toast and closes, failure toasts and stays. */
function ActionsScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "actions" }> }) {
  const aid = typeof props.route.aid === "number" ? props.route.aid : Number(props.route.aid || 0);
  const [busy, setBusy] = createSignal(false);
  const savedItem = (): BiliItem => ({ aid: aid || undefined, bvid: props.route.bvid, cid: typeof props.route.cid === "number" ? props.route.cid : undefined, title: props.route.title, owner: { name: props.route.owner }, cover: props.route.cover });
  const title = () => biliActionTitle(props.route.title, props.route.bvid, props.route.aid);
  const toast = (message: string) => { void hostOperation("ui.toast", { message }).result.catch(() => {}); };
  async function run(action: () => Promise<void>, success: string, failure: string) {
    if (busy()) return; setBusy(true);
    try { await action(); toast(success); props.onBack(); }
    catch (error) { toast(error instanceof Error && error.message ? error.message : `${title()} ${failure}`); }
    finally { setBusy(false); }
  }
  const favorite = () => run(async () => {
    const folders = await props.client.favoriteFolders({ rid: aid, type: 2 });
    const id = folders[0]?.id ?? folders[0]?.fid; if (!id) throw new Error("没有可用的收藏夹");
    await props.client.favorite({ aid, bvid: props.route.bvid, addMediaIds: [id], savedItem: savedItem() });
  }, "已收藏", "收藏失败");
  const watchLater = () => run(() => props.client.addToView({ aid: aid || undefined, bvid: props.route.bvid, savedItem: savedItem() }).then(() => {}), "已加入稍后再看", "加入稍后再看失败");
  const share = () => { const qr = () => props.onNavigate({ name: "share", aid: props.route.aid, bvid: props.route.bvid, title: title() }); if (props.onShare) props.onShare({ origin: "detail", title: title(), link: biliShareLink(props.route.bvid, props.route.aid) }, qr); else qr(); };
  const width = props.width ?? 233;
  const entries = createMemo<ScrollEntry[]>(() => [
    spacerEntry(4),
    pillEntry("收藏", width, aid && !busy() ? () => void favorite() : undefined, 8),
    pillEntry("稍后再看", width, (aid || props.route.bvid) && !busy() ? () => void watchLater() : undefined, 8),
    pillEntry("分享", width, biliShareLink(props.route.bvid, props.route.aid) && !busy() ? share : undefined, 8),
    pillEntry("取消", width, busy() ? undefined : props.onBack, 8),
  ]);
  return <Scrolled {...props} entries={entries()} />;
}

function ShareScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "share" }> }) {
  const url = biliShareLink(props.route.bvid,props.route.aid)??"";
  return <SharedShareQrScreen width={props.width ?? 233} height={props.height} title={props.route.title || "扫码分享"} url={url} onClose={props.onBack} onError={message => fail(props, new Error(message))} />;
}


/** Native BiliSettingsScreen geometry (OWW242): title 21/26, status 12/14, 7.5dp section gap, 8dp entry gaps. */
function SettingsScreen(props: BiliScreenProps) {
  const session = asyncData(() => props.client.getSession()), [original, setOriginal] = createSignal(props.settings?.originalContentEnabled ?? true), [background, setBackground] = createSignal(props.settings?.continuePlaybackInBackgroundEnabled ?? false);
  createEffect(() => { const value = props.settings?.originalContentEnabled; if (typeof value === "boolean" && value !== original()) setOriginal(value); });
  createEffect(() => { const value = props.settings?.continuePlaybackInBackgroundEnabled; if (typeof value === "boolean" && value !== background()) setBackground(value); });
  function toggleOriginal() { const value = !original(); props.settings?.onOriginalContentChange?.(value); }
  function toggleBackground() { if (!props.settings?.onContinuePlaybackInBackgroundChange) return; const value = !background(); setBackground(value); props.settings.onContinuePlaybackInBackgroundChange(value); }
  return <PlatformSettingsScreen width={props.width ?? 233} height={props.height} loggedIn={() => session.loading() ? undefined : authenticated(session.value())}
    showOriginalContent={props.settings?.showOriginalContent} originalContentEnabled={original()} onToggleOriginal={toggleOriginal}
    showContinuePlaybackInBackground={props.settings?.showContinuePlaybackInBackground} continuePlaybackInBackgroundEnabled={background()} onToggleContinuePlaybackInBackground={props.settings?.onContinuePlaybackInBackgroundChange ? toggleBackground : undefined}
    deleteEnabled={props.settings?.deleteEnabled} onDelete={props.settings?.onDeleteChannel} onLogout={async () => { await props.client.logout(); props.onNavigate({ name: "feed" }); }}
    onError={error => fail(props, error)} ref={props.ref} />;
}
function PlayerScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: "player" }> }) { const entries = [titleEntry("播放", props.route.title), messageEntry("播放器路由应由宿主接管，当前页面未取得原生播放边界。", props.width ?? 233), buttonEntry("返回", props.onBack)]; return <Scrolled {...props} entries={entries} />; }

export function BiliScreen(props: BiliScreenProps) {
  const route = () => props.route;
  return <Show when={route().name !== "entry" && route().name !== "feed"} fallback={<FeedScreen {...props} />}>
    <Show when={route().name !== "channel-info"} fallback={<ChannelInfoScreen {...props} />}><Show when={route().name !== "history"} fallback={<HistoryScreen {...props} />}><Show when={route().name !== "watch-later"} fallback={<WatchLaterScreen {...props} />}><Show when={route().name !== "favorites"} fallback={<FavoritesScreen {...props} />}><Show when={route().name !== "favorite-folder"} fallback={<FavoriteFolderScreen {...props} route={route() as Extract<BiliRoute, { name: "favorite-folder" }>} />}><Show when={route().name !== "login"} fallback={<LoginScreen {...props} />}><Show when={route().name !== "search"} fallback={<SearchScreen {...props} />}>
      <Show when={route().name !== "results"} fallback={<ResultsScreen {...props} route={route() as Extract<BiliRoute, { name: "results" }>} />}>
        <Show when={route().name !== "detail"} fallback={(props.settings?.originalContentEnabled ?? true) ? <DetailScreen {...props} route={route() as Extract<BiliRoute, { name: "detail" }>} /> : <RssDetailScreen {...props} route={route() as Extract<BiliRoute, { name: "detail" }>} />}>
          <Show when={route().name !== "comments" && route().name !== "replies"} fallback={<CommentScreen {...props} route={route() as Extract<BiliRoute, { name: "comments" | "replies" }>} />}>
            <Show when={route().name !== "actions"} fallback={<ActionsScreen {...props} route={route() as Extract<BiliRoute, { name: "actions" }>} />}><Show when={route().name !== "share"} fallback={<ShareScreen {...props} route={route() as Extract<BiliRoute, { name: "share" }>} />}><Show when={route().name !== "settings"} fallback={<SettingsScreen {...props} />}><PlayerScreen {...props} route={route() as Extract<BiliRoute, { name: "player" }>} /></Show></Show></Show>
          </Show>
        </Show>
      </Show>
    </Show></Show></Show></Show></Show></Show></Show>
  </Show>;
}

export default BiliScreen;
