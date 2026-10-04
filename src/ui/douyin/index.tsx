import {douyinShareLink,type ShareHandler} from "../../sharing/policy.ts";
import {wireFields} from "../../sync/article-batches.ts";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js";
import { layoutText } from "../../reader/index.ts";
import { ScrollEntries, type ScrollEntry } from "../ScrollEntries.tsx";
import { RemoteImage } from "../RemoteImage.tsx";
import { SafeQrScreen } from "../SafeQrScreen.tsx";
import { ShareQrScreen as SharedShareQrScreen } from "../ShareQrScreen.tsx";
import { DOUYIN_PUBLIC_MEDIA_HEADERS } from "../../douyin/index.ts";
import type { DouyinClient, DouyinContent, DouyinHistoryEntry, DouyinItem, DouyinResult } from "../../douyin/index.ts";

export type DouyinRoute =
  | { name: "entry" }
  | { name: "login" }
  | { name: "feed" }
  | { name: "detail"; awemeId: string }
  | { name: "history" }
  | { name: "actions"; awemeId: string }
  | { name: "share"; awemeId: string }
  | { name: "settings" }
  | { name: "player"; awemeId: string };

export interface DouyinPlayRequest { item: DouyinItem; playback: DouyinItem; playlist?: DouyinItem[]; cursor?: string; hasMore?: boolean }
export type DouyinPlaybackCommand = "toggle" | "previous" | "next" | "replay";
export interface DouyinSettingsBindings {
  originalContentEnabled: boolean;
  onOriginalContentChange: (enabled: boolean) => void;
  continuePlaybackInBackgroundEnabled: boolean;
  onContinuePlaybackInBackgroundChange: (enabled: boolean) => void;
  onDeleteChannel: () => void | Promise<void>;
}
export interface DouyinScreenProps {
  onShare?:ShareHandler;
  width: number;
  height: number;
  route: DouyinRoute;
  client: DouyinClient;
  onNavigate: (route: DouyinRoute) => void;
  onBack: () => void;
  onPlay: (request: DouyinPlayRequest) => void;
  onPlaybackCommand?: (command: DouyinPlaybackCommand) => void;
  playbackState?: { playing: boolean; positionMs?: number; durationMs?: number };
  loginQrImage?: string;
  onRequestQrLogin?: () => void;
  onUnsupported?: (message: string) => void;
  settings: DouyinSettingsBindings;
  input: (prompt: string, value?: string) => Promise<string | null>;
  ref?: (value: { scroller: Scroller }) => void;
}

interface FeedSnapshot { items: DouyinItem[]; cursor?: string; hasMore: boolean }
/** One bounded feed window per client/session; route changes do not trigger requests. */
const feedSnapshots = new WeakMap<DouyinClient, FeedSnapshot>();
const MAX_FEED_SNAPSHOT_ITEMS = 40;
const playIcon = "../assets/icons/play-circle.svg";

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
function wrappedHeader(title: string, subtitle: string, width: number): ScrollEntry {
  const titleLines = lines(title, width - 64, 18).slice(0, 3);
  const subtitleLines = lines(subtitle, width - 56, 12).slice(0, 2);
  const subtitleTop = titleLines.length * 26 + 3;
  return { height: subtitleTop + subtitleLines.length * 14 + 4, render: () => <View class="absolute inset-0 items-center"><Text class="absolute top-[0] left-[14] right-[14] text-center text-lg leading-[26] text-[#f5f5f5]">{titleLines.join("\n")}</Text><Text style={{ insetT: subtitleTop }} class="absolute left-[10] right-[10] text-center text-xs leading-[14] text-[#b6b6b6]">{subtitleLines.join("\n")}</Text></View> };
}
function button(label: string, onPress?: () => void, danger = false): ScrollEntry {
  return { height: 48, render: () => <View onPress={onPress} focusable={!!onPress} class="absolute inset-0 rounded-[24] bg-[#2a2a2a] items-center justify-center"><Show when={danger} fallback={<Text class="text-base leading-[20] text-[#f5f5f5]">{label}</Text>}><Text class="text-base leading-[20] text-[#ff5a5f]">{label}</Text></Show></View> };
}
function statusCard(title: string, detail: string): ScrollEntry {
  const wrapped = lines(detail, 165, 12);
  return { height: 45 + wrapped.length * 14, render: () => <View class="absolute inset-0 rounded-[16] bg-[#1c1f21]"><Text class="absolute left-[12] right-[12] top-[9] text-base leading-[20] text-[#f5f5f5]">{title}</Text><Text class="absolute left-[12] right-[12] top-[33] text-xs leading-[14] text-[#b6b6b6]">{wrapped.join("\n")}</Text></View> };
}

