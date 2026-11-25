import {BluetoothWarningPage} from './NetworkUnavailableOverlay.tsx';
import {browserOpenFailureMessage} from "../browser/open-failure.ts";
import {preserveNetworkContent} from '../network/context.ts';
import {isNetworkRecoveryCancellation} from '../network/recovery.ts';
import {bindBluetoothWarningRoute,useBluetoothWarningConnection,createHostNetworkRecovery,NetworkRecoveryProvider,NetworkRecoveryLayer,observeNetworkRecovery} from './network-recovery.tsx';
import {readCloudAccountStatus,subscribeCloudAccountStatus} from '../cloud/status.ts';
import {bindShellCommands} from '../debug/shell-host.ts';
import {PlayerLoadingIndicator} from './PlayerLoadingIndicator.tsx';
import {playerGesture,rotateVector} from "./player-gestures.ts";
import {rightSwipeBack} from '../navigation/right-swipe-back.ts';
import {backStackSize,usesImmersiveBackObserver} from '../navigation/back-target.ts';
import {idleHit} from '../diagnostics/idle-counters';
import {douyinBench} from '../douyin/bench.ts';
import {startExternalDebug} from '../debug/external-host.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {markFeedArticleRead} from "./reader-open-state.ts";
import {readerBodyState} from '../reader/body-state.ts';
import {useMinuteClock} from './minute-clock.ts';
import {ActivityLog} from '../logs/activity.ts';
import {activityStateHub} from '../navigation/activity-host.ts';
import {captureActivityNavigation,resolveActivityNavigation,routeMemory,CONTENT_ACTIVITY_KEY} from '../navigation/activity-navigation.ts';
import {startupActivityNavigation} from '../navigation/startup-navigation.ts';
import {InformationActivity} from '../navigation/information-activity.ts';
import {RouteActivityProvider} from './route-activity.tsx';
import { afterPaint } from "@podjs/framework/render";
import { startupFirstScreen, startupMark } from "../core/startup-trace.ts";
import {readHomeChannelSnapshot,writeHomeChannelSnapshot} from "./home-snapshot.ts";
import {debugGate} from '../debug/host.ts';
import type {DebugBluetoothSession} from '../debug/bluetooth.ts';
import {usageTelemetry,createVideoBatteryTelemetry} from '../telemetry/host.ts';
import {TelemetryScreenSession} from '../telemetry/usage.ts';
import {telemetryScreen,telemetryScreenOwner} from '../telemetry/screens.ts';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('screen');
import { openBrowserUrl, type BrowserOrigin } from "../browser/open.ts";
import { supportsSystemShare, openSystemShare } from "../sharing/host.ts";
import { routeShare, type ShareHandler } from "../sharing/policy.ts";
import { managedCache } from "../cache/host.ts";
import { takeRemoteInput } from "../remote-input/inbox.ts";
import {
  readerPreviewSession,
  onReaderPreviewOpen,
  readerPreviewOpenRevision,
  setReaderPreviewVisible,
} from "../reader/preview-host.ts";
import { enforcePlaybackStartVolume } from "../media/start-volume.ts";
import {
  SpeechPlayback,
  type SpeechPlaybackState,
} from "../reader/speech-playback.ts";
import { SpeechSpectrum } from "../reader/speech-spectrum.ts";
import { TtsConfigStore } from "../tts/config-store.ts";
import {
  ReaderPresetStore,
  onReaderPresetsChanged,
  activeReaderPreset,
  type ReaderPresetState,
} from "../reader/preset-store.ts";
import { defaultReaderPreset } from "../reader/preset.ts";
import { getOps } from "@pocketjs/framework/host";
import { shouldAutoRemoveWatchLater } from "../reader/watch-later-completion.ts";
import { loadFeedWindow } from "./feed-window.ts";
import type { BiliRoute } from "./bili/index.tsx";
import type { DouyinRoute } from "./douyin/index.tsx";
import { biliClient, douyinClient } from "../media-services.ts";
import type { PlaybackSource } from "./VideoPlayerScreen.tsx";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  RelativeAxis,
  RelativeAxisUnits,
  lifecycle,
  onLifecycleCheckpoint,
  hasCapability,
  onLifecycleChange,
  getDisplayMetrics,
  kv,
  onAxisDelta,
  onSystemBack,
  setNavigationState,
  __onHostEvent,
} from "@podjs/framework/watch";
import {
  ReaderExitGuard,
  type ReaderProgressFlushOutcome,
} from "../navigation/reader-exit.ts";
import {
  speech,
  video,
  mediaVolume,
  hostOperation,
  delay,
} from "@podjs/framework/services";
import { layoutText } from "../reader/index.ts";
import type { AppServices, Article, Channel, ArticleQuery } from "./service.ts";
import { cancelActiveTouches, createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BackMotion } from "@podjs/framework/navigation";
import { HomeEntryPlacementStore } from "./home-placement.ts";
import type { SettingsRoute } from "./SettingsScreen.tsx";
import { SettingsStore, type SettingsState } from "../settings/index.ts";
import type { InformationPage } from "./InformationScreens.tsx";
import { checkpointInformationSnapshot } from "./information-route-state.ts";
import type { RecommendedChannel } from "../rss/recommendations.ts";
import { memoRepository } from "../services.ts";
import type { HomePlatformLoginState } from "./home-extras.ts";
import { HomeRoutes } from "./routes/home.tsx";
import { InfoRoutes } from "./routes/info.tsx";
import { MediaRoutes } from "./routes/media.tsx";
import { createMediaRouteController } from "./routes/media-controller.ts";
import { NotesRoutes } from "./routes/notes.tsx";
import { ReaderRoutes } from "./routes/reader.tsx";
import {TopNotice} from "@podjs/framework/watch-ui";
import {readerControlViewport} from "../reader/viewport.ts";
import { RssRoutes } from "./routes/rss.tsx";
import { SavedRoutes } from "./routes/saved.tsx";
import { createSavedRouteController } from "./routes/saved-controller.ts";
import { SettingsRoutes } from "./routes/settings.tsx";
import { PhoneRoutes } from "./routes/phone.tsx";
import { routeIsSelfTitled, routeTitle } from "./routes/meta.ts";
import type { Page, RouteEntry } from "./routes/types.ts";
import type { ApplicationForegroundSync } from "../sync/application-foreground.ts";
import type { createAnnouncementServices } from "../announcement/host.ts";
import { loadHomeNotices } from "../announcement/home.ts";
import { entryDisclosure } from "./entry-disclosure.ts";
import { PendingDisclosure } from "./PlatformNotice.tsx";
import type { Announcement, PushMessage } from "../announcement/models.ts";
import { HomeNoticeDialog } from "./HomeNoticeDialog.tsx";
import { ReadAloudFloatingBubble } from "./ReadAloudFloatingBubble.tsx";
import { bindPairingRequestRoute } from "./routes/pairing.ts";

type Entry = RouteEntry;
const bg = "#050507",
  panel = "#101014",
  ink = "#f4f4f6",
  muted = "#9a9aa5",
  accent = "#45d6a7",
  blue = "#3157a4";
const rowHeight = 48;

