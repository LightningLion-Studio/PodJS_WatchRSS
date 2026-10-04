import {supportsSystemShare,openSystemShare} from "../sharing/host.ts";
import {CHANNEL_SHARE_QR_HINT,routeShare,type ShareHandler} from "../sharing/policy.ts";
import {wireFields} from "../sync/article-batches.ts";
import {managedCache} from "../cache/host.ts";
import {RemoteInputScreen} from "./RemoteInputScreen.tsx";
import {TtsConfigScreen} from './TtsConfigScreen.tsx';
import {enqueueRemoteInput,takeRemoteInput} from "../remote-input/inbox.ts";
import {ReaderPreviewScreen} from "./ReaderPreviewScreen.tsx";
import {readerPreviewSession,onReaderPreviewOpen,readerPreviewOpenRevision,setReaderPreviewVisible} from "../reader/preview-host.ts";
import {noteImageSource} from '../notes/presentation.ts';
import { PhoneConnectionScreen } from "./PhoneConnectionScreen.tsx";
import { enforcePlaybackStartVolume } from "../media/start-volume.ts";
import { SpeechPlaybackScreen } from "./SpeechPlaybackScreen.tsx";
import { SpeechPlayback, type SpeechPlaybackState } from "../reader/speech-playback.ts";
import {TtsConfigStore} from '../tts/config-store.ts';
import { ReaderPresetScreen } from "./ReaderPresetScreen.tsx";
import { ReaderPresetStore, onReaderPresetsChanged, activeReaderPreset, type ReaderPresetState } from "../reader/preset-store.ts";
import { defaultReaderPreset } from "../reader/preset.ts";
import {readerFontResolver} from "../reader/font-assets.ts";
import {LlmUsageScreen} from "./LlmUsageScreen.tsx";
import {LlmPromptPresetScreen} from "./LlmPromptPresetScreen.tsx";
import { biliVideoTarget, douyinVideoTarget } from "../reader/media.ts";
import { ChannelDetailScreen, ChannelSettingsScreen } from "./ChannelScreens.tsx";
import {ReaderScreen} from "./ReaderScreen.tsx";
import { resolveUrl } from "../core/parser.ts";
import { ImagePreviewScreen } from "./ImagePreviewScreen.tsx";
import { AutoScrollSettingsScreen } from "./AutoScrollSettingsScreen.tsx";
import { type ReaderBodyHandle } from "./ReaderBody.tsx";
import { getOps } from "@pocketjs/framework/host";
import { RssFeedScreen, RssActionsScreen } from "./RssScreens.tsx";
import { RssSearchScreen } from "./RssSearchScreen.tsx";
import { AddRssScreen } from "./AddRssScreen.tsx";
import {SavedItemsScreen,type SavedDisplayItem} from "./SavedItemsScreen.tsx";
import {shouldAutoRemoveWatchLater} from "../reader/watch-later-completion.ts";
import {loadFeedWindow} from "./feed-window.ts";
import { ShareQrScreen } from "./ShareQrScreen.tsx";
import { createBiliPlaybackCheckpoint, type BiliPlaybackCheckpointController } from "../bili/playback.ts";
import { DouyinPlaybackQueue } from "../douyin/playback-queue.ts";
import { DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT } from "../media/douyin-login.ts";
import type { DouyinSavedEntry } from "../douyin/index.ts";
import { ScrollEntries } from "./ScrollEntries.tsx";
import { authorizeInBrowser } from "../media/browser-auth.ts";
import { BiliScreen, type BiliRoute } from "./bili/index.tsx";
import { DouyinScreen, type DouyinRoute, type DouyinPlayRequest } from "./douyin/index.tsx";
import { biliClient, douyinClient } from "../media-services.ts";
import { VideoPlayerScreen, type PlaybackSource } from "./VideoPlayerScreen.tsx";
import { biliPlaybackSource } from "../playback.ts";
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { VirtualListHandle } from "@pocketjs/framework/virtual-list";
import { RelativeAxis, RelativeAxisUnits, lifecycle, onLifecycleChange, getDisplayMetrics, kv, onAxisDelta, onSystemBack, setNavigationState, __onHostEvent } from "@podjs/framework/watch";
import { browser, video, mediaVolume, hostOperation, delay } from "@podjs/framework/services";
import { layoutText } from "../reader/index.ts";
import type { AppServices, Article, Channel, ArticleQuery } from "./service.ts";
import { ProfileScreen } from "./ProfileScreen.tsx";
import { AccountStatusScreen } from "./AccountStatusScreen.tsx";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BackMotion } from "./back-motion.ts";
import HomeScreen from "./HomeScreen.tsx";
import { NotesListScreen, NoteDetailScreen, NoteActionsScreen, type NoteActionsHandle } from "./NotesScreen.tsx";
import { AdvancedSettingsScreen, SettingsScreen, SpeechSettingsScreen, type SettingsRoute } from "./SettingsScreen.tsx";
import { SettingsStore, type SettingsState } from "../settings/index.ts";
import { InformationScreen, type InformationPage } from "./InformationScreens.tsx";
import { RecommendationScreen } from "./RecommendationScreen.tsx";
import type { RecommendedChannel } from "../rss/recommendations.ts";
import { memoRepository } from "../services.ts";

type Page = "add-rss" | "remote-input" | "tts-config" | "reader-preview" | "phone-connection" | "account-status" | "speech-playback" | "settings-reader-presets" | "settings-llm-usage" | "settings-llm-preset" | "channel-detail" | "channel-settings" | "channel-share" | "reader-image" | "settings-auto-scroll" | "reader-scroll-controls" | "settings-speech" | "rss-actions" | "rss-share" | "bili" | "douyin" | "video" | "watch-later" | "home" | "profile" | "articles" | "saved" | "search" | "settings" | "settings-advanced" | "notes" | "note-detail" | "note-actions" | "recommendations" | "information" | "reader";
const bg = "#050507", panel = "#101014", ink = "#f4f4f6", muted = "#9a9aa5", accent = "#45d6a7", blue = "#3157a4";
const rowHeight = 48;