function EntryScreen(props: DouyinScreenProps) {
  const [loggedIn, setLoggedIn] = createSignal<boolean | null>(null);
  const [items, setItems] = createSignal<DouyinItem[]>([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const refresh = async () => {
    setLoading(true); setError("");
    const logged = await props.client.isLoggedIn().catch(() => false); setLoggedIn(logged);
    if (logged) { const cached = feedSnapshots.get(props.client); if (cached) setItems(cached.items); else { const result = await props.client.fetchFeedPage({ count: 12 }); if (result.ok) { const snapshot = { items: result.data.items, cursor: result.data.nextCursor || undefined, hasMore: result.data.hasMore }; feedSnapshots.set(props.client, snapshot); setItems(snapshot.items); } else setError(messageOf(result, "加载失败")); } }
    setLoading(false);
  };
  createEffect(() => { if (props.route.name === "entry") void refresh(); });
  const entries = createMemo<ScrollEntry[]>(() => [
    header("抖音", loading() ? "刷新中..." : items().length ? "向上进入短视频流" : loggedIn() === false ? "登录后获取推荐内容" : "暂无内容，点击刷新重试"),
    ...(error() ? [statusCard("加载失败", error())] : []),
    ...(loggedIn() === false ? [button("登录", () => props.onNavigate({ name: "login" }))] : []),
    ...(items().length ? [button("进入短视频流", () => props.onNavigate({ name: "feed" }))] : [button(loading() ? "刷新中..." : "刷新", loading() ? undefined : () => void refresh())]),
    button("播放历史", () => props.onNavigate({ name: "history" })),
    button("设置", () => props.onNavigate({ name: "settings" }))
  ]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function LoginScreen(props: DouyinScreenProps) {
  const [busy, setBusy] = createSignal(false), [message, setMessage] = createSignal(props.loginQrImage ? "请使用抖音手机客户端扫码登录" : props.onRequestQrLogin ? "打开抖音官方登录页，完成登录后点“完成”返回手表。" : "当前宿主未提供抖音网页登录入口，可从手机复制抖音 Cookie 后输入。");
  const inputCookie = async () => {
    const cookie = await props.input("输入抖音 Cookie"); if (!cookie?.trim()) return;
    setBusy(true); const result = await props.client.applyCookie(cookie.trim()); setBusy(false);
    if (result.ok) { const verified = await props.client.isLoggedIn(); if (verified) { feedSnapshots.delete(props.client); props.onNavigate({ name: "entry" }); } else setMessage("Cookie 已保存，但抖音未确认登录状态"); }
    else setMessage(messageOf(result, "Cookie 登录失败"));
  };
  const detail = lines(message(), props.width - 60, 12);
  const entries = createMemo<ScrollEntry[]>(() => [header("登录抖音", "扫码登录或输入 Cookie"), { height: 102, render: () => <View onPress={props.onRequestQrLogin} focusable={!!props.onRequestQrLogin} class="absolute inset-0 rounded-[16] bg-[#1c1f21] items-center justify-center"><Show when={props.loginQrImage} fallback={<View class="absolute inset-0 items-center justify-center"><View class="w-[54] h-[38] rounded-[19] bg-[#2a2a2a] items-center justify-center"><Text class="text-xs leading-[14] text-[#f5f5f5]">网页登录</Text></View><Text class="absolute left-[12] right-[12] bottom-[8] text-center text-[11px] leading-[14] text-[#f5f5f5]">打开抖音官方登录页</Text></View>}><Image src={props.loginQrImage!} class="w-[88] h-[88] rounded-[8]" /></Show></View> }, { height: Math.max(42, detail.length * 14 + 12), render: () => <Text class="absolute inset-0 text-xs leading-[14] text-[#b6b6b6]">{detail.join("\n")}</Text> }, button(busy() ? "验证中..." : "输入 Cookie", busy() ? undefined : () => void inputCookie()), button("返回", props.onBack)]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function FeedScreen(props: DouyinScreenProps) {
  const initial = feedSnapshots.get(props.client);
  const [items, setItems] = createSignal<DouyinItem[]>(initial?.items ?? []), [cursor, setCursor] = createSignal<string | undefined>(initial?.cursor), [hasMore, setHasMore] = createSignal(initial?.hasMore ?? true), [loading, setLoading] = createSignal(false), [error, setError] = createSignal("");
  const load = async (append = false) => { if (loading()) return; setLoading(true); setError(""); const result = await props.client.fetchFeedPage({ cursor: append ? cursor() : undefined, count: 12 }); if (result.ok) { const nextItems = (append ? [...items(), ...result.data.items] : result.data.items).slice(-MAX_FEED_SNAPSHOT_ITEMS); const snapshot = { items: nextItems, cursor: result.data.nextCursor || undefined, hasMore: result.data.hasMore }; feedSnapshots.set(props.client, snapshot); setItems(snapshot.items); setCursor(snapshot.cursor); setHasMore(snapshot.hasMore); } else setError(messageOf(result, "加载失败")); setLoading(false); };
  createEffect(() => { if (props.route.name === "feed" && !feedSnapshots.has(props.client)) void untrack(() => load(false)); });
  const card = (item: DouyinItem): ScrollEntry => { const titleLines = lines(itemTitle(item), props.width - 60, 17).slice(0, 2), summaryLines = lines(itemSummary(item), props.width - 60, 12).slice(0, 1); return { height: 51 + titleLines.length * 21, render: () => <View onPress={() => props.onNavigate({ name: "detail", awemeId: item.awemeId })} focusable class="absolute inset-0 rounded-[16] bg-[#1c1f21]"><Text class="absolute left-[12] right-[12] top-[9] text-[17px] leading-[21] text-[#f5f5f5]">{titleLines.join("\n")}</Text><Text class="absolute left-[12] right-[12] bottom-[10] text-xs leading-[14] text-[#b6b6b6]">{summaryLines.join("\n")}</Text></View> }; };
  const entries = createMemo<ScrollEntry[]>(() => [header("抖音", loading() ? "刷新中..." : "推荐内容"), button(loading() ? "刷新中..." : "刷新", loading() ? undefined : () => void load(false)), ...(error() ? [statusCard("加载失败", error())] : []), ...items().map(card), ...(items().length === 0 && !loading() && !error() ? [statusCard("暂无内容", "刷新以获取推荐内容")] : []), button(loading() ? "加载中..." : hasMore() ? "加载更多" : "没有更多了", !loading() && hasMore() ? () => void load(true) : undefined)]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function DetailScreen(props: DouyinScreenProps & { awemeId: string }) {
  const [content, setContent] = createSignal<DouyinContent | null>(null), [error, setError] = createSignal("");
  createEffect(() => { const id = props.awemeId; setContent(null); setError(""); void props.client.fetchDetail(id).then(result => result.ok ? setContent(result.data) : setError(messageOf(result, "内容加载失败"))); });
  const item = () => content()?.kind === "video" ? (content() as Extract<DouyinContent, { kind: "video" }>).item : null;
  const play = async () => { const current = item(); if (!current) return; const result = await props.client.resolvePlayback(current.awemeId); if (result.ok) { await props.client.recordHistory(result.data); const snapshot=props.client.feedSnapshot(),playlist=snapshot.items.some(entry=>entry.awemeId===current.awemeId)?snapshot.items:[result.data,...snapshot.items]; props.onPlay({ item: current, playback: result.data, playlist, ...(snapshot.cursor?{cursor:snapshot.cursor}:{}), hasMore:snapshot.hasMore }); props.onNavigate({ name: "player", awemeId: current.awemeId }); } else setError(messageOf(result, "当前内容暂无可用视频地址")); };
  const entries = createMemo<ScrollEntry[]>(() => { const currentContent = content(); if (!currentContent) return [header("抖音视频"), statusCard(error() ? "加载失败" : "正在加载", error() || "正在读取内容...")]; const current = item(), body = (currentContent.kind === "video" ? currentContent.item.description : currentContent.description).trim() || "这是一条来自抖音的信息流内容。", bodyLines = lines(body, props.width - 36, 13), author = currentContent.kind === "video" ? currentContent.item.authorName : currentContent.authorName, cover = currentContent.kind === "video" ? currentContent.item.coverUrl : currentContent.imageUrls[0]; return [wrappedHeader(current ? itemTitle(current) : body, `作者：${author?.trim() || "未知作者"}`, props.width), ...(cover ? [{ height: 124, render: () => <View onPress={current ? () => void play() : undefined} focusable={!!current} class="absolute inset-0 rounded-[16] overflow-hidden bg-[#1c1f21]"><RemoteImage url={cover} width={props.width - 36} height={124} class="absolute inset-0" headers={{ ...DOUYIN_PUBLIC_MEDIA_HEADERS }} /><Show when={current}><View class="absolute inset-0 items-center justify-center"><View class="w-[42] h-[42] rounded-full bg-[#000000aa] items-center justify-center"><Image src={playIcon} class="w-[32] h-[32]" /></View></View></Show></View> } as ScrollEntry] : []), { height: Math.max(40, bodyLines.length * 18 + 12), render: () => <Text class="absolute inset-0 text-[13px] leading-[18] text-[#f5f5f5]">{bodyLines.join("\n")}</Text> }, ...(error() ? [statusCard("无法播放", error())] : []), ...(current ? [button("播放", () => void play()), button("更多操作", () => props.onNavigate({ name: "actions", awemeId: current.awemeId }))] : [statusCard("图文内容", "当前内容没有视频播放流")])]; });
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function HistoryScreen(props: DouyinScreenProps) {
  const [history, setHistory] = createSignal<DouyinHistoryEntry[]>([]), [error, setError] = createSignal("");
  const refresh = async () => { try { setHistory(await props.client.listHistory()); } catch (e) { setError(String(e)); } };
  createEffect(() => { if (props.route.name === "history") void refresh(); });
  const entries = createMemo<ScrollEntry[]>(() => [header("播放历史", "保存在本地，记录最近播放内容"), ...(history().length ? [button("清空历史", async () => { await props.client.clearHistory(); await refresh(); })] : []), ...history().map(entry => { const item = entry.item, titleLines = lines(itemTitle(item), props.width - 60, 16).slice(0, 1), summaryLines = lines(`${item.authorName || "未知作者"} · ${new Date(entry.watchedAtMillis).toLocaleString()}`, props.width - 60, 12).slice(0, 2); return { height: 64, render: () => <View onPress={() => props.onNavigate({ name: "detail", awemeId: item.awemeId })} focusable class="absolute inset-0 rounded-[16] bg-[#1c1f21]"><Text class="absolute left-[12] right-[12] top-[9] text-base leading-[20] text-[#f5f5f5]">{titleLines.join("\n")}</Text><Text class="absolute left-[12] right-[12] top-[35] text-xs leading-[14] text-[#b6b6b6]">{summaryLines.join("\n")}</Text></View> }; }), ...(!history().length ? [statusCard(error() ? "读取失败" : "暂无播放历史", error() || "播放过的视频会显示在这里")] : [])]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function ActionsScreen(props: DouyinScreenProps & { awemeId: string }) {
  const [item, setItem] = createSignal<DouyinItem | null>(null), [favorite, setFavorite] = createSignal(false), [watchLater, setWatchLater] = createSignal(false), [message, setMessage] = createSignal("正在读取状态...");
  createEffect(() => { const id = props.awemeId; void Promise.all([props.client.fetchDetail(id), props.client.getSavedState(id)]).then(([detail, saved]) => { if (!detail.ok) { setMessage(detail.message); return; } if (detail.data.kind !== "video") { setMessage("图文内容暂不支持加入本地收藏"); return; } setItem(detail.data.item); setFavorite(saved.favorite); setWatchLater(saved.watchLater); setMessage(""); }).catch(error => setMessage(String(error))); });
  const toggle = async (kind: "favorite" | "watchLater") => { const current = item(); if (!current) return; try { const saved = await props.client.toggleSaved(current, kind); if (kind === "favorite") setFavorite(saved); else setWatchLater(saved); setMessage(saved ? (kind === "favorite" ? "已收藏" : "已加入稍后再看") : (kind === "favorite" ? "已取消收藏" : "已从稍后再看移除")); } catch (error) { setMessage(String(error)); } };
  const entries = createMemo<ScrollEntry[]>(() => [button(favorite() ? "取消收藏" : "收藏", item() ? () => void toggle("favorite") : undefined), button(watchLater() ? "取消稍后再看" : "稍后再看", item() ? () => void toggle("watchLater") : undefined), button("分享", () => {const qr=()=>props.onNavigate({name:"share",awemeId:props.awemeId});if(props.onShare)props.onShare({origin:"detail",title:wireFields.trim(item()?.description??"")||"抖音视频",link:douyinShareLink(props.awemeId)},qr);else qr();}), ...(message() ? [statusCard("状态", message())] : []), button("取消", props.onBack)]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} padding={22} ref={props.ref} />;
}

function ShareScreen(props: DouyinScreenProps & { awemeId: string }) {
  const url = douyinShareLink(props.awemeId)??"";
  const [title, setTitle] = createSignal("抖音视频");
  createEffect(() => { void props.client.fetchDetail(props.awemeId).then(result => { if (result.ok) setTitle(result.data.kind === "video" ? itemTitle(result.data.item) : result.data.description.trim() || "抖音图文"); }); });
  return <SharedShareQrScreen width={props.width} height={props.height} title={title()} url={url} onClose={props.onBack} onError={message => props.onUnsupported?.(`二维码生成失败：${message}`)} />;
}

function SettingsScreen(props: DouyinScreenProps) {
  const [loggedIn, setLoggedIn] = createSignal<boolean | null>(null), [message, setMessage] = createSignal(""), [confirmDelete, setConfirmDelete] = createSignal(false);
  createEffect(() => { if (props.route.name === "settings") void props.client.isLoggedIn().then(setLoggedIn); });
  const setting = (label: string, enabled: boolean, onToggle: () => void): ScrollEntry => ({ height: 52, render: () => <View onPress={onToggle} focusable class="absolute inset-0 rounded-[26] bg-[#2a2a2a]"><Text class="absolute left-[12] top-[16] text-base leading-[20] text-[#f5f5f5]">{label}</Text><Show when={enabled} fallback={<View class="absolute right-[11] top-[13] w-[40] h-[26] rounded-[13] bg-[#555555]"><View class="absolute left-[3] top-[3] w-[20] h-[20] rounded-full bg-white" /></View>}><View class="absolute right-[11] top-[13] w-[40] h-[26] rounded-[13] bg-[#ff4d67]"><View class="absolute left-[17] top-[3] w-[20] h-[20] rounded-full bg-white" /></View></Show></View> });
  const entries = createMemo<ScrollEntry[]>(() => confirmDelete() ? [header("删除频道"), statusCard("确认删除？", "删除后将移除本地缓存"), button("确认删除", async () => { try { await props.settings.onDeleteChannel(); feedSnapshots.delete(props.client); setConfirmDelete(false); } catch (error) { setMessage(String(error)); setConfirmDelete(false); } }, true), button("取消", () => setConfirmDelete(false))] : [header("设置", loggedIn() ? "已登录" : "未登录"), setting("原文阅读模式", props.settings.originalContentEnabled, () => props.settings.onOriginalContentChange(!props.settings.originalContentEnabled)), { height: 24, render: () => <Text class="absolute left-[10] right-[10] top-[0] text-[11px] leading-[15] text-[#b6b6b6]">刷新时抓取原文正文与图片</Text> }, setting("在后台继续播放", props.settings.continuePlaybackInBackgroundEnabled, () => props.settings.onContinuePlaybackInBackgroundChange(!props.settings.continuePlaybackInBackgroundEnabled)), button("退出登录", loggedIn() ? async () => { try { await props.client.logout(); feedSnapshots.delete(props.client); setLoggedIn(false); setMessage("已退出登录"); } catch (e) { setMessage(`退出失败：${String(e)}`); } } : undefined, true), button("删除频道", () => setConfirmDelete(true), true), ...(message() ? [statusCard("状态", message())] : [])]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

function PlayerScreen(props: DouyinScreenProps & { awemeId: string }) {
  const playing = () => props.playbackState?.playing ?? true;
  const time = () => { const p = Math.floor((props.playbackState?.positionMs || 0) / 1000), d = Math.floor((props.playbackState?.durationMs || 0) / 1000); return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, "0")} / ${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`; };
  const entries = createMemo<ScrollEntry[]>(() => [header("正在播放", time()), statusCard("视频画面", "视频由宿主原生媒体表面显示"), button(playing() ? "暂停" : "继续播放", () => props.onPlaybackCommand?.("toggle")), button("重播", () => props.onPlaybackCommand?.("replay")), button("上一个", () => props.onPlaybackCommand?.("previous")), button("下一个", () => props.onPlaybackCommand?.("next")), button("视频操作", () => props.onNavigate({ name: "actions", awemeId: props.awemeId }))]);
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />;
}

export function DouyinScreen(props: DouyinScreenProps) {
  return <Show when={props.route} keyed>{route => {
    switch (route.name) {
      case "entry": return <EntryScreen {...props} />;
      case "login": return <LoginScreen {...props} />;
      case "feed": return <FeedScreen {...props} />;
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
