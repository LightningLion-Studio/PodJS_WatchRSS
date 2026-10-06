import {onFrame} from '@pocketjs/framework/lifecycle';
import {lifecycle} from '@podjs/framework/watch';
import {douyinDebug} from '../../debug/douyin-host.ts';
import { createSignal, type Accessor, type Setter } from "solid-js";
import { kv } from "@podjs/framework/watch";
import { video } from "@podjs/framework/services";
import { createBiliPlaybackCheckpoint } from "../../bili/playback.ts";
import { originalContentEnabled } from "../../bili/browse.ts";
import { restoreDouyinQueue } from "../../douyin/resume.ts";
import { DouyinPlaybackQueue } from "../../douyin/playback-queue.ts";
import { douyinOriginalContentEnabled } from "../../douyin/original-mode.ts";
import { DouyinRssRecovery } from "../../douyin/rss-recovery.ts";
import { managedCache } from "../../cache/host.ts";
import { resolveUrl } from "../../core/parser.ts";
import { authorizeInBrowser } from "../../media/browser-auth.ts";
import { DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT } from "../../media/douyin-login.ts";
import { biliClient, douyinClient } from "../../media-services.ts";
import { biliPlaybackSource, createBiliPlaybackRetry } from "../../playback.ts";
import { biliVideoTarget, douyinVideoTarget } from "../../reader/media.ts";
import type { SettingsState } from "../../settings/index.ts";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinPlayRequest, DouyinRoute } from "../douyin/index.tsx";
import type { AppServices, Article, Channel } from "../service.ts";
import type { PlaybackSource } from "../VideoPlayerScreen.tsx";
import { douyinDecoderProfile, type DouyinPreparedSource } from "../douyin/video-sessions.ts";
import type { RouteEntry, SetPage } from "./types.ts";

interface MediaControllerDependencies {
  onRssSourcePublished?: () => void;
  onActivityStateChange?:()=>void;
  services: AppServices;
  current: () => RouteEntry;
  motion: { readonly phase: string };
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  setError: Setter<string>;
  settings: Accessor<SettingsState>;
  playingSource: Accessor<PlaybackSource | undefined>;
  setPlayingSource: Setter<PlaybackSource | undefined>;
  channels: Accessor<Channel[]>;
  setChannels: Setter<Channel[]>;
  setOriginalModes: Setter<Record<string, boolean>>;
  setStack: Setter<RouteEntry[]>;
  setPage: SetPage;
  popPage: (skipInternal?: boolean) => boolean;
}

