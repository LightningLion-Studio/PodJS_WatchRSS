import {usageTelemetry} from '../../telemetry/host.ts';
import {DouyinQrLoadTelemetry} from '../../telemetry/qr-load.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import { DouyinFavoriteController } from '../../douyin/favorite.ts';
import { DouyinRssFeedController, type DouyinRssFeedSnapshot } from '../../douyin/rss-feed.ts';
import { DouyinActionsController, type DouyinActionDone } from '../../douyin/actions.ts';
import { douyinVideoTarget } from "../../reader/media.ts";
import {appLogger} from '../../logs/app-logger.ts';
import {DouyinLoginLog} from '../../logs/douyin-login.ts';
import { ReaderBody } from "../ReaderBody.tsx";
import { defaultReaderPreset, type ReaderPreset } from "../../reader/preset.ts";
import { loadDouyinDetail, douyinDetailBlocks } from "../../douyin/detail.ts";
import { browser, DOUYIN_AUTH_STATUS_SCRIPT, hostOperation } from "@podjs/framework/services";
import { DOUYIN_USER_AGENT } from "../../douyin/request-config.ts";
import { douyinBrowserAvailable } from "../../douyin/browser.ts";
import { hasCapability } from "@podjs/framework/watch";
import { authorizeInBrowser } from "../../media/browser-auth.ts";
import { DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT } from "../../media/douyin-login.ts";
import { observeHostInternet } from "../../onboarding/network-host.ts";
import type { InternetStatus } from "../../onboarding/state.ts";
import { loginGate, loginError, douyinLoginFailureCode, initialLoginStatus, updateLoginStatus, loginStatusMessage, DOUYIN_QR_WAIT, finishLoginStatus } from "./login-state.ts";
import { ImmersiveEntry } from "./ImmersiveEntry.tsx";
import { platformCardEntry } from "../PlatformNotice.tsx";
import { platformScope } from "../../announcement/platform.ts";
import { cardSlices, chunkLines } from "../round-rows.tsx";
import {douyinShareLink,type ShareHandler} from "../../sharing/policy.ts";
import { MediaReaderDetail } from "../MediaReaderDetail.tsx";
import { readerChrome } from "../../reader/chrome.ts";
import { readerColor } from "../../reader/content-layout.ts";
import {wireFields} from "../../sync/article-batches.ts";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { createEffect, createMemo, createSignal, onMount, onCleanup, Show, untrack } from "solid-js";
import { layoutText } from "../../reader/index.ts";
import { ScrollEntries, type ScrollEntry } from "../ScrollEntries.tsx";
import { RssFeedScreen, feedEmptyStateEntry, feedPillEntry } from "../RssScreens.tsx";
import { PlatformSettingsScreen } from "../PlatformSettingsScreen.tsx";
import type { Article } from "../service.ts";
import { SafeQrScreen } from "../SafeQrScreen.tsx";
import { ShareQrScreen as SharedShareQrScreen } from "../ShareQrScreen.tsx";
import type { DouyinClient, DouyinContent, DouyinHistoryEntry, DouyinItem, DouyinResult } from "../../douyin/index.ts";

export type DouyinRoute =
  | { name: "entry"; debugAutoEnterFlow?:boolean; resumeAwemeId?:string }
  | { name: "channel-info" }
  | { name: "login" }
  | { name: "feed" }
  | { name: "detail"; awemeId: string; item?: DouyinItem; playlist?: DouyinItem[] }
  | { name: "history" }
  | { name: "actions"; awemeId: string; item?: DouyinItem }
  | { name: "share"; awemeId: string; item?: DouyinItem }
  | { name: "settings" }
  | { name: "player"; awemeId: string };

