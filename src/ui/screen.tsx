import {startExternalDebug} from '../debug/external-host.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import {markFeedArticleRead} from "./reader-open-state.ts";
import {ActivityLog} from '../logs/activity.ts';
import {activityStateHub} from '../navigation/activity-host.ts';
import {captureActivityNavigation,restoreActivityNavigation,resolveActivityNavigation,routeMemory,CONTENT_ACTIVITY_KEY} from '../navigation/activity-navigation.ts';
import {InformationActivity} from '../navigation/information-activity.ts';
import {RouteActivityProvider} from './route-activity.tsx';
import { startupFirstScreen, startupMark } from "../core/startup-trace.ts";
import {readHomeChannelSnapshot,writeHomeChannelSnapshot} from "./home-snapshot.ts";
import {debugGate} from '../debug/host.ts';
import type {DebugBluetoothSession} from '../debug/bluetooth.ts';
import {usageTelemetry} from '../telemetry/host.ts';
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
import { readerFontResolver } from "../reader/font-assets.ts";
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
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BackMotion } from "@podjs/framework/navigation";
import { HomeEntryPlacementStore } from "./home-placement.ts";
import type { SettingsRoute } from "./SettingsScreen.tsx";
import { SettingsStore, type SettingsState } from "../settings/index.ts";
import type { InformationPage } from "./InformationScreens.tsx";
import { checkpointInformationSnapshot } from "./information-route-state.ts";
import type { RecommendedChannel } from "../rss/recommendations.ts";
import { memoRepository } from "../services.ts";
import {
  AppResumeStore,
  resolveResumeTarget,
  resumeTargetForStack,
} from "../navigation/resume-state.ts";
import type { HomePlatformLoginState } from "./home-extras.ts";
import { HomeRoutes } from "./routes/home.tsx";
import { InfoRoutes } from "./routes/info.tsx";
import { MediaRoutes } from "./routes/media.tsx";
import { createMediaRouteController } from "./routes/media-controller.ts";
import { NotesRoutes } from "./routes/notes.tsx";
import { ReaderRoutes } from "./routes/reader.tsx";
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
import type { Announcement, PushMessage } from "../announcement/models.ts";
import { HomeNoticeDialog } from "./HomeNoticeDialog.tsx";

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
  bluetoothSync?: Pick<ApplicationForegroundSync, "state" | "subscribe" | "refresh">;
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
  const resumeStore = new AppResumeStore(kv);
  const startupResume = resumeStore.read();
  const activityEntries=restoreActivityNavigation(activityStateHub.read(),debugGate.allowed);
  const [resumeReady, setResumeReady] = createSignal(false);
  const [stack, setStack] = createSignal<Entry[]>([{ page: "home" }]);
  const checkpoints=new Map<Entry,Set<()=>void>>();
  const saveActivity=()=>traceServiceWork("navigation.saveActivity",()=>untrack(()=>{
    if(!resumeReady())return;
    traceServiceWork("navigation.checkpoints",()=>{for(const handlers of checkpoints.values())for(const checkpoint of handlers)checkpoint();});
    traceServiceWork("navigation.resume",()=>resumeStore.save(resumeTargetForStack(stack())));
    const next=captureActivityNavigation(activityStateHub.read(),stack());
    void activityStateHub.write(next,[CONTENT_ACTIVITY_KEY]).catch(error=>logConsole.warn('Activity state save failed',String(error)));
  }));
  const informationActivity=new InformationActivity(saveActivity,error=>logConsole.warn('Information restore',String(error)));
  onCleanup(()=>informationActivity.close());
  const [playingSource, setPlayingSource] = createSignal<PlaybackSource>();
  const current = () => stack()[stack().length - 1];
  const page = () => current().page;
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
  const motion = new BackMotion(width);
  const [backOffset, setBackOffset] = createSignal(0);
  function setPage(next: Page,data: Partial<Entry> = {}) { return traceServiceWork("navigation.setPage",()=>kv.batch(()=>setPageImpl(next,data))); }
  function setPageImpl(next: Page, data: Partial<Entry> = {}) {
    if((next==="debug-tools"||next==="debug-summary")&&!debugGate.allowed)return;
    if (
      (next === page() && Object.keys(data).length === 0) ||
      motion.phase !== "idle"
    )
      return;
    traceServiceWork("navigation.informationCheckpoint",()=>checkpointInformationSnapshot(current()));
    traceServiceWork("navigation.stopList",()=>current().list?.scroller.stop());
    traceServiceWork("navigation.setStack",()=>setStack((entries) => [...entries, { page: next, ...data }]));
  }
  function finishPopPage(leaving: Entry) {
    if (current() !== leaving || stack().length <= 1) return false;
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
    current().queue?.cancel();
    if (leaving.page === "saved" || leaving.page === "watch-later")
      clearSavedUndo();
    if (current().page === "note-detail" || current().page === "note-actions")
      setNotesRefreshKey((value) => value + 1);
    batch(() => {
      setStack((entries) => entries.slice(0, -1));
      if (current().playback) setPlayingSource(current().playback);
      setError("");
      setBackOffset(0);
    });
    motion.reset();
    if (leaving.page === "search" && leaving.channelId)
      void loadFeedArticles(leaving.channelId, feedVisibleCount());
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
    readerExit.begin(
      leaving,
      () => leaving.reader!.flushProgress(),
      (outcome) => {
        logReaderProgressFlush("exit", outcome);
        if (current() === leaving) finishPopPage(leaving);
      },
    );
    return true;
  }
  createGesture({
    region: {
      rect: () =>
        stack().length > 1 &&
        motion.phase !== "settling" &&
        (current().player?.canSwipeBack?.() ?? true) &&
        current().page !== "reader-image"
          ? { x: 0, y: 0, w: width, h: height }
          : null,
    },
    axis: "x",
    panSlop: 8,
    onPanStart: (c) => {
      current().list?.scroller.stop();
      motion.begin(c.dx);
      setBackOffset(motion.offset);
    },
    onPanMove: (c) => {
      motion.move(c.dx);
      setBackOffset(motion.offset);
    },
    onPanEnd: (c) => {
      if (motion.phase === "dragging") motion.release(c.vx, Date.now());
    },
    onCancel: () => {
      if (motion.phase === "dragging") motion.release(0, Date.now(), true);
    },
  });
  onFrame(() => {
    if (motion.phase !== "settling") return;
    const result = motion.tick(Date.now());
    if (result === "commit") popPage();
    else setBackOffset(motion.offset);
  });
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
  const homeSnapshot = (activityEntries?.length??0)>1 ? undefined : readHomeChannelSnapshot(kv, startupResume);
  const [channels, setChannels] = createSignal<Channel[]>(homeSnapshot ?? []);
  const notesPlacementStore = new HomeEntryPlacementStore();
  const [notesHomePlacement, setNotesHomePlacement] = createSignal(notesPlacementStore.read());
  const [articles, setArticles] = createSignal<Article[]>([]);
  const [article, setArticle] = createSignal<Article | null>(null);
  const [loading, setLoading] = createSignal(!homeSnapshot),
    [busy, setBusy] = createSignal(false),
    [homeRefreshing, setHomeRefreshing] = createSignal(false),
    [error, setError] = createSignal("");
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
    setLoading,
    setError,
    setCurrentQuery: (value) => {
      currentQuery = value;
    },
  });
  const [query, setQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<Article[]>([]);
  const [searchLoading, setSearchLoading] = createSignal(false);
  let searchRequestVersion = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (page() !== "search" && searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = undefined;
      searchRequestVersion++;
    }
  });
  onCleanup(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
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
    props.services,
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
    const source = current();
    const finishSource =
      source.page === "rss-actions" ||
      (source.page === "bili" && source.biliRoute?.name === "actions") ||
      (source.page === "douyin" && source.douyinRoute?.name === "actions");
    void shareEnvironment
      .then(async (supported) => {
        if (!shareAlive || current() !== source || motion.phase !== "idle")
          return;
        const outcome = await routeShare(input, settings().shareUseSystem && supported, {
          text: openSystemShare,
          qr,
          unavailable: () => {
            void hostToast("暂无可分享链接");
          },
        });
        if (shareAlive && onDone && outcome !== "none") onDone();
        else if (shareAlive && finishSource) {
          source.list?.scroller.stop();
          setStack((entries) =>
            entries.length > 1
              ? entries.filter((entry) => entry !== source)
              : entries,
          );
        }
      })
      .catch((e) => {
        if (shareAlive) setError(String(e));
      });
  };
  createEffect(() =>
    props.onSyncMediaKeepAliveChange?.(settings().syncMediaKeepAlive),
  );
  createEffect(() => {
    void managedCache
      .configure(settings().cacheLimitMb * 1024 * 1024)
      .catch((error) => logConsole.warn("Cache maintenance failed"));
  });
  const presetStore = new ReaderPresetStore();
  const [presetState, setPresetState] = createSignal<ReaderPresetState>();
  const [presetRevision, setPresetRevision] = createSignal(0);
  const [foreground, setForeground] = createSignal(lifecycle() === "active");
  const activityLog = new ActivityLog();
  const telemetrySession = new TelemetryScreenSession(usageTelemetry, () => globalThis.performance?.now?.() ?? Date.now());
  const telemetryReaders = new WeakSet<Entry>();
  const telemetryPlayers = new WeakSet<Entry>();
  createEffect(() => {
    const entries = stack();
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
  createEffect(() => spectrum.update(foreground() && page() === "home", speechState()));
  onFrame(() => spectrum.frame(globalThis.performance?.now?.() ?? Date.now()));
  onCleanup(() => spectrum.dispose());
  const [pendingAnnouncement, setPendingAnnouncement] = createSignal<Announcement | null>(null);
  const [pendingPushMessages, setPendingPushMessages] = createSignal<PushMessage[]>([]);
  const homeNoticeVisible = () => !!pendingAnnouncement() || pendingPushMessages().length > 0;
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
    const services = props.announcements;
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
      if (value !== "active" && entry.page === "reader" && entry.reader)
        backgroundReaderFlush.begin(
          entry,
          () => entry.reader!.flushProgress(),
          (outcome) => logReaderProgressFlush("background", outcome),
        );
    }),
  );
  let platformLoginRefresh = 0;
  const refreshPlatformLoginState = async () => {
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
    if (page() === "home" && foreground()) void refreshPlatformLoginState();
  });
  onCleanup(() => {
    platformLoginRefresh++;
  });
  createEffect(() => {
    const entries = stack();
    if (resumeReady()) {
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
  });
  createEffect(() => setReaderPreviewVisible(page() === "reader-preview"));
  onCleanup(() => setReaderPreviewVisible(false));
  const [presetClock, setPresetClock] = createSignal(new Date());
  onFrame(() => {
    if (
      presetState()?.selection.mode === "SYSTEM" &&
      Math.floor(Date.now() / 60000) !==
        Math.floor(presetClock().getTime() / 60000)
    )
      setPresetClock(new Date());
  });
  const readerPreset = createMemo(() =>
    presetState()
      ? activeReaderPreset(presetState()!, presetClock())
      : defaultReaderPreset(undefined, undefined, true, settings().fontSizeSp),
  );
  const informationFonts = createMemo(() =>
    readerFontResolver(presetState() ?? {}, presetRevision()),
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

  async function loadChannels() {
    // Keep showing the current list (e.g. the startup snapshot) while refreshing it.
    if (!channels().length) setLoading(true);
    setError("");
    try {
      const list = await props.services.listChannels();
      traceServiceWork("home.setChannels",()=>setChannels(list));
      writeHomeChannelSnapshot(kv, list);
      startupMark("channels.loaded");
      startupFirstScreen();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  async function loadArticles(opts?: ArticleQuery) {
    setLoading(true);
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
      setLoading(false);
    }
  }
  async function loadFeedArticles(
    channelId: string,
    limit = feedVisibleCount(),
    initial = false,
  ) {
    const version = ++feedRequestVersion;
    if (initial) setLoading(true);
    try {
      const window = await loadFeedWindow(
        props.services.listArticles,
        channelId,
        limit,
      );
      if (
        version !== feedRequestVersion ||
        page() !== "articles" ||
        current().channelId !== channelId
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
      if (version === feedRequestVersion) {
        if (initial) setLoading(false);
        setFeedLoadingMore(false);
      }
    }
  }
  async function restoreStartupNavigation() {
    const baseline=stack();let owned=baseline;
    try {
      await loadChannels();
      if(stack()!==baseline)return;
      if(activityEntries){
        const entries=await resolveActivityNavigation(activityEntries,{
          hasChannel:id=>channels().some(channel=>channel.id===id),article:id=>props.services.getArticle(id),
          canRestore:entry=>entry.page!=='reader-preview'||!!readerPreviewSession.state(),
        });
        for(const entry of entries)await informationActivity.restore(entry);
        if(entries.some(entry=>entry.page==='notes'||entry.page==='note-detail'||entry.page==='note-actions'))await memoRepository.initialize();
        if(stack()!==baseline)return;owned=entries;
        batch(()=>{setStack(entries);const lastReader=[...entries].reverse().find(entry=>entry.readerArticle);if(lastReader)setArticle(lastReader.readerArticle!);});
        const feed=[...entries].reverse().find(entry=>entry.page==='articles');
        if(feed?.channelId)await loadFeedArticles(feed.channelId,Number(routeMemory(feed).retained.feedCount)||12,true);
        const saved=[...entries].reverse().find(entry=>entry.page==='saved'||entry.page==='watch-later');
        if(saved)await loadSaved(saved.page==='saved'?'favorite':'watchLater');
        const search=entries.at(-1);
        if(search?.page==='search'&&search.channelId){const draft=routeMemory(search).retained.query;if(typeof draft==='string')await searchChannelArticles(search.channelId,draft);}
        if(stack()!==entries)return;
        const playback=entries.at(-1);
        if(playback?.page==='video'&&playback.videoTarget){
          const target=playback.videoTarget;
          // Restore identities from Activity memory; Douyin URLs come from the secure queue, headers from current credentials.
          owned=entries.slice(0,-1);setStack(owned);
          if(target.kind==='bili')await biliNavigate({...target,name:'player'},playback.memory);
          else if(target.kind==='douyin')await restoreDouyinVideo(target.awemeId,target.immersive,playback.memory,target.detailPlayback);
          else {const rss=await props.services.getArticle(target.articleId);if(rss&&stack()===owned)await openRssVideo(rss,target.url,playback.memory);}
        }
        return;
      }
      const target = await resolveResumeTarget(startupResume, {
        hasChannel: (id) => channels().some((channel) => channel.id === id),
        getArticle: (id) => props.services.getArticle(id),
      });
      if(stack()!==baseline)return;
      if (target.kind === "home") return;
      if (target.kind === "articles") {
        setStack([
          { page: "home" },
          { page: "articles", channelId: target.channelId },
        ]);
        await loadFeedArticles(target.channelId, 12, true);
        return;
      }
      if (target.kind === "reader") {
        batch(() => {
          setArticle(target.article);
          setStack([
            { page: "home" },
            { page: "reader", readerArticle: target.article },
          ]);
        });
        return;
      }
      if (target.kind === "bili") {
        setStack([
          { page: "home" },
          { page: "bili", biliRoute: target.route as BiliRoute },
        ]);
        return;
      }
      if (target.route.name === "player" && target.route.savedQueue === true) {
        owned=[{ page: "home" }, { page: "douyin", douyinRoute: { name: "entry" } }];setStack(owned);
        await restoreDouyinVideo(String(target.route.awemeId),target.route.immersive===true,undefined,target.route.detailPlayback===true);
        return;
      }
      setStack([
        { page: "home" },
        { page: "douyin", douyinRoute: target.route as DouyinRoute },
      ]);
    } catch (error) {
      if(stack()===owned)setError(`无法恢复上次内容：${String(error)}`);
    } finally {
      setResumeReady(true);
    }
  }
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
  async function go(next: Page) {
    if (motion.phase !== "idle") return;
    if (next === "notes") {
      setBusy(true);
      try {
        await memoRepository.initialize();
      } catch (e) {
        setError(String(e));
        return;
      } finally {
        setBusy(false);
      }
    }
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
    if (next === "notes") setLoading(false);
    if (
      [
        "phone-connection",
        "settings",
        "settings-advanced",
        "search",
        "profile",
        "recommendations",
        "information",
        "note-detail",
        "note-actions",
      ].includes(next)
    )
      setLoading(false);
  }
  async function openArticle(item: Article, fromWatchLater = false) {
    setBusy(true);
    try {
      const full = await props.services.getArticle(item.id);
      await props.services.markRead(item.id);
      setArticle({ ...(full ?? item), read: true });
      // Reopening an already-read article must not rebuild the retained feed
      // and synchronously remeasure every card for an unchanged read flag.
      setArticles((items) => markFeedArticleRead(items,item.id));
      setChannels((items) => item.read ? items :
        items.map((c) =>
          c.id === item.channelId && !item.read
            ? { ...c, unreadCount: Math.max(0, (c.unreadCount ?? 0) - 1) }
            : c,
        ),
      );
      traceServiceWork("reader.setPage",()=>setPage("reader", {
        readerArticle: { ...(full ?? item), read: true },
        readerFromWatchLater: fromWatchLater,
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function openArticleActions(item: Article) {
    if (busy()) return;
    const origin = current();
    setBusy(true);
    try {
      const full = await props.services.getArticle(item.id);
      if (current() === origin) {
        setArticle(full ?? item);
        setPage("rss-actions");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteArticle() {
    const selected = article();
    if (!selected || busy()) return;
    setBusy(true);
    try {
      await props.services.deleteArticle(selected.id);
      setArticles((items) => items.filter((item) => item.id !== selected.id));
      popPage(true);
      setArticle(null);
      await loadChannels();
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
      if (navigateBack) popPage();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function markArticleUnread() {
    const selected = article();
    if (!selected?.read || busy()) return;
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
      popPage();
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
    const origin = current();
    setBusy(true);
    try {
      const [enabled, playback] = await Promise.all([
        props.services.getChannelOriginalMode(id),
        props.services.getChannelPlaybackSettings(id),
      ]);
      setOriginalModes((m) => ({ ...m, [id]: enabled }));
      setChannelPlayback((m) => ({ ...m, [id]: playback }));
      if (current() === origin) setPage("channel-settings", { channelId: id });
    } catch (e) {
      setError(String(e));
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
        setStack([{ page: "home" }]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function searchChannel(id: string) {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = undefined;
    searchRequestVersion++;
    setQuery("");
    setSearchResults([]);
    setPage("search", { channelId: id });
  }
  function updateSearchKeyword(channelId: string, value: string) {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchRequestVersion++;
    setQuery(value);
    if(current().page==='search'){routeMemory(current()).retained.query=value;saveActivity();}
    setSearchResults([]);
    setSearchLoading(false);
    if (!value.trim()) return;
    searchDebounce = setTimeout(() => {
      searchDebounce = undefined;
      if (current().page === "search" && current().channelId === channelId)
        void searchChannelArticles(channelId, value);
    }, 180);
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
    const refreshAll = page() === "home";
    if (refreshAll && homeRefreshing()) return;
    // Native HomeComposeScreen keeps channel interactions enabled while "刷新全部" runs; the
    // refresh state only drives the indicator. Per-page refresh still holds the busy gate.
    if (refreshAll) setHomeRefreshing(true);
    else setBusy(true);
    setError("");
    try {
      try { await props.services.refresh(current().channelId); }
      finally { if (refreshAll) usageTelemetry.recordFeedRefreshed(); }
      if (page() === "home") await loadChannels();
      else if (page() === "articles" && current().channelId)
        await loadFeedArticles(current().channelId!, feedVisibleCount());
      else if (page() === "saved" || page() === "watch-later")
        await loadSaved(page() === "saved" ? "favorite" : "watchLater");
      else if (page() === "search" && current().channelId)
        await searchChannelArticles(current().channelId!, query());
      else await loadArticles(currentQuery);
    } catch (e) {
      setError(String(e));
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
  onFrame(updateFeedWhenSettled);
  let debugDisposed=false,debugStop:(()=>void)|undefined;
  onCleanup(()=>{debugDisposed=true;debugStop?.();});
  onMount(() => {
    const unsubscribe = props.services.subscribeChannel((event) => {
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
    if (homeSnapshot) { startupMark("channels.snapshot"); startupFirstScreen(); }
    void restoreStartupNavigation().then(()=>{if(!debugDisposed)debugStop=startExternalDebug(resumeAwemeId=>douyinNavigate({name:"entry",debugAutoEnterFlow:true,resumeAwemeId}),id=>setPage("debug-summary",{articleId:id}));});
  });
  createEffect(() => setNavigationState({ canGoBack: stack().length > 1 }));
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
    if (page() === "home" && dismissHomeNotice()) return true;
    if (stack().length <= 1) return false;
    if (motion.phase !== "idle") return true;
    motion.begin(0);
    motion.release(0, Date.now(), false, true);
    return true;
  });
  const removeAxis = onAxisDelta(RelativeAxis.Primary, (delta: number) => {
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
      setError(String(e));
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
  });
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
    douyinNavigate,
    changeDouyinVideo,
    prepareDouyinAdjacent,
    promoteDouyinAdjacent,
    biliOriginal,
    setBiliOriginal,
    recoverDouyinVideo,
    douyinReady,
    douyinActions,
    douyinOriginal,
    setDouyinOriginal,
    recoverRssDouyinVideo,
    deleteBuiltin,
  } = createMediaRouteController({
    onActivityStateChange:saveActivity,
    onRssSourcePublished: () => usageTelemetry.recordVideoPlayed(),
    services: props.services,
    current,
    motion,
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
  };
  const openAddedChannel = async (channel: Channel) => {
    await loadChannels();
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
    if(entry.page==='reader-scroll-controls')entry.reader=stack().slice(0,stack().indexOf(entry)).reverse().find(item=>item.page==='reader')?.reader;
    const entryPage = () => entry.page;
    const active = () => current() === entry;
    const selfTitled = () => routeIsSelfTitled(entryPage());

    const handlers=new Set<()=>void>();checkpoints.set(entry,handlers);const scrollSlots=new Set<number>();
    onCleanup(()=>checkpoints.delete(entry));
    return (
      <RouteActivityProvider entry={entry} changed={saveActivity} checkpoints={handlers} scrollSlots={scrollSlots}>
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
            ? backOffset()
            : current().page === "video"
              ? -2 * width
              : 0,
          opacity:
            current().page === "video" && !active()
              ? 0
              : stack().indexOf(entry) >= stack().length - 2
                ? 1
                : 0,
        }}
      >
        <Show when={!selfTitled()}>
          <View class="absolute left-[12] right-[12] top-[8] h-[30] items-center justify-center">
            <Text class="text-lg text-white">{routeTitle(entryPage())}</Text>
          </View>
        </Show>
        <Show when={error()}>
          <View class="absolute left-[12] right-[12] top-[38] h-[28] z-10 rounded-[8] bg-[#4b2030] items-center justify-center">
            <Text class="text-xs text-[#ffd5dc]">{error()}</Text>
          </View>
        </Show>
        <Show when={busy()}>
          <Text class="absolute right-[14] top-[18] text-xs text-[#45d6a7]">
            处理中
          </Text>
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
              !active() ||
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
            <HomeRoutes
              entry={entry}
              page={entryPage}
              active={() => active() && !(entryPage() === "home" && homeNoticeVisible())}
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
              services={props.services}
              go={go}
              openSpeech={() => setPage("speech-playback")}
              openAdd={() => void doAdd()}
              refresh={refresh}
              openBili={biliNavigate}
              openDouyin={douyinNavigate}
              openFeed={(channel) => {
                setFeedVisibleCount(12);
                setFeedHasMore(false);
                setPage("articles", { channelId: channel.id });
                void loadFeedArticles(channel.id, 12, true);
              }}
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
              services={props.services}
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
              preset={readerPreset}
              entry={entry}
              page={entryPage}
              active={active}
              width={width}
              height={height}
              round={metrics.shape === "round"}
              backOffset={backOffset}
              services={props.services}
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
              loginDouyin={douyinLogin}
              openUrl={openUrl}
              popPage={popPage}
              setError={setError}
              recoverDouyinVideo={recoverDouyinVideo}
              recoverRssDouyinVideo={recoverRssDouyinVideo}
              douyinReady={douyinReady}
              douyinActions={douyinActions}
              changeDouyinVideo={changeDouyinVideo}
              prepareDouyinAdjacent={prepareDouyinAdjacent}
              promoteDouyinAdjacent={promoteDouyinAdjacent}
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
              services={props.services}
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
              services={props.services}
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
              preset={readerPreset}
              fonts={informationFonts}
              backgroundSnapshot={informationBackground}
              setPage={setPage}
              openInformation={informationNavigate}
              addRecommendation={addRecommendation}
              openUrl={openUrl}
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
            entry={entry}
            page={entryPage}
            active={active}
            width={width}
            height={height}
            density={metrics.density}
            stack={stack}
            motion={motion}
            setBackOffset={setBackOffset}
            services={props.services}
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
        </View>
      </View>
      </RouteActivityProvider>
    );
  };

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
    </View>
  );
}