export default function WatchRSS(props: {
  createDebugBluetooth?:()=>DebugBluetoothSession;
  services: AppServices;
  bluetoothSync?: Pick<ApplicationForegroundSync, "state" | "subscribe" | "refresh"> & Partial<Pick<ApplicationForegroundSync,"acquireConnectionPage">>;
  announcements?: ReturnType<typeof createAnnouncementServices>;
  onSyncMediaKeepAliveChange?: (enabled: boolean) => void;
}) {
  const metrics = getDisplayMetrics();
  const bluetoothSync = props.bluetoothSync ?? {
    state: "disposed" as const,
    subscribe: () => () => {},
    refresh: async () => {},
  };
  const width = Math.max(
    160,
    metrics.logicalWidth - metrics.safeInsets.left - metrics.safeInsets.right,
  );
  const height = Math.max(
    180,
    metrics.logicalHeight - metrics.safeInsets.top - metrics.safeInsets.bottom,
  );
  // Only the host's task-scoped Bundle can resume navigation. Durable KV
  // checkpoints and legacy last-screen records are not launch instructions.
  const activityEntries=startupActivityNavigation(activityStateHub.read(),debugGate.allowed);
  const startupNeedsChannels=(activityEntries?.length??0)<=1||!!activityEntries?.some(entry=>entry.channelId);
  const [resumeReady, setResumeReady] = createSignal(false);
  const [activityReady, setActivityReady] = createSignal(false);
  let startupDisposed=false;
  onCleanup(()=>{startupDisposed=true;});
  const [stack, setStack] = createSignal<Entry[]>([{ page: "home" }]);
  const checkpoints=new Map<Entry,Set<()=>void>>();
  const saveActivity=()=>traceServiceWork("navigation.saveActivity",()=>untrack(()=>{
    if(!activityReady())return;
    traceServiceWork("navigation.checkpoints",()=>{for(const handlers of checkpoints.values())for(const checkpoint of handlers)checkpoint();});
    const next=captureActivityNavigation(activityStateHub.read(),stack());
    void activityStateHub.write(next,[CONTENT_ACTIVITY_KEY]).catch(error=>logConsole.warn('Activity state save failed',String(error)));
  }));
  onCleanup(onLifecycleCheckpoint(()=>{
    if(!activityReady())return;
    saveActivity();
  }));
  const informationActivity=new InformationActivity(saveActivity,error=>logConsole.warn('Information restore',String(error)));
  onCleanup(()=>informationActivity.close());
  const [playingSource, setPlayingSource] = createSignal<PlaybackSource>();
  const current = () => stack()[stack().length - 1];
  const networkScopes=new WeakMap<Entry,ReturnType<typeof createHostNetworkRecovery>>();
  const networkFor=(entry:Entry)=>{let scope=networkScopes.get(entry);if(!scope){scope=createHostNetworkRecovery();networkScopes.set(entry,scope);}return scope;};
  const page = () => current().page;
  const [cloudOwnerChoice,setCloudOwnerChoice]=createSignal(!!readCloudAccountStatus()?.ownerChoiceRequired);
  onCleanup(subscribeCloudAccountStatus(()=>setCloudOwnerChoice(!!readCloudAccountStatus()?.ownerChoiceRequired)));
  const warningNetwork=useBluetoothWarningConnection();
  const warningShown=()=>page()==='bluetooth-warning';
  const contentRoute=()=>warningShown()?stack().at(-2)!:current();
  const recoveryEnabled = (entry:Entry) => entry.page !== 'sync-v2' && entry.page !== 'bluetooth-warning' && !cloudOwnerChoice();
  const ownerChoiceNetwork=createHostNetworkRecovery();
  onCleanup(()=>ownerChoiceNetwork.dispose());
  const visibleNetwork=observeNetworkRecovery(()=>cloudOwnerChoice()?ownerChoiceNetwork:networkFor(current()));
  const networkPageBlocksSwipe=()=>(cloudOwnerChoice()||recoveryEnabled(current()))&&visibleNetwork().blocking;
  const [nativeInputOpen,setNativeInputOpen]=createSignal(false);
  const [systemShareOpen,setSystemShareOpen]=createSignal(false);
  const routeServices:AppServices=Object.assign(Object.create(props.services),{
    input:async (...args:Parameters<AppServices['input']>)=>{
      setNativeInputOpen(true);
      try{return await props.services.input(...args);}
      finally{setNativeInputOpen(false);}
    },
  });
  const readerFlushTimer = (milliseconds: number) => delay(milliseconds);
  const readerExit = new ReaderExitGuard<Entry>(readerFlushTimer);
  const backgroundReaderFlush = new ReaderExitGuard<Entry>(readerFlushTimer);
  const logReaderProgressFlush = (
    context: "exit" | "background",
    outcome: ReaderProgressFlushOutcome,
  ) => {
    if (outcome.status === "failed")
      logConsole.warn(
        `Reader progress ${context} flush failed; continuing`,
        outcome.error,
      );
    else if (outcome.status === "timed-out")
      logConsole.warn(
        `Reader progress ${context} flush timed out after ${outcome.timeoutMs}ms; continuing`,
      );
  };
  function flushReaderProgress(entry:Entry,context:"exit"|"background",complete?:()=>void) {
    const reader=entry.reader;
    if(!reader)return;
    const guard=context==="exit"?readerExit:backgroundReaderFlush;
    guard.begin(entry,()=>reader.flushProgress(),outcome=>{
      logReaderProgressFlush(context,outcome);
      complete?.();
    });
  }
  let motion = new BackMotion(width);
  let editorBack: (() => void) | undefined;
  const [backOffset, setBackOffset] = createSignal(0);
  // Keep the previous route mounted for restoration. Paint it when a back swipe reveals it.
  const backUnderlay = createMemo(() =>
    backOffset() > 0 && page() !== "video" ? stack().at(-2) : undefined
  );
  const [backRotation, setBackRotation] = createSignal(0);
  const backTranslation = createMemo(() => backOffset() === 0 ? { x: 0, y: 0 } : rotateVector(backOffset(), 0, backRotation()));
  // Hold completed navigation while the current back gesture finishes.
  // Requests still in flight never participate in this queue.
  const afterBack: {apply:()=>void;cancel?:()=>void}[]=[];
  function navigate(apply:()=>void,cancel?:()=>void) {
    if(startupDisposed){cancel?.();return;}
    if(motion.phase==="idle")batch(apply);
    else afterBack.push({apply,cancel});
  }
  onFrame(()=>{
    if(motion.phase!=="idle")return;
    for(const {apply,cancel} of afterBack.splice(0))navigate(apply,cancel);
  },()=>afterBack.length>0&&motion.phase==="idle");
  onCleanup(()=>{for(const {cancel} of afterBack.splice(0))cancel?.();});
  function waitForBack():Promise<boolean> {
    return new Promise(resolve=>navigate(()=>resolve(true),()=>resolve(false)));
  }
  function setPage(next: Page,data: Partial<Entry> = {}) {
    navigate(()=>traceServiceWork("navigation.setPage",()=>kv.batch(()=>setPageImpl(next,data))));
  }
  function setPageImpl(next: Page, data: Partial<Entry>) {
    if((next==="debug-tools"||next==="debug-summary")&&!debugGate.allowed)return;
    if(warningShown()){
      if(next==="bluetooth-warning")return;
      removeWarningRoute();
    }
    if(next===page()&&Object.keys(data).length===0)return;
    traceServiceWork("navigation.informationCheckpoint",()=>checkpointInformationSnapshot(current()));
    traceServiceWork("navigation.stopList",()=>current().list?.scroller.stop());
    traceServiceWork("navigation.setStack",()=>setStack((entries) => [...entries, { page: next, ...data }]));
  }
  function finishPopPage(leaving: Entry) {
    if (current() !== leaving || stack().length <= 1) return false;
    if(leaving.page==='bluetooth-warning'){
      motion.reset();
      batch(()=>{
        setStack(entries=>entries.slice(0,-1));
        setBackOffset(0);
      });
      return true;
    }
    const latestArticle =
      article()?.id === leaving.readerArticle?.id
        ? article()
        : leaving.readerArticle;
    const autoRemoveItem =
      leaving.page === "reader" &&
      stack().at(-2)?.page === "watch-later" &&
      shouldAutoRemoveWatchLater(
        !!leaving.readerFromWatchLater,
        leaving.reader?.reachedBottom() ?? false,
        !!latestArticle?.watchLater,
      )
        ? savedEntries().find(
            (item) =>
              item.kind === "rss" &&
              item.articleId === leaving.readerArticle?.id,
          )
        : undefined;
    if (leaving.page === "reader" && telemetryReaders.has(leaving)) {
      telemetryReaders.delete(leaving); usageTelemetry.recordArticleReadFinished();
    }
    for(const entry of stack().slice(backStackSize(stack()))) entry.queue?.cancel();
    if (leaving.page === "saved" || leaving.page === "watch-later")
      clearSavedUndo();
    if (current().page === "note-detail" || current().page === "note-actions")
      setNotesRefreshKey((value) => value + 1);
    batch(() => {
      setStack((entries) => entries.slice(0, backStackSize(entries)));
      setPlayingSource(current().playback);
      setError("");
      setBackOffset(0);
    });
    motion.reset();
    const destination=current();
    if (destination.page==="articles"&&destination.channelId&&
        (leaving.page==="search"||currentQuery.channelId!==destination.channelId)) {
      const limit=Number(routeMemory(destination).retained.feedCount)||12;
      void loadFeedArticles(destination.channelId,limit,true);
    }
    if (autoRemoveItem) void removeSaved(autoRemoveItem);
    else if (page() === "saved" || page() === "watch-later")
      void loadSaved(page() === "saved" ? "favorite" : "watchLater");
    return true;
  }
  function popPage(skipInternal = false) {
    if (stack().length <= 1) return false;
    if (!skipInternal && current().internalBack?.()) {
      setBackOffset(0);
      motion.reset();
      return true;
    }
    const leaving = current();
    if (leaving.page !== "reader" || !leaving.reader)
      return finishPopPage(leaving);
    leaving.list?.scroller.stop();
    flushReaderProgress(leaving,"exit",()=>{
      if(current()===leaving)finishPopPage(leaving);
    });
    return true;
  }
  let sideSwipe: NonNullable<NonNullable<Entry["player"]>["sideSwipe"]> | undefined;
  const playerRotation=()=>contentRoute().player?.gestureRotation?.()??0;
  const playerViewport=()=>({x:0,y:0,w:width,h:height});
  let backPointerRotation = 0;
  const rememberBackRotation = () => { if (motion.phase === "idle") backPointerRotation = playerRotation(); };
  const beginBack = (dx: number) => {
    editorBack = current().noteEditorBack;
    const axis = rotateVector(1, 0, backPointerRotation);
    const extent = Math.min(width / Math.abs(axis.x), height / Math.abs(axis.y));
    motion = new BackMotion(extent);
    motion.begin(dx);
    batch(() => { setBackRotation(backPointerRotation); setBackOffset(motion.offset); });
  };
  createGesture(playerGesture({
    onDown: rememberBackRotation,
    region: {
      rect: () =>
        stack().length > 1 &&
        !disclosurePending() &&
        !networkFor(current()).blocking &&
        !networkPageBlocksSwipe() &&
        motion.phase !== "settling" &&
        (current().player?.canSwipeBack?.() ?? true) &&
        current().page !== "reader-image" &&
        !usesImmersiveBackObserver(current())
          ? { x: 0, y: 0, w: width, h: height }
          : null,
    },
    axis: "x",
    panSlop: 8,
    onPanStart: (c) => {
      // A right-to-left drag can belong to the page (the player's detail panel);
      // left-to-right is always Back and never reaches sideSwipe.
      const side = c.dx < 0 ? current().player?.sideSwipe : undefined;
      if (side?.begin()) { sideSwipe = side; side.move(c.dx); return; }
      current().list?.scroller.stop();
      beginBack(c.dx);
    },
    onPanMove: (c) => {
      if (sideSwipe) { sideSwipe.move(c.dx); return; }
      motion.move(c.dx);
      setBackOffset(motion.offset);
    },
    onPanEnd: (c) => {
      if (sideSwipe) { const side = sideSwipe; sideSwipe = undefined; side.end(c.vx); return; }
      if (motion.phase === "dragging") motion.release(c.vx, Date.now());
    },
    onCancel: () => {
      if (sideSwipe) { const side = sideSwipe; sideSwipe = undefined; if (side.cancel) side.cancel(); else side.end(0); return; }
      if (motion.phase === "dragging") motion.release(0, Date.now(), true);
    },
  },playerRotation,playerViewport));
  const backObserver = rightSwipeBack({rect:()=>
    stack().length>1 && usesImmersiveBackObserver(current()) && !disclosurePending() && !networkPageBlocksSwipe() && motion.phase!=="settling"
      ? {x:0,y:0,w:width,h:height} : null,
  },{
    start:beginBack,
    move(dx){motion.move(dx);setBackOffset(motion.offset);},
    end(velocity){if(motion.phase==="dragging")motion.release(velocity,Date.now());},
    cancel(){if(motion.phase==="dragging")motion.release(0,Date.now(),true);},
  });
  createGesture(playerGesture({
    ...backObserver,
    onDown(c) { rememberBackRotation(); backObserver.onDown?.(c); },
  },playerRotation,playerViewport));
  onFrame(() => {
    if (motion.phase !== "settling") return;
    const result = motion.tick(Date.now());
    if (result === "commit" && editorBack) {
      // A swipe that began in the editor owns that editor's close. It cannot
      // pop the reader if the close button or a system Back already won.
      const close = editorBack;
      editorBack = undefined;
      motion.reset();
      setBackOffset(0);
      close();
    } else if (result === "commit") popPage();
    else setBackOffset(motion.offset);
  },()=>motion.phase==="settling");
  const contentHeight = height - 36;
  let currentQuery: ArticleQuery = {};
  const [channelPlayback, setChannelPlayback] = createSignal<
    Record<
      string,
      { hasPlayableMedia: boolean; continuePlaybackInBackground: boolean }
    >
  >({});
  const [originalModes, setOriginalModes] = createSignal<
    Record<string, boolean>
  >({});
  // Cold start renders the home list from the last snapshot (synchronous KV) so the first screen
  // does not wait for database setup; the live list replaces it a moment later. Only used when
  // the app resumes to home, otherwise the snapshot would flash before the restored page.
  const homeSnapshot = (activityEntries?.length??0)>1 ? undefined : readHomeChannelSnapshot(kv, null);
  const [channels, setChannels] = createSignal<Channel[]>(homeSnapshot ?? []);
  const notesPlacementStore = new HomeEntryPlacementStore();
  const [notesHomePlacement, setNotesHomePlacement] = createSignal(notesPlacementStore.read());
  const [articles, setArticles] = createSignal<Article[]>([]);
  const hasLocalPageContent = (entry: Entry) => {
    if (entry.page === "home") return channels().length > 0;
    if (entry.page === "reader") {
      const body = entry.readerArticle;
      return !!(body?.content.trim() || body?.importedText || body?.contentBlocks?.length);
    }
    if (entry.page === "saved" || entry.page === "watch-later") return savedEntries().length > 0;
    if (entry.page === "search") return searchResults().some(item => item.channelId === entry.channelId);
    return entry.page === "articles" && !!entry.channelId &&
      articles().some(item => item.channelId === entry.channelId);
  };
  const [article, setArticle] = createSignal<Article | null>(null);
  const [pageLoad,setPageLoad]=createSignal<{entry:Entry}|undefined>(startupNeedsChannels&&!homeSnapshot?{entry:current()}:undefined);
  const loading=()=>pageLoad()?.entry===contentRoute();
  const [busy,setBusy]=createSignal(false);
  const [homeRefreshing,setHomeRefreshing]=createSignal(false);
  const [errorMessage,setError]=createSignal("");
  // Loading replaces the browsing surface only for the route that owns it.
  const startPageLoading=()=>{
    const load={entry:contentRoute()};
    setPageLoad(load);
    return ()=>setPageLoad(currentLoad=>currentLoad===load?undefined:currentLoad);
  };
  const error = createMemo(() => {
    const message = errorMessage();
    // A rejected async handler can report a QuickJS allocation failure after
    // the host turn has already requested reclamation. Keep the player usable.
    return message === "InternalError: out of memory" || message === "out of memory" ? "" : message;
  });
  const {
    savedEntries,
    savedUndo,
    clearSavedUndo,
    loadSaved,
    removeSaved,
    undoSaved,
    reorderSaved,
  } = createSavedRouteController({
    services: props.services,
    current,
    setArticles,
    startPageLoading,
    setError,
    setCurrentQuery: (value) => {
      currentQuery = value;
    },
  });
  const [query, setQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<Article[]>([]);
  const [searchLoading, setSearchLoading] = createSignal(false);
  let searchRequestVersion = 0;
  let searchDebounce: ReturnType<typeof delay> | undefined;
  createEffect(() => {
    if (page() !== "search" && searchDebounce) {
      searchDebounce.cancel();
      searchDebounce = undefined;
      searchRequestVersion++;
    }
  });
  onCleanup(() => {
    searchDebounce?.cancel();
  });
  const [feedVisibleCount, setFeedVisibleCount] = createSignal(12);
  const [feedHasMore, setFeedHasMore] = createSignal(false);
  const [feedLoadingMore, setFeedLoadingMore] = createSignal(false);
  let feedRequestVersion = 0;
  const [speechState, setSpeechState] = createSignal<SpeechPlaybackState>();
  const [speechSpectrum, setSpeechSpectrum] = createSignal<readonly number[]>([]);
  const spectrum = new SpeechSpectrum({
    supported: () => hasCapability("media.tts.spectrum"),
    onSpectrum: listener => speech.onSpectrum(listener),
    setSpectrumEnabled: enabled => speech.setSpectrumEnabled(enabled),
  }, setSpeechSpectrum);
  const [platformLoginState, setPlatformLoginState] =
    createSignal<HomePlatformLoginState>({ bili: false, douyin: false });
  const speechPlayback = new SpeechPlayback(
    {
      listArticles:query=>props.services.listArticles(query),
      getArticle:id=>props.services.getArticle(id),
      getOriginalArticle:id=>props.services.getOriginalArticle(id),
      getSpeechSource:props.services.getSpeechSource?(article,anchor)=>props.services.getSpeechSource!(article,anchor):undefined,
      speak:(...args)=>networkFor(current()).run(()=>props.services.speak(...args)),
      stopSpeech:()=>props.services.stopSpeech(),
    },
    (state) => {
      const previous = speechState();
      setSpeechState(state);
      spectrum.update(foreground() && page() === "home", state);
      if (
        state.phase === "error" &&
        state.error !== previous?.error &&
        page() !== "speech-playback"
      )
        void hostOperation("ui.toast", {
          message: state.error ?? "朗读失败",
        }).result.catch(() => {});
    },
    {
      now: () => globalThis.performance?.now?.() ?? Date.now(),
      after: (ms, callback) => {
        const timer = delay(ms);
        void timer.result.then(callback, () => {});
        return () => timer.cancel();
      },
    },
    (isCurrent) =>
      enforcePlaybackStartVolume(
        mediaVolume,
        settings().playbackStartVolumeLimit,
        isCurrent,
      ),
  );
  const settingsStore = new SettingsStore();
  const ttsConfigStore = new TtsConfigStore();
  const [settings, setSettings] = createSignal<SettingsState>(
    settingsStore.load(),
  );
  const [systemShareAvailable, setSystemShareAvailable] = createSignal(false);
  const shareEnvironment = supportsSystemShare().catch((e) => {
    setError(String(e));
    return false;
  });
  let shareAlive = true;
  onCleanup(() => {
    shareAlive = false;
  });
  void shareEnvironment.then((value) => {
    if (shareAlive) setSystemShareAvailable(value);
  });
  const share: ShareHandler = (input, qr, onDone) => {
    const source = contentRoute();
    const finishSource =
      source.page === "rss-actions" ||
      (source.page === "bili" && source.biliRoute?.name === "actions") ||
      (source.page === "douyin" && source.douyinRoute?.name === "actions");
    void shareEnvironment.then(supported => {
      navigate(() => {
        if (!shareAlive || contentRoute() !== source) return;
        void routeShare(input, settings().shareUseSystem && supported, {
          text: async text => {
            setSystemShareOpen(true);
            try { await openSystemShare(text); }
            finally { setSystemShareOpen(false); }
          },
          qr,
          unavailable: () => { void hostToast("暂无可分享链接"); },
        }).then(outcome => {
          if (!shareAlive) return;
          if (onDone && outcome !== "none") onDone();
          else if (finishSource) {
            source.list?.scroller.stop();
            setStack(entries => entries.length > 1
              ? entries.filter(entry => entry !== source)
              : entries);
          }
        }).catch(error => {
          if (shareAlive) setError(String(error));
        });
      });
    });
  };
  createEffect(() =>
    props.onSyncMediaKeepAliveChange?.(settings().syncMediaKeepAlive),
  );
  createEffect(() => {
    idleHit(8);void managedCache
      .configure(settings().cacheLimitMb * 1024 * 1024)
      .catch((error) => logConsole.warn("Cache maintenance failed"));
  });
  const presetStore = new ReaderPresetStore();
  const [presetState, setPresetState] = createSignal<ReaderPresetState>();
  const [presetRevision, setPresetRevision] = createSignal(0);
  const [foreground, setForeground] = createSignal(lifecycle() === "active");
  createEffect(()=>ownerChoiceNetwork.setActive(cloudOwnerChoice()&&foreground()));
  const activityLog = new ActivityLog();
  const telemetrySession = new TelemetryScreenSession(usageTelemetry, () => globalThis.performance?.now?.() ?? Date.now());
  const telemetryReaders = new WeakSet<Entry>();
  const telemetryPlayers = new WeakSet<Entry>();
  createEffect(() => {
    idleHit(9);const entries = stack();
    const owner = telemetryScreenOwner(entries);
    activityLog.update(entries,foreground());
    telemetrySession.update(owner, owner && telemetryScreen(owner), foreground());
    for (const value of entries) {
      if (value.page === "reader" && value.readerArticle && !telemetryReaders.has(value)) {
        telemetryReaders.add(value); usageTelemetry.recordArticleReadStarted();
      }
      if (value.page === "video" && value.playback && !value.playback.immersive && !telemetryPlayers.has(value)) {
        telemetryPlayers.add(value); usageTelemetry.recordVideoPlayed();
      }
    }
  });
  onCleanup(() => telemetrySession.pause());
  createEffect(() => {idleHit(12);spectrum.update(foreground() && page() === "home", speechState());});
  onFrame(() => spectrum.frame(globalThis.performance?.now?.() ?? Date.now()),()=>foreground()&&page()==="home"&&!!speechState()?.playing);
  onCleanup(() => spectrum.dispose());
  const [pendingAnnouncement, setPendingAnnouncement] = createSignal<Announcement | null>(null);
  const [pendingPushMessages, setPendingPushMessages] = createSignal<PushMessage[]>([]);
  const homeNoticeVisible = () => !!pendingAnnouncement() || pendingPushMessages().length > 0;
  // Native shows the first-use disclosure only once announcements and push messages are gone.
  const homeDisclosure = entryDisclosure({}, { page: "home" });
  const homeDisclosurePending = () => homeDisclosure.pending(homeNoticeVisible());
  let homeDisclosureList: Entry["disclosureList"];
  const disclosurePending = () => {
    const entry = current();
    if (entry.page === "home") return !!homeDisclosurePending();
    if (entry.page !== "bili" && entry.page !== "douyin") return false;
    const route = entry.page === "bili" ? entry.biliRoute : entry.douyinRoute;
    return (route?.name ?? "entry") === "entry" && !!entryDisclosure(entry, {page:entry.page,name:"entry"}).pending();
  };
  const dismissHomeNotice = () => {
    if (pendingPushMessages().length) {
      setPendingPushMessages([]);
      return true;
    }
    const announcement = pendingAnnouncement();
    if (!announcement || announcement.forceUpdate || !props.announcements) return false;
    props.announcements.repository.markDismissed(announcement);
    setPendingAnnouncement(null);
    return true;
  };
  let homeNoticesChecked = false;
  let homeNoticesAlive = true;
  createEffect(() => {
    idleHit(10);const services = props.announcements;
    if (!services || homeNoticesChecked || !foreground()) return;
    homeNoticesChecked = true;
    void loadHomeNotices(services.repository).then(result => {
      if (!homeNoticesAlive) return;
      batch(() => {
        setPendingAnnouncement(result.announcement);
        setPendingPushMessages(result.messages);
      });
    });
  });
  onCleanup(() => { homeNoticesAlive = false; });
  onCleanup(
    onLifecycleChange((value) => {
      setForeground(value === "active");
      const entry = current();
      if (value !== "active") {
        for(const item of stack()){
          const snapshot=checkpointInformationSnapshot(item);if(snapshot)informationActivity.save(item,snapshot);
        }
        saveActivity();
      }
      if (value !== "active" && entry.page === "reader")
        flushReaderProgress(entry,"background");
    }),
  );
  let platformLoginRefresh = 0;
  const refreshPlatformLoginState = async () => {idleHit(6);
    const revision = ++platformLoginRefresh;
    const [bili, douyin] = await Promise.all([
      biliClient
        .getLoginState()
        .then((state) => state.status === "authenticated")
        .catch(() => false),
      douyinClient.isLoggedIn().catch(() => false),
    ]);
    if (revision === platformLoginRefresh)
      setPlatformLoginState({ bili, douyin });
  };
  createEffect(() => {
    idleHit(7);if (page() === "home" && foreground()) void refreshPlatformLoginState();
  });
  onCleanup(() => {
    platformLoginRefresh++;
  });
  createEffect(() => {
    idleHit(11);const entries = stack();
    if (activityReady()) {
      informationActivity.prune(entries);saveActivity();
    }
  });
  try {
    setPresetState(presetStore.ensureSeeded(true, settings().fontSizeSp));
  } catch (error) {
    setError(String(error));
  }
  onCleanup(
    onReaderPresetsChanged(() => {
      try {
        batch(() => {
          setPresetState(presetStore.load());
          setPresetRevision((value) => value + 1);
        });
      } catch (error) {
        setError(String(error));
      }
    }),
  );
  const [previewState, setPreviewState] = createSignal(
    readerPreviewSession.state(),
  );
  let previewOpenPending =
    !!readerPreviewSession.state() && readerPreviewOpenRevision() > 0;
  onCleanup(
    onReaderPreviewOpen(() => {
      previewOpenPending = true;
    }),
  );
  onCleanup(
    readerPreviewSession.subscribe((state) => {
      setPreviewState(state);
      if (!state) {
        previewOpenPending = false;
        const wasCurrent = current().page === "reader-preview";
        for (const entry of stack())
          if (entry.page === "reader-preview") entry.list?.scroller.stop();
        setStack((entries) =>
          entries.filter((entry) => entry.page !== "reader-preview"),
        );
        if (wasCurrent) {
          motion.reset();
          setBackOffset(0);
        }
      }
    }),
  );
  onFrame(() => {
    if (!previewOpenPending || motion.phase !== "idle" || !previewState())
      return;
    previewOpenPending = false;
    if (page() === "reader-preview") return;
    const existing = stack().findIndex(
      (entry) => entry.page === "reader-preview",
    );
    if (existing >= 0) setStack((entries) => entries.slice(0, existing + 1));
    else setPage("reader-preview");
  },()=>previewOpenPending&&motion.phase==="idle"&&!!previewState());
  createEffect(() => setReaderPreviewVisible(page() === "reader-preview"));
  onCleanup(() => setReaderPreviewVisible(false));
  const presetClock = useMinuteClock(() => foreground() && presetState()?.selection.mode === "SYSTEM");
  const readerPreset = createMemo(() =>
    presetState()
      ? activeReaderPreset(presetState()!, presetClock())
      : defaultReaderPreset(undefined, undefined, true, settings().fontSizeSp),
  );
  const informationBackground = createMemo(() => ({
    state: presetState() ?? {},
    revision: presetRevision(),
  }));
  const updatePreset = (change: () => ReaderPresetState) => {
    try {
      batch(() => {
        setPresetState(change());
        setPresetRevision((value) => value + 1);
      });
    } catch (error) {
      setError(String(error));
    }
  };
  const [notesRefreshKey, setNotesRefreshKey] = createSignal(0);

  async function loadChannels(foregroundLoad=true) {idleHit(5);
    // Keep the startup snapshot visible and leave a restored page's state alone.
    const loaded=foregroundLoad&&!channels().length?startPageLoading():undefined;
    if(foregroundLoad)setError("");
    try {
      const list = await props.services.listChannels();
      traceServiceWork("home.setChannels",()=>setChannels(list));
      writeHomeChannelSnapshot(kv, list);
      startupMark("channels.loaded");
    } catch (e) {
      if(foregroundLoad||page()==="home")setError(String(e));
    } finally {
      loaded?.();
    }
  }
  async function loadArticles(opts?: ArticleQuery) {
    const loaded=startPageLoading();
    setError("");
    try {
      const next = opts?.page ?? 0;
      currentQuery = { ...opts, page: next };
      setArticles(
        await props.services.listArticles({
          ...opts,
          page: next,
          pageSize: 30,
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      loaded();
    }
  }
  async function loadFeedArticles(
    channelId: string,
    limit = feedVisibleCount(),
    initial = false,
  ) {
    const origin=contentRoute();
    const version = ++feedRequestVersion;
    const loaded=initial?startPageLoading():undefined;
    try {
      const window = await loadFeedWindow(
        props.services.listArticles,
        channelId,
        limit,
      );
      if (
        version !== feedRequestVersion ||
        contentRoute() !== origin ||
        origin.channelId !== channelId
      )
        return;
      batch(() => {
        setArticles(window.items);
        setFeedVisibleCount(limit);
        setFeedHasMore(window.hasMore);
        currentQuery = { channelId, page: 0 };
      });
    } catch (e) {
      if (version === feedRequestVersion) setError(String(e));
    } finally {
      loaded?.();
      if (version === feedRequestVersion) {
        setFeedLoadingMore(false);
      }
    }
  }
  async function restoreStartupNavigation() {
    const baseline=stack();let owned=baseline;
    const ownsStack=(entries:Entry[])=>contentRoute()===entries.at(-1);
    try {
      if(startupNeedsChannels){
        if(homeSnapshot)void loadChannels(false);
        else await loadChannels();
      }
      if(startupDisposed||!ownsStack(baseline))return;
      if(activityEntries){
        const entries=await resolveActivityNavigation(activityEntries,{
          hasChannel:id=>channels().some(channel=>channel.id===id),article:id=>props.services.getArticle(id),
          canRestore:entry=>entry.page!=='reader-preview'||!!readerPreviewSession.state(),
        });
        for(const entry of entries)await informationActivity.restore(entry);
        if(entries.some(entry=>entry.page==='notes'||entry.page==='note-detail'||entry.page==='note-actions'))await memoRepository.initialize();
        if(startupDisposed||!ownsStack(baseline))return;
        if(!await waitForBack()||!ownsStack(baseline))return;
        owned=entries;
        batch(()=>{
          removeWarningRoute();
          setStack(entries);
          const lastReader=[...entries].reverse().find(entry=>entry.readerArticle);
          if(lastReader)setArticle(lastReader.readerArticle!);
          setActivityReady(true);
        });
        const destination=entries.at(-1);
        if(destination?.page==='articles'&&destination.channelId)
          await loadFeedArticles(destination.channelId,Number(routeMemory(destination).retained.feedCount)||12,true);
        if(destination?.page==='saved'||destination?.page==='watch-later')
          await loadSaved(destination.page==='saved'?'favorite':'watchLater');
        if(destination?.page==='search'&&destination.channelId){
          const draft=routeMemory(destination).retained.query;
          if(typeof draft==='string')await searchChannelArticles(destination.channelId,draft);
        }
      }
    } catch (error) {
      if(!startupDisposed&&ownsStack(owned))setError(`无法恢复上次内容：${String(error)}`);
    } finally {
      if(!startupDisposed){
        batch(()=>{setActivityReady(true);setResumeReady(true);});
        if(!startupNeedsChannels)void loadChannels(false);
      }
    }
  }
  let firstScreenSignaled=false;
  createEffect(()=>{
    const route=contentRoute();
    if(firstScreenSignaled||(!resumeReady()&&!(homeSnapshot&&route.page==="home")))return;
    const ready=()=>{
      firstScreenSignaled=true;
      startupMark(`firstScreen.route.${route.page}`);
      startupFirstScreen();
    };
    if(route.page==="home"){ready();return;}
    const paint=afterPaint();
    let active=true;
    onCleanup(()=>{active=false;paint.cancel();});
    void paint.result.catch(()=>{}).then(()=>{if(active)ready();});
  });
  function loadMoreFeedArticles() {
    const channelId = current().channelId;
    if (
      page() !== "articles" ||
      !channelId ||
      feedLoadingMore() ||
      loading() ||
      busy() ||
      !feedHasMore()
    )
      return;
    const limit = Math.min(200, feedVisibleCount() + 8);
    routeMemory(current()).retained.feedCount=limit;
    if (limit === feedVisibleCount()) return;
    setFeedLoadingMore(true);
    void loadFeedArticles(channelId, limit);
  }
  // A phone starting scan binding asks the watch to open its pairing code; only when idle and in front.
  onCleanup(bindPairingRequestRoute({
    active: () => foreground() && motion.phase === "idle" && !busy(),
    page,
    go: () => go("phone-connection"),
  }));
  // Finishing a flow (for example watch pairing) returns to the home page instead of the page it started from.
  function goHome() {
    navigate(()=>{
      removeWarningRoute();
      if (stack()[0]?.page === "home") setStack((entries) => entries.slice(0, 1));
      else setStack([{ page: "home" }]);
      kv.set("page", "home");
      void loadChannels();
    });
  }
  async function go(next: Page) {
    if (next === "notes") {
      if (busy()) return;
      setBusy(true);
      try {
        await memoRepository.initialize();
      } catch (error) {
        if(!startupDisposed)setError(String(error));
        return;
      } finally {
        setBusy(false);
      }
    }
    if(!await waitForBack())return;
    setPage(next);
    kv.set("page", next);
    if (next === "home") await loadChannels();
    if (next === "articles") {
      if (current().channelId)
        await loadFeedArticles(current().channelId!, 12, true);
      else await loadArticles();
    }
    if (next === "saved" || next === "watch-later")
      await loadSaved(next === "saved" ? "favorite" : "watchLater");
  }
  async function openArticle(item: Article, fromWatchLater = false, replaceReader = false) {
    const origin=contentRoute();
    const previousReader=replaceReader&&origin.page==="reader"?origin:undefined;
    try {
      const full = await props.services.getArticle(item.id,article());
      if(!full)throw new Error("文章不存在，请返回后重试");
      const available=!readerBodyState(full),read=available?true:full.read;
      if(available)await props.services.markRead(item.id);
      navigate(()=>{
        const active = contentRoute();
        if(active.page==="reader"&&active.readerArticle?.id===full.id)return;
        setArticle({ ...full, read });
        // Reopening an already-read article must not rebuild the retained feed
        // and synchronously remeasure every card for an unchanged read flag.
        if(available)setArticles((items) => markFeedArticleRead(items,item.id));
        setChannels((items) => !available||item.read ? items :
          items.map((c) =>
            c.id === item.channelId && !item.read
              ? { ...c, unreadCount: Math.max(0, (c.unreadCount ?? 0) - 1) }
              : c,
          ),
        );
        traceServiceWork("reader.setPage",()=>setPage("reader", {
          readerArticle: { ...full, read },
          readerFromWatchLater: fromWatchLater,
        }));
        if(previousReader)setStack(entries=>entries.filter(entry=>entry!==previousReader));
      });
    } catch (e) {
      if(!startupDisposed)setError(String(e));
    }
  }
  async function openArticleActions(item: Article) {
    if (busy()) return;
    setBusy(true);
    try {
      const full = await props.services.getArticle(item.id,article());
      navigate(()=>{
        setArticle(full ?? item);
        setPage("rss-actions");
      });
    } catch (e) {
      if(!startupDisposed)setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteArticle() {
    const selected = article();
    if (!selected || busy()) return;
    const origin = current();
    setBusy(true);
    try {
      await props.services.deleteArticle(selected.id);
      setArticles((items) => items.filter((item) => item.id !== selected.id));
      if (current() === origin && popPage(true)) setArticle(null);
      await loadChannels(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveArticleState(
    type: "favorite" | "watchLater",
    saved: boolean,
    navigateBack = true,
  ) {
    const selected = article();
    if (!selected || busy()) return;
    const origin = current();
    setBusy(true);
    try {
      await props.services.setSaveState(selected.id, type, saved);
      const patch = type === "favorite" ? { saved } : { watchLater: saved };
      setArticle({ ...selected, ...patch });
      setArticles((items) =>
        items
          .map((a) => (a.id === selected.id ? { ...a, ...patch } : a))
          .filter(
            (a) =>
              a.id !== selected.id ||
              saved ||
              !(
                (currentQuery.saveType ??
                  (currentQuery.saved ? "favorite" : undefined)) === type
              ),
          ),
      );
      if (navigateBack && current() === origin) popPage();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function markArticleUnread() {
    const selected = article();
    if (!selected?.read || busy()) return;
    const origin = current();
    setBusy(true);
    try {
      await props.services.markRead(selected.id, false);
      setArticle({ ...selected, read: false });
      setArticles((items) =>
        items.map((a) => (a.id === selected.id ? { ...a, read: false } : a)),
      );
      setChannels((items) =>
        items.map((c) =>
          c.id === selected.channelId
            ? { ...c, unreadCount: (c.unreadCount ?? 0) + 1 }
            : c,
        ),
      );
      if (current() === origin) popPage();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggleFeedSave(
    item: Article,
    type: "favorite" | "watchLater",
  ) {
    if (busy()) return;
    const saved = type === "favorite" ? !item.saved : !item.watchLater;
    setBusy(true);
    try {
      await props.services.setSaveState(item.id, type, saved);
      setArticles((items) =>
        items.map((article) =>
          article.id === item.id
            ? {
                ...article,
                ...(type === "favorite" ? { saved } : { watchLater: saved }),
              }
            : article,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function openChannelSettings(id: string) {
    if (busy()) return;
    setBusy(true);
    try {
      const [enabled, playback] = await Promise.all([
        props.services.getChannelOriginalMode(id),
        props.services.getChannelPlaybackSettings(id),
      ]);
      navigate(()=>{
        setOriginalModes((m) => ({ ...m, [id]: enabled }));
        setChannelPlayback((m) => ({ ...m, [id]: playback }));
        setPage("channel-settings", { channelId: id });
      });
    } catch (e) {
      if(!startupDisposed)setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function channelAction(
    id: string,
    action:
      | "original"
      | "background"
      | "move"
      | "pin"
      | "read"
      | "delete"
      | "clear",
  ) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      if (action === "original") {
        const enabled = !originalModes()[id];
        await props.services.setChannelOriginalMode(id, enabled);
        setOriginalModes((m) => ({ ...m, [id]: enabled }));
        setChannels((items) =>
          items.map((c) =>
            c.id === id ? { ...c, useOriginalContent: enabled } : c,
          ),
        );
      } else if (action === "background") {
        const value = channelPlayback()[id];
        if (!value?.hasPlayableMedia) return;
        const enabled = !value.continuePlaybackInBackground;
        await props.services.setChannelBackgroundPlayback(id, enabled);
        setChannelPlayback((m) => ({
          ...m,
          [id]: { ...value, continuePlaybackInBackground: enabled },
        }));
      } else if (action === "move") {
        await props.services.moveChannelToTop(id);
        setChannels(await props.services.listChannels());
      } else if (action === "pin") {
        const channel = channels().find((item) => item.id === id);
        if (!channel) return;
        await props.services.setChannelPinned(id, !channel.isPinned);
        setChannels(await props.services.listChannels());
      } else if (action === "read") {
        await props.services.markChannelRead(id);
        setArticles((items) =>
          items.map((a) => (a.channelId === id ? { ...a, read: true } : a)),
        );
        setChannels((items) =>
          items.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)),
        );
      } else if (action === "clear") {
        await props.services.clearLocalContent(id);
        setArticles((items) => items.filter((a) => a.channelId !== id));
        setChannels((items) =>
          items.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)),
        );
        setChannelPlayback((m) => ({
          ...m,
          [id]: { ...m[id], hasPlayableMedia: false },
        }));
      } else {
        await props.services.deleteChannel(id);
        setChannels((items) => items.filter((c) => c.id !== id));
        setArticles((items) => items.filter((a) => a.channelId !== id));
        navigate(()=>{removeWarningRoute();setStack([{ page: "home" }]);});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function searchChannel(id: string) {
    searchDebounce?.cancel();
    searchDebounce = undefined;
    searchRequestVersion++;
    setQuery("");
    setSearchResults([]);
    setPage("search", { channelId: id });
  }
  function updateSearchKeyword(channelId: string, value: string) {
    searchDebounce?.cancel();
    searchRequestVersion++;
    setQuery(value);
    if(current().page==='search'){routeMemory(current()).retained.query=value;saveActivity();}
    setSearchResults([]);
    setSearchLoading(false);
    if (!value.trim()) return;
    const timer = (searchDebounce = delay(180));
    void timer.result.then(() => {
      if (searchDebounce !== timer) return;
      searchDebounce = undefined;
      if (current().page === "search" && current().channelId === channelId)
        void searchChannelArticles(channelId, value);
    }, () => {});
  }
  async function searchChannelArticles(channelId: string, keyword: string) {
    const version = ++searchRequestVersion;
    const term = keyword.trim();
    setQuery(keyword);
    if(current().page==='search'){routeMemory(current()).retained.query=keyword;saveActivity();}
    setError("");
    setSearchResults([]);
    if (!term) {
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    try {
      const found = props.services.searchArticles
        ? await props.services.searchArticles(channelId, term)
        : await props.services.listArticles({
            channelId,
            query: term,
            pageSize: 120,
          });
      if (
        version === searchRequestVersion &&
        current().page === "search" &&
        current().channelId === channelId
      )
        setSearchResults(found);
    } catch (e) {
      if (
        version === searchRequestVersion &&
        current().page === "search" &&
        current().channelId === channelId
      )
        setError(String(e));
    } finally {
      if (version === searchRequestVersion) setSearchLoading(false);
    }
  }
  async function refresh() {
    const origin=current();
    const refreshAll = page() === "home";
    if (refreshAll && homeRefreshing()) return;
    // Native HomeComposeScreen keeps channel interactions enabled while "刷新全部" runs; the
    // refresh state only drives the indicator. Per-page refresh still holds the busy gate.
    if (refreshAll) setHomeRefreshing(true);
    else setBusy(true);
    setError("");
    try {
      try {
        await networkFor(origin).run(() => props.services.refresh(origin.channelId));
      }
      finally { if (refreshAll) usageTelemetry.recordFeedRefreshed(); }
      if(contentRoute()!==origin)return;
      if(origin.page==="home")await loadChannels(false);
      else if(origin.page==="articles"&&origin.channelId)
        await loadFeedArticles(origin.channelId,feedVisibleCount());
      else if(origin.page==="saved"||origin.page==="watch-later")
        await loadSaved(origin.page==="saved"?"favorite":"watchLater");
      else if(origin.page==="search"&&origin.channelId)
        await searchChannelArticles(origin.channelId,query());
      else await loadArticles(currentQuery);
    } catch (e) {
      if(current()===origin&&!isNetworkRecoveryCancellation(e))setError(String(e));
    } finally {
      if (refreshAll) setHomeRefreshing(false);
      else setBusy(false);
    }
  }
  const pendingFeedUpdates = new Set<string>();
  let updatingFeed = false,
    pendingLibraryUpdate = false;
  function updateFeedWhenSettled() {
    const origin = current(),
      id = origin.channelId,
      snapshot = currentQuery;
    const libraryUpdate =
      pendingLibraryUpdate &&
      ["articles", "saved", "watch-later", "search"].includes(origin.page);
    if (
      updatingFeed ||
      feedLoadingMore() ||
      (!libraryUpdate &&
        (!id || !pendingFeedUpdates.has(id) || origin.page !== "articles")) ||
      origin.list?.scroller.state() !== "idle"
    )
      return;
    if (id) pendingFeedUpdates.delete(id);
    if (libraryUpdate) pendingLibraryUpdate = false;
    updatingFeed = true;
    if (origin.page === "search") {
      void (
        id && query().trim()
          ? searchChannelArticles(id, query())
          : Promise.resolve()
      ).finally(() => {
        updatingFeed = false;
      });
      return;
    }
    const feed = origin.page === "articles" && !!id,
      limit = feed ? feedVisibleCount() : 30;
    const request = feed
      ? loadFeedWindow(props.services.listArticles, id!, limit)
      : props.services
          .listArticles({ ...snapshot, page: snapshot.page, pageSize: 30 })
          .then((items) => ({ items, hasMore: false }));
    void request
      .then((window) => {
        if (current() === origin && currentQuery === snapshot) {
          if (origin.list?.scroller.state() === "idle") {
            setArticles(window.items);
            if (feed) setFeedHasMore(window.hasMore);
          } else {
            if (id) pendingFeedUpdates.add(id);
            if (libraryUpdate) pendingLibraryUpdate = true;
          }
        } else {
          if (id) pendingFeedUpdates.add(id);
          if (libraryUpdate) pendingLibraryUpdate = true;
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        updatingFeed = false;
      });
  }
  onFrame(updateFeedWhenSettled,()=>false);
  onFrame(()=>{if(page()==="home")idleHit(2);},()=>false);
  let debugDisposed=false,debugStop:(()=>void)|undefined,shellStop:(()=>void)|undefined;
  onCleanup(()=>{debugDisposed=true;debugStop?.();shellStop?.();});
  onMount(() => {
    const unsubscribe = props.services.subscribeChannel((event) => {idleHit(47);
      if (event.kind === "error") {
        if (current().channelId === event.id)
          setError(event.message ?? "刷新失败");
        return;
      }
      if (event.kind === "notes") {
        setNotesRefreshKey((v) => v + 1);
        return;
      }
      if (event.kind === "library") pendingLibraryUpdate = true;
      if (event.kind === "refresh" || event.kind === "library")
        void props.services
          .listChannels()
          .then(list=>traceServiceWork("home.setChannels",()=>setChannels(list)))
          .catch((e) => setError(String(e)));
      pendingFeedUpdates.add(event.id);
      updateFeedWhenSettled();
    });
    onCleanup(unsubscribe);
    if (homeSnapshot) startupMark("channels.snapshot");
    void restoreStartupNavigation().then(()=>{if(!debugDisposed){debugStop=startExternalDebug(resumeAwemeId=>douyinNavigate({name:"entry",resumeAwemeId}),id=>setPage("debug-summary",{articleId:id}));shellStop=bindShellCommands({current,client:douyinClient,navigate:douyinNavigate,play:douyinPlay,move:changeDouyinVideo});}});
  });
  function removeWarningRoute(){
    if(!warningShown())return;
    cancelActiveTouches();
    finishPopPage(current());
  }
  createEffect(()=>{if(cloudOwnerChoice()&&warningShown())untrack(removeWarningRoute);});
  createEffect(() => {idleHit(13);setNavigationState({ canGoBack: stack().length > 1, rootSwipeEnabled: !networkPageBlocksSwipe() });});
  const removeHostEvent = __onHostEvent((event) => {
    if (event.t === "touchCancel" && motion.phase === "dragging")
      motion.release(0, Date.now(), true);
    if (
      event.t === "lifecycle" &&
      event.state !== "active" &&
      motion.phase !== "idle"
    ) {
      motion.reset();
      setBackOffset(0);
    }
  });
  const removeBack = onSystemBack(() => {
    if (disclosurePending()) return true;
    if (page() === "home" && dismissHomeNotice()) return true;
    if (stack().length <= 1) return false;
    const closeEditor = current().noteEditorBack;
    if (closeEditor) {
      closeEditor();
      return true;
    }
    if (motion.phase !== "idle") return true;
    rememberBackRotation();
    beginBack(0);
    motion.release(0, Date.now(), false, true);
    return true;
  });
  const removeAxis = onAxisDelta(RelativeAxis.Primary, (delta: number) => {
    if (disclosurePending()) {
      const list = page() === "home" ? homeDisclosureList : current().disclosureList;
      list?.scroller.scrollBy((delta * rowHeight) / (12 * RelativeAxisUnits.PerDegree), {durMs:120});
      return;
    }
    if (page() === "home" && homeNoticeVisible()) return;
    if (motion.phase === "idle" && !current().player?.onCrown(delta)) {
      if (current().page === "reader") current().reader?.manualScroll();
      current().list?.scroller.scrollBy(
        (delta * rowHeight) / (12 * RelativeAxisUnits.PerDegree),
        { durMs: 120 },
      );
    }
  });
  onCleanup(() => {
    void speechPlayback.stop();
    removeBack();
    removeAxis();
    removeHostEvent();
  });

  const readerFont = () => {
    const size = settings().fontSizeSp,
      base = Math.min(18, size);
    return { slot: (base - 12) / 2, scale: size / base };
  };
  const readerLineHeight = () =>
    readerPreset().body.fontSizeSp * readerPreset().body.lineHeightEm;
  const doAdd = async (prefill = "") => {
    setPage("add-rss", { addUrl: prefill });
  };
  const openUrl = async (url: string, origin: BrowserOrigin = "information") => {
    try {
      await openBrowserUrl(url, origin, readerPreset());
    } catch (e) {
      setError(browserOpenFailureMessage(e));
    }
  };
  const updateSettings = (patch: Partial<SettingsState>) => {
    try {
      setSettings(settingsStore.update(patch));
      if (patch.speechRate !== undefined)
        ttsConfigStore.setSpeed(patch.speechRate);
    } catch (e) {
      setError(String(e));
    }
  };
  let remotePromptActive = false;
  onFrame(() => {
    if (
      lifecycle() !== "active" ||
      remotePromptActive ||
      busy() ||
      loading() ||
      motion.phase !== "idle"
    )
      return;
    if (page() === "bluetooth-connection") return;
    const url = takeRemoteInput();
    if (url === undefined) return;
    if (page() === "remote-input") popPage(true);
    remotePromptActive = true;
    void doAdd(url)
      .catch((error) => setError(String(error)))
      .finally(() => {
        remotePromptActive = false;
      });
  },()=>false);
  const settingsNavigate = (route: SettingsRoute) => {
    if (route === "debug-tools") {if(debugGate.allowed)setPage("debug-tools");}
    else if (route === "reader-presets") {
      if (presetState()) setPage("settings-reader-presets");
      else setError("阅读器预设数据无法读取，已保留原数据");
    } else if (route === "llm-usage") setPage("settings-llm-usage");
    else if (route === "llm-preset") setPage("settings-llm-preset");
    else if (route === "auto-scroll") setPage("settings-auto-scroll");
    else if (route === "tts") setPage("settings-speech");
    else if (route === "tts-config") setPage("tts-config");
    else if (route === "remote-input") setPage("remote-input");
    else if (route === "advanced") setPage("settings-advanced");
    else if (route === "beian")
      setPage("information", { informationPage: "beian" });
    else setError("此设置页尚未迁移");
  };
  const informationNavigate = (informationPage: InformationPage) =>
    setPage("information", { informationPage });
  const {
    biliBackground,
    setBiliBackground,
    douyinBackground,
    setDouyinBackground,
    openRssVideo,
    biliNavigate,
    restoreDouyinVideo,
    douyinLogin,
    douyinPlay,
    primeDouyinEntry,
    stopDouyinEntry,
    douyinNavigate,
    changeDouyinVideo,
    prepareDouyinAdjacent,
    promoteDouyinAdjacent,
    selectDouyinTarget,
    biliOriginal,
    setBiliOriginal,
    recoverDouyinVideo,
    rejectDouyinAdjacent,
    douyinReady,
    douyinActions,
    douyinOriginal,
    setDouyinOriginal,
    recoverRssDouyinVideo,
    reloadVideo,
    videoLoading,
    deleteBuiltin,
  } = createMediaRouteController({
    network:()=>networkFor(contentRoute()),
    initialVideoBounds:()=>hasCapability("media.video.sessions")?{x:0,y:0,width,height,visible:false}:undefined,
    onActivityStateChange:saveActivity,
    onRssSourcePublished: () => usageTelemetry.recordVideoPlayed(),
    services: props.services,
    current:contentRoute,
    motion:{get phase(){return motion.phase;}},
    waitForBack,
    busy,
    setBusy,
    setError,
    settings,
    playingSource,
    setPlayingSource,
    channels,
    setChannels,
    setOriginalModes,
    setStack,
    setPage,
    popPage,
  });
  const hostToast = (message: string) =>
    hostOperation("ui.toast", { message }).result.catch(() => {});
  const addRecommendation = (channel: RecommendedChannel) => {
    void doAdd(channel.url);
  };
  const openHttpExport = (exportMode: "favorite" | "watchLater" | "bili") =>
    setPage("remote-input", { exportMode });
  const receiveBluetoothUrl = (url: string, destination: "return" | "add") => {
    takeRemoteInput(url);
    const entries = stack();
    const caller = entries.at(-2);
    const target: Entry = { page: "add-rss", addUrl: url };
    if (destination === "return" && caller?.page === "add-rss")
      setStack([...entries.slice(0, -2), target]);
    else setStack([...entries.slice(0, -1), target]);
    motion.reset();
    setBackOffset(0);
  };
  createEffect(()=>{if(page()!=='home')douyinBench.cancelLogoutFeedback(douyinClient);});
  onCleanup(()=>douyinBench.cancelLogoutFeedback(douyinClient));
  const returnHomeAfterDouyinLogout = () => {
    for (const entry of stack()) entry.queue?.cancel();
    batch(() => {
      setStack([{ page: "home" }]);
      setPlayingSource(undefined);
      setError("");
      setBackOffset(0);
    });
    motion.reset();
    void video.stop().catch(() => {});
    void hostToast("已退出登录");
    douyinBench.logoutFeedback(douyinClient);
  };
  const openAddedChannel = async (channel: Channel) => {
    await loadChannels();
    if(!await waitForBack())return;
    if (page() === "add-rss") setStack((entries) => entries.slice(0, -1));
    if (channel.url === "builtin:bili") await biliNavigate({ name: "entry" });
    else if (channel.url === "builtin:douyin")
      await douyinNavigate({ name: "entry" });
    else {
      setFeedVisibleCount(12);
      setFeedHasMore(false);
      setPage("articles", { channelId: channel.id });
      await loadFeedArticles(channel.id, 12, true);
    }
  };

  const renderPage = (entry: Entry) => {
    const network=networkFor(entry);
    preserveNetworkContent(network,()=>hasLocalPageContent(entry));
    if(entry.page==='reader-scroll-controls')entry.reader=stack().slice(0,stack().indexOf(entry)).reverse().find(item=>item.page==='reader')?.reader;
    const entryPage = () => entry.page;
    const active = () => current() === entry;
    const selfTitled = () => routeIsSelfTitled(entryPage());

    const handlers=new Set<()=>void>();checkpoints.set(entry,handlers);const scrollSlots=new Set<number>();
    onCleanup(()=>checkpoints.delete(entry));
    return (
      <NetworkRecoveryProvider network={network} active={()=>contentRoute()===entry&&foreground()&&recoveryEnabled(entry)}><RouteActivityProvider entry={entry} changed={saveActivity} checkpoints={handlers} scrollSlots={scrollSlots}>
      <View
        class={
          entryPage() === "video"
            ? metrics.shape === "round" && active() && backOffset() > 0
              ? "absolute inset-0 overflow-hidden rounded-[9999]"
              : "absolute inset-0 overflow-hidden"
            : metrics.shape === "round" && active() && backOffset() > 0
              ? "absolute inset-0 overflow-hidden rounded-[9999] bg-[#000000]"
              : "absolute inset-0 overflow-hidden bg-[#000000]"
        }
        style={{
          translateX: active()
            ? backTranslation().x
            : current().page === "video"
              ? -2 * width
              : 0,
          translateY: active() ? backTranslation().y : 0,
          opacity: active() || backUnderlay() === entry ? 1 : 0,
        }}
      >
        <Show when={!selfTitled()}>
          <View class="absolute left-[12] right-[12] top-[8] h-[30] items-center justify-center">
            <Text class="text-lg text-white">{routeTitle(entryPage())}</Text>
          </View>
        </Show>
        <View
          class={
            entryPage() === "video"
              ? "absolute left-[0] right-[0] bottom-[0] overflow-hidden"
              : "absolute left-[0] right-[0] bottom-[0] overflow-hidden bg-[#000000]"
          }
          style={{ insetT: selfTitled() ? 0 : 42 }}
        >
          <Show
            when={
              contentRoute() !== entry ||
              !loading() ||
              entryPage() === "saved" ||
              entryPage() === "watch-later"
            }
            fallback={
              <View class="absolute inset-0 items-center justify-center">
                <Text class="text-sm text-[#9aa9c4]">加载中…</Text>
              </View>
            }
          >
            <Show when={entryPage()==='bluetooth-warning'}>
              <BluetoothWarningPage width={width} height={height} rotation={playerRotation()} onBack={()=>{if(active()&&motion.phase==='idle')popPage();}}/>
            </Show>
            <HomeRoutes
              ownerChoiceNetwork={ownerChoiceNetwork}
              foreground={foreground}
              goHome={goHome}
              entry={entry}
              page={entryPage}
              active={() => active() && !(entryPage() === "home" && (homeNoticeVisible() || !!homeDisclosurePending()))}
              width={width}
              height={height}
              channels={channels}
              notesPlacement={notesHomePlacement()}
              moveNotesToTop={() => setNotesHomePlacement(notesPlacementStore.moveNotesToTop())}
              toggleNotesPinned={() => setNotesHomePlacement(notesPlacementStore.setNotesPinned(!notesHomePlacement().isPinned))}
              refreshing={homeRefreshing}
              busy={busy}
              platformLoginState={platformLoginState}
              speechState={speechState}
              speechSpectrum={speechSpectrum}
              services={routeServices}
              go={go}
              openSpeech={() => setPage("speech-playback")}
              openAdd={() => void doAdd()}
              refresh={refresh}
              openBili={biliNavigate}
              openDouyin={douyinNavigate}
              openFeed={(channel) => navigate(() => {
                setFeedVisibleCount(12);
                setFeedHasMore(false);
                setPage("articles", { channelId: channel.id });
                void loadFeedArticles(channel.id, 12, true);
              })}
              channelAction={channelAction}
              openInformation={informationNavigate}
              setError={setError}
            />
            <RssRoutes
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              services={routeServices}
              channels={channels}
              articles={articles}
              article={article}
              query={query}
              searchResults={searchResults}
              searchLoading={searchLoading}
              busy={busy}
              feedLoadingMore={feedLoadingMore}
              feedHasMore={feedHasMore}
              originalModes={originalModes}
              channelPlayback={channelPlayback}
              systemShareEnabled={() =>
                settings().shareUseSystem && systemShareAvailable()
              }
              setPage={setPage}
              popPage={popPage}
              setError={setError}
              openAddedChannel={openAddedChannel}
              searchChannelArticles={searchChannelArticles}
              updateSearchKeyword={updateSearchKeyword}
              openArticle={openArticle}
              openArticleActions={openArticleActions}
              openChannelSettings={openChannelSettings}
              searchChannel={searchChannel}
              channelAction={channelAction}
              share={share}
              toggleFeedSave={toggleFeedSave}
              refresh={refresh}
              loadMoreFeedArticles={loadMoreFeedArticles}
              deleteArticle={deleteArticle}
              markArticleUnread={markArticleUnread}
              saveArticleState={saveArticleState}
            />
            <SavedRoutes
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              items={savedEntries}
              articles={articles}
              loading={loading}
              undoVisible={() => !!savedUndo()}
              openArticle={openArticle}
              openBili={biliNavigate}
              openDouyin={douyinNavigate}
              remove={removeSaved}
              undo={undoSaved}
              reorder={reorderSaved}
              setError={setError}
              openExport={openHttpExport}
            />
            <MediaRoutes
              onOpenImage={url=>setPage("reader-image",{imageUrl:url})}
              readerKeepAwake={()=>settings().readerKeepAwake}
              createBatteryTelemetry={createVideoBatteryTelemetry}
              preset={readerPreset}
              entry={entry}
              page={entryPage}
              active={active}
              coveredByActions={() => current().douyinActionsOwner === entry}
              width={width}
              height={height}
              round={metrics.shape === "round"}
              backOffset={backOffset}
              backTranslation={backTranslation}
              services={routeServices}
              channels={channels}
              playingSource={playingSource}
              biliOriginal={biliOriginal}
              douyinOriginal={douyinOriginal}
              biliBackground={biliBackground}
              douyinBackground={douyinBackground}
              setBiliOriginal={setBiliOriginal}
              setDouyinOriginal={setDouyinOriginal}
              setBiliBackground={setBiliBackground}
              setDouyinBackground={setDouyinBackground}
              saveMediaSetting={(platform, key, value) =>
                kv.set(`watchrss.${platform}.${key}`, value)
              }
              deleteBuiltin={deleteBuiltin}
              share={share}
              openBili={biliNavigate}
              openDouyin={douyinNavigate}
              playDouyin={douyinPlay}
              primeDouyinEntry={primeDouyinEntry}
              stopDouyinEntry={stopDouyinEntry}
              loginDouyin={douyinLogin}
              openUrl={openUrl}
              popPage={popPage}
              setError={setError}
              recoverDouyinVideo={recoverDouyinVideo}
              rejectDouyinAdjacent={rejectDouyinAdjacent}
              recoverRssDouyinVideo={recoverRssDouyinVideo}
              reloadVideo={reloadVideo}
              douyinReady={douyinReady}
              douyinActions={douyinActions}
              changeDouyinVideo={changeDouyinVideo}
              prepareDouyinAdjacent={prepareDouyinAdjacent}
              promoteDouyinAdjacent={promoteDouyinAdjacent}
              selectDouyinTarget={selectDouyinTarget}
              openHttpExport={openHttpExport}
              onDouyinLogoutSuccess={returnHomeAfterDouyinLogout}
            />
            <SettingsRoutes
              createDebugBluetooth={props.createDebugBluetooth}
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              services={routeServices}
              settings={settings}
              presetState={presetState}
              presetActions={presetStore}
              updatePreset={updatePreset}
              updateSettings={updateSettings}
              navigate={settingsNavigate}
              systemShareAvailable={systemShareAvailable}
              reloadSettings={() => setSettings(settingsStore.load())}
              popPage={popPage}
              setError={setError}
            />
            <NotesRoutes
              onStateChange={saveActivity}
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              services={routeServices}
              backOffset={() => backTranslation().x}
              transitionIdle={() => motion.phase === "idle"}
              cancelBack={() => { editorBack = undefined; motion.reset(); setBackOffset(0); }}
              refreshKey={notesRefreshKey}
              bumpRefreshKey={() => setNotesRefreshKey((value) => value + 1)}
              preset={readerPreset}
              backgroundSnapshot={informationBackground}
              setPage={setPage}
              popPage={popPage}
              setError={setError}
            />
            <InfoRoutes
              saveSnapshot={(item,snapshot)=>{if(snapshot)informationActivity.save(item,snapshot);}}
              entry={entry}
              page={entryPage}
              active={active}
              foreground={foreground}
              width={width}
              height={height}
              setPage={setPage}
              openInformation={informationNavigate}
              addRecommendation={addRecommendation}
              openUrl={(url) => openBrowserUrl(url,"information",readerPreset())}
            />
            <PhoneRoutes
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              bluetoothSync={bluetoothSync}
              onUrl={receiveBluetoothUrl}
              popPage={popPage}
            />
          </Show>
          <ReaderRoutes
            openNovelChapter={article=>openArticle(article,false,true)}
            updateSettings={updateSettings}
            entry={entry}
            page={entryPage}
            active={active}
            width={width}
            height={height}
            density={metrics.density}
            stack={stack}
            motion={motion}
            setBackOffset={setBackOffset}
            services={routeServices}
            settings={settings}
            busy={busy}
            speechState={speechState}
            speechPlayback={speechPlayback}
            previewState={previewState}
            preset={readerPreset}
            lineHeight={readerLineHeight}
            article={article}
            setArticle={setArticle}
            openArticle={openArticle}
            setPage={setPage}
            popPage={popPage}
            setError={setError}
            saveArticleState={saveArticleState}
            share={share}
            toast={hostToast}
            openRssVideo={openRssVideo}
          />
          <Show when={active() && entryPage() === "home" && props.announcements} keyed>
            {services => <HomeNoticeDialog
              width={width}
              height={height}
              announcement={pendingAnnouncement()}
              messages={pendingPushMessages()}
              updater={services.updater}
              onDismissAnnouncement={announcement => {
                services.repository.markDismissed(announcement);
                setPendingAnnouncement(null);
              }}
              onDismissMessages={dismissHomeNotice}
            />}
          </Show>
          <Show when={active() && entryPage() === "home"}>
            <PendingDisclosure width={width} height={height} pending={homeDisclosurePending} onConfirm={homeDisclosure.confirm} ref={value => { homeDisclosureList = value; }} />
          </Show>
        </View>
      </View>
      </RouteActivityProvider></NetworkRecoveryProvider>
    );
  };

  // Each entry here is a browsing surface. A new route must explicitly opt in.
  const warningBrowseReady:Partial<Record<Page,(entry:Entry)=>boolean>>={
    home:entry=>entry.browseReady?.()!==false&&!homeNoticeVisible()&&!homeDisclosurePending(),
    articles:entry=>entry.browseReady?.()!==false,
    notes:entry=>entry.browseReady?.()!==false,
    settings:()=>true,
  };
  bindBluetoothWarningRoute(warningNetwork,{
    shown:warningShown,
    canShow:()=>{
      const entry=current();
      if(!warningBrowseReady[entry.page]?.(entry))return false;
      if(!foreground()||cloudOwnerChoice()||networkPageBlocksSwipe()||nativeInputOpen()||systemShareOpen())return false;
      if(motion.phase!=='idle'||afterBack.length||playingSource())return false;
      return (entry.list?.scroller.state()??'idle')==='idle';
    },
    push:()=>setPage('bluetooth-warning'),
    pop:removeWarningRoute,
  });

  const noticeFrame=createMemo(()=>readerControlViewport(width,height,metrics.shape==="round",page()==="reader"&&settings().readerPageMode));
  return (
    <View
      class={
        page() === "video"
          ? "relative overflow-hidden"
          : "relative overflow-hidden bg-[#000000]"
      }
      style={{ width, height }}
    >
      <For each={stack()}>{renderPage}</For>
      <Show when={!warningShown()}>
      <TopNotice message={error()} width={width} height={height} round={metrics.shape==="round"}
        top={noticeFrame().top+38} maxWidth={noticeFrame().width-24} background="#4b2030" color="#ffd5dc" />
      <Show when={busy()}>
        <Text class="absolute z-10 text-xs text-center text-[#45d6a7]" style={{insetL:noticeFrame().left,width:noticeFrame().width,insetT:noticeFrame().top+18}}>
          处理中
        </Text>
      </Show>
      <PlayerLoadingIndicator width={width} height={height} visible={foreground()&&videoLoading()} phase="fetching"/>
      <ReadAloudFloatingBubble
        width={width}
        height={height}
        round={metrics.shape === "round"}
        active={foreground()}
        page={page()}
        state={speechState()}
        onOpen={() => setPage("speech-playback")}
      />
      </Show>
      <Show when={cloudOwnerChoice()&&!warningShown()}>
        <NetworkRecoveryLayer network={ownerChoiceNetwork} width={width} height={height} round={metrics.shape==='round'}/>
      </Show>
      <Show when={recoveryEnabled(current())}>
        <NetworkRecoveryLayer network={networkFor(current())} width={width} height={height} round={metrics.shape==='round'} rotation={playerRotation()}/>
      </Show>
    </View>
  );
}