export interface DouyinPlayRequest { detailPlayback?:boolean; immersive?:boolean; item: DouyinItem; playback: DouyinItem; playlist?: DouyinItem[]; cursor?: string; hasMore?: boolean }
export type DouyinPlaybackCommand = "toggle" | "previous" | "next" | "replay";
export interface DouyinSettingsBindings {
  originalContentEnabled: boolean;
  onOriginalContentChange: (enabled: boolean) => void;
  continuePlaybackInBackgroundEnabled: boolean;
  onContinuePlaybackInBackgroundChange: (enabled: boolean) => void;
  onDeleteChannel: () => void | Promise<void>;
}
export interface DouyinScreenProps {
  preset?: ReaderPreset;
  readerKeepAwake?:boolean;
  active?:boolean;
  onShare?:ShareHandler;
  onDone?: (kind: DouyinActionDone) => void;
  width: number;
  height: number;
  route: DouyinRoute;
  client: DouyinClient;
  onNavigate: (route: DouyinRoute) => void;
  onBack: () => void;
  onPlay: (request: DouyinPlayRequest) => void;
  onPreloadWindow?:(owner:unknown,items:DouyinItem[],anchor:string|null)=>void;
  onPreloadStop?:(owner:unknown)=>void;
  onPlaybackCommand?: (command: DouyinPlaybackCommand) => void;
  playbackState?: { playing: boolean; positionMs?: number; durationMs?: number };
  loginQrImage?: string;
  onRequestQrLogin?: () => void;
  onUnsupported?: (message: string) => void;
  onLogoutSuccess?: () => void;
  settings: DouyinSettingsBindings;
  input: (prompt: string, value?: string) => Promise<string | null>;
  ref?: (value: { scroller: Scroller }) => void;
}

/** Session data is retained in full; ScrollEntries virtualizes rendered entries. */
const feedSnapshots = new WeakMap<DouyinClient, DouyinRssFeedSnapshot>();

function lines(text: string, width: number, size = 13): string[] {
  const cjk = size, latin = Math.ceil(size / 2);
  return layoutText(text, { width, measure: value => Array.from(value).reduce((n, ch) => n + (ch.codePointAt(0)! > 255 ? cjk : latin), 0) });
}
function messageOf(result: DouyinResult<unknown>, fallback: string): string {
  return result.ok ? fallback : result.message || fallback;
}
function itemTitle(item?: DouyinItem | null): string { return item?.description?.trim() || "抖音视频"; }
function itemSummary(item: DouyinItem): string {
  const author = item.authorName?.trim() || "未知作者";
  return item.likeCount && item.likeCount > 0 ? `${author} · 赞 ${formatCount(item.likeCount)}` : author;
}
function formatCount(value: number): string { return value >= 10_000 ? `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万` : String(value); }
function header(title: string, subtitle?: string): ScrollEntry {
  return { height: subtitle ? 50 : 34, render: () => <View class="absolute inset-0 items-center"><Text class="absolute top-[0] left-[0] right-[0] text-center text-lg leading-[26] text-[#f5f5f5]">{title}</Text><Show when={subtitle}><Text class="absolute top-[29] left-[0] right-[0] text-center text-xs leading-[14] text-[#b6b6b6]">{subtitle}</Text></Show></View> };
}
function button(label: string, onPress?: () => void, danger = false): ScrollEntry {
  return { height: 48, render: () => <View onPress={onPress} focusable={!!onPress} class="absolute inset-0 rounded-[24] bg-[#2a2a2a] items-center justify-center"><Show when={danger} fallback={<Text class="text-base leading-[20] text-[#f5f5f5]">{label}</Text>}><Text class="text-base leading-[20] text-[#ff5a5f]">{label}</Text></Show></View> };
}
function statusCard(title: string, detail: string): ScrollEntry[] {
  const wrapped = lines(detail, 165, 12), box = { x: 12, width: 173 };
  const titleRow = (rest: string[]) => ({ height: 45 + rest.length * 14, bounds: { ...box, y: 9, height: 24 + rest.length * 14 }, render: () => <>
    <Text class="absolute left-[12] right-[12] top-[9] text-base leading-[20] text-[#f5f5f5]">{title}</Text><Text class="absolute left-[12] right-[12] top-[33] text-xs leading-[14] text-[#b6b6b6]">{rest.join("\n")}</Text></> });
  // Long details continue as further slices of the same card so every line can scroll into view.
  const [first, ...more] = chunkLines(wrapped, 14, box.width, 24);
  return cardSlices([titleRow(first), ...more.map(chunk => ({ height: chunk.length * 14 + 12, bounds: { ...box, y: 0, height: chunk.length * 14 }, render: () =>
    <Text class="absolute left-[12] right-[12] top-[0] text-xs leading-[14] text-[#b6b6b6]">{chunk.join("\n")}</Text> }))], 8, "#1c1f21", 16);
}