export function createMediaRouteController(
  dependencies: MediaControllerDependencies,
) {
  const [biliBackground, setBiliBackground] = createSignal(
    kv.get<boolean>("watchrss.bili.background-playback") ?? false,
  );
  const [douyinBackground, setDouyinBackground] = createSignal(
    kv.get<boolean>("watchrss.douyin.background-playback") ?? false,
  );

  const playbackPreferences = () => ({
    digitalCrownVolume: dependencies.settings().mediaVolumeControl,
    volumeGuard: dependencies.settings().mediaVolumeGuard,
    startVolumeLimit: dependencies.settings().playbackStartVolumeLimit,
  });

  const openVideo = async (
    source: PlaybackSource,
    extra: Partial<RouteEntry> = {},
  ) => {
    const origin = dependencies.current();
    dependencies.setBusy(false);
    dependencies.setError("");
    await video.captureBackdrop();
    if (
      dependencies.current() !== origin ||
      dependencies.motion.phase !== "idle"
    ) {
      await video.stop();
      return;
    }
    dependencies.setPlayingSource(source);
    dependencies.setPage("video", { playback: source, ...extra });
  };

  async function openRssVideo(article: Article, rawUrl: string,memory?:RouteEntry["memory"]) {
    if (dependencies.busy()) return;
    const origin = dependencies.current();
    dependencies.setBusy(true);
    dependencies.setError("");
    try {
      const bili = biliVideoTarget(rawUrl) ?? biliVideoTarget(article.link);
      if (bili) {
        const detail = bili.cid ? undefined : await biliClient.detail(bili);
        const cid = bili.cid ?? detail?.pages[0]?.cid;
        if (!cid) throw new Error("视频没有可播放的分 P");
        if (dependencies.current() !== origin) return;
        await biliNavigate({
          name: "player",
          ...bili,
          cid,
          title: article.title,
        },memory);
        return;
      }
      const preferences = article.channelId
        ? await dependencies.services.getChannelPlaybackSettings(
            article.channelId,
          )
        : { continuePlaybackInBackground: false };
      const resolved = resolveUrl(rawUrl, article.link) ?? rawUrl;
      const douyin =
        douyinVideoTarget(article.link) ?? douyinVideoTarget(rawUrl);
      let url = resolved;
      let headers: Record<string, string> | undefined;
      if (douyin) {
        headers = await douyinClient.buildPlaybackHeaders();
        if (douyin.awemeId) {
          const result = await douyinClient.resolvePlayback(douyin.awemeId);
          if (result.ok) url = result.data.playUrl;
          else if (douyinVideoTarget(resolved)) {
            throw new Error(result.message);
          }
        }
      }
      if (dependencies.current() !== origin) return;
      await openVideo(
        {
          url,
          headers,
          webUrl: douyin?.webUrl ?? resolved,
          title: article.title,
          platform: "rss",
          backgroundPlayback: preferences.continuePlaybackInBackground,
          ...playbackPreferences(),
        },
        {
          memory,videoTarget:{kind:'rss',articleId:article.id,url:rawUrl},
          rssDouyinRecovery: douyin?.awemeId
            ? new DouyinRssRecovery(douyinClient, douyin.awemeId)
            : undefined,
        },
      );
    } finally {
      dependencies.setBusy(false);
    }
  }

  const biliNavigate = async (route: BiliRoute,memory?:RouteEntry["memory"]) => {
    if (route.name !== "player") {
      dependencies.setPage("bili", { biliRoute: route });
      if (route.name === "entry") {
        const session = await biliClient.getSession();
        if (session?.refreshToken) {
          void biliClient
            .refreshCookies()
            .catch((error) => dependencies.setError(String(error)));
        }
      }
      return;
    }
    const origin = dependencies.current();
    dependencies.setBusy(true);
    try {
      const source =
        route.source ??
        (await biliClient.resolvePlayback({
          aid: Number(route.aid) || undefined,
          bvid: route.bvid,
          cid: Number(route.cid),
          preferMp4: true,
        }));
      const session = await biliClient.getSession();
      const headers: Record<string, string> = {
        Referer: "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0",
      };
      if (session) {
        headers.Cookie = Object.entries(session.cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      }
      const checkpoint = createBiliPlaybackCheckpoint({
        storage: {
          get: async (key) => kv.get<string>(key),
          set: async (key, value) => {
            kv.set(key, value);
          },
          delete: async (key) => {
            kv.delete(key);
          },
        },
        reporter: biliClient,
        target: {
          aid: Number(route.aid) || undefined,
          bvid: route.bvid,
          cid: Number(route.cid),
        },
      });
      const resume = await checkpoint.restore();
      if (dependencies.current() !== origin) return;
      const resolveRetry = createBiliPlaybackRetry(
        source,
        () =>
          biliClient.resolvePlayback({
            aid: Number(route.aid) || undefined,
            bvid: route.bvid,
            cid: Number(route.cid),
            preferMp4: true,
          }),
        route.title ?? "哔哩哔哩",
        headers,
      );
      const retryPlayback = async (positionMs: number) => {
        const entry = dependencies.current();
        if (entry.retryPlayback !== retryPlayback) return;
        const next = await resolveRetry();
        if (dependencies.current() !== entry) return;
        const previous = dependencies.playingSource() ?? entry.playback!;
        const updated = {
          ...previous,
          url: undefined,
          videoUrl: undefined,
          audioUrl: undefined,
          ...next,
          resumePositionMs: positionMs,
        };
        entry.playback = updated;
        dependencies.setPlayingSource(updated);
      };
      await openVideo(
        {
          ...biliPlaybackSource(source, route.title ?? "哔哩哔哩", headers),
          ...playbackPreferences(),
          resumePositionMs: resume?.positionMs,
          platform: "bili",
          backgroundPlayback: biliBackground(),
          webUrl: route.bvid
            ? `https://www.bilibili.com/video/${route.bvid}`
            : `https://www.bilibili.com/video/av${route.aid}`,
        },
        { checkpoint, retryPlayback,memory,videoTarget:{kind:'bili',aid:route.aid,bvid:route.bvid,cid:route.cid,title:route.title} },
      );
    } catch (error) {
      dependencies.setError(String(error));
    } finally {
      dependencies.setBusy(false);
    }
  };

  const douyinLogin = async () => {
    dependencies.setError("");
    try {
      const result = await authorizeInBrowser({
        url: "https://www.douyin.com/chat?isPopup=1",
        cookieOrigin: "https://www.douyin.com",
        qrExtractionScript: DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT,
        requiredCookieNames: ["sessionid"],
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
      }).result;
      const saved = await douyinClient.applyCookie(result.cookie);
      if (!saved.ok) throw new Error(saved.message);
      dependencies.setPage("douyin", { douyinRoute: { name: "entry" } });
    } catch (error) {
      dependencies.setError(String(error));
    }
  };

  let pendingDouyinPlayback: Promise<PlaybackSource> | undefined;
  let pendingDouyinQueue: DouyinPlaybackQueue | undefined;
  const douyinPlay = (request: DouyinPlayRequest) => {
    pendingDouyinQueue = new DouyinPlaybackQueue(douyinClient, {
      items: (request.playlist ?? [request.item]).map(item => item.awemeId === request.item.awemeId ? request.playback : item),
      selectedAwemeId: request.item.awemeId,
      cursor: request.cursor,
      hasMore: request.hasMore,
      fixedSources: request.immersive !== true,
    });
    pendingDouyinPlayback = douyinClient
      .buildPlaybackHeaders()
      .then((headers) => ({
        immersive: request.immersive,
        detailPlayback: request.detailPlayback,
        awemeId: request.item.awemeId,
        posterUrl: request.item.coverUrl,
        url: douyinDebug.playbackUrl(request.item.awemeId,request.playback.playUrl),
        ...douyinDecoderProfile(request.playback),
        title: request.item.description,
        headers,
        ...playbackPreferences(),
        platform: "douyin" as const,
        webUrl: `https://www.douyin.com/video/${request.item.awemeId}`,
        backgroundPlayback: douyinBackground(),
      }));
  };

  const douyinNavigate = async (route: DouyinRoute,memory?:RouteEntry["memory"]) => {
    if ((route.name === "actions" || route.name === "share") && !route.item) {
      const current = dependencies.current(), origin = current.douyinRoute;
      const item = origin && "item" in origin ? origin.item : current.queue?.snapshot().item;
      if (item?.awemeId === route.awemeId) route = { ...route, item };
    }
    if (route.name === "player" && pendingDouyinPlayback) {
      try {
        const source = await pendingDouyinPlayback, queue = pendingDouyinQueue;
        await queue?.persist();
        await openVideo(source, { queue, memory, videoTarget: {
          kind: 'douyin', awemeId: route.awemeId, immersive: source.immersive,
          ...(source.detailPlayback ? {detailPlayback:true} : {}),
        } });
      } catch (error) {
        dependencies.setError(String(error));
      } finally {
        pendingDouyinPlayback = undefined;
        pendingDouyinQueue = undefined;
      }
    } else {
      dependencies.setPage("douyin", { douyinRoute: route });
    }
  };

  // Activity restoration and legacy KV resume share this queue-backed entry point.
  const restoreDouyinVideo = async (awemeId:string, immersive=false, memory?:RouteEntry["memory"], detailPlayback=false):Promise<boolean> => {
    const origin = dependencies.current();
    const restored = await restoreDouyinQueue(douyinClient, awemeId, immersive);
    if (!restored || dependencies.current() !== origin) return false;
    const { item, queue } = restored;
    const headers = await douyinClient.buildPlaybackHeaders();
    if (dependencies.current() !== origin) return false;
    const source: PlaybackSource = {
      platform: "douyin", immersive, detailPlayback, awemeId: item.awemeId,
      url: item.playUrl, posterUrl: item.coverUrl, title: item.description,
      ...douyinDecoderProfile(item), ...playbackPreferences(), headers,
      backgroundPlayback: douyinBackground(), webUrl: `https://www.douyin.com/video/${item.awemeId}`,
    };
    await openVideo(source, {queue, memory, videoTarget: {
      kind:'douyin',awemeId,immersive,...(detailPlayback ? {detailPlayback:true} : {}),
    }});
    return dependencies.current().queue === queue;
  };

  const changeDouyinVideo = async (
    entry: RouteEntry,
    direction: "next" | "previous",
  ) => {
    if (!entry.queue || dependencies.current() !== entry) return;
    if (
      direction === "previous" &&
      entry.playback?.immersive &&
      entry.queue.snapshot().index === 0
    ) {
      dependencies.popPage();
      return;
    }
    const result = await entry.queue[direction]();
    if (dependencies.current() !== entry) return;
    if (!result.ok) {
      if (result.code !== "CANCELLED") {
        dependencies.setError(result.message);
      }
      return;
    }
    const headers = await douyinClient.buildPlaybackHeaders();
    if (
      dependencies.current() !== entry ||
      entry.queue.snapshot().item?.awemeId !== result.data.item.awemeId
    ) {
      return;
    }
    entry.playback = {
      ...entry.playback!,
      awemeId: result.data.item.awemeId,
      posterUrl: result.data.item.coverUrl,
      url: douyinDebug.playbackUrl(result.data.item.awemeId,result.data.item.playUrl,direction==="next"),
      ...douyinDecoderProfile(result.data.item),
      title: result.data.item.description,
      headers,
      webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
    };
    dependencies.setError("");
    dependencies.setPlayingSource(entry.playback);
    await entry.queue.persist();
    if (dependencies.current() === entry) dependencies.onActivityStateChange?.();
  };

  onFrame(()=>{const entry=dependencies.current(),state=entry.queue?.snapshot();douyinDebug.updateContext(state?.item?.awemeId??'',state?.playlist[(state?.index??0)+1]?.awemeId??'',entry.page==='video'&&!!entry.queue);void douyinDebug.tick(Date.now(),lifecycle()==='active'&&entry.page==='video'&&!!entry.queue,()=>changeDouyinVideo(entry,'next')).catch(error=>dependencies.setError(String(error)));});

  const prepareDouyinAdjacent = async (
    entry:RouteEntry,
    direction:"next"|"previous",
  ):Promise<DouyinPreparedSource|undefined> => {
    if(!entry.queue||dependencies.current()!==entry)return;
    const result=await entry.queue.preview(direction);
    if(dependencies.current()!==entry||!result.ok)return;
    const headers=await douyinClient.buildPlaybackHeaders();
    if(dependencies.current()!==entry||entry.queue.snapshot().playlist[result.data.index]?.awemeId!==result.data.item.awemeId)return;
    return {key:result.data.item.awemeId,source:{
      ...entry.playback!,awemeId:result.data.item.awemeId,posterUrl:result.data.item.coverUrl,
      url:douyinDebug.playbackUrl(result.data.item.awemeId,result.data.item.playUrl,direction==="next"),title:result.data.item.description,headers,
      ...douyinDecoderProfile(result.data.item),
      webUrl:`https://www.douyin.com/video/${result.data.item.awemeId}`,
    }};
  };

  const promoteDouyinAdjacent = async (
    entry:RouteEntry,
    prepared:DouyinPreparedSource,
  ):Promise<boolean> => {
    if(!entry.queue||dependencies.current()!==entry)return false;
    const result=entry.queue.commitPreview(prepared.key);
    if(!result.ok||dependencies.current()!==entry)return false;
    entry.playback=prepared.source;dependencies.setError("");dependencies.setPlayingSource(prepared.source);
    await entry.queue.persist();
    if(dependencies.current()===entry)dependencies.onActivityStateChange?.();
    return true;
  };

  const biliOriginal = () =>
    originalContentEnabled(
      dependencies.channels().find((item) => item.url === "builtin:bili"),
    );

  const setBiliOriginal = async (value: boolean) => {
    const channel = dependencies
      .channels()
      .find((item) => item.url === "builtin:bili");
    if (!channel) {
      dependencies.setError("请先添加哔哩哔哩频道");
      return;
    }
    try {
      await dependencies.services.setChannelOriginalMode(channel.id, value);
      dependencies.setChannels((items) =>
        items.map((item) =>
          item.id === channel.id
            ? { ...item, useOriginalContent: value }
            : item,
        ),
      );
      dependencies.setOriginalModes((modes) => ({
        ...modes,
        [channel.id]: value,
      }));
    } catch (error) {
      dependencies.setError(String(error));
    }
  };

  const recoverDouyinVideo = async (entry: RouteEntry, manual = false) => {
    if (
      !entry.queue ||
      dependencies.current() !== entry ||
      entry.douyinRecovering
    ) {
      return;
    }
    entry.douyinRecovering = true;
    try {
      const id = entry.queue.snapshot().item?.awemeId;
      if (!id) return;
      if (entry.playback?.detailPlayback) {
        entry.rssDouyinRecovery ??= new DouyinRssRecovery(douyinClient, id);
        const source = await entry.rssDouyinRecovery.recover(entry.playback, () => dependencies.current() === entry, manual);
        if (!source || dependencies.current() !== entry) return;
        entry.queue.updateCurrentUrl(source.url ?? "");
        await entry.queue.persist();
        if (dependencies.current() !== entry) return;
        entry.playback = source;
        dependencies.setError(""); dependencies.setPlayingSource(source);
        dependencies.onActivityStateChange?.();
        return;
      }
      const failures = (entry.douyinFailures ??= new Set<string>());
      const skip = failures.has(id);
      failures.add(id);
      const result = await (skip
        ? entry.queue.discard()
        : entry.queue.recover());
      if (dependencies.current() !== entry) return;
      if (!result.ok) {
        if (result.code === "CANCELLED") return;
        if (
          !entry.queue.snapshot().playlist.length &&
          entry.playback?.immersive
        ) {
          await douyinClient.clearPlaybackWindow();
          if (dependencies.current() !== entry) return;
          dependencies.popPage();
        }
        dependencies.setError(result.message);
        return;
      }
      const headers = await douyinClient.buildPlaybackHeaders();
      if (
        dependencies.current() !== entry ||
        entry.queue.snapshot().item?.awemeId !== result.data.item.awemeId
      ) {
        return;
      }
      entry.playback = {
        ...entry.playback!,
        awemeId: result.data.item.awemeId,
        posterUrl: result.data.item.coverUrl,
        url: douyinDebug.playbackUrl(result.data.item.awemeId,result.data.item.playUrl),
        ...douyinDecoderProfile(result.data.item),
        title: result.data.item.description,
        headers,
        webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
      };
      dependencies.setError("");
      dependencies.setPlayingSource(entry.playback);
      await entry.queue.persist();
      if (dependencies.current() === entry) dependencies.onActivityStateChange?.();
    } catch (error) {
      dependencies.setError(String(error));
    } finally {
      entry.douyinRecovering = false;
    }
  };

  const douyinReady = (entry: RouteEntry) => {
    if (dependencies.current() !== entry || !entry.queue) return;
    void entry.queue
      .settled()
      .catch((error) => dependencies.setError(String(error)));
    void entry.queue.prefetch().catch(() => {});
  };

  const douyinActions = (entry: RouteEntry) => {
    const item = entry.queue?.snapshot().item;
    if (item) void douyinNavigate({ name: "actions", awemeId: item.awemeId, item });
  };

  const douyinOriginal = () =>
    douyinOriginalContentEnabled(
      dependencies.channels().find((item) => item.url === "builtin:douyin"),
    );

  const setDouyinOriginal = async (value: boolean) => {
    const channel = dependencies
      .channels()
      .find((item) => item.url === "builtin:douyin");
    if (!channel) {
      dependencies.setError("请先添加抖音频道");
      return;
    }
    try {
      await dependencies.services.setChannelOriginalMode(channel.id, value);
      dependencies.setChannels((items) =>
        items.map((item) =>
          item.id === channel.id
            ? { ...item, useOriginalContent: value }
            : item,
        ),
      );
      dependencies.setOriginalModes((modes) => ({
        ...modes,
        [channel.id]: value,
      }));
    } catch (error) {
      dependencies.setError(String(error));
    }
  };

  const recoverRssDouyinVideo = async (entry: RouteEntry, manual = false) => {
    if (!entry.rssDouyinRecovery || !entry.playback) return;
    try {
      const source = await entry.rssDouyinRecovery.recover(
        entry.playback,
        () => dependencies.current() === entry,
        manual,
      );
      if (source) {
        dependencies.onRssSourcePublished?.();
        entry.playback = source;
        dependencies.setError("");
        dependencies.setPlayingSource(source);
      }
    } catch (error) {
      if (dependencies.current() === entry) {
        dependencies.setError(String(error));
      }
    }
  };

  const deleteBuiltin = async (platform: "bili" | "douyin") => {
    if (dependencies.busy()) return;
    dependencies.setBusy(true);
    dependencies.setError("");
    try {
      // These cards can exist without a persisted channel in older PodJS installs.
      // Remove a real channel when present; otherwise still clear its own cache.
      if (platform === "douyin") await douyinClient.logout();
      const channel = (await dependencies.services.listChannels()).find(
        (item) => item.url === `builtin:${platform}`,
      );
      if (channel) await dependencies.services.deleteChannel(channel.id);
      else {
        await managedCache.clearBucket(
          platform === "bili" ? "bili-preview" : "douyin-preload",
        );
      }
      dependencies.setChannels((items) =>
        items.filter((item) => item.url !== `builtin:${platform}`),
      );
      dependencies.setStack([{ page: "home" }]);
    } catch (error) {
      dependencies.setError(String(error));
      throw error;
    } finally {
      dependencies.setBusy(false);
    }
  };

  return {
    restoreDouyinVideo,
    biliBackground,
    setBiliBackground,
    douyinBackground,
    setDouyinBackground,
    openRssVideo,
    biliNavigate,
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
  };
}
