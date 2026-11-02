import {DouyinVideoSessionPool} from '../douyin/video-sessions.ts';
import {bindDouyinStockIdle} from '../../douyin/stock-lifecycle.ts';
import {playerFailureFields} from '../../media/player-errors.ts';
import {benchmark,type FailureStage} from '@podjs/framework/benchmark';
import {douyinPlaybackFailure} from '../../douyin/errors.ts';
import {douyinBench} from '../../douyin/bench.ts';
import {playbackFailure} from '../../media/playback-failure.ts';
import {douyinNetworkFailure} from '../douyin/player-network.ts';
import {DOUYIN_USER_AGENT} from '../../douyin/request-config.ts';
import {isDouyinTemporaryFailure} from '../../douyin/errors.ts';
import {DouyinPlaybackRecovery} from '../../douyin/playback-recovery.ts';
import {videoOptEnabled,invalidateVideoNetwork,videoNetworkEpoch,VideoPlaybackTrace,registerVideoResolution} from '../../media/video-opt.ts';
import {afterPaint} from '@podjs/framework/render';
import {appLogger} from '../../logs/app-logger.ts';
import {applyPreferredDouyinPlayback} from '../../douyin/playback-selector.ts';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {lifecycle} from '@podjs/framework/watch';
import {douyinDebug} from '../../debug/douyin-host.ts';
import { onCleanup, createEffect, createSignal, type Accessor, type Setter } from "solid-js";
import { kv } from "@podjs/framework/watch";
import * as hostServices from "@podjs/framework/services";
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
import { DOUYIN_QR_WAIT } from "../douyin/login-state.ts";
import { biliClient, biliPreviewCache, douyinClient, douyinPreload, douyinStock } from "../../media-services.ts";
import { resolveBiliPlaybackWithPreview, createBiliPlaybackRetry } from "../../playback.ts";
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
  initialVideoBounds?:()=>hostServices.VideoBounds|undefined;
  createInitialVideoPool?:()=>DouyinVideoSessionPool;
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

  if(videoOptEnabled('recovery')||videoOptEnabled('adaptive'))onCleanup(hostServices.onNetworkChange(invalidateVideoNetwork));

  bindDouyinStockIdle(douyinStock,()=>dependencies.current().page==='home'&&!dependencies.busy()&&dependencies.motion.phase==='idle'&&dependencies.channels().some(c=>c.url==='builtin:douyin'));

  const playbackPreferences = () => ({
    digitalCrownVolume: dependencies.settings().mediaVolumeControl,
    volumeGuard: dependencies.settings().mediaVolumeGuard,
    startVolumeLimit: dependencies.settings().playbackStartVolumeLimit,
  });

  const openVideo = async (
    source: PlaybackSource,
    extra: Partial<RouteEntry> = {},
    canOpen:()=>boolean=()=>true,
  ) => {
    const origin = dependencies.current();
    dependencies.setBusy(false);
    dependencies.setError("");
    benchmark.mark('startup_stage',source.startupSeq??0,{startup_stage:'backdrop_start'});
    await video.captureBackdrop({ opaque: source.immersive === true });
    benchmark.mark('startup_stage',source.startupSeq??0,{startup_stage:'backdrop_done'});
    if(!canOpen())return;
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
        let cid = bili.cid;
        if (!cid) {
          try { cid = (await biliClient.detail(bili)).pages[0]?.cid; }
          catch (error) {
            cid = (await biliPreviewCache.lookup(bili))?.cid;
            if (!cid) throw error;
          }
        }
        if (!cid) cid = (await biliPreviewCache.lookup(bili))?.cid;
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
      let douyinItem:import("../../douyin/types.ts").DouyinItem|undefined;
      let headers: Record<string, string> | undefined;
      if (douyin) {
        headers = await douyinClient.buildPlaybackHeaders();
        if (douyin.awemeId) {
          const result = await douyinClient.resolvePlayback(douyin.awemeId);
          if (result.ok) {url = result.data.playUrl;douyinItem=result.data;}
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
            ? new DouyinRssRecovery(douyinClient, douyin.awemeId,douyinItem)
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
      const localPreview = async (): Promise<PlaybackSource | undefined> => {
        const cached = await biliPreviewCache.lookup({aid: Number(route.aid) || undefined,bvid: route.bvid,cid: Number(route.cid)});
        return cached ? {url: cached.path,type: 'video/mp4',headers: {},title: route.title ?? "哔哩哔哩"} : undefined;
      };
      const trace=new VideoPlaybackTrace('bili'),apiStarted=Date.now();
      const {remote: source,source: initialSource} = await resolveBiliPlaybackWithPreview(
        () => route.source&&(route.source.apiSource!=='watch'||biliClient.watchApiEnabled()) ? Promise.resolve(route.source) : biliClient.resolvePlayback({aid: Number(route.aid) || undefined,bvid: route.bvid,cid: Number(route.cid),preferMp4: true}),
        localPreview,route.title ?? "哔哩哔哩",headers,
      );
      trace.setBiliRoute(source.apiSource);trace.event('api',{apiMs:Date.now()-apiStarted,cacheHit:route.source?1:0});trace.event('candidate',{candidate:0});registerVideoResolution(initialSource.url??initialSource.videoUrl??'',trace);
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
        retry =>
          biliClient.resolvePlayback({
            aid: Number(route.aid) || undefined,
            bvid: route.bvid,
            cid: Number(route.cid),
            preferMp4: true,
            forceWeb:retry?.forceWeb,
          }),
        route.title ?? "哔哩哔哩",
        headers,
        localPreview,
        initialSource,
        {enabled:videoOptEnabled('recovery'),networkEpoch:videoNetworkEpoch},
      );
      const retryPlayback = async (positionMs: number, options?: import("../../playback.ts").BiliPlaybackRetryOptions) => {
        const entry = dependencies.current();
        if (entry.retryPlayback !== retryPlayback) return;
        const next = await resolveRetry(options);
        if (dependencies.current() !== entry) return;
        if(source.apiSource==='watch')trace.setBiliRoute(next.url?.startsWith('managed-cache/bili-preview/')?undefined:'web');
        trace.event('candidate');registerVideoResolution(next.url??next.videoUrl??'',trace);
        const previous = dependencies.playingSource() ?? entry.playback!;
        const updated = {
          ...previous,
          url: undefined,
          videoUrl: undefined,
          audioUrl: undefined,
          biliApiSource: undefined,
          ...next,
          resumePositionMs: next.url?.startsWith("managed-cache/bili-preview/") ? 0 : positionMs,
        };
        entry.playback = updated;
        dependencies.setPlayingSource(updated);
      };
      await openVideo(
        {
          ...initialSource,
          ...playbackPreferences(),
          resumePositionMs: initialSource.url?.startsWith("managed-cache/bili-preview/") ? 0 : resume?.positionMs,
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
    const benchAttempt=douyinBench.loginEntry(douyinClient);let nativeCompleted=false;
    dependencies.setError("");
    try {
      const result = await authorizeInBrowser({
        url: "https://www.douyin.com/chat?isPopup=1",
        cookieOrigin: "https://www.douyin.com",
        qrExtractionScript: hostServices.DOUYIN_AUTH_STATUS_SCRIPT,
        qrWait: DOUYIN_QR_WAIT,
        onStatus: () => {},
        completeOnLoginPanelHidden: true,
        completeOnRequiredCookies: true,
        lowMemory: true,
        benchmark: {seq:benchAttempt.seq,attempt:benchAttempt.attempt},
        requiredCookieNames: ["sessionid"],
        userAgent:DOUYIN_USER_AGENT,
      }).result;
      nativeCompleted=true;
      const saved = await douyinClient.applyCookie(result.cookie);
      if (!saved.ok) throw new Error(saved.message);
      dependencies.setPage("douyin", { douyinRoute: { name: "entry" } });
    } catch (error) {
      if(nativeCompleted)douyinBench.error(benchAttempt);
      dependencies.setError(String(error));
    } finally {douyinBench.leaveLogin(douyinClient,benchAttempt);}
  };

  const douyinPlaybackUrl=async(item:import('../../douyin/types.ts').DouyinItem,headers:Record<string,string>,forward=false)=>{
    const override=douyinDebug.playbackUrl(item.awemeId,item.playUrl,forward);
    return override!==item.playUrl?override:douyinPreload.playback?douyinPreload.playback(item,headers):item.playUrl;
  };
  let pendingInitialPool:{origin:RouteEntry;pool:DouyinVideoSessionPool}|undefined;
  createEffect(()=>{const entry=dependencies.current();if(pendingInitialPool&&pendingInitialPool.origin!==entry){void pendingInitialPool.pool.releaseAll().catch(()=>{});pendingInitialPool=undefined;}});
  onCleanup(()=>{void pendingInitialPool?.pool.releaseAll().catch(()=>{});});
  let pendingDouyinPlayback: Promise<PlaybackSource> | undefined;
  let pendingDouyinQueue: DouyinPlaybackQueue | undefined;
  let pendingDouyinRequest: DouyinPlayRequest | undefined;
  const douyinPlay = (input: DouyinPlayRequest) => {
    const request={...input,item:applyPreferredDouyinPlayback(input.item),playback:applyPreferredDouyinPlayback(input.playback)};
    pendingDouyinRequest=request;
    pendingDouyinQueue = new DouyinPlaybackQueue(douyinClient, {
      items: (request.playlist ?? [request.item]).map(item => item.awemeId === request.item.awemeId ? request.playback : item),
      selectedAwemeId: request.item.awemeId,
      cursor: request.cursor,
      hasMore: request.hasMore,
      fixedSources: request.immersive !== true,
      localPlayback: id=>douyinPreload.lookup(id),
    });
    pendingDouyinPlayback = (async()=>{
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'preview_start'});
        // A restored native cache capability already owns authorized upstream headers.
        const bundle=await douyinPreload.readySource?.(request.item);
        const headers=bundle?{}:await douyinClient.buildPlaybackHeaders();
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'headers_ready'});
        const previewFrame=bundle?.previewFrame??(!douyinPreload.readySource?await douyinPreload.previewFrame(request.item):undefined);
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'preview_ready'});
        return ({
        startupSeq:request.entrySeq,
        immersive: request.immersive,
        detailPlayback: request.detailPlayback,
        awemeId: request.item.awemeId,
        posterUrl: request.item.coverUrl,
        previewFrame,
        url: bundle?.url ?? await douyinPreload.lookup(request.item.awemeId) ?? await douyinPlaybackUrl(request.playback,headers),
        ...douyinDecoderProfile(bundle?.item??request.playback),
        title: request.item.description,
        headers,
        ...playbackPreferences(),
        platform: "douyin" as const,
        webUrl: `https://www.douyin.com/video/${request.item.awemeId}`,
        backgroundPlayback: douyinBackground(),
      });})();
  };

  const douyinNavigate = async (route: DouyinRoute,memory?:RouteEntry["memory"]) => {
    if ((route.name === "actions" || route.name === "share") && !route.item) {
      const current = dependencies.current(), origin = current.douyinRoute;
      const item = origin && "item" in origin ? origin.item : current.queue?.snapshot().item;
      if (item?.awemeId === route.awemeId) route = { ...route, item };
    }
    if (route.name === "player" && pendingDouyinPlayback) {
      const pending=pendingDouyinPlayback,queue=pendingDouyinQueue,request=pendingDouyinRequest,origin=dependencies.current();
      const current=()=>dependencies.current()===origin&&pendingDouyinPlayback===pending&&(request?.isCurrent?.()??true);
      let stage:FailureStage='source',initialPool:DouyinVideoSessionPool|undefined;
      try {
        const source = await pending;
        if(!current())return;
        benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'source_ready'});
        const bounds=dependencies.initialVideoBounds?.();
        if(bounds&&source.immersive&&source.previewFrame&&source.url?.startsWith('podjs-media-cache:')&&lifecycle()==='active'){
          initialPool=dependencies.createInitialVideoPool?.()??new DouyinVideoSessionPool();pendingInitialPool={origin,pool:initialPool};
          void initialPool.prime({key:source.awemeId??source.url,source},{...source,bounds,autoplay:false}).result.catch(()=>{});
        }

        stage='persist';benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'persist_start'});await queue?.persist();benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'persist_done'});
        if(!current())return;
        if(pendingInitialPool?.pool!==initialPool&&initialPool){initialPool=undefined;}
        pendingInitialPool=undefined;
        stage='backdrop';await openVideo(source, { queue, memory, initialVideoPool:initialPool, douyinEntrySeq:request?.entrySeq, videoTarget: {
          kind: 'douyin', awemeId: route.awemeId, immersive: source.immersive,
          ...(source.detailPlayback ? {detailPlayback:true} : {}),
        } },current);
        if(dependencies.current().playback===source)initialPool=undefined;
      } catch (error) {
        if(current()){
          benchmark.begin('error_page',{reason:'exhausted',...playerFailureFields(error,stage)});
          if(request?.onFailure)request.onFailure(douyinPlaybackFailure(error));
          else dependencies.setError(error instanceof Error?error.message:String(error));
        }
      } finally {
        if(initialPool){if(pendingInitialPool?.pool===initialPool)pendingInitialPool=undefined;void initialPool.releaseAll().catch(()=>{});}
        if(pendingDouyinPlayback===pending){pendingDouyinPlayback = undefined;pendingDouyinQueue = undefined;pendingDouyinRequest=undefined;}
      }
    } else {
      dependencies.setPage("douyin", { douyinRoute: route });
    }
  };

  // Activity restoration and legacy KV resume share this queue-backed entry point.
  const restoreDouyinVideo = async (awemeId:string, immersive=false, memory?:RouteEntry["memory"], detailPlayback=false):Promise<boolean> => {
    const origin = dependencies.current();
    const restored = await restoreDouyinQueue(douyinClient, awemeId, immersive,id=>douyinPreload.lookup(id));
    if (!restored || dependencies.current() !== origin) return false;
    const { item, queue } = restored;
    const headers = await douyinClient.buildPlaybackHeaders();
    const localUrl=await douyinPreload.lookup(item.awemeId);
    if (dependencies.current() !== origin) return false;
    const frame=await douyinPreload.restoreFrame?.(item,headers).catch(()=>({available:false as const}));
    if(dependencies.current()!==origin)return false;
    const source: PlaybackSource = {
      platform:"douyin",immersive,detailPlayback,awemeId:item.awemeId,
      url:frame?.available?item.playUrl:localUrl??await douyinPlaybackUrl(item,headers),
      previewOnly:frame?.available===true,previewFrame:frame?.available?{entryId:item.awemeId,frame}:undefined,
      posterUrl:item.coverUrl,title:item.description,...douyinDecoderProfile(item),...playbackPreferences(),headers,
      backgroundPlayback:douyinBackground(),webUrl:`https://www.douyin.com/video/${item.awemeId}`,
    };
    if(dependencies.current()!==origin)return false;
    await openVideo(source, {queue, memory, videoTarget: {
      kind:'douyin',awemeId,immersive,...(detailPlayback ? {detailPlayback:true} : {}),
    }});
    if(source.previewOnly){const entry=dependencies.current();
      void douyinPlaybackUrl(item,headers).then(url=>{if(dependencies.current()!==entry||entry.queue!==queue||queue.snapshot().item?.awemeId!==item.awemeId||entry.playback!==source)return;
        entry.playback={...source,url,previewOnly:false};dependencies.setPlayingSource(entry.playback);
      }).catch(error=>{if(dependencies.current()===entry)dependencies.setError(String(error));});
    }
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
    const previousSource=entry.playback;
    try {
    const switchStarted=Date.now();appLogger.i('DouyinTiming','switch begin');
    const result = await entry.queue[direction]();
    if (dependencies.current() !== entry) return;
    if (!result.ok) {
      if (result.code !== "CANCELLED") {
        dependencies.setError(result.message);
        throw new Error(result.message);
      }
      return;
    }
    const headers = await douyinClient.buildPlaybackHeaders();
    const localUrl=await douyinPreload.lookup(result.data.item.awemeId);
    if (
      dependencies.current() !== entry ||
      entry.queue.snapshot().item?.awemeId !== result.data.item.awemeId
    ) {
      return;
    }
    const nextSource = {
      ...entry.playback!,
      awemeId: result.data.item.awemeId,
      posterUrl: result.data.item.coverUrl,
      url: localUrl ?? await douyinPlaybackUrl(result.data.item,headers,direction==="next"),
      ...douyinDecoderProfile(result.data.item),
      title: result.data.item.description,
      headers,
      webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
    };
    if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==result.data.item.awemeId)return;
    entry.playback=nextSource;dependencies.setError("");
    dependencies.setPlayingSource(entry.playback);
    appLogger.i('DouyinTiming',`sourcePublished ms=${Date.now()-switchStarted}`);
    await entry.queue.persist();
    if (dependencies.current() === entry) dependencies.onActivityStateChange?.();
    } catch(error) {
      // Publication is the commit point. Preserve the playing anchor on a failed URL/header/transport step.
      if(dependencies.current()!==entry||entry.playback!==previousSource)return;
      if(previousSource?.awemeId&&entry.queue.restoreSelection(previousSource.awemeId))await entry.queue.persist();
      dependencies.setError(error instanceof Error?error.message:'视频加载失败，请重试');
      throw error;
    }
  };

  onFrame(()=>{const entry=dependencies.current(),state=entry.queue?.snapshot();douyinDebug.updateContext(state?.item?.awemeId??'',state?.playlist[(state?.index??0)+1]?.awemeId??'',entry.page==='video'&&!!entry.queue,entry.queue);void douyinDebug.tick(Date.now(),lifecycle()==='active'&&entry.page==='video'&&!!entry.queue,()=>changeDouyinVideo(entry,'next')).catch(error=>dependencies.setError(String(error)));});

  const prepareDouyinAdjacent = async (
    entry:RouteEntry,
    direction:"next"|"previous",
    distance:1|2=1,
  ):Promise<DouyinPreparedSource|undefined> => {
    if(!entry.queue||dependencies.current()!==entry)return;
    const result=await entry.queue.preview(direction,distance);
    if(dependencies.current()!==entry||!result.ok)return;
    const headers=await douyinClient.buildPlaybackHeaders();
    const localUrl=await douyinPreload.lookup(result.data.item.awemeId);
    if(dependencies.current()!==entry||entry.queue.snapshot().playlist[result.data.index]?.awemeId!==result.data.item.awemeId)return;
    const url=localUrl ?? await douyinPlaybackUrl(result.data.item,headers,direction==='next');
    if(dependencies.current()!==entry||entry.queue.snapshot().playlist[result.data.index]?.awemeId!==result.data.item.awemeId)return;
    return {key:result.data.item.awemeId,source:{
      ...entry.playback!,awemeId:result.data.item.awemeId,posterUrl:result.data.item.coverUrl,
      url,title:result.data.item.description,headers,
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
    // Publication commits playback. Persistence must not hold the paging strip.
    void entry.queue.persist().then(()=>{if(dependencies.current()===entry)dependencies.onActivityStateChange?.();}).catch(error=>{if(dependencies.current()===entry)dependencies.setError(error instanceof Error?error.message:"视频进度保存失败");});
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

  const recoverDouyinVideo = async (entry: RouteEntry, manual = false, positionMs = 0, error?:unknown) => {
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
      const category=playbackFailure(error);
      if(manual){entry.queue.resetAutomaticFailures();entry.douyinFailures?.delete(id);}
      if(!manual&&entry.playback?.immersive){
        const code=String((error as {code?:unknown}|undefined)?.code??'');
        if(code==='CANCELLED'||/cancel|abort/i.test(code))return;

        if(error!==undefined&&!entry.queue.claimAutomaticFailure()){dependencies.setError('连续播放失败，请重试');return;}
      }
      if ((videoOptEnabled('recovery')||entry.playback?.immersive&&error!==undefined)&&category!=='decode'&&category!=='restricted') {
        const selected=entry.queue.snapshot().item!;
        if(entry.douyinRecovery?.id!==id)entry.douyinRecovery={id,policy:new DouyinPlaybackRecovery(selected,async()=>{
          const result=await douyinClient.resolvePlayback(id,{forceRefresh:true});
          if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,retryAfterMs:result.retryAfterMs});
          return result.data;
        })};
        if(entry.playback?.url?.startsWith('podjs-media-cache:')||entry.playback?.url?.startsWith('managed-cache/'))await douyinPreload.invalidate(id);
        const queueGeneration=entry.queue.diagnostics().generation;
        const current=()=>dependencies.current()===entry&&entry.queue?.snapshot().item?.awemeId===id&&entry.queue.diagnostics().generation===queueGeneration;
        const source=await entry.douyinRecovery.policy.recover({...entry.playback!,resumePositionMs:positionMs},current,manual,error);
        if(!source||!current())return;
        entry.queue.updateCurrentUrl(source.url!);await entry.queue.persist();
        if(!current())return;
        entry.playback=source;dependencies.setPlayingSource(source);dependencies.setError('');
        dependencies.onActivityStateChange?.();return;
      }
      if (category!=='restricted'&&category!=='decode'&&entry.playback?.url?.startsWith('managed-cache/douyin-preload/')) {
        await douyinPreload.invalidate(id);
        const remote=await douyinClient.resolvePlayback(id,{forceRefresh:true});
        if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==id)return;
        if(!remote.ok){dependencies.setError(remote.message);return;}
        const headers=await douyinClient.buildPlaybackHeaders();
        if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==id)return;
        const source={...entry.playback,url:remote.data.playUrl,headers};
        entry.queue.updateCurrentUrl(remote.data.playUrl);await entry.queue.persist();
        if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==id)return;
        entry.playback=source;dependencies.setPlayingSource(source);dependencies.setError('');
        dependencies.onActivityStateChange?.();return;
      }
      if(category!=='restricted'&&category!=='decode'&&entry.playback?.previewOnly){
        const fresh=await douyinClient.resolvePlayback(id,{forceRefresh:true});if(!fresh.ok){dependencies.setError(fresh.message);return;}
        const headers=await douyinClient.buildPlaybackHeaders(),url=await douyinPlaybackUrl(fresh.data,headers);
        if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==id)return;
        entry.queue.refreshPrefetchItem(id,fresh.data);entry.playback={...entry.playback,url,headers,previewOnly:false};await entry.queue.persist();
        if(dependencies.current()===entry){dependencies.setPlayingSource(entry.playback);dependencies.setError('');}return;
      }
      if(entry.playback?.url?.startsWith('podjs-media-cache:'))await douyinPreload.invalidate(id);
      if (dependencies.current() !== entry) return;
      if (entry.playback?.detailPlayback&&!(entry.playback.immersive&&(category==='restricted'||category==='decode'))) {
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
      const skip = !manual&&(category==='decode'||failures.has(id));
      failures.add(id);
      const result = await (skip
        ? entry.queue.discard()
        : entry.queue.recover());
      if (dependencies.current() !== entry) return;
      if (!result.ok) {
        if(isDouyinTemporaryFailure(result.code)||result.code==='REQUEST_FAILED'||result.code==='CANCELLED')failures.delete(id);
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
      const recoveredSource = {
        ...entry.playback!,previewOnly:false,
        awemeId: result.data.item.awemeId,
        posterUrl: result.data.item.coverUrl,
        url: await douyinPlaybackUrl(result.data.item,headers),
        ...douyinDecoderProfile(result.data.item),
        title: result.data.item.description,
        headers,
        webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
      };
      if(dependencies.current()!==entry||entry.queue.snapshot().item?.awemeId!==result.data.item.awemeId)return;
      entry.playback=recoveredSource;dependencies.setError("");
      dependencies.setPlayingSource(entry.playback);
      await entry.queue.persist();
      if (dependencies.current() === entry) dependencies.onActivityStateChange?.();
    } catch (error) {
      dependencies.setError(error instanceof Error?error.message:String(error));
    } finally {
      entry.douyinRecovering = false;
    }
  };

  const paintCheckpoints=new WeakMap<RouteEntry,number>();
  const [firstCardAction,setFirstCardAction]=createSignal<{entry:RouteEntry;seq:number}>();
  createEffect(()=>{
    const action=firstCardAction();if(!action)return;
    if(dependencies.current()!==action.entry){douyinBench.cancelPresented('first_card',action.seq);return;}
    onCleanup(()=>douyinBench.cancelPresented('first_card',action.seq));
  });
  const douyinReady = (entry: RouteEntry) => {
    if (dependencies.current() !== entry || !entry.queue) return;
    entry.queue.resetAutomaticFailures();
    const selected=entry.queue.snapshot().item,resolved=entry.playback?.url&&douyinPreload.sourceFor?.(entry.playback.url);
    if(resolved&&resolved.awemeId===selected?.awemeId&&resolved.playUrl!==selected.playUrl)entry.queue.refreshPrefetchItem(resolved.awemeId,resolved);
    const queue=entry.queue,id=queue.snapshot().item?.awemeId,revision=(paintCheckpoints.get(entry)??0)+1;
    paintCheckpoints.set(entry,revision);
    // Register at decoded-frame publication; native stamps the next actual visible
    // commit. Waiting for afterPaint first would measure an extra frame.
    if(entry.douyinEntrySeq){const seq=entry.douyinEntrySeq;douyinBench.firstCard(seq);setFirstCardAction({entry,seq});entry.douyinEntrySeq=undefined;}
    // The first frame must get a window commit before history JSON/KV work can occupy this completion turn.
    void afterPaint().result.then(async result=>{
      if(dependencies.current()!==entry||entry.queue!==queue||queue.snapshot().item?.awemeId!==id||paintCheckpoints.get(entry)!==revision)return;
      appLogger.i('DouyinTiming',`persistenceBegin committed=${result.committed}`);
      await queue.settled();
    }).catch(error=>{if(dependencies.current()===entry)dependencies.setError(String(error));});
    const state=entry.queue.snapshot();
    if(state.item)douyinStock.consume(state.item.awemeId);
    if(entry.playback?.immersive)douyinPreload.start(entry,state.playlist,state.item?.awemeId,'active',{
      isForeground:id=>dependencies.current()===entry&&entry.queue?.snapshot().item?.awemeId===id,
      async sourceRefreshed(id,previousUri,item,uri,headers){
        if(dependencies.current()!==entry||!entry.queue)return;
        entry.queue.refreshPrefetchItem(id,item);entry.player?.invalidatePrefetch?.(id);
        if(entry.queue.snapshot().item?.awemeId===id&&entry.playback?.url===previousUri){entry.playback={...entry.playback,url:uri,headers,previewOnly:false};dependencies.setPlayingSource(entry.playback);}
        await entry.queue.persist();
      },
      async quarantine(id){if(dependencies.current()!==entry||!entry.queue?.quarantinePrefetch(id))return false;entry.player?.invalidatePrefetch?.(id);await entry.queue.persist();return true;},
    });
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

  const recoverRssDouyinVideo = async (entry: RouteEntry, manual = false,positionMs?:number,error?:unknown) => {
    if (!entry.rssDouyinRecovery || !entry.playback) return;
    try {
      const source = await entry.rssDouyinRecovery.recover(
        {...entry.playback,resumePositionMs:positionMs??entry.playback.resumePositionMs},
        () => dependencies.current() === entry,
        manual,error,
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