function ChannelInfoScreen(props: DouyinScreenProps) {
  const [loggedIn,setLoggedIn]=createSignal(false);
  createEffect(()=>{void props.client.isLoggedIn().then(setLoggedIn);});
  const entries=createMemo<ScrollEntry[]>(()=>[
    header("腕上RSS · 抖音频道"),...statusCard("频道说明",loggedIn()?"进入以获取推荐内容":"未登录，登录后获取推荐内容"),
    ...statusCard("URL","https://www.douyin.com"),header(loggedIn()?"更新：实时":"更新: --"),platformCardEntry(props.width-36,platformScope),
    ...(!loggedIn()?[button("登录",()=>props.onNavigate({name:"login"}))]:[]),
    button("设置",()=>props.onNavigate({name:"settings"})),button("播放历史",()=>props.onNavigate({name:"history"})),button("返回",props.onBack)
  ]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref}/>;
}

function LoginScreen(props: DouyinScreenProps) {
  const loginLog=new DouyinLoginLog();
  const qrTelemetry=new DouyinQrLoadTelemetry(ms=>{loginLog.qrLoaded(ms);usageTelemetry.recordDouyinQrLoadTime(ms);});
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false), [message, setMessage] = createSignal(props.loginQrImage ? "请使用抖音手机客户端扫码登录" : "打开抖音官方登录页，完成登录后点“完成”返回手表。");
  const [authStatus, setAuthStatus] = createSignal(initialLoginStatus());
  const [statusMode, setStatusMode] = createSignal(false);
  const qrImage = () => statusMode() ? (authStatus().qr ? `data:${authStatus().qr!.mime};base64,${authStatus().qr!.imageBase64}` : undefined) : props.loginQrImage;
  const [internet, setInternet] = createSignal<InternetStatus>("checking");
  const [browserAvailable, setBrowserAvailable] = createSignal(hasCapability("system.browser.auth"));
  const gate = () => loginGate(internet(), browserAvailable());
  let disposed = false, generation = 0;
  let authorization: ReturnType<typeof authorizeInBrowser> | undefined;
  onMount(() => onCleanup(observeHostInternet(status => {
    setInternet(status);
    if (status !== "available") { generation++; authorization?.cancel(); authorization = undefined; setAuthStatus(finishLoginStatus(authStatus())); setBusy(false); }
  })));
  onCleanup(() => { loginLog.dispose(); disposed = true; generation++; authorization?.cancel(); });
  const openLogin = async () => {
    if (gate() || busy()) return;
    const current = ++generation;
    setBusy(true);
    setStatusMode(hasCapability("system.browser.auth.status"));
    setAuthStatus(initialLoginStatus());
    setMessage("正在加载抖音登录页…");
    let acceptingStatus = true;
    try {
      const available = await douyinBrowserAvailable({ ...browser, hasCapability });
      if (disposed || current !== generation || gate()) return;
      if (!available) { setBrowserAvailable(false); return; }
      authorization = authorizeInBrowser({url:"https://www.douyin.com/chat?isPopup=1",cookieOrigin:"https://www.douyin.com",qrExtractionScript:statusMode() ? DOUYIN_AUTH_STATUS_SCRIPT : DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT,...(statusMode() ? {completeOnLoginPanelHidden:true,qrWait:DOUYIN_QR_WAIT,onStatus: (event: import("@podjs/framework/services").BrowserAuthStatus) => {
        if (disposed || current !== generation || !acceptingStatus) return;
        loginLog.status(event);
        qrTelemetry.status(event);
        setAuthStatus(state => updateLoginStatus(state, event));
        setMessage(loginStatusMessage(authStatus()));
      }} : {}),requiredCookieNames:["sessionid"],userAgent:DOUYIN_USER_AGENT});
      const result = await authorization.result;
      acceptingStatus = false;
      if (disposed || current !== generation || gate()) return;
      setAuthStatus(finishLoginStatus(authStatus()));
      const saved = await props.client.applyCookie(result.cookie);
      if (!saved.ok) throw new Error(saved.message);
      loginLog.completed();
      if (!disposed && current === generation) { feedSnapshots.delete(props.client); props.onNavigate({name:"entry"}); }
    } catch (error) {
      acceptingStatus = false;
      if (!disposed && current === generation) setAuthStatus(finishLoginStatus(authStatus()));
      if (!disposed && current === generation) { setFailed(true); const failure = loginError(error); appLogger.w("DouyinLogin", "code=" + douyinLoginFailureCode(error)); if(failure.unavailable)appLogger.e("DouyinLoginScreen","Failed to initialize WebView"); setMessage(failure.message); if (failure.unavailable) setBrowserAvailable(false); }
    } finally { if (!disposed && current === generation) { authorization = undefined; setAuthStatus(finishLoginStatus(authStatus())); setBusy(false); } }
  };
  const inputCookie = async () => {
    if (gate() || busy()) return;
    setBusy(true);
    try {
      const cookie = await props.input("输入抖音 Cookie"); if (!cookie?.trim() || disposed || gate()) return;
      const result = await props.client.applyCookie(cookie.trim());
      if (disposed) return;
      if (result.ok) {
        const verified = await props.client.isLoggedIn();
        if (disposed) return;
        if (verified) { feedSnapshots.delete(props.client); props.onNavigate({ name: "entry" }); }
        else setMessage("Cookie 已保存，但抖音未确认登录状态");
      } else setMessage(messageOf(result, "Cookie 登录失败"));
    } catch (error) { if (!disposed) setMessage(`Cookie 登录失败：${String(error)}`); }
    finally { if (!disposed) setBusy(false); }
  };
  const detail = () => lines(message(), props.width - 60, 12);
  const entries = createMemo<ScrollEntry[]>(() => gate() ? [header("登录抖音"), ...statusCard(gate()!.title,gate()!.detail),button("返回",props.onBack)] : [header("登录抖音", "扫码登录或输入 Cookie"), { height: 102, render: () => <View onPress={busy() ? undefined : () => void openLogin()} focusable={!busy()} class="absolute inset-0 rounded-[16] bg-[#1c1f21] items-center justify-center"><Show when={qrImage()} fallback={<View class="absolute inset-0 items-center justify-center"><View class="w-[54] h-[38] rounded-[19] bg-[#2a2a2a] items-center justify-center"><Text class="text-xs leading-[14] text-[#f5f5f5]">{busy() ? "加载中…" : failed() ? "重试登录" : "网页登录"}</Text></View><Text class="absolute left-[12] right-[12] bottom-[8] text-center text-[11px] leading-[14] text-[#f5f5f5]">{busy() ? "正在等待登录二维码…" : "打开抖音官方登录页"}</Text></View>}><Image src={qrImage()!} class="w-[88] h-[88] rounded-[8]" /></Show></View> }, { height: Math.max(42, detail().length * 14 + 12), render: () => <Text class="absolute inset-0 text-xs leading-[14] text-[#b6b6b6]">{detail().join("\n")}</Text> }, button(busy() ? "验证中..." : "输入 Cookie", busy() ? undefined : () => void inputCookie()), button("返回", props.onBack)]);
  return <Show when={!gate() && statusMode() && authStatus().qr} fallback={<ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />}>
    <View class="absolute inset-0 bg-black items-center justify-center">
      <Text class="absolute top-[16] text-sm text-white">请使用手机扫码</Text>
      <Image src={qrImage()!} style={{width: props.width * 0.7, height: props.height * 0.7}} class="rounded-[8]" />
      <Text class="absolute bottom-[16] text-xs text-white">{loginStatusMessage(authStatus())}</Text>
    </View>
  </Show>;
}