export default function WatchRSS(props: { services: AppServices; onSyncMediaKeepAliveChange?:(enabled:boolean)=>void }) {
  const metrics = getDisplayMetrics();
  const width = Math.max(160, metrics.logicalWidth - metrics.safeInsets.left - metrics.safeInsets.right);
  const height = Math.max(180, metrics.logicalHeight - metrics.safeInsets.top - metrics.safeInsets.bottom);
  type Entry = { addUrl?:string;imageUrl?:string;imageFilePath?:string; reader?:ReaderBodyHandle; readerArticle?:Article; readerFromWatchLater?:boolean; page: Page; channelId?:string; biliRoute?:BiliRoute; douyinRoute?:DouyinRoute; playback?:PlaybackSource; checkpoint?:BiliPlaybackCheckpointController; queue?:DouyinPlaybackQueue; noteId?:string; informationPage?:InformationPage; recommendationGroup?:string; list?: Pick<VirtualListHandle, "scroller">; internalBack?:()=>boolean; player?:{onCrown:(delta:number)=>boolean;canSwipeBack?:()=>boolean} };
  const [stack, setStack] = createSignal<Entry[]>([{ page: "home" }]);
  const [playingSource,setPlayingSource]=createSignal<PlaybackSource>();
  const current = () => stack()[stack().length - 1];
  const page = () => current().page;
  const motion = new BackMotion(width);
  const [backOffset, setBackOffset] = createSignal(0);
  function setPage(next: Page, data:Partial<Entry>={}) {
    if ((next === page() && Object.keys(data).length === 0) || motion.phase !== "idle") return;
    current().list?.scroller.stop();
    setStack(entries => [...entries, { page: next, ...data }]);
  }
  function popPage(skipInternal=false) {
    if (stack().length <= 1) return false;
    if(!skipInternal && current().internalBack?.()) { setBackOffset(0); motion.reset(); return true; }
    const leaving=current();
    const latestArticle=article()?.id===leaving.readerArticle?.id?article():leaving.readerArticle;
    const autoRemoveItem=leaving.page==="reader"&&stack().at(-2)?.page==="watch-later"&&shouldAutoRemoveWatchLater(!!leaving.readerFromWatchLater,leaving.reader?.reachedBottom()??false,!!latestArticle?.watchLater)?savedEntries().find(item=>item.kind==="rss"&&item.articleId===leaving.readerArticle?.id):undefined;
    current().queue?.cancel();
    if(leaving.page==="saved"||leaving.page==="watch-later")clearSavedUndo();
    if(current().page==="note-detail"||current().page==="note-actions") setNotesRefreshKey(value=>value+1);
    batch(() => { setStack(entries => entries.slice(0, -1)); setError(""); setBackOffset(0); });
    motion.reset();
    if(leaving.page==="search"&&leaving.channelId)void loadFeedArticles(leaving.channelId,feedVisibleCount());
    if(autoRemoveItem)void removeSaved(autoRemoveItem);
    else if(page()==="saved"||page()==="watch-later")void loadSaved(page()==="saved"?"favorite":"watchLater");
    return true;
  }
  createGesture({
    region: { rect: () => stack().length > 1 && motion.phase !== "settling" && (current().player?.canSwipeBack?.() ?? true) && current().page!=="reader-image" ? { x: 0, y: 0, w: width, h: height } : null },
    axis: "x", panSlop: 8,
    onPanStart: c => { current().list?.scroller.stop(); motion.begin(c.dx); setBackOffset(motion.offset); },
    onPanMove: c => { motion.move(c.dx); setBackOffset(motion.offset); },
    onPanEnd: c => { if (motion.phase === "dragging") motion.release(c.vx, Date.now()); },
    onCancel: () => { if (motion.phase === "dragging") motion.release(0, Date.now(), true); }
  });
  onFrame(() => {
    if (motion.phase !== "settling") return;
    const result = motion.tick(Date.now());
    if (result === "commit") popPage();
    else setBackOffset(motion.offset);
  });
  const contentHeight = height - 36;
  let currentQuery: ArticleQuery = {};
  const [channelPlayback,setChannelPlayback]=createSignal<Record<string,{hasPlayableMedia:boolean;continuePlaybackInBackground:boolean}>>({});
  const [originalModes,setOriginalModes]=createSignal<Record<string,boolean>>({});
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [articles, setArticles] = createSignal<Article[]>([]);
  const [savedVideos,setSavedVideos]=createSignal<DouyinSavedEntry[]>([]);
  const [savedEntries,setSavedEntries]=createSignal<SavedDisplayItem[]>([]);
  const [savedUndo,setSavedUndo]=createSignal<{item:SavedDisplayItem;video?:DouyinSavedEntry;type:"favorite"|"watchLater"}|null>(null);
  let savedUndoTimer:ReturnType<typeof delay>|null=null;
  let savedUndoVersion=0,savedLoadVersion=0;
  onCleanup(()=>savedUndoTimer?.cancel());
  const [article, setArticle] = createSignal<Article | null>(null);
  const [loading, setLoading] = createSignal(true), [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [searchResults,setSearchResults]=createSignal<Article[]>([]);
  const [searchLoading,setSearchLoading]=createSignal(false);
  let searchRequestVersion=0;
  let searchDebounce:ReturnType<typeof setTimeout>|undefined;
  createEffect(()=>{if(page()!=="search"&&searchDebounce){clearTimeout(searchDebounce);searchDebounce=undefined;searchRequestVersion++;}});
  onCleanup(()=>{if(searchDebounce)clearTimeout(searchDebounce);});
  const [feedVisibleCount,setFeedVisibleCount]=createSignal(12);
  const [feedHasMore,setFeedHasMore]=createSignal(false);
  const [feedLoadingMore,setFeedLoadingMore]=createSignal(false);
  let feedRequestVersion=0;
  const [speechState,setSpeechState] = createSignal<SpeechPlaybackState>();
  const speechPlayback = new SpeechPlayback(props.services,state=>{const previous=speechState();setSpeechState(state);if(state.phase==="error"&&state.error!==previous?.error&&page()!=="speech-playback")void hostOperation("ui.toast",{message:state.error??"朗读失败"}).result.catch(()=>{});},{now:()=>globalThis.performance?.now?.()??Date.now(),after:(ms,callback)=>{const timer=delay(ms);void timer.result.then(callback,()=>{});return()=>timer.cancel();}},isCurrent=>enforcePlaybackStartVolume(mediaVolume,settings().playbackStartVolumeLimit,isCurrent));
  const settingsStore = new SettingsStore();
  const ttsConfigStore = new TtsConfigStore();
  const [settings,setSettings] = createSignal<SettingsState>(settingsStore.load());
  const [systemShareAvailable,setSystemShareAvailable]=createSignal(false);
  const shareEnvironment=supportsSystemShare().catch(e=>{setError(String(e));return false;});
  let shareAlive=true;onCleanup(()=>{shareAlive=false;});
  void shareEnvironment.then(value=>{if(shareAlive)setSystemShareAvailable(value);});
  const share:ShareHandler=(input,qr)=>{
    const source=current();
    const finishSource=source.page==="rss-actions"||source.page==="bili"&&source.biliRoute?.name==="actions"||source.page==="douyin"&&source.douyinRoute?.name==="actions";
    void shareEnvironment.then(async supported=>{
      if(!shareAlive||current()!==source||motion.phase!=="idle")return;
      await routeShare(input,settings().shareUseSystem&&supported,{text:openSystemShare,qr,unavailable:()=>{void hostToast("暂无可分享链接");}});
      if(shareAlive&&finishSource){source.list?.scroller.stop();setStack(entries=>entries.length>1?entries.filter(entry=>entry!==source):entries);}
    }).catch(e=>{if(shareAlive)setError(String(e));});
  };
  createEffect(()=>props.onSyncMediaKeepAliveChange?.(settings().syncMediaKeepAlive));
  createEffect(()=>{void managedCache.configure(settings().cacheLimitMb*1024*1024).catch(error=>console.warn("Cache maintenance: "+String(error)));});
  const presetStore = new ReaderPresetStore();
  const [presetState, setPresetState] = createSignal<ReaderPresetState>();
  const [presetRevision, setPresetRevision] = createSignal(0);
  const [foreground, setForeground] = createSignal(lifecycle() === "active");
  onCleanup(onLifecycleChange(value => setForeground(value === "active")));
  try { setPresetState(presetStore.ensureSeeded(true, settings().fontSizeSp)); } catch (error) { setError(String(error)); }
  onCleanup(onReaderPresetsChanged(()=>{try{batch(() => { setPresetState(presetStore.load()); setPresetRevision(value => value + 1); });}catch(error){setError(String(error));}}));
  const [previewState,setPreviewState]=createSignal(readerPreviewSession.state());
  let previewOpenPending=!!readerPreviewSession.state()&&readerPreviewOpenRevision()>0;
  onCleanup(onReaderPreviewOpen(()=>{previewOpenPending=true;}));
  onCleanup(readerPreviewSession.subscribe(state=>{setPreviewState(state);if(!state){previewOpenPending=false;const wasCurrent=current().page==='reader-preview';for(const entry of stack())if(entry.page==='reader-preview')entry.list?.scroller.stop();setStack(entries=>entries.filter(entry=>entry.page!=='reader-preview'));if(wasCurrent){motion.reset();setBackOffset(0);}}}));
  onFrame(()=>{if(!previewOpenPending||motion.phase!=='idle'||!previewState())return;previewOpenPending=false;if(page()==='reader-preview')return;const existing=stack().findIndex(entry=>entry.page==='reader-preview');if(existing>=0)setStack(entries=>entries.slice(0,existing+1));else setPage('reader-preview');});
  createEffect(()=>setReaderPreviewVisible(page()==='reader-preview'));
  onCleanup(()=>setReaderPreviewVisible(false));
  const [presetClock, setPresetClock] = createSignal(new Date());
  onFrame(() => { if (presetState()?.selection.mode === "SYSTEM" && Math.floor(Date.now()/60000) !== Math.floor(presetClock().getTime()/60000)) setPresetClock(new Date()); });
  const readerPreset = createMemo(() => presetState() ? activeReaderPreset(presetState()!, presetClock()) : defaultReaderPreset(undefined, undefined, true, settings().fontSizeSp));
  const informationFonts = createMemo(() => readerFontResolver(presetState() ?? {}, presetRevision()));
  const informationBackground = createMemo(() => ({state:presetState() ?? {}, revision:presetRevision()}));
  const updatePreset = (change: () => ReaderPresetState) => { try { batch(() => { setPresetState(change()); setPresetRevision(value => value + 1); }); } catch (error) { setError(String(error)); } };
  const [notesRefreshKey,setNotesRefreshKey]=createSignal(0);

  async function loadChannels() { setLoading(true); setError(""); try { setChannels(await props.services.listChannels()); } catch (e) { setError(String(e)); } finally { setLoading(false); } }
  async function loadArticles(opts?: ArticleQuery) { setLoading(true); setError(""); try { const next = opts?.page ?? 0; currentQuery = { ...opts, page: next }; setArticles(await props.services.listArticles({ ...opts, page: next, pageSize: 30 })); } catch (e) { setError(String(e)); } finally { setLoading(false); } }
  async function loadSaved(type:"favorite"|"watchLater") {
    const version=++savedLoadVersion;
    setLoading(true);setError("");
    try {
      const rss:Article[]=[];
      for(let offset=0;;offset+=24){const part=await props.services.listArticles({saveType:type,offset,pageSize:24});rss.push(...part);if(part.length<24)break;}
      const videos=await douyinClient.listSaved(type);
      const entries:SavedDisplayItem[]=[
        ...rss.map(article=>({key:`rss:${article.id}`,kind:"rss" as const,articleId:article.id,title:article.title,summary:article.excerpt??"暂无摘要",channelTitle:article.channelTitle??"RSS",savedAt:article.savedAt??0,sortOrder:article.saveSortOrder??-(article.savedAt??0)})),
        ...videos.map(video=>({key:`douyin:${video.awemeId}`,kind:"douyin" as const,awemeId:video.awemeId,title:video.item.description||"抖音视频",summary:video.item.description||"暂无摘要",channelTitle:"抖音",savedAt:video.savedAtMillis,sortOrder:-video.savedAtMillis}))
      ];
      entries.sort((a,b)=>a.sortOrder-b.sortOrder||a.key.localeCompare(b.key));
      let order:string[]=[];
      try {const stored=JSON.parse(kv.get<string>(`watchrss.saved.order.${type}`)??"[]");if(Array.isArray(stored))order=stored.filter((key):key is string=>typeof key==="string");}catch{}
      if(order.length){const rank=new Map(order.map((key,index)=>[key,index]));entries.sort((a,b)=>{const ai=rank.get(a.key),bi=rank.get(b.key);return ai===undefined&&bi===undefined?a.sortOrder-b.sortOrder:ai===undefined?-1:bi===undefined?1:ai-bi;});}
      if(version===savedLoadVersion&&current().page===(type==="favorite"?"saved":"watch-later"))batch(()=>{setArticles(rss);setSavedVideos(videos);setSavedEntries(entries);currentQuery={saveType:type};});
    }catch(e){if(version===savedLoadVersion)setError(String(e));}finally{if(version===savedLoadVersion)setLoading(false);}
  }
  function clearSavedUndo(){savedUndoVersion++;savedUndoTimer?.cancel();savedUndoTimer=null;setSavedUndo(null);}
  async function removeSaved(item:SavedDisplayItem){
    const type=current().page==="saved"?"favorite":"watchLater";
    const video=item.kind==="douyin"?savedVideos().find(entry=>entry.awemeId===item.awemeId):undefined;
    try {
      if(item.kind==="rss")await props.services.setSaveState(item.articleId!,type,false);
      else if(video)await douyinClient.setSaved(video.item,type,false);
      else throw new Error("保存项目不存在");
      clearSavedUndo();setSavedUndo({item,video,type});
      const version=savedUndoVersion;
      savedUndoTimer=delay(3000);void savedUndoTimer.result.then(()=>{if(savedUndoVersion===version)setSavedUndo(null);},()=>{});
      setSavedEntries(entries=>entries.filter(entry=>entry.key!==item.key));
      if(item.kind==="rss")setArticles(items=>items.filter(article=>article.id!==item.articleId));else setSavedVideos(items=>items.filter(entry=>entry.awemeId!==item.awemeId));
      const key=`watchrss.saved.order.${type}`;
      try {const order=JSON.parse(kv.get<string>(key)??"[]");if(Array.isArray(order))kv.set(key,JSON.stringify(order.filter((value:unknown)=>value!==item.key)));}catch{}
    }catch(e){setError(String(e));}
  }
  async function undoSaved(){
    const undo=savedUndo();if(!undo)return;clearSavedUndo();
    try {if(undo.item.kind==="rss")await props.services.setSaveState(undo.item.articleId!,undo.type,true);else if(undo.video)await douyinClient.setSaved(undo.video.item,undo.type,true);await loadSaved(undo.type);}catch(e){setError(String(e));}
  }
  async function reorderSaved(items:SavedDisplayItem[]){
    const type=current().page==="saved"?"favorite":"watchLater",key=`watchrss.saved.order.${type}`;
    try {setSavedEntries(items);kv.set(key,JSON.stringify(items.map(item=>item.key)));await props.services.reorderSavedArticles(type,items.filter(item=>item.kind==="rss").map(item=>item.articleId!));}
    catch(e){kv.delete(key);setError(String(e));await loadSaved(type);}
  }
  async function loadFeedArticles(channelId:string,limit=feedVisibleCount(),initial=false) {
    const version=++feedRequestVersion;
    if(initial)setLoading(true);
    try {
      const window=await loadFeedWindow(props.services.listArticles,channelId,limit);
      if(version!==feedRequestVersion||page()!=="articles"||current().channelId!==channelId)return;
      batch(()=>{setArticles(window.items);setFeedVisibleCount(limit);setFeedHasMore(window.hasMore);currentQuery={channelId,page:0};});
    } catch(e) {if(version===feedRequestVersion)setError(String(e));}
    finally {if(version===feedRequestVersion){if(initial)setLoading(false);setFeedLoadingMore(false);}}
  }
  function loadMoreFeedArticles(){
    const channelId=current().channelId;
    if(page()!=="articles"||!channelId||feedLoadingMore()||loading()||busy()||!feedHasMore())return;
    const limit=Math.min(200,feedVisibleCount()+8);
    if(limit===feedVisibleCount())return;
    setFeedLoadingMore(true);
    void loadFeedArticles(channelId,limit);
  }
  async function go(next: Page) {
    if (motion.phase !== "idle") return;
    if (next === "notes") { setBusy(true); try { await memoRepository.initialize(); } catch(e) { setError(String(e)); return; } finally { setBusy(false); } }
    setPage(next); kv.set("page", next);
    if (next === "home") await loadChannels();
    if (next === "articles") {if(current().channelId)await loadFeedArticles(current().channelId!,12,true);else await loadArticles();}
    if (next === "saved" || next === "watch-later") await loadSaved(next === "saved" ? "favorite" : "watchLater");
    if (next === "notes") setLoading(false);
    if (["phone-connection","settings","settings-advanced","search","profile","recommendations","information","note-detail","note-actions"].includes(next)) setLoading(false);
  }
  async function openArticle(item: Article,fromWatchLater=false) { setBusy(true); try { const full = await props.services.getArticle(item.id); await props.services.markRead(item.id); setArticle({...(full ?? item),read:true}); setArticles(items=>items.map(a=>a.id===item.id?{...a,read:true}:a)); setChannels(items=>items.map(c=>c.id===item.channelId&&!item.read?{...c,unreadCount:Math.max(0,(c.unreadCount??0)-1)}:c)); setPage("reader",{readerArticle:{...(full??item),read:true},readerFromWatchLater:fromWatchLater}); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  async function openArticleActions(item:Article) {
    if(busy())return;
    const origin=current(); setBusy(true);
    try { const full=await props.services.getArticle(item.id); if(current()===origin){setArticle(full??item);setPage("rss-actions");} }
    catch(e){setError(String(e));} finally{setBusy(false);}
  }
  async function saveArticleState(type:"favorite"|"watchLater",saved:boolean,navigateBack=true) {
    const selected=article(); if(!selected||busy())return;
    setBusy(true);
    try {
      await props.services.setSaveState(selected.id,type,saved);
      const patch=type==="favorite"?{saved}:{watchLater:saved};
      setArticle({...selected,...patch});
      setArticles(items=>items.map(a=>a.id===selected.id?{...a,...patch}:a).filter(a=>a.id!==selected.id||saved||!((currentQuery.saveType??(currentQuery.saved?"favorite":undefined))===type)));
      if(navigateBack)popPage();
    } catch(e){setError(String(e));} finally{setBusy(false);}
  }
  async function toggleFeedSave(item:Article,type:"favorite"|"watchLater") {
    if(busy())return;
    const saved=type==="favorite"?!item.saved:!item.watchLater;
    setBusy(true);
    try {
      await props.services.setSaveState(item.id,type,saved);
      setArticles(items=>items.map(article=>article.id===item.id?{...article,...(type==="favorite"?{saved}:{watchLater:saved})}:article));
    } catch(e){setError(String(e));} finally{setBusy(false);}
  }
  async function openChannelSettings(id:string) {
    if(busy())return;const origin=current();setBusy(true);
    try { const [enabled,playback]=await Promise.all([props.services.getChannelOriginalMode(id),props.services.getChannelPlaybackSettings(id)]);setOriginalModes(m=>({...m,[id]:enabled}));setChannelPlayback(m=>({...m,[id]:playback}));if(current()===origin)setPage("channel-settings",{channelId:id}); }
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function channelAction(id:string,action:"original"|"background"|"read"|"delete"|"clear") {
    if(busy())return;setBusy(true);setError("");
    try {
      if(action==="original") {const enabled=!originalModes()[id];await props.services.setChannelOriginalMode(id,enabled);setOriginalModes(m=>({...m,[id]:enabled}));setChannels(items=>items.map(c=>c.id===id?{...c,useOriginalContent:enabled}:c));}
      else if(action==="background") {const value=channelPlayback()[id];if(!value?.hasPlayableMedia)return;const enabled=!value.continuePlaybackInBackground;await props.services.setChannelBackgroundPlayback(id,enabled);setChannelPlayback(m=>({...m,[id]:{...value,continuePlaybackInBackground:enabled}}));}
      else if(action==="read") {await props.services.markChannelRead(id);setArticles(items=>items.map(a=>a.channelId===id?{...a,read:true}:a));setChannels(items=>items.map(c=>c.id===id?{...c,unreadCount:0}:c));}
      else if(action==="clear") {await props.services.clearLocalContent(id);setArticles(items=>items.filter(a=>a.channelId!==id));setChannels(items=>items.map(c=>c.id===id?{...c,unreadCount:0}:c));setChannelPlayback(m=>({...m,[id]:{...m[id],hasPlayableMedia:false}}));}
      else {await props.services.deleteChannel(id);setChannels(items=>items.filter(c=>c.id!==id));setArticles(items=>items.filter(a=>a.channelId!==id));setStack([{page:"home"}]);}
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  function searchChannel(id:string) {if(searchDebounce)clearTimeout(searchDebounce);searchDebounce=undefined;searchRequestVersion++;setQuery("");setSearchResults([]);setPage("search",{channelId:id});}
  function updateSearchKeyword(channelId:string,value:string){
    if(searchDebounce)clearTimeout(searchDebounce);
    searchRequestVersion++;setQuery(value);setSearchResults([]);setSearchLoading(false);
    if(!value.trim())return;
    searchDebounce=setTimeout(()=>{searchDebounce=undefined;if(current().page==="search"&&current().channelId===channelId)void searchChannelArticles(channelId,value);},180);
  }
  async function searchChannelArticles(channelId:string,keyword:string) {
    const version=++searchRequestVersion;
    const term=keyword.trim();
    setQuery(keyword);setError("");setSearchResults([]);
    if(!term){setSearchLoading(false);return;}
    setSearchLoading(true);
    try {
      const found=props.services.searchArticles?await props.services.searchArticles(channelId,term):await props.services.listArticles({channelId,query:term,pageSize:120});
      if(version===searchRequestVersion&&current().page==="search"&&current().channelId===channelId)setSearchResults(found);
    }catch(e){if(version===searchRequestVersion&&current().page==="search"&&current().channelId===channelId)setError(String(e));}
    finally{if(version===searchRequestVersion)setSearchLoading(false);}
  }
  async function refresh() { setBusy(true); setError(""); try { await props.services.refresh(current().channelId); if(page()==="home") await loadChannels(); else if(page()==="articles"&&current().channelId)await loadFeedArticles(current().channelId!,feedVisibleCount());else if(page()==="saved"||page()==="watch-later")await loadSaved(page()==="saved"?"favorite":"watchLater");else if(page()==="search"&&current().channelId)await searchChannelArticles(current().channelId!,query());else await loadArticles(currentQuery); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  const pendingFeedUpdates=new Set<string>();let updatingFeed=false,pendingLibraryUpdate=false;
  function updateFeedWhenSettled(){
    const origin=current(),id=origin.channelId,snapshot=currentQuery;
    const libraryUpdate=pendingLibraryUpdate&&["articles","saved","watch-later","search"].includes(origin.page);
    if(updatingFeed||feedLoadingMore()||(!libraryUpdate&&(!id||!pendingFeedUpdates.has(id)||origin.page!=="articles"))||origin.list?.scroller.state()!=="idle")return;
    if(id)pendingFeedUpdates.delete(id);if(libraryUpdate)pendingLibraryUpdate=false;updatingFeed=true;
    if(origin.page==="search"){
      void (id&&query().trim()?searchChannelArticles(id,query()):Promise.resolve()).finally(()=>{updatingFeed=false;});
      return;
    }
    const feed=origin.page==="articles"&&!!id,limit=feed?feedVisibleCount():30;
    const request=feed?loadFeedWindow(props.services.listArticles,id!,limit):props.services.listArticles({...snapshot,page:snapshot.page,pageSize:30}).then(items=>({items,hasMore:false}));
    void request.then(window=>{
      if(current()===origin&&currentQuery===snapshot){if(origin.list?.scroller.state()==="idle"){setArticles(window.items);if(feed)setFeedHasMore(window.hasMore);}else {if(id)pendingFeedUpdates.add(id);if(libraryUpdate)pendingLibraryUpdate=true;}}
      else {if(id)pendingFeedUpdates.add(id);if(libraryUpdate)pendingLibraryUpdate=true;}
    }).catch(e=>setError(String(e))).finally(()=>{updatingFeed=false;});
  }
  onFrame(updateFeedWhenSettled);
  onMount(() => {
    const unsubscribe=props.services.subscribeChannel(event=>{
      if(event.kind==="error"){if(current().channelId===event.id)setError(event.message??"刷新失败");return;}
      if(event.kind==="notes"){setNotesRefreshKey(v=>v+1);return;}
      if(event.kind==="library")pendingLibraryUpdate=true;
      if(event.kind==="refresh"||event.kind==="library")void props.services.listChannels().then(setChannels).catch(e=>setError(String(e)));
      pendingFeedUpdates.add(event.id);updateFeedWhenSettled();
    });
    onCleanup(unsubscribe);void go(page());
  });
  createEffect(() => setNavigationState({ canGoBack: stack().length > 1 }));
  const removeHostEvent = __onHostEvent(event => {
    if (event.t === "touchCancel" && motion.phase === "dragging") motion.release(0, Date.now(), true);
    if (event.t === "lifecycle" && event.state !== "active" && motion.phase !== "idle") {
      motion.reset(); setBackOffset(0);
    }
  });
  const removeBack = onSystemBack(() => {
    if (stack().length <= 1) return false;
    if (motion.phase !== "idle") return true;
    motion.begin(0); motion.release(0, Date.now(), false, true);
    return true;
  });
  const removeAxis = onAxisDelta(RelativeAxis.Primary, (delta: number) => { if (motion.phase === "idle" && !current().player?.onCrown(delta)) {if(current().page==="reader")current().reader?.manualScroll();current().list?.scroller.scrollBy(delta * rowHeight / (12 * RelativeAxisUnits.PerDegree), { durMs: 120 });} });
  onCleanup(() => { void speechPlayback.stop(); removeBack(); removeAxis(); removeHostEvent(); });

  const readerFont=()=>{const size=settings().fontSizeSp,base=Math.min(18,size);return {slot:(base-12)/2,scale:size/base};};
  const readerLineHeight=()=>readerPreset().body.fontSizeSp*readerPreset().body.lineHeightEm;
  const doAdd = async (prefill="") => {setPage("add-rss",{addUrl:prefill});};
  const openUrl=async(url:string)=>{try{await browser.open(url).result;}catch(e){setError(String(e));}};
  const updateSettings=(patch:Partial<SettingsState>)=>{try{setSettings(settingsStore.update(patch));if(patch.speechRate!==undefined)ttsConfigStore.setSpeed(patch.speechRate);}catch(e){setError(String(e));}};
  let remotePromptActive=false;
  onFrame(()=>{if(lifecycle()!=="active"||remotePromptActive||busy()||loading()||motion.phase!=="idle")return;const url=takeRemoteInput();if(url===undefined)return;if(page()==="remote-input")popPage(true);remotePromptActive=true;void doAdd(url).catch(error=>setError(String(error))).finally(()=>{remotePromptActive=false;});});
  const settingsNavigate=(route:SettingsRoute)=>{if(route==="reader-presets"){if(presetState())setPage("settings-reader-presets");else setError("阅读器预设数据无法读取，已保留原数据");}else if(route==="llm-usage")setPage("settings-llm-usage");else if(route==="llm-preset")setPage("settings-llm-preset");else if(route==="auto-scroll")setPage("settings-auto-scroll");else if(route==="tts")setPage("settings-speech");else if(route==="tts-config")setPage("tts-config");else if(route==="remote-input")setPage("remote-input");else if(route==="advanced")setPage("settings-advanced");else if(route==="beian")setPage("information",{informationPage:"beian"});else setError("此设置页尚未迁移");};
  const informationNavigate=(informationPage:InformationPage)=>setPage("information",{informationPage});
  const openVideo=async(source:PlaybackSource,extra:Partial<Entry>={})=>{
    const origin=current(); setBusy(false); setError("");
    await video.captureBackdrop();
    if(current()!==origin || motion.phase!=="idle") {await video.stop();return;}
    setPlayingSource(source);setPage("video",{playback:source,...extra});
  };
  const playbackPreferences=()=>({digitalCrownVolume:settings().mediaVolumeControl,volumeGuard:settings().mediaVolumeGuard,startVolumeLimit:settings().playbackStartVolumeLimit});
  async function openRssVideo(article:Article,rawUrl:string) {
    if(busy())return;const origin=current();setBusy(true);setError("");
    try {
      const bili=biliVideoTarget(rawUrl)??biliVideoTarget(article.link);
      if(bili){
        const detail=bili.cid?undefined:await biliClient.detail(bili);const cid=bili.cid??detail?.pages[0]?.cid;
        if(!cid)throw new Error("视频没有可播放的分 P");
        if(current()!==origin)return;
        await biliNavigate({name:"player",...bili,cid,title:article.title});return;
      }
      const preferences=article.channelId?await props.services.getChannelPlaybackSettings(article.channelId):{continuePlaybackInBackground:false};
      const resolved=resolveUrl(rawUrl,article.link)??rawUrl,douyin=douyinVideoTarget(article.link)??douyinVideoTarget(rawUrl);
      let url=resolved,headers:Record<string,string>|undefined;
      if(douyin){
        headers=await douyinClient.buildPlaybackHeaders();
        if(douyin.awemeId){const result=await douyinClient.resolvePlayback(douyin.awemeId);if(result.ok)url=result.data.playUrl;else if(douyinVideoTarget(resolved))throw new Error(result.message);}
      }
      if(current()!==origin)return;
      await openVideo({url,headers,webUrl:douyin?.webUrl??resolved,title:article.title,platform:"rss",backgroundPlayback:preferences.continuePlaybackInBackground,...playbackPreferences()});
    }finally{setBusy(false);}
  }
  const biliNavigate=async(route:BiliRoute)=>{
    if(route.name!=="player"){setPage("bili",{biliRoute:route});if(route.name==="entry"){const session=await biliClient.getSession();if(session?.refreshToken)void biliClient.refreshCookies().catch(e=>setError(String(e)));}return;}
    const origin=current();setBusy(true);try{
      const source=route.source??await biliClient.resolvePlayback({aid:Number(route.aid)||undefined,bvid:route.bvid,cid:Number(route.cid),preferMp4:true});
      const session=await biliClient.getSession();
      const headers:Record<string,string>={Referer:"https://www.bilibili.com/","User-Agent":"Mozilla/5.0"};
      if(session)headers.Cookie=Object.entries(session.cookies).map(([key,value])=>`${key}=${value}`).join("; ");
      const checkpoint=createBiliPlaybackCheckpoint({storage:{get:async key=>kv.get<string>(key),set:async(key,value)=>{kv.set(key,value);},delete:async key=>{kv.delete(key);}},reporter:biliClient,target:{aid:Number(route.aid)||undefined,bvid:route.bvid,cid:Number(route.cid)}});
      const resume=await checkpoint.restore();
      if(current()!==origin)return;
      await openVideo({...biliPlaybackSource(source,route.title??"哔哩哔哩",headers),...playbackPreferences(),resumePositionMs:resume?.positionMs,platform:"bili",backgroundPlayback:biliBackground(),webUrl:route.bvid?`https://www.bilibili.com/video/${route.bvid}`:`https://www.bilibili.com/video/av${route.aid}`},{checkpoint});
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const douyinLogin=async()=>{setError("");try{const result=await authorizeInBrowser({url:"https://www.douyin.com/chat?isPopup=1",cookieOrigin:"https://www.douyin.com",qrExtractionScript:DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT,requiredCookieNames:["sessionid"],userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0"}).result;const saved=await douyinClient.applyCookie(result.cookie);if(!saved.ok)throw new Error(saved.message);setPage("douyin",{douyinRoute:{name:"entry"}});}catch(e){setError(String(e));}};
  let pendingDouyinPlayback:Promise<PlaybackSource>|undefined,pendingDouyinQueue:DouyinPlaybackQueue|undefined;
  const douyinPlay=(request:DouyinPlayRequest)=>{pendingDouyinQueue=new DouyinPlaybackQueue(douyinClient,{items:request.playlist??[request.item],selectedAwemeId:request.item.awemeId,cursor:request.cursor,hasMore:request.hasMore});pendingDouyinPlayback=douyinClient.buildPlaybackHeaders().then(headers=>({url:request.playback.playUrl,title:request.item.description,headers,...playbackPreferences(),platform:"douyin" as const,webUrl:`https://www.douyin.com/video/${request.item.awemeId}`,backgroundPlayback:douyinBackground()}));};
  const douyinNavigate=async(route:DouyinRoute)=>{if(route.name==="player"&&pendingDouyinPlayback){try{await openVideo(await pendingDouyinPlayback,{queue:pendingDouyinQueue});}catch(e){setError(String(e));}finally{pendingDouyinPlayback=undefined;pendingDouyinQueue=undefined;}}else setPage("douyin",{douyinRoute:route});};
  const changeDouyinVideo=async(entry:Entry,direction:"next"|"previous")=>{
    if(!entry.queue || current()!==entry)return;
    const result=await entry.queue[direction](); if(current()!==entry)return;
    if(!result.ok)throw new Error(result.message);
    const headers=await douyinClient.buildPlaybackHeaders();if(current()!==entry)return;
    setPlayingSource({...entry.playback!,url:result.data.item.playUrl,title:result.data.item.description,headers,webUrl:`https://www.douyin.com/video/${result.data.item.awemeId}`});
  };
  const [biliOriginal,setBiliOriginal]=createSignal(kv.get<boolean>("watchrss.bili.original-content")??false);
  const [douyinOriginal,setDouyinOriginal]=createSignal(kv.get<boolean>("watchrss.douyin.original-content")??false);
  const [biliBackground,setBiliBackground]=createSignal(kv.get<boolean>("watchrss.bili.background-playback")??false);
  const [douyinBackground,setDouyinBackground]=createSignal(kv.get<boolean>("watchrss.douyin.background-playback")??false);
  const hostToast=(message:string)=>hostOperation("ui.toast",{message}).result.catch(()=>{});
  const mediaSetting=(platform:string,key:string,value:boolean,setter:(value:boolean)=>unknown)=>{kv.set(`watchrss.${platform}.${key}`,value);setter(value);};
  const deleteBuiltin=async(platform:"bili"|"douyin")=>{
    if(busy())return;
    setBusy(true);setError("");
    try{
      // These cards can exist without a persisted channel in older PodJS installs.
      // Remove a real channel when present; otherwise still clear its own cache.
      if(platform==="douyin")await douyinClient.logout();
      const channel=(await props.services.listChannels()).find(item=>item.url===`builtin:${platform}`);
      if(channel)await props.services.deleteChannel(channel.id);
      else await managedCache.clearBucket(platform==="bili"?"bili-preview":"douyin-preload");
      setChannels(items=>items.filter(item=>item.url!==`builtin:${platform}`));
      setStack([{page:"home"}]);
    }catch(error){setError(String(error));throw error;}
    finally{setBusy(false);}
  };
  const addRecommendation=(channel:RecommendedChannel)=>{void doAdd(channel.url);};
  const openAddedChannel=async(channel:Channel)=>{
    await loadChannels();
    if(page()==="add-rss")setStack(entries=>entries.slice(0,-1));
    if(channel.url==="builtin:bili")await biliNavigate({name:"entry"});
    else if(channel.url==="builtin:douyin")await douyinNavigate({name:"entry"});
    else {setFeedVisibleCount(12);setFeedHasMore(false);setPage("articles",{channelId:channel.id});await loadFeedArticles(channel.id,12,true);}
  };
  

  const renderPage = (entry: Entry) => {
    const page = () => entry.page;
    const active = () => current() === entry;
    const title = () => ({"add-rss":"添加 RSS","remote-input":"从手机输入","tts-config":"配置朗读语音","reader-preview":"预设实时预览","phone-connection":"连接手机","account-status":"账号","speech-playback":"朗读播控","settings-reader-presets":"阅读器预设","settings-llm-usage":"Token 消耗","settings-llm-preset":"提示词预设","channel-detail":"频道详情","channel-settings":"频道设置","channel-share":"分享频道","reader-image":"图片","settings-auto-scroll":"自动滚动控制","reader-scroll-controls":"自动滚动控制", "rss-actions":"操作","rss-share":"分享",bili:"哔哩哔哩",douyin:"抖音",video:"播放",home: "", profile: "我的", articles: "文章", saved: "收藏", "watch-later":"稍后再看", search: "搜索", "settings-speech":"朗读语速", settings: "设置", "settings-advanced":"高级", notes: "备忘录", "note-detail":"备忘录", "note-actions":"笔记操作", recommendations:"RSS推荐", information:"信息", reader: "阅读" }[page()]);
    const selfTitled=()=>["add-rss","remote-input","tts-config","reader-preview","phone-connection","account-status","speech-playback","settings-reader-presets","settings-llm-usage","settings-llm-preset","reader","channel-detail","channel-settings","channel-share","reader-image","settings-auto-scroll","reader-scroll-controls","rss-actions","rss-share","articles","saved","watch-later","search","bili","douyin","video","home","profile","settings","settings-speech","settings-advanced","notes","note-detail","note-actions","recommendations","information"].includes(page());
    return <View class={page()==="video" ? (metrics.shape === "round" && active() && backOffset() > 0 ? "absolute inset-0 overflow-hidden rounded-[9999]" : "absolute inset-0 overflow-hidden") : (metrics.shape === "round" && active() && backOffset() > 0 ? "absolute inset-0 overflow-hidden rounded-[9999] bg-[#000000]" : "absolute inset-0 overflow-hidden bg-[#000000]")} style={{ translateX: active() ? backOffset() : current().page === "video" ? -2 * width : 0, opacity: current().page==="video" && !active() ? 0 : (stack().indexOf(entry) >= stack().length - 2 ? 1 : 0) }}>
    <Show when={!selfTitled()}><View class="absolute left-[12] right-[12] top-[8] h-[30] items-center justify-center"><Text class="text-lg text-white">{title()}</Text></View></Show>
    <Show when={error()}><View class="absolute left-[12] right-[12] top-[38] h-[28] z-10 rounded-[8] bg-[#4b2030] items-center justify-center"><Text class="text-xs text-[#ffd5dc]">{error()}</Text></View></Show>
    <Show when={busy()}><Text class="absolute right-[14] top-[18] text-xs text-[#45d6a7]">处理中</Text></Show>
    <View class={page()==="video" ? "absolute left-[0] right-[0] bottom-[0] overflow-hidden" : "absolute left-[0] right-[0] bottom-[0] overflow-hidden bg-[#000000]"} style={{insetT:selfTitled()?0:42}}>
      <Show when={!active() || !loading() || page()==="saved" || page()==="watch-later"} fallback={<View class="absolute inset-0 items-center justify-center"><Text class="text-sm text-[#9aa9c4]">加载中…</Text></View>}>
        <Show when={page() === "home"}><HomeScreen width={width} channels={channels()} height={height} onProfile={() => void go("profile")} onNotes={() => void go("notes")} onRecommend={() => void go("recommendations")} onAdd={() => void doAdd()} onChannel={channel => { if(channel.url==="builtin:bili")void biliNavigate({name:"entry"});else if(channel.url==="builtin:douyin")douyinNavigate({name:"entry"}); else { setFeedVisibleCount(12);setFeedHasMore(false);setPage("articles",{channelId:channel.id});void loadFeedArticles(channel.id,12,true); } }} onBeian={() => informationNavigate("beian")} ref={v => entry.list = v} /></Show>
        <Show when={page() === "add-rss"}><AddRssScreen width={width} height={height} active={active()} initialUrl={entry.addUrl??""} preview={props.services.previewChannel} confirm={props.services.confirmAddChannel} input={props.services.input} openInlineInput={props.services.openInlineInput} onAdded={channel=>void openAddedChannel(channel).catch(error=>setError(String(error)))} onExisting={channel=>void openAddedChannel(channel).catch(error=>setError(String(error)))} ref={value=>{entry.list=value;entry.internalBack=value.onRootBack;}}/></Show>
        <Show when={page() === "profile"}><ProfileScreen height={height} onSelect={i => { if (i === 0) void go("account-status"); else if (i === 1) void go("saved"); else if (i === 2) void go("watch-later"); else if (i === 3) void go("phone-connection"); else if (i === 4) void go("settings"); else if(i===5) informationNavigate("about"); else if(i===6) informationNavigate("contact-developer"); else setError("此页面尚未迁移"); }} onBeian={() => informationNavigate("beian")} ref={v => entry.list = v} /></Show>
        <Show when={page() === "account-status"}><AccountStatusScreen width={width} height={height} active={active} load={props.services.readAccountStatus} subscribe={props.services.subscribeAccountStatus} onError={setError} ref={value=>{entry.list=value;entry.internalBack=value.onRootBack;}}/></Show>
        <Show when={page() === "phone-connection"}><PhoneConnectionScreen width={width} height={height} active={active} onError={setError} ref={value=>{entry.list=value;entry.internalBack=value.onRootBack;}}/></Show>
        <Show when={page() === "search"}><RssSearchScreen width={width} height={height} active={active()} keyword={query()} results={searchResults()} loading={searchLoading()} onInput={()=>{void props.services.input("搜索文章",query()).then(value=>{if(value!==null&&entry.channelId)void searchChannelArticles(entry.channelId,value);}).catch(e=>setError(String(e)));}} onKeywordChange={value=>{if(entry.channelId)updateSearchKeyword(entry.channelId,value);}} openInlineInput={props.services.openInlineInput} onOpen={a=>void openArticle(a)} ref={v=>entry.list=v}/></Show>
        <Show when={["channel-detail","channel-settings","channel-share"].includes(page())&&channels().find(c=>c.id===entry.channelId)}>{c=><>
          <Show when={page()==="channel-detail"}><ChannelDetailScreen width={width} height={height} channel={c()} busy={busy()} onSettings={()=>void openChannelSettings(c().id)} onSearch={()=>searchChannel(c().id)} onShare={()=>share({origin:"channel",title:c().title,link:c().url},()=>setPage("channel-share",{channelId:c().id}))} onMarkRead={()=>void channelAction(c().id,"read")} ref={v=>entry.list=v}/></Show>
          <Show when={page()==="channel-settings"}><ChannelSettingsScreen width={width} height={height} channel={c()} busy={busy()} original={originalModes()[c().id]??false} hasPlayableMedia={channelPlayback()[c().id]?.hasPlayableMedia??false} background={channelPlayback()[c().id]?.continuePlaybackInBackground??false} onBackground={()=>void channelAction(c().id,"background")} onOriginal={()=>void channelAction(c().id,"original")} onClear={()=>channelAction(c().id,"clear")} onDelete={()=>void channelAction(c().id,"delete")} ref={v=>entry.list=v}/></Show>
          <Show when={page()==="channel-share"}><ShareQrScreen width={width} height={height} title={c().title} url={c().url} topHint={CHANNEL_SHARE_QR_HINT} onClose={()=>popPage()} onError={setError}/></Show>
        </>}</Show>
        <Show when={page() === "articles"}><RssFeedScreen width={width} height={height} active={active()} originalEnabled={channels().find(c=>c.id===entry.channelId)?.useOriginalContent} onOriginalPaused={paused=>{if(entry.channelId)props.services.setOriginalUpdatesPaused(entry.channelId,paused);}} onOriginalContents={ids=>{if(entry.channelId)void props.services.requestOriginalContents(entry.channelId,ids).catch(()=>{});}} title={channels().find(c=>c.id===entry.channelId)?.title??"文章"} onInfo={()=>{if(entry.channelId)setPage("channel-detail",{channelId:entry.channelId});}} items={articles()} refreshing={busy()} loadingMore={feedLoadingMore()} canNext={feedHasMore()} onOpen={a=>void openArticle(a)} onActions={a=>void openArticleActions(a)} onFavorite={a=>void toggleFeedSave(a,"favorite")} onWatchLater={a=>void toggleFeedSave(a,"watchLater")} onRefresh={()=>void refresh()} onNext={loadMoreFeedArticles} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "saved" || page() === "watch-later"}><SavedItemsScreen width={width} height={height} active={active()} type={page()==="saved"?"favorite":"watchLater"} items={savedEntries()} loading={loading()} undoVisible={!!savedUndo()} onOpen={item=>{if(item.kind==="rss"){const value=articles().find(article=>article.id===item.articleId);if(!value)return;const bili=value.link?.includes("/video/")?biliVideoTarget(value.link):null;if(bili)void biliNavigate({name:"detail",...bili});else void openArticle(value,page()==="watch-later");}else if(item.awemeId)void douyinNavigate({name:"detail",awemeId:item.awemeId});}} onRemove={item=>void removeSaved(item)} onUndo={()=>void undoSaved()} onReorder={items=>void reorderSaved(items)} onError={setError} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "bili"}><BiliScreen onShare={share} width={width} height={height} route={entry.biliRoute??{name:"entry"}} client={biliClient} settings={{showOriginalContent:true,originalContentEnabled:biliOriginal(),onOriginalContentChange:value=>mediaSetting("bili","original-content",value,setBiliOriginal),showContinuePlaybackInBackground:true,continuePlaybackInBackgroundEnabled:biliBackground(),onContinuePlaybackInBackgroundChange:value=>mediaSetting("bili","background-playback",value,setBiliBackground),deleteEnabled:channels().some(item=>item.url==="builtin:bili"),onDeleteChannel:()=>deleteBuiltin("bili")}} onNavigate={route=>void biliNavigate(route).catch(e=>setError(String(e)))} onBack={()=>popPage()} input={(title,value)=>props.services.input(title,value)} onError={setError} onOpenUrl={url=>void openUrl(url)} ref={v=>{if(v.scroller)entry.list={scroller:v.scroller};entry.internalBack=v.onRootBack;}}/></Show>
        <Show when={page() === "douyin"}><DouyinScreen onShare={share} width={width} height={height} route={entry.douyinRoute??{name:"entry"}} client={douyinClient} settings={{originalContentEnabled:douyinOriginal(),onOriginalContentChange:value=>mediaSetting("douyin","original-content",value,setDouyinOriginal),continuePlaybackInBackgroundEnabled:douyinBackground(),onContinuePlaybackInBackgroundChange:value=>mediaSetting("douyin","background-playback",value,setDouyinBackground),onDeleteChannel:()=>deleteBuiltin("douyin")}} onNavigate={douyinNavigate} onBack={()=>popPage()} onPlay={douyinPlay} onRequestQrLogin={()=>void douyinLogin()} input={(title,value)=>props.services.input(title,value)} onUnsupported={setError} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "video" && entry.playback}><VideoPlayerScreen width={width} height={height} source={active()?(playingSource()??entry.playback!):entry.playback!} active={active()} offset={active()?backOffset():0} round={metrics.shape==="round"} onOpenWeb={()=>void openUrl((playingSource()??entry.playback)?.webUrl??"")} onProgress={(p,d)=>void entry.checkpoint?.onProgress(p,d).catch(e=>setError(String(e)))} onCheckpoint={(t,p,d)=>void entry.checkpoint?.onCheckpoint(t,p,d).catch(e=>setError(String(e)))} onNext={entry.queue?()=>changeDouyinVideo(entry,"next"):undefined} onPrevious={entry.queue?()=>changeDouyinVideo(entry,"previous"):undefined} ref={handle=>entry.player=handle}/></Show>
        <Show when={page()==="rss-actions" && article()}>{a=><RssActionsScreen width={width} height={height} article={a()} systemShare={settings().shareUseSystem&&systemShareAvailable()} busy={busy()} onBack={()=>popPage()} onShare={()=>share({origin:"detail",title:wireFields.trim(a().title),link:wireFields.trim(a().link??"")},()=>setPage("rss-share"))} onSave={(type,saved)=>void saveArticleState(type,saved)} ref={v=>entry.list=v}/>}</Show>
        <Show when={page()==="rss-share" && article()}>{a=><ShareQrScreen width={width} height={height} title={a().title} url={a().link??""} onClose={()=>popPage()} onError={setError}/>}</Show>
        <Show when={page()==="settings-llm-usage"}><LlmUsageScreen width={width} height={height} load={()=>props.services.readSummaryUsage!()} clear={()=>props.services.clearSummaryUsage!()} onBack={()=>popPage()} onError={setError} ref={v=>{entry.list=v;entry.internalBack=v.onRootBack;}}/></Show>
        <Show when={page()==="settings-reader-presets"&&presetState()}>{state=><ReaderPresetScreen width={width} height={height} state={state()} active={active} onMode={mode=>updatePreset(()=>presetStore.setThemeMode(mode))} onSelect={(kind,id)=>updatePreset(()=>presetStore.selectPreset(kind,id))} onSchedule={patch=>updatePreset(()=>presetStore.updateSchedule(patch))} onLocation={(latitude,longitude)=>updatePreset(()=>presetStore.setSunLocation(latitude,longitude))} onError={setError} ref={value=>{entry.list=value;entry.internalBack=value.goBack;}}/>}</Show>
        <Show when={page()==="settings-llm-preset"}><LlmPromptPresetScreen width={width} height={height} state={settings()} onChange={updateSettings} onNavigate={settingsNavigate} ref={v=>entry.list=v}/></Show>
        <Show when={page()==="remote-input"}><RemoteInputScreen width={width} height={height} active={active} onUrl={enqueueRemoteInput} onDismiss={()=>popPage()} onError={setError} ref={value=>{entry.internalBack=value.onRootBack;}}/></Show>
        <Show when={page()==="tts-config"}><TtsConfigScreen width={width} height={height} active={active} onSaved={()=>setSettings(settingsStore.load())} onDismiss={()=>popPage()} onError={setError} ref={value=>{entry.internalBack=value.onRootBack;}}/></Show>
        <Show when={page() === "settings"}><SettingsScreen hasSummaryAccount={props.services.hasSummaryAccount} active={active} width={width} height={height} state={settings()} onChange={updateSettings} onNavigate={settingsNavigate} onUnsupported={setError} ref={v=>entry.list=v}/></Show>
        <Show when={page()==="settings-auto-scroll"||page()==="reader-scroll-controls"}><AutoScrollSettingsScreen width={width} height={height} state={settings()} onChange={updateSettings} onNavigate={settingsNavigate} reader={page()==="reader-scroll-controls"?entry.reader:undefined} onReturn={page()==="reader-scroll-controls"?()=>popPage():undefined} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "settings-speech"}><SpeechSettingsScreen width={width} height={height} state={settings()} onChange={updateSettings} onNavigate={settingsNavigate} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "settings-advanced"}><AdvancedSettingsScreen systemShareSupported={systemShareAvailable()} width={width} height={height} state={settings()} onChange={updateSettings} onNavigate={settingsNavigate} onUnsupported={setError} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "notes"}><NotesListScreen width={width} height={height} repository={memoRepository} refreshKey={notesRefreshKey()} onOpenNote={noteId=>setPage("note-detail",{noteId})} onCreateNote={()=>setPage("note-detail")} onOpenActions={noteId=>setPage("note-actions",{noteId})} onError={setError} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "note-detail"}><NoteDetailScreen width={width} height={height} repository={memoRepository} refreshKey={notesRefreshKey()} noteId={entry.noteId} preset={readerPreset()} backgroundSnapshot={informationBackground()} active={active()} onImage={path=>{const source=noteImageSource(path);setPage("reader-image",{imageUrl:source.url,imageFilePath:source.filePath});}} input={(title,value)=>props.services.input(title,value)} onBack={()=>{setNotesRefreshKey(v=>v+1);popPage(true);}} onError={setError} ref={v=>{entry.list=v.scroller?{scroller:v.scroller}:undefined;entry.internalBack=v.goBack;}}/></Show>
        <Show when={page() === "note-actions" && entry.noteId}><NoteActionsScreen width={width} height={height} repository={memoRepository} refreshKey={notesRefreshKey()} noteId={entry.noteId!} onDone={()=>{setNotesRefreshKey(v=>v+1);popPage(true);}} onError={setError} ref={(v:NoteActionsHandle)=>{entry.list=v;entry.internalBack=v.goBack;}}/></Show>
        <Show when={page() === "recommendations"}><RecommendationScreen width={width} height={height} groupId={entry.recommendationGroup} onGroup={recommendationGroup=>setPage("recommendations",{recommendationGroup})} onAdd={addRecommendation} ref={v=>entry.list=v}/></Show>
        <Show when={page() === "information"}><InformationScreen width={width} height={height} preset={readerPreset()} fonts={informationFonts()} backgroundSnapshot={informationBackground()} active={() => active() && foreground()} page={entry.informationPage??"about"} onNavigate={informationNavigate} onOpenUrl={url=>void openUrl(url)} legalBaseUrl="https://sly-data-plane.watchrss.cn" ref={v=>entry.list=v}/></Show>
      </Show>
        <Show when={page()==="reader-image"&&entry.imageUrl}><ImagePreviewScreen url={entry.imageUrl!} filePath={entry.imageFilePath} width={width} height={height} density={metrics.density} active={active()} onExit={()=>popPage()} onError={setError} onBackGesture={(phase,dx,velocity)=>{if(phase==="start"){motion.begin(dx);setBackOffset(motion.offset);}else if(phase==="move"){motion.move(dx);setBackOffset(motion.offset);}else if(motion.phase==="dragging")motion.release(velocity,Date.now(),phase==="cancel");}}/></Show>
        <Show when={page()==="speech-playback"}><SpeechPlaybackScreen volumeEnabled={settings().mediaVolumeControl} volumeGuard={settings().mediaVolumeGuard} width={width} height={height} active={active()} state={speechState()??speechPlayback.state} onToggle={()=>void speechPlayback.toggle()} onPrevious={()=>void speechPlayback.previous()} onNext={()=>void speechPlayback.next()} onStop={()=>{void speechPlayback.stop();popPage();}} onAutoAdvance={()=>speechPlayback.toggleAutoAdvance()} onRate={step=>void speechPlayback.changeRate(step)} onReturn={()=>popPage()}/></Show>
        <Show when={page()==='reader-preview'&&previewState()}>{state=><ReaderPreviewScreen state={state()} width={width} height={height} active={active()&&motion.phase==='idle'} ref={value=>{entry.list=value;}}/>}</Show>
        <Show when={page() === "reader" && entry.readerArticle}>{rss => <ReaderScreen mediaCacheMode={settings().mediaCacheMode} highlight={speechState()?.highlight} llmEnabled={settings().llmEnabled} llmAutoSummarize={settings().llmAutoSummarize} llmPromptPreset={settings().llmPromptPreset} article={rss()} services={props.services} width={width} height={height} preset={readerPreset()} fontSize={readerPreset().body.fontSizeSp} lineHeight={readerLineHeight()} active={active()&&motion.phase==="idle"} autoStart={settings().readerAutoStart} speed={settings().readerScrollSpeed} favorite={(article()?.id===rss().id?article():rss())?.saved??false} speaking={speechState()?.playing===true&&speechState()?.article?.id===rss().id} busy={busy()} onFavorite={()=>{const selected=article()?.id===rss().id?article()!:rss();setArticle(selected);void saveArticleState("favorite",!selected.saved,false);}} onShare={()=>{const selected=article()?.id===rss().id?article()!:rss();share({origin:"detail",title:selected.title,link:selected.link},()=>{setArticle(selected);setPage("rss-share");});}} onSpeak={a=>{void speechPlayback.start(a);void hostToast("已开始朗读，长按文章可打开朗读页面");}} onSpeechControls={(a,anchor)=>{if(speechState()?.phase==="idle"||!speechState()||speechState()?.article?.id!==a.id)void speechPlayback.start(a,speechPlayback.state.rate,anchor);setPage("speech-playback");}} onMedia={(a,block)=>{if(block.type==="video")void openRssVideo(a,block.url).catch(e=>setError(String(e)));else setPage("reader-image",{imageUrl:resolveUrl(block.url,a.link)??block.url,imageFilePath:a.offlineMedia?.[block.url]});}} onControls={reader=>setPage("reader-scroll-controls",{reader})} onError={setError} ref={v=>{entry.list=v;entry.reader=v;}}/>}</Show>
    </View>
  </View>;
  };
  return <View class={page()==="video" ? "relative overflow-hidden" : "relative overflow-hidden bg-[#000000]"} style={{ width, height }}><For each={stack()}>{renderPage}</For></View>;
}