/** Native list/history callers mark before navigation; saved-reader entry does not. */
function detailNavigation(props: DouyinScreenProps, onRecorded?: () => Promise<void>) {
  let busy = false, disposed = false;
  onCleanup(() => { disposed = true; });
  return async (item: DouyinItem, playlist?: DouyinItem[]) => {
    if (busy || disposed) return;
    busy = true;
    try {
      await props.client.recordHistory(item);
      if (disposed) return;
      await onRecorded?.();
      if (!disposed) props.onNavigate({name:"detail",awemeId:item.awemeId,item,...(playlist ? {playlist} : {})});
    } finally { busy = false; }
  };
}

function FeedScreen(props: DouyinScreenProps) {
  const openDetail = detailNavigation(props);
  const [resume, setResume] = createSignal<Awaited<ReturnType<DouyinClient["restorePlaybackQueue"]>>>();
  onMount(() => { let current = true; onCleanup(() => { current = false; }); void props.client.restorePlaybackQueue().then(value => { if (current) setResume(value); }).catch(() => {}); });
  const continuePlayback = async () => {
    const queue = resume(), id = queue?.anchorAwemeId; if (!queue || !id) return;
    try {
      const result = await props.client.resolvePlayback(id);
      if (!result.ok) { setError(result.message); return; }
      props.onPlay({item:result.data,playback:result.data,playlist:queue.items,cursor:queue.cursor ?? undefined,hasMore:queue.hasMore});
      props.onNavigate({name:"player",awemeId:id});
    } catch (error) { setError(String(error)); }
  };
  const initial = feedSnapshots.get(props.client);
  const controller = new DouyinRssFeedController(props.client, initial, state => setFeed(state), snapshot => feedSnapshots.set(props.client, snapshot));
  const [feed, setFeed] = createSignal(controller.state), [error, setError] = createSignal("");
  const items = () => feed().items, hasMore = () => feed().hasMore, loading = () => feed().loading;
  const [refreshing, setRefreshing] = createSignal(false);
  const load = (append = false) => { setError(""); if (append) return controller.loadMore(); setRefreshing(true); return controller.refresh().finally(() => setRefreshing(false)); };
  createEffect(() => setError(feed().error));
  onCleanup(() => controller.dispose());
  createEffect(() => { if ((props.route.name === "feed" || props.route.name === "entry") && !feedSnapshots.has(props.client)) void untrack(() => load(false)); });
  // Native DouyinRssFeedScreen reuses FeedHeader / FeedItemEntry / FeedActions: swipe reveals 收藏 / 稍后再看
  // (toggle + toast), long press opens the actions page with the item, pull refresh and auto load near the end.
  const [loggedIn, setLoggedIn] = createSignal<boolean | null>(null);
  createEffect(() => { if (props.route.name === "feed" || props.route.name === "entry") void Promise.resolve().then(() => props.client.isLoggedIn()).then(setLoggedIn, () => setLoggedIn(null)); });
  const toast = (message: string) => { void hostOperation("ui.toast", { message }).result.catch(() => {}); };
  const byId = createMemo(() => new Map(items().map(item => [item.awemeId, item])));
  const articles = createMemo<Article[]>(() => loggedIn() === false ? [] : items().map(item => ({ id: item.awemeId, title: itemTitle(item), excerpt: itemSummary(item), content: "", read: true })));
  const withItem = (article: Article, run: (item: DouyinItem) => void) => { const item = byId().get(article.id); if (item) run(item); };
  const toggleSaved = (item: DouyinItem, kind: "favorite" | "watchLater") => void props.client.toggleSaved(item, kind).then(saved => toast(kind === "favorite" ? saved ? "已收藏" : "已取消收藏" : saved ? "已加入稍后再看" : "已从稍后再看移除"), error => toast(error instanceof Error ? error.message : String(error)));
  const leading = createMemo<ScrollEntry[]>(() => (loggedIn() === false
    ? [{ height: 21, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-[17px] leading-[21] text-center text-[#b6b6b6]">未登录</Text> }, feedPillEntry("登录", props.width, () => props.onNavigate({ name: "login" }))]
    : resume()?.anchorAwemeId ? [feedPillEntry("继续上次播放", props.width, () => void continuePlayback())] : []));
  const empty = createMemo<ScrollEntry[]>(() => loggedIn() === false || (loading() && !error()) ? [] : [feedEmptyStateEntry(error() ? "加载失败" : "暂无内容", error() || "下拉刷新获取推荐内容", props.width)]);
  return <RssFeedScreen width={props.width} height={props.height} title="抖音" active={props.active !== false} onInfo={() => props.onNavigate({ name: "channel-info" })}
    items={articles()} refreshing={refreshing() || (loading() && !items().length)} loadingMore={loading() && !refreshing() && items().length > 0} canNext={hasMore() && loggedIn() !== false}
    onOpen={article => withItem(article, item => void openDetail(item).catch(error => setError(String(error))))}
    onActions={article => withItem(article, item => props.onNavigate({ name: "actions", awemeId: item.awemeId, item }))}
    onFavorite={article => withItem(article, item => toggleSaved(item, "favorite"))} onWatchLater={article => withItem(article, item => toggleSaved(item, "watchLater"))}
    onRefresh={() => void load(false)} onNext={() => void load(true)} leading={leading()} empty={empty()} ref={props.ref} />;
}

function DetailScreen(props: DouyinScreenProps & { awemeId: string }) {
  const [content, setContent] = createSignal<DouyinContent | null>(null), [error, setError] = createSignal("");
  createEffect(() => {
    const id = props.awemeId, route = props.route;
    let current = true; onCleanup(() => { current = false; });
    setContent(null); setError("");
    void loadDouyinDetail(props.client, id, route.name === "detail" ? route.item : undefined)
      .then(result => { if (current) result.ok ? setContent(result.data) : setError(result.message); })
      .catch(error => { if (current) setError(String(error)); });
  });
  const item = () => content()?.kind === "video" ? (content() as Extract<DouyinContent, { kind: "video" }>).item : null;
  const play = async () => {
    const current = item(); if (!current) return;
    try {
      const result = await props.client.resolvePlayback(current.awemeId);
      // RssPlayerViewModel allows the stored direct URL when initial refresh fails.
      const playback = result.ok ? result.data : current.playUrl.trim() && !douyinVideoTarget(current.playUrl) ? current : null;
      if (!playback) { setError(result.ok ? "播放地址为空" : result.message); return; }
      // Native history/detail uses a single RssPlayerActivity, never the history/feed list.
      props.onPlay({ item: current, playback, playlist: [playback], hasMore: false, detailPlayback: true });
      props.onNavigate({ name: "player", awemeId: current.awemeId });
    } catch (error) { setError(String(error)); }
  };
  const preset = () => props.preset ?? defaultReaderPreset();
  // Native DouyinDetailActivity renders the article DetailContent: reader title, then the blocks,
  // then the reader's favorite / share circles. Favorite uses the persistent local saved store.
  const favoriteController = new DouyinFavoriteController(props.client, props.awemeId, next => setSaved(next));
  const [saved, setSaved] = createSignal(favoriteController.state);
  const favorite = () => saved().favorite, notice = () => saved().message;
  createEffect(() => { if (props.active !== false) void favoriteController.refresh(); });
  onCleanup(() => favoriteController.dispose());
  const toggleFavorite = async () => { const current = item(); if (current) await favoriteController.toggle(current); };
  const share = () => {
    const title = wireFields.trim(item()?.description ?? "") || "抖音视频", qr = () => props.onNavigate({ name: "share", awemeId: props.awemeId });
    if (props.onShare) props.onShare({ origin: "detail", title, link: douyinShareLink(props.awemeId) }, qr); else qr();
  };
  return <Show when={content()} fallback={<View class="absolute inset-0 items-center justify-center" style={{ bgColor: readerColor(preset().background.colorArgb) }}>
      <Text class="text-[21px] leading-[26] text-center" style={{ textColor: readerChrome(preset()).content }}>{error() || "加载中..."}</Text>
    </View>}>
    {value => {
      const blocks = () => douyinDetailBlocks(value());
      const title = () => { const first = blocks()[0]; return first?.type === "text" ? first.text : "抖音视频"; };
      return <MediaReaderDetail width={props.width} height={props.height} preset={preset()} active={props.active !== false} keepAwake={props.readerKeepAwake}
        articleId={`douyin:${props.awemeId}`} title={title()} blocks={blocks().slice(1)} message={error() || notice()}
        favorite={favorite} onPlay={() => void play()} onFavorite={() => void toggleFavorite()} onShare={share}
        onError={setError} ref={handle => props.ref?.({ scroller: handle.scroller })} />;
    }}
  </Show>;
}

function HistoryScreen(props: DouyinScreenProps) {
  const [history, setHistory] = createSignal<DouyinHistoryEntry[]>([]), [error, setError] = createSignal("");
  const refresh = async () => { try { setHistory(await props.client.listHistory()); } catch (e) { setError(String(e)); } };
  const openDetail = detailNavigation(props, refresh);
  createEffect(() => { if (props.route.name === "history") void refresh(); });
  const entries = createMemo<ScrollEntry[]>(() => [header("播放历史", "保存在本地，记录最近播放内容"), ...(history().length ? [button("清空历史", async () => { await props.client.clearHistory(); await refresh(); })] : []), ...history().map(entry => { const item = entry.item, titleLines = lines(itemTitle(item), props.width - 60, 16).slice(0, 1), summaryLines = lines(`${item.authorName || "未知作者"} · ${new Date(entry.watchedAtMillis).toLocaleString()}`, props.width - 60, 12).slice(0, 2); return { height: 64, render: () => <View onPress={() => void openDetail(item).catch(error => setError(String(error)))} focusable class="absolute inset-0 rounded-[16] bg-[#1c1f21]"><Text class="absolute left-[12] right-[12] top-[9] text-base leading-[20] text-[#f5f5f5]">{titleLines.join("\n")}</Text><Text class="absolute left-[12] right-[12] top-[35] text-xs leading-[14] text-[#b6b6b6]">{summaryLines.join("\n")}</Text></View> }; }), ...(!history().length ? [...statusCard(error() ? "读取失败" : "暂无播放历史", error() || "播放过的视频会显示在这里")] : [])]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function ActionsScreen(props: DouyinScreenProps & { awemeId: string }) {
  const supplied = props.route.name === "actions" ? props.route.item : undefined;
  // Native DouyinVideoActionsActivity: a successful save toasts and finishes; share dispatch also finishes.
  const done = (kind: DouyinActionDone) => { if (kind !== "share" && state().message) void hostOperation("ui.toast", { message: state().message }).result.catch(() => {}); if (props.onDone) props.onDone(kind); else props.onBack(); };
  const controller = new DouyinActionsController(props.client, props.awemeId, supplied, next => setState(next), done);
  const [state, setState] = createSignal(controller.state);
  const item = () => state().item, favorite = () => state().favorite, watchLater = () => state().watchLater, message = () => state().message;
  onMount(() => void controller.load());
  onCleanup(() => controller.dispose());
  const toggle = (kind: "favorite" | "watchLater") => controller.toggle(kind);
  const entries = createMemo<ScrollEntry[]>(() => [button(favorite() ? "取消收藏" : "收藏", item() ? () => void toggle("favorite") : undefined), button(watchLater() ? "取消稍后再看" : "稍后再看", item() ? () => void toggle("watchLater") : undefined), button("分享", () => {const qr=()=>props.onNavigate({name:"share",awemeId:props.awemeId,item:item()});if(props.onShare)props.onShare({origin:"detail",title:wireFields.trim(item()?.description??"")||"抖音视频",link:douyinShareLink(props.awemeId)},qr);else qr();}), ...(message() ? [...statusCard("状态", message())] : []), button("取消", props.onBack)]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} padding={22} ref={props.ref} />;
}

function ShareScreen(props: DouyinScreenProps & { awemeId: string }) {
  const url = douyinShareLink(props.awemeId)??"";
  const [title, setTitle] = createSignal(itemTitle(props.route.name === "share" ? props.route.item : undefined));
  createEffect(() => { void props.client.fetchDetail(props.awemeId).then(result => { if (result.ok) setTitle(result.data.kind === "video" ? itemTitle(result.data.item) : result.data.kind === "note" ? result.data.description.trim() || "抖音图文" : "抖音内容"); }).catch(() => {}); });
  return <SharedShareQrScreen width={props.width} height={props.height} title={title()} url={url} onClose={props.onBack} onError={message => props.onUnsupported?.(`二维码生成失败：${message}`)} />;
}

/** Native DouyinSettingsActivity renders BiliSettingsScreen + DeleteConfirmDialog; messages toast. */
function SettingsScreen(props: DouyinScreenProps) {
  const [loggedIn, setLoggedIn] = createSignal<boolean | undefined>(undefined);
  createEffect(() => { if (props.route.name === "settings") void Promise.resolve().then(() => props.client.isLoggedIn()).then(setLoggedIn, () => setLoggedIn(false)); });
  const toast = (message: string) => { void hostOperation("ui.toast", { message }).result.catch(() => {}); };
  return <PlatformSettingsScreen width={props.width} height={props.height} loggedIn={loggedIn}
    showOriginalContent originalContentEnabled={props.settings.originalContentEnabled} onToggleOriginal={() => props.settings.onOriginalContentChange(!props.settings.originalContentEnabled)}
    showContinuePlaybackInBackground continuePlaybackInBackgroundEnabled={props.settings.continuePlaybackInBackgroundEnabled} onToggleContinuePlaybackInBackground={() => props.settings.onContinuePlaybackInBackgroundChange(!props.settings.continuePlaybackInBackgroundEnabled)}
    deleteEnabled onDelete={async () => { await props.settings.onDeleteChannel(); feedSnapshots.delete(props.client); }}
    onLogout={async () => { try { await props.client.logout(); feedSnapshots.delete(props.client); setLoggedIn(false); props.onLogoutSuccess?.(); } catch (error) { toast(`退出失败：${String(error)}`); } }}
    onError={error => toast(error instanceof Error ? error.message : String(error))} ref={props.ref} />;
}

function PlayerScreen(props: DouyinScreenProps & { awemeId: string }) {
  const playing = () => props.playbackState?.playing ?? true;
  const time = () => { const p = Math.floor((props.playbackState?.positionMs || 0) / 1000), d = Math.floor((props.playbackState?.durationMs || 0) / 1000); return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, "0")} / ${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`; };
  const entries = createMemo<ScrollEntry[]>(() => [header("正在播放", time()), ...statusCard("视频画面", "视频由宿主原生媒体表面显示"), button(playing() ? "暂停" : "继续播放", () => props.onPlaybackCommand?.("toggle")), button("重播", () => props.onPlaybackCommand?.("replay")), button("上一个", () => props.onPlaybackCommand?.("previous")), button("下一个", () => props.onPlaybackCommand?.("next")), button("视频操作", () => props.onNavigate({ name: "actions", awemeId: props.awemeId }))]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function DouyinScreenImpl(props: DouyinScreenProps) {
  onCleanup(props.client.onAuthExpired(()=>{
    if((props.active??true)&&props.route.name!=='login')props.onNavigate({name:'login'});
  }));
  return <Show when={props.route} keyed>{route => {
    switch (route.name) {
      case "entry": return <Show when={props.settings.originalContentEnabled} fallback={<FeedScreen {...props} />}><ImmersiveEntry {...props} /></Show>;
      case "channel-info": return <ChannelInfoScreen {...props} />;
      case "login": return <LoginScreen {...props} />;
      case "feed": return <Show when={props.settings.originalContentEnabled} fallback={<FeedScreen {...props} />}><ImmersiveEntry {...props} /></Show>;
      case "detail": return <DetailScreen {...props} awemeId={route.awemeId} />;
      case "history": return <HistoryScreen {...props} />;
      case "actions": return <ActionsScreen {...props} awemeId={route.awemeId} />;
      case "share": return <ShareScreen {...props} awemeId={route.awemeId} />;
      case "settings": return <SettingsScreen {...props} />;
      case "player": return <PlayerScreen {...props} awemeId={route.awemeId} />;
    }
  }}</Show>;
}

export default DouyinScreen;

export function DouyinScreen(props:Parameters<typeof DouyinScreenImpl>[0]) {return traceServiceWork("navigation.DouyinScreen",()=>DouyinScreenImpl(props));}
