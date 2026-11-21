import {douyinPlaybackMirrors} from '../../douyin/playback-mirrors.ts';
import type {DouyinItem} from '../../douyin/types.ts';
import {directNetworkWork,isNetworkRecoveryCancellation,type NetworkWork} from '../../network/recovery.ts';
import {reloadDouyinPlayback,retryableDouyinSourceFailure,type DouyinReloadMode} from '../../douyin/reload-playback.ts';
import {douyinPlaybackAddressExpired} from '../../douyin/media-expiry.ts';
import {freshVideoSource} from '../../media/reload-source.ts';
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
import {withoutDouyinSource} from '../../douyin/playback-ingress.ts';
import {DOUYIN_MAX_SHORT_EDGE,DOUYIN_RESOLUTION_LIMIT,applyPreferredDouyinPlayback} from '../../douyin/playback-selector.ts';
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
import { resolveBiliPlaybackWithPreview, createBiliPlaybackRetry, douyinDetail } from "../../playback.ts";
import { biliVideoTarget, douyinVideoTarget } from "../../reader/media.ts";
import type { SettingsState } from "../../settings/index.ts";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinPlayRequest, DouyinRoute } from "../douyin/index.tsx";
import type { AppServices, Article, Channel } from "../service.ts";
import type { PlaybackSource } from "../VideoPlayerScreen.tsx";
import { douyinDecoderProfile, type DouyinPreparedSource } from "../douyin/video-sessions.ts";
import type { RouteEntry, SetPage } from "./types.ts";

interface MediaControllerDependencies {
  network?:()=>NetworkWork;
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

const DOUYIN_SNAPSHOT_WRITE_TIMEOUT_MS=2_000;

async function waitForDouyinSnapshotWrite(write:Promise<void>,description:string):Promise<void>{
  const deadline=hostServices.delay(DOUYIN_SNAPSHOT_WRITE_TIMEOUT_MS);
  try{
    // The transaction can still finish after the player stops waiting for it.
    const timedOut=await Promise.race([write.then(()=>false),deadline.result.then(()=>true)]);
    if(timedOut)appLogger.w('DouyinPlayer',`${description} timed out`);
  }catch{
    appLogger.w('DouyinPlayer',`${description} failed`);
  }finally{
    deadline.cancel();
  }
}

export function createMediaRouteController(
  dependencies: MediaControllerDependencies,
) {
  const [videoLoading,setVideoLoading]=createSignal(false);
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
    setVideoLoading(false);
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
    dependencies.setBusy(true);setVideoLoading(true);
    dependencies.setError("");
    try {
      const bili = biliVideoTarget(rawUrl) ?? biliVideoTarget(article.link);
      if (bili) {
        let cid = bili.cid;
        if (!cid) {
          try { cid = await (dependencies.network?.()??directNetworkWork).run(async()=>{
            try{return (await biliClient.detail(bili)).pages[0]?.cid;}
            catch(error){const cached=(await biliPreviewCache.lookup(bili))?.cid;if(!cached)throw error;return cached;}
          }); }
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
          cover: article.imageUrl || undefined,
          author: article.channelTitle || undefined,
          description: article.excerpt || undefined,
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
        douyinVideoTarget(article.link) ?? douyinVideoTarget(resolved);
      let url = resolved;
      let douyinItem:import("../../douyin/types.ts").DouyinItem|undefined;
      let headers: Record<string, string> | undefined;
      if (douyin) {
        headers = await douyinClient.buildPlaybackHeaders();
        if (douyin.awemeId) {
          const result = await (dependencies.network?.()??directNetworkWork).result(()=>douyinClient.resolvePlayback(douyin.awemeId!));
          if (result.ok) {url = result.data.playUrl;douyinItem=result.data;}
          else if (result.code===DOUYIN_RESOLUTION_LIMIT||douyinVideoTarget(resolved)) {
            throw Object.assign(new Error(result.message),result);
          }
        }
      }
      if (dependencies.current() !== origin) return;
      await openVideo(
        {
          url,
          ...(douyin?{maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE,awemeId:douyin.awemeId}:{}),
          ...(douyinItem?douyinDecoderProfile(douyinItem):{}),
          headers,
          webUrl: douyin?.webUrl ?? resolved,
          title: article.title,
          posterUrl: douyinItem?.coverUrl ?? (article.imageUrl || article.enclosureImageUrl || undefined),
          author: douyinItem?.authorName || article.channelTitle || undefined,
          description: (douyinItem?.description || article.excerpt)?.trim() || undefined,
          platform: "rss",awemeId:douyin?.awemeId,
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
      dependencies.setBusy(false);setVideoLoading(false);
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
    dependencies.setBusy(true);setVideoLoading(true);
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
      const {remote: source,source: initialSource} = await (dependencies.network?.()??directNetworkWork).run(()=>resolveBiliPlaybackWithPreview(
        () => route.source&&(route.source.apiSource!=='watch'||biliClient.watchApiEnabled()) ? Promise.resolve(route.source) : biliClient.resolvePlayback({aid: Number(route.aid) || undefined,bvid: route.bvid,cid: Number(route.cid),preferMp4: true}),
        localPreview,route.title ?? "哔哩哔哩",headers,
      ));
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
          (dependencies.network?.()??directNetworkWork).run(()=>biliClient.resolvePlayback({
            aid: Number(route.aid) || undefined,
            bvid: route.bvid,
            cid: Number(route.cid),
            preferMp4: true,
            forceWeb:retry?.forceWeb,
          })),
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
        if (dependencies.current() !== entry || options?.isCurrent?.()===false) return;
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
          ...(options?.freshOnly?{bypassCache:true,recoveryDeadlineMs:undefined}:{}),
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
          posterUrl: route.cover,
          author: route.author,
          description: route.description,
          backgroundPlayback: biliBackground(),
          webUrl: route.bvid
            ? `https://www.bilibili.com/video/${route.bvid}`
            : `https://www.bilibili.com/video/av${route.aid}`,
        },
        { checkpoint, retryPlayback,memory,videoTarget:{kind:'bili',aid:route.aid,bvid:route.bvid,cid:route.cid,title:route.title} },
      );
    } catch (error) {
      if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
    } finally {
      dependencies.setBusy(false);setVideoLoading(false);
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
      if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
    } finally {douyinBench.leaveLogin(douyinClient,benchAttempt);}
  };

  const douyinPlaybackUrl=async(item:import('../../douyin/types.ts').DouyinItem,headers:Record<string,string>,forward=false,intent:'playback'|'prewarm'='playback')=>{
    item=applyPreferredDouyinPlayback(item);
    if(!item.playUrl)throw Object.assign(new Error('没有可用的视频播放流'),{code:DOUYIN_RESOLUTION_LIMIT});
    const override=douyinDebug.playbackUrl(item.awemeId,item.playUrl,forward);
    return override!==item.playUrl?override:douyinPreload.playback?douyinPreload.playback(item,headers,intent):item.playUrl;
  };
  const playbackProfile=(item:DouyinItem,url?:string)=>{
    const registered=url?douyinPreload.sourceFor?.(url):undefined;
    const rendition=registered?.awemeId===item.awemeId?registered:item;
    // A verified complete file contains its own audio track. Even if the
    // metadata LRU has advanced, never attach a remote DASH companion to it.
    const complete=url?.startsWith('file:');
    const profile=douyinDecoderProfile(rendition,complete?url:rendition.playUrl);
    return {videoMime:profile.videoMime,videoWidth:profile.videoWidth,videoHeight:profile.videoHeight,
      maxVideoShortEdge:profile.maxVideoShortEdge,audioUrl:complete?undefined:profile.audioUrl};
  };
  // Only the verified local first item owns a hidden decoder on the title page.
  // Nothing plays before the user enters; navigation adopts this exact pool.
  let entryInitial:{entry:RouteEntry;owner:unknown;id:string;remoteUrl:string;seq:number;version:number;source?:PlaybackSource;pool?:DouyinVideoSessionPool;pending:Promise<void>}|undefined;
  const stopDouyinEntry=(owner?:unknown)=>{
    if(entryInitial&&(owner===undefined||entryInitial.owner===owner)){const old=entryInitial;entryInitial=undefined;void old.pool?.releaseAll().catch(()=>{});}
  };
  createEffect(()=>{const entry=dependencies.current(),active=lifecycle()==='active';if(entryInitial&&(entryInitial.entry!==entry||!active))stopDouyinEntry();});
  onCleanup(()=>stopDouyinEntry());
  const primeDouyinEntry=async(entry:RouteEntry,owner:unknown,items:import('../../douyin/types.ts').DouyinItem[],anchor:string|null,seq?:number)=>{
    const bounds=dependencies.initialVideoBounds?.();
    if(!seq||!bounds||dependencies.current()!==entry||entry.page!=='douyin'||(entry.douyinRoute?.name??'entry')!=='entry'||lifecycle()!=='active')return;
    const requested=entry.douyinRoute?.name==='entry'?entry.douyinRoute.resumeAwemeId:undefined;
    const item=applyPreferredDouyinPlayback(items.find(x=>x.awemeId===(requested??anchor))??items[0]);if(!item)return;
    if(entryInitial?.entry===entry&&entryInitial.owner===owner&&entryInitial.id===item.awemeId&&entryInitial.remoteUrl===item.playUrl&&entryInitial.seq===seq)return entryInitial.pending;
    stopDouyinEntry();
    const own:NonNullable<typeof entryInitial>={entry,owner,id:item.awemeId,remoteUrl:item.playUrl,seq,version:0,pending:Promise.resolve()};entryInitial=own;
    own.pending=(async()=>{
      const bundle=await douyinPreload.readySource?.(item);
      if(entryInitial!==own||dependencies.current()!==entry||lifecycle()!=='active'||!bundle?.previewFrame||! /^(?:podjs-media-cache:|file:)/.test(bundle.url))return;
      own.version=douyinClient.playbackAuthorizationVersion();
      const source:PlaybackSource={startupSeq:seq,immersive:true,awemeId:item.awemeId,posterUrl:item.coverUrl,previewFrame:bundle.previewFrame,url:bundle.url,...playbackProfile(bundle.item??item,bundle.url),...douyinDetail(item),headers:{},...playbackPreferences(),platform:'douyin',webUrl:`https://www.douyin.com/video/${item.awemeId}`,backgroundPlayback:douyinBackground()};
      own.source=source;own.pool=dependencies.createInitialVideoPool?.()??new DouyinVideoSessionPool();
      void own.pool.prime({key:item.awemeId,source},{...source,bounds,autoplay:false,compactProgress:true}).result.catch(()=>{});
    })().catch(()=>{});
    await own.pending;
  };
  let pendingInitialPool:{origin:RouteEntry;pool:DouyinVideoSessionPool}|undefined;
  createEffect(()=>{const entry=dependencies.current();if(pendingInitialPool&&pendingInitialPool.origin!==entry){if(entry.initialVideoPool!==pendingInitialPool.pool)void pendingInitialPool.pool.releaseAll().catch(()=>{});pendingInitialPool=undefined;}});
  onCleanup(()=>{void pendingInitialPool?.pool.releaseAll().catch(()=>{});});
  let pendingDouyinPlayback: Promise<PlaybackSource> | undefined;
  let pendingDouyinQueue: DouyinPlaybackQueue | undefined;
  let pendingDouyinRequest: DouyinPlayRequest | undefined;
  const douyinPlay = (input: DouyinPlayRequest) => {
    setVideoLoading(true);
    const request={...input,item:applyPreferredDouyinPlayback(input.item),playback:applyPreferredDouyinPlayback(input.playback)};
    pendingDouyinRequest=request;
    pendingDouyinQueue = new DouyinPlaybackQueue(douyinClient, {
      items: (request.playlist ?? [request.item]).map(item => item.awemeId === request.item.awemeId ? request.playback : item),
      selectedAwemeId: request.item.awemeId,
      cursor: request.cursor,
      hasMore: request.hasMore,
      fixedSources: request.immersive !== true,
      ...(request.immersive===true?{limit:80}:{}),
      localPlayback: id=>douyinPreload.lookup(id),
    });
    void pendingDouyinQueue.fillAhead(16).catch(()=>{});
    pendingDouyinPlayback = (async()=>{
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'candidate_start'});
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'preview_start'});
        // A restored native cache capability already owns authorized upstream headers.
        const bundle=await douyinPreload.readySource?.(request.item);
        const localUrl=bundle?.url??await douyinPreload.lookup(request.item.awemeId);
        if(!localUrl&&request.immersive&&douyinPlaybackAddressExpired(request.playback)){
          throw Object.assign(new Error('推荐播放地址已过期'),{code:'source_expired'});
        }
        const headers=localUrl?{}:await douyinClient.buildPlaybackHeaders();
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'headers_ready'});
        const previewFrame=bundle?.previewFrame??(!douyinPreload.readySource?await douyinPreload.previewFrame(request.item):undefined);
        benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'preview_ready'});
        const url=localUrl??await douyinPlaybackUrl(request.playback,headers);
        return ({
        startupSeq:request.entrySeq,releaseStartupPreview:request.releaseStartupPreview,
        immersive: request.immersive,
        detailPlayback: request.detailPlayback,
        awemeId: request.item.awemeId,
        posterUrl: request.item.coverUrl,
        previewFrame,
        url,...playbackProfile(bundle?.item??request.playback,url),
        ...douyinDetail(request.item),
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
      const item = origin && "item" in origin ? origin.item : current.queue?.itemAtOffset();
      if (item?.awemeId === route.awemeId) route = { ...route, item };
    }
    if (route.name === "player" && pendingDouyinPlayback) {
      const pending=pendingDouyinPlayback,queue=pendingDouyinQueue,request=pendingDouyinRequest,origin=dependencies.current();
      const current=()=>dependencies.current()===origin&&pendingDouyinPlayback===pending&&(request?.isCurrent?.()??true);
      let opened=false;let stage:FailureStage='source',initialPool:DouyinVideoSessionPool|undefined;
      try {
        const deadline=request?.immersive?hostServices.delay(200):undefined;
        let source:PlaybackSource|undefined,initialRejection:unknown;
        try{source=await (deadline?Promise.race([pending,deadline.result.then(()=>undefined)]):pending);}
        catch(error){
          const resolutionLimited=douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT;
          if(!request?.immersive||!queue||(!resolutionLimited&&!retryableDouyinSourceFailure(error)))throw error;
          initialRejection=error;
        }finally{deadline?.cancel();}
        if(!current())return;
        if(!source&&request){
          // Local queue metadata can enter even while cookie IO is blocked.
          // A preview-only source cannot open a network connection or decoder.
          stopDouyinEntry();
          const resolutionLimited=douyinPlaybackFailure(initialRejection).code===DOUYIN_RESOLUTION_LIMIT;
          const waiting:PlaybackSource={platform:'douyin',immersive:true,previewOnly:true,startupSeq:request.entrySeq,awemeId:request.item.awemeId,...douyinDetail(request.item),
            preparationError:resolutionLimited?undefined:initialRejection,
            releaseStartupPreview:request.releaseStartupPreview,posterUrl:request.item.coverUrl,...playbackPreferences(),backgroundPlayback:douyinBackground(),webUrl:`https://www.douyin.com/video/${request.item.awemeId}`};
          if(!initialRejection)void queue?.persist().catch(()=>appLogger.w('DouyinEntry','queue persistence failed'));
          stage='backdrop';await openVideo(waiting,{queue,memory,douyinEntrySeq:request.entrySeq,videoTarget:{kind:'douyin',awemeId:route.awemeId,immersive:true}},current);
          const entry=dependencies.current(),selected=()=>(request.isCurrent?.()??true)&&dependencies.current()===entry&&entry.playback===waiting&&entry.queue===queue;
          if(entry.playback===waiting){
            opened=true;
            request.onSourcePublished?.(waiting);
            if(initialRejection){
              if(resolutionLimited)await recoverDouyinVideo(entry,false,0,initialRejection,request.item.awemeId);
              return;
            }
            void pending.then(ready=>{if(!selected())return;benchmark.mark('startup_stage',request.entrySeq??0,{startup_stage:'source_ready'});entry.playback={...ready,previewOnly:false};dependencies.setPlayingSource(entry.playback);request.onSourcePublished?.(entry.playback);},error=>{
              if(!selected()||douyinPlaybackFailure(error).code==='CANCELLED')return;
              if(douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT){
                void recoverDouyinVideo(entry,false,0,error,request.item.awemeId);
                return;
              }
              entry.playback={...waiting,preparationError:error};dependencies.setPlayingSource(entry.playback);
              request.onSourceFailure?.(douyinPlaybackFailure(error));
            });
          }
          return;
        }
        if(!source)return;
        benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'source_ready'});
        const warm=entryInitial;
        // A completed matching prime can be reused. Speculative lookup must
        // not block publication of the foreground source.
        if(warm&&entryInitial===warm&&warm.entry===origin&&warm.id===source.awemeId&&warm.seq===request?.entrySeq&&warm.pool&&warm.source?.url===source.url&&warm.version===douyinClient.playbackAuthorizationVersion()){
          initialPool=warm.pool;entryInitial=undefined;pendingInitialPool={origin,pool:initialPool};
        }else if(warm&&entryInitial===warm)stopDouyinEntry();
        const bounds=dependencies.initialVideoBounds?.();
        if(!initialPool&&bounds&&source.immersive&&source.previewFrame&&source.url?.startsWith('podjs-media-cache:')&&lifecycle()==='active'){
          initialPool=dependencies.createInitialVideoPool?.()??new DouyinVideoSessionPool();pendingInitialPool={origin,pool:initialPool};
          void initialPool.prime({key:source.awemeId??source.url,source},{...source,bounds,autoplay:false,compactProgress:true}).result.catch(()=>{});
        }

        stage='persist';benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'persist_start'});
        const persisted=queue?.persist().then(()=>{benchmark.mark('startup_stage',request?.entrySeq??0,{startup_stage:'persist_done'});});
        // Enqueue the durable write before publication, but immersive entry
        // cannot wait behind legacy migration or another storage operation.
        if(source.immersive)void persisted?.catch(()=>appLogger.w('DouyinEntry','queue persistence failed'));
        else await persisted;
        if(!current())return;
        if(pendingInitialPool?.pool!==initialPool&&initialPool){initialPool=undefined;}
        stage='backdrop';await openVideo(source, { queue, memory, initialVideoPool:initialPool, douyinEntrySeq:request?.entrySeq, videoTarget: {
          kind: 'douyin', awemeId: route.awemeId, immersive: source.immersive,
          ...(source.detailPlayback ? {detailPlayback:true} : {}),
        } },current);
        if(dependencies.current().playback===source){opened=true;initialPool=undefined;request?.onSourcePublished?.(source);}
      } catch (error) {
        if(current()){
          benchmark.begin('error_page',{reason:'exhausted',...playerFailureFields(error,stage)});
          if(request?.onFailure)request.onFailure(douyinPlaybackFailure(error));
          else dependencies.setError(error instanceof Error?error.message:String(error));
        }
      } finally {
        setVideoLoading(false);
        if(!opened)request?.releaseStartupPreview?.();
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
    let url=localUrl,initialRejection:unknown;
    if(!frame?.available&&!url){
      try{url=await douyinPlaybackUrl(item,headers);}
      catch(error){
        if(douyinPlaybackFailure(error).code!==DOUYIN_RESOLUTION_LIMIT)throw error;
        initialRejection=error;
      }
    }
    if(dependencies.current()!==origin)return false;
    const source: PlaybackSource = {
      platform:"douyin",immersive,detailPlayback,awemeId:item.awemeId,
      url:frame?.available?item.playUrl:url,
      previewOnly:frame?.available===true||!!initialRejection,
      previewFrame:frame?.available?{entryId:item.awemeId,frame}:undefined,
      posterUrl:item.coverUrl,...douyinDetail(item),...playbackProfile(item,url),...playbackPreferences(),headers,
      backgroundPlayback:douyinBackground(),webUrl:`https://www.douyin.com/video/${item.awemeId}`,
    };
    await openVideo(source, {queue, memory, videoTarget: {
      kind:'douyin',awemeId,immersive,...(detailPlayback ? {detailPlayback:true} : {}),
    }});
    const entry=dependencies.current();
    const selected=()=>dependencies.current()===entry&&entry.queue===queue
      &&queue.itemAtOffset()?.awemeId===item.awemeId&&entry.playback===source;
    if(initialRejection&&selected()){
      await recoverDouyinVideo(entry,false,0,initialRejection,item.awemeId);
      return true;
    }
    if(source.previewOnly&&selected()){
      void douyinPlaybackUrl(item,headers).then(url=>{
        if(!selected())return;
        entry.playback={...source,url,...playbackProfile(item,url),previewOnly:false};dependencies.setPlayingSource(entry.playback);
      }).catch(error=>{
        if(!selected()||isNetworkRecoveryCancellation(error))return;
        if(douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT){
          void recoverDouyinVideo(entry,false,0,error,item.awemeId);
        }else dependencies.setError(String(error));
      });
    }
    return dependencies.current().queue === queue;
  };

  const changeDouyinVideo = async (
    entry: RouteEntry,
    direction: "next" | "previous",
    isCurrent:()=>boolean=()=>true,
  ) => {
    if (!entry.queue || dependencies.current() !== entry) return;
    if (
      direction === "previous" &&
      entry.playback?.immersive &&
      entry.queue.selectedIndex === 0
    ) {
      // At the session history boundary, use the normal route exit and player cleanup.
      dependencies.popPage();
      return;
    }
    const previousSource=entry.playback;
    try {
    const switchStarted=Date.now();appLogger.i('DouyinTiming','switch begin');
    const result = await entry.queue[direction]();
    if(!isCurrent())throw new Error("cancelled");
    if (dependencies.current() !== entry) return;
    if (!result.ok) {
      if (result.code !== "CANCELLED") {
        dependencies.setError(result.message);
        throw Object.assign(new Error(result.message),result);
      }
      return;
    }
    const headers = await adjacentHeaders(entry);
    const localUrl=await douyinPreload.lookup(result.data.item.awemeId);
    if(!isCurrent())throw new Error("cancelled");
    if (
      dependencies.current() !== entry ||
      entry.queue.itemAtOffset()?.awemeId !== result.data.item.awemeId
    ) {
      return;
    }
    const url=localUrl??await douyinPlaybackUrl(result.data.item,headers,direction==="next");
    const nextSource = {
      ...entry.playback!,
      awemeId: result.data.item.awemeId,
      posterUrl: result.data.item.coverUrl,
      url,...playbackProfile(result.data.item,url),
      ...douyinDetail(result.data.item),
      headers,
      webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
    };
    if(!isCurrent())throw new Error("cancelled");
    if(dependencies.current()!==entry||entry.queue.itemAtOffset()?.awemeId!==result.data.item.awemeId)return;
    entry.playback=nextSource;dependencies.setError("");
    dependencies.setPlayingSource(entry.playback);
    appLogger.i('DouyinTiming',`sourcePublished ms=${Date.now()-switchStarted}`);
    await entry.queue.persist();
    if (dependencies.current() === entry) dependencies.onActivityStateChange?.();
    } catch(error) {
      // Publication is the commit point. Preserve the playing anchor on a failed URL/header/transport step.
      if(dependencies.current()!==entry||entry.playback!==previousSource)return;
      if(previousSource?.awemeId&&entry.queue.restoreSelection(previousSource.awemeId))await entry.queue.persist();
      if(isCurrent())dependencies.setError(error instanceof Error?error.message:'视频加载失败，请重试');
      throw error;
    }
  };

  // Startup resolves the native build gate before mounting the route controller.
  // A native video does not need guest display ticks to keep playing.
  if(douyinDebug.allowed){
    onFrame(()=>{
      const entry=dependencies.current(),queue=entry.queue,inVideoFlow=entry.page==='video'&&!!queue;
      douyinDebug.updateContext(queue?.itemAtOffset()?.awemeId??'',queue?.itemAtOffset(1)?.awemeId??'',inVideoFlow,queue);
      void douyinDebug.tick(Date.now(),inVideoFlow&&lifecycle()==='active',()=>changeDouyinVideo(entry,'next'))
        .catch(error=>dependencies.setError(String(error)));
    },()=>dependencies.current().page==='video');
  }

  const adjacentHeaderCache=new WeakMap<RouteEntry,{authorization:number;value:Promise<Record<string,string>>}>();
  const adjacentHeaders=async(entry:RouteEntry)=>{
    const authorization=douyinClient.playbackAuthorizationVersion?.()??0,known=adjacentHeaderCache.get(entry);
    if(known?.authorization===authorization)return known.value;
    // A playing route already owns authenticated headers. Coalesce subsequent
    // reads after an auth change before either neighbour queues decoder work.
    // A restored stock capability carries its own headers. Its empty route
    // headers cannot be used to register the neighbouring network sources.
    const playingHeaders=entry.playback?.headers;
    const record={authorization,value:!known&&playingHeaders&&Object.keys(playingHeaders).length?Promise.resolve(playingHeaders):douyinClient.buildPlaybackHeaders()};
    adjacentHeaderCache.set(entry,record);
    try{return await record.value;}catch(error){if(adjacentHeaderCache.get(entry)===record)adjacentHeaderCache.delete(entry);throw error;}
  };
  const readyPagingSource=async(item:import('../../douyin/types.ts').DouyinItem)=>{
    const bundle=await douyinPreload.readySource?.(item);
    if(bundle?.previewFrame.entryId===item.awemeId&&bundle.item?.awemeId===item.awemeId)return bundle;
  };
  const prepareDouyinAdjacent = async (
    entry:RouteEntry,
    direction:"next"|"previous",
    distance:1|2|3|4|5=1,
  ):Promise<DouyinPreparedSource|undefined> => {
    const queue=entry.queue;
    if(!queue||dependencies.current()!==entry)return;
    const result=await queue.preview(direction,distance);
    if(dependencies.current()!==entry||entry.queue!==queue||!result.ok)return;
    const offset=direction==='next'?distance:-distance;
    const stillAdjacent=()=>dependencies.current()===entry&&entry.queue===queue&&queue.itemAtOffset(offset)?.awemeId===result.data.item.awemeId;
    const authorizationVersion=douyinClient.playbackAuthorizationVersion?.()??0;
    const bundle=await readyPagingSource(result.data.item);
    const localUrl=bundle?.url??await douyinPreload.lookup(result.data.item.awemeId);
    if(!stillAdjacent())return;
    const headers=localUrl?{}:await adjacentHeaders(entry);
    if(!stillAdjacent())return;
    const url=localUrl ?? await douyinPlaybackUrl(result.data.item,headers,direction==='next','prewarm');
    if(!stillAdjacent())return;
    const previewFrame=bundle?.previewFrame??(localUrl?await douyinPreload.previewFrame(result.data.item,localUrl).catch(()=>undefined):undefined);
    if(!stillAdjacent())return;
    const registered=bundle?.item??douyinPreload.sourceFor?.(url)??result.data.item;
    return {key:result.data.item.awemeId,attemptedUrl:localUrl?.startsWith('file:')?localUrl:registered.playUrl,authorizationVersion,queueIndex:queue.selectedIndex+offset,anchorIndex:queue.selectedIndex,source:{
      ...entry.playback!,startupSeq:undefined,releaseStartupPreview:undefined,recoveryDeadlineMs:undefined,awemeId:result.data.item.awemeId,posterUrl:result.data.item.coverUrl,
      url,previewOnly:false,previewFrame,resumePositionMs:0,...douyinDetail(result.data.item),headers,
      ...playbackProfile(registered,url),
      webUrl:`https://www.douyin.com/video/${result.data.item.awemeId}`,
    }};
  };

  const selectDouyinTarget = (entry:RouteEntry,direction:"next"|"previous",distance:1|2=1,prepared?:DouyinPreparedSource) => {
    if(!entry.queue||dependencies.current()!==entry)return;
    const queue=entry.queue,result=queue.selectIntent(direction,distance);
    if(!result.ok){
      if(direction==='previous'&&entry.playback?.immersive&&queue.selectedIndex===0){dependencies.popPage();return;}
      // Feed boundaries use the existing single coalesced page request.
      else if(direction==='next')void changeDouyinVideo(entry,direction).catch(()=>{});
      return;
    }
    startDouyinWindow(entry);
    void queue.fillAhead(16).catch(()=>{});
    const item=result.data.item,old=entry.playback!;
    // The player supplies a decoded neighbour from this authorized route.
    // Selection still commits synchronously; no second cache/URL lookup gates it.
    if(prepared?.key===item.awemeId&&prepared.source.awemeId===item.awemeId&&prepared.authorizationVersion===(douyinClient.playbackAuthorizationVersion?.()??0)){
      entry.playback=prepared.source;dependencies.setError('');dependencies.setPlayingSource(prepared.source);
      void queue.persist().catch(error=>{if(dependencies.current()===entry)if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));});
      return;
    }
    // Publish metadata synchronously. A cached decoded frame can be shown;
    // otherwise the selected page is black while its URL is registered.
    let selected:PlaybackSource={...old,startupSeq:undefined,releaseStartupPreview:undefined,recoveryDeadlineMs:undefined,resumePositionMs:0,awemeId:item.awemeId,...douyinDetail(item),posterUrl:item.coverUrl,
      previewFrame:undefined,url:undefined,videoUrl:undefined,previewOnly:true,preparationError:undefined,
      ...douyinDecoderProfile(item),webUrl:`https://www.douyin.com/video/${item.awemeId}`};
    entry.playback=selected;dependencies.setError('');dependencies.setPlayingSource(selected);
    const current=()=>dependencies.current()===entry&&entry.queue===queue&&entry.playback===selected&&queue.itemAtOffset()?.awemeId===item.awemeId;
    void (async()=>{
      const bundle=await readyPagingSource(item);
      const local=bundle?.url??await douyinPreload.lookup(item.awemeId);if(!current())return;
      const headers=local?{}:await adjacentHeaders(entry);if(!current())return;
      if(!bundle?.previewFrame)void (local?video.restoreFrame(`douyin:${item.awemeId}`,{url:local,maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE}):douyinPreload.restoreFrame?.(item,headers))?.then(frame=>{
        if(!current()||!frame?.available)return;
        selected={...selected,previewFrame:{entryId:item.awemeId,frame}};entry.playback=selected;dependencies.setPlayingSource(selected);
      }).catch(()=>{});
      const url=local??await douyinPlaybackUrl(item,headers,direction==='next');if(!current())return;
      entry.playback={...selected,...playbackProfile(bundle?.item??item,url),
        previewFrame:bundle?.previewFrame??selected.previewFrame,headers,url,previewOnly:false,preparationError:undefined};
      dependencies.setPlayingSource(entry.playback);
      void queue.persist().catch(error=>{if(dependencies.current()===entry)if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));});
    })().catch(error=>{
      if(!current())return;
      if(douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT){void recoverDouyinVideo(entry,false,0,error);return;}
      // The selected source object is this intent's generation token. Keep
      // that target visible with its own retry state; old failures cannot
      // replace a newer selection, a replaced queue, or another route.
      selected={...selected,preparationError:error};entry.playback=selected;
      dependencies.setPlayingSource(selected);if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
    });
  };

  const promoteDouyinAdjacent = async (
    entry:RouteEntry,
    prepared:DouyinPreparedSource,
  ):Promise<boolean> => {
    if(!entry.queue||dependencies.current()!==entry)return false;
    const result=entry.queue.commitPreview(prepared.key);
    if(!result.ok||dependencies.current()!==entry)return false;
    entry.playback=prepared.source;dependencies.setError("");dependencies.setPlayingSource(prepared.source);
    startDouyinWindow(entry);
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
      if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
    }
  };

  const rejectedAddress=(registered?:DouyinItem,remote?:string,mirrorIndex?:number)=>
    mirrorIndex===1?(registered&&douyinPlaybackMirrors(registered)[0]):remote??registered?.playUrl;
  const dropAttempt=(queue:DouyinPlaybackQueue,item:DouyinItem,uri?:string,url?:string)=>{
    if(uri)douyinPreload.forgetSource?.(item.awemeId,uri);
    return url?{item:withoutDouyinSource(item,url),stored:queue.persistSourceRemoval(item.awemeId,url)}
      :{item,stored:Promise.resolve()};
  };
  const rejectDouyinAdjacent=(entry:RouteEntry,id:string,uri?:string,remote?:string,mirrorIndex?:number)=>{
    if(dependencies.current()!==entry||!entry.queue)return false;
    const state=entry.queue.snapshot(),item=state.playlist.find(value=>value.awemeId===id);
    if(!item||state.item?.awemeId===id)return false;
    const address=rejectedAddress(uri?douyinPreload.sourceFor?.(uri):undefined,remote,mirrorIndex);
    const {item:replacement,stored}=dropAttempt(entry.queue,item,uri,address??(mirrorIndex===1?undefined:uri??item.playUrl));
    void stored.catch(error=>{if(dependencies.current()===entry)dependencies.setError(String(error));});
    if(replacement===item)return false;
    if(replacement?.playUrl)entry.queue.refreshPrefetchItem(id,replacement);
    else if(!entry.queue.quarantinePrefetch(id))return false;
    entry.player?.invalidatePrefetch?.(id);
    void entry.queue.persist().catch(error=>dependencies.setError(String(error)));
    startDouyinWindow(entry);
    return true;
  };

  type RejectedAttempt={playback?:PlaybackSource;uri?:string;url?:string;registered?:DouyinItem};
  const recoveryRuns=new WeakMap<RouteEntry,{id:string;rejected?:RejectedAttempt}>();
  const recoverDouyinVideo = async (entry: RouteEntry, manual = false, positionMs = 0, error?:unknown,expectedId?:string,attempt?:{uri:string;url:string}) => {
    if(!entry.queue||dependencies.current()!==entry)return;
    const queue=entry.queue,item=queue.itemAtOffset(),id=item?.awemeId;
    if(!item||!id)return;
    const resolutionRejected=douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT;
    if(resolutionRejected&&((expectedId??entry.playback?.awemeId??id)!==id||
      attempt&&entry.playback?.url&&entry.playback.url!==attempt.uri))return;
    const previous=recoveryRuns.get(entry);
    if(previous&&!resolutionRejected)return;
    let rejected:RejectedAttempt|undefined;
    if(resolutionRejected){
      const playback=entry.playback,uri=attempt?.uri??playback?.url;
      const last=previous?.id===id?previous.rejected:undefined;
      // Forgetting a registration must not change the identity of its in-flight rejection.
      const samePlayback=last?.playback===playback&&last?.uri===uri?last:undefined;
      const registered=uri?(samePlayback?.registered??douyinPreload.sourceFor?.(uri)):undefined;
      const mirrorIndex=attempt?undefined:(error as {mirrorIndex?:number}|undefined)?.mirrorIndex;
      const url=rejectedAddress(registered,attempt?.url,mirrorIndex)??
        (!registered?samePlayback?.url:undefined)??(mirrorIndex===1?undefined:uri??item.playUrl);
      if(last&&last.url===url)return;
      rejected={playback,uri,url,registered};
    }
    // A new source can fail while the previous replacement snapshot is being saved.
    // The queue orders its deletion after that write, even though recovery starts now.
    const run={id,rejected};
    recoveryRuns.set(entry,run);
    const currentRun=()=>dependencies.current()===entry&&entry.queue===queue&&recoveryRuns.get(entry)===run;
    const persistReplacement=()=>waitForDouyinSnapshotWrite(queue.persist(),'Replacement queue snapshot save');
    let resolvingId=id;
    try {
      const category=resolutionRejected?'decode':playbackFailure(error);
      const dropped=rejected?dropAttempt(queue,item,rejected.uri,rejected.url):undefined;
      const snapshotCleanup=dropped&&waitForDouyinSnapshotWrite(dropped.stored,'Rejected source snapshot cleanup');
      const replacement=dropped?.item;
      if(replacement?.playUrl)entry.queue.refreshPrefetchItem(id,replacement);
      if(manual){entry.queue.resetAutomaticFailures();entry.douyinFailures?.delete(id);}
      if(!manual&&!resolutionRejected&&entry.playback?.immersive){
        const code=String((error as {code?:unknown}|undefined)?.code??'');
        if(code==='CANCELLED'||/cancel|abort/i.test(code))return;

        if(error!==undefined&&!entry.queue.claimAutomaticFailure()){dependencies.setError('连续播放失败，请重试');return;}
      }
      if ((videoOptEnabled('recovery')||entry.playback?.immersive&&error!==undefined)&&category!=='decode'&&category!=='restricted') {
        const selected=entry.queue.itemAtOffset()!;
        if(entry.douyinRecovery?.id!==id)entry.douyinRecovery={id,policy:new DouyinPlaybackRecovery(selected,async()=>{
          const result=await (dependencies.network?.()??directNetworkWork).result(()=>douyinClient.resolvePlayback(id,{forceRefresh:true,feedItem:entry.queue!.itemAtOffset(),allowDetail:false}));
          if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,retryAfterMs:result.retryAfterMs});
          return result.data;
        })};
        if(entry.playback?.url?.startsWith('podjs-media-cache:')||entry.playback?.url?.startsWith('managed-cache/'))await douyinPreload.invalidate(id);
        const queueGeneration=entry.queue.diagnostics().generation;
        const current=()=>currentRun()&&entry.queue?.itemAtOffset()?.awemeId===id&&entry.queue.diagnostics().generation===queueGeneration;
        const source=await entry.douyinRecovery.policy.recover({...entry.playback!,resumePositionMs:positionMs},current,manual,error);
        if(!source||!current())return;
        entry.queue.updateCurrentUrl(source.url!);await entry.queue.persist();
        if(!current())return;
        entry.playback=source;dependencies.setPlayingSource(source);dependencies.setError('');
        dependencies.onActivityStateChange?.();return;
      }
      if (category!=='restricted'&&category!=='decode'&&entry.playback?.url?.startsWith('managed-cache/douyin-preload/')) {
        await douyinPreload.invalidate(id);
        const remote=await (dependencies.network?.()??directNetworkWork).result(()=>douyinClient.resolvePlayback(id,{forceRefresh:true,feedItem:entry.queue!.itemAtOffset(),allowDetail:false}));
        if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==id)return;
        if(!remote.ok){if(remote.code===DOUYIN_RESOLUTION_LIMIT)throw Object.assign(new Error(remote.message),remote);dependencies.setError(remote.message);return;}
        const headers=await douyinClient.buildPlaybackHeaders();
        if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==id)return;
        const source={...entry.playback,url:remote.data.playUrl,...douyinDecoderProfile(remote.data),headers};
        entry.queue.updateCurrentUrl(remote.data.playUrl);await entry.queue.persist();
        if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==id)return;
        entry.playback=source;dependencies.setPlayingSource(source);dependencies.setError('');
        dependencies.onActivityStateChange?.();return;
      }
      if(category!=='restricted'&&category!=='decode'&&entry.playback?.previewOnly){
        const fresh=await (dependencies.network?.()??directNetworkWork).result(()=>douyinClient.resolvePlayback(id,{forceRefresh:true,feedItem:entry.queue!.itemAtOffset(),allowDetail:false}));if(!fresh.ok){if(fresh.code===DOUYIN_RESOLUTION_LIMIT)throw Object.assign(new Error(fresh.message),fresh);dependencies.setError(fresh.message);return;}
        const headers=await douyinClient.buildPlaybackHeaders(),url=await douyinPlaybackUrl(fresh.data,headers);
        if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==id)return;
        entry.queue.refreshPrefetchItem(id,fresh.data);entry.playback={...entry.playback,url,...playbackProfile(fresh.data,url),headers,previewOnly:false};await entry.queue.persist();
        if(currentRun()){dependencies.setPlayingSource(entry.playback);dependencies.setError('');}return;
      }
      if(!resolutionRejected&&entry.playback?.url?.startsWith('podjs-media-cache:'))await douyinPreload.invalidate(id);
      if (!currentRun()) return;
      if (!resolutionRejected&&entry.playback?.detailPlayback&&!(entry.playback.immersive&&(category==='restricted'||category==='decode'))) {
        entry.rssDouyinRecovery ??= new DouyinRssRecovery(douyinClient, id);
        const source = await entry.rssDouyinRecovery.recover(entry.playback, currentRun, manual);
        if (!source || !currentRun()) return;
        entry.queue.updateCurrentUrl(source.url ?? "");
        await entry.queue.persist();
        if (!currentRun()) return;
        entry.playback = source;
        dependencies.setError(""); dependencies.setPlayingSource(source);
        dependencies.onActivityStateChange?.();
        return;
      }
      const failures = (entry.douyinFailures ??= new Set<string>());
      const skip = !manual&&(category==='decode'||failures.has(id));
      failures.add(id);
      const next=resolutionRejected?(replacement?.playUrl?entry.queue.current():entry.queue.discardResolution())
        :skip?entry.queue.discard():entry.queue.recover();
      // Commit the deletion before preparing a new source so restart cannot
      // restore the rejected URL when cleanup succeeded.
      const [result]=await Promise.all([next,snapshotCleanup]);
      if (!currentRun()) return;
      if (!result.ok) {
        if(resolutionRejected){
          const source=entry.playback;
          if(source){
            entry.playback={...source,url:undefined,previewFrame:undefined,previewOnly:true,preparationError:error};
            dependencies.setPlayingSource(entry.playback);
          }
          if(!currentRun())return;
          await persistReplacement();
          if(!currentRun())return;
        }
        if(isDouyinTemporaryFailure(result.code)||result.code==='REQUEST_FAILED'||result.code==='CANCELLED')failures.delete(id);
        if (result.code === "CANCELLED") return;
        if (
          !entry.queue.snapshot().playlist.length &&
          entry.playback?.immersive
        ) {
          if(!resolutionRejected)await douyinClient.clearPlaybackWindow();
          if (!currentRun()) return;
          dependencies.popPage();
        }
        dependencies.setError(result.message);
        return;
      }
      resolvingId=result.data.item.awemeId;
      const headers = await douyinClient.buildPlaybackHeaders();
      if (
        !currentRun() ||
        entry.queue.itemAtOffset()?.awemeId !== result.data.item.awemeId
      ) {
        return;
      }
      const url=await douyinPlaybackUrl(result.data.item,headers);
      const recoveredSource = {
        ...entry.playback!,previewOnly:false,preparationError:undefined,previewFrame:undefined,
        videoUrl:undefined,resumePositionMs:undefined,
        awemeId: result.data.item.awemeId,
        posterUrl: result.data.item.coverUrl,
        url,...playbackProfile(result.data.item,url),
        ...douyinDetail(result.data.item),
        headers,
        webUrl: `https://www.douyin.com/video/${result.data.item.awemeId}`,
      };
      if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==result.data.item.awemeId)return;
      entry.playback=recoveredSource;dependencies.setError("");
      dependencies.setPlayingSource(entry.playback);
      if(!currentRun())return;
      if(resolutionRejected)await persistReplacement();
      else await entry.queue.persist();
      if (currentRun()){startDouyinWindow(entry);dependencies.onActivityStateChange?.();}
    } catch (error) {
      if(!currentRun()||entry.queue.itemAtOffset()?.awemeId!==resolvingId)return;
      if(douyinPlaybackFailure(error).code===DOUYIN_RESOLUTION_LIMIT){
        recoveryRuns.delete(entry);
        await recoverDouyinVideo(entry,false,0,error,resolvingId);
        return;
      }
      dependencies.setError(error instanceof Error?error.message:String(error));
    } finally {
      if(recoveryRuns.get(entry)===run)recoveryRuns.delete(entry);
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
    const selected=entry.queue.itemAtOffset(),resolved=entry.playback?.url&&douyinPreload.sourceFor?.(entry.playback.url);
    if(resolved&&!resolved.playUrl.startsWith('file:')&&resolved.awemeId===selected?.awemeId&&resolved.playUrl!==selected.playUrl)entry.queue.refreshPrefetchItem(resolved.awemeId,resolved);
    const queue=entry.queue,id=queue.itemAtOffset()?.awemeId,revision=(paintCheckpoints.get(entry)??0)+1;
    paintCheckpoints.set(entry,revision);
    // Register at decoded-frame publication; native stamps the next actual visible
    // commit. Waiting for afterPaint first would measure an extra frame.
    if(entry.douyinEntrySeq){const seq=entry.douyinEntrySeq;douyinBench.firstCard(seq);setFirstCardAction({entry,seq});entry.douyinEntrySeq=undefined;}
    // The first frame must get a window commit before history JSON/KV work can occupy this completion turn.
    void afterPaint().result.then(async result=>{
      if(dependencies.current()!==entry||entry.queue!==queue||queue.itemAtOffset()?.awemeId!==id||paintCheckpoints.get(entry)!==revision)return;
      appLogger.i('DouyinTiming',`persistenceBegin committed=${result.committed}`);
      await queue.settled();
    }).catch(error=>{if(dependencies.current()===entry)if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));});
    const state=entry.queue.snapshot();
    if(state.item)douyinStock.consume(state.item.awemeId);
    startDouyinWindow(entry);
  };

  // A selected page queues current/+1/+2 bytes before its own decoder is ready.
  const startDouyinWindow=(entry:RouteEntry)=>{
    if(!entry.queue||dependencies.current()!==entry)return;
    const state=entry.queue.snapshot();
    // Promotion also consumes metadata. Refill before the six-frame ring reaches
    // the page boundary, then publish the added sources without moving selection.
    const queue=entry.queue,anchor=state.item?.awemeId,count=state.playlist.length,tail=state.playlist.at(-1)?.awemeId;
    void queue.fillAhead(16).then(()=>{
      if(dependencies.current()!==entry||entry.queue!==queue)return;
      const fresh=queue.snapshot();
      // A full bounded pager evicts its head on refill, so its length stays
      // unchanged. Publish the new tail before the next gesture needs it.
      if(fresh.item?.awemeId===anchor&&(fresh.playlist.length!==count||fresh.playlist.at(-1)?.awemeId!==tail))startDouyinWindow(entry);
    }).catch(()=>{});
    if(entry.playback?.immersive)douyinPreload.start(entry,state.playlist,state.item?.awemeId,'active',{
      isForeground:id=>dependencies.current()===entry&&entry.queue?.itemAtOffset()?.awemeId===id,
      async sourceRefreshed(id,previousUri,item,uri,headers){
        if(dependencies.current()!==entry||!entry.queue)return;
        entry.queue.refreshPrefetchItem(id,item);entry.player?.invalidatePrefetch?.(id);
        if(entry.queue.itemAtOffset()?.awemeId===id&&entry.playback?.url===previousUri){entry.playback={...entry.playback,url:uri,...douyinDecoderProfile(item),headers,previewOnly:false};dependencies.setPlayingSource(entry.playback);}
        await entry.queue.persist();
      },
      async rejectSource(binding){
        if(dependencies.current()!==entry)return false;
        if(entry.queue?.itemAtOffset()?.awemeId===binding.id){
          await recoverDouyinVideo(entry,false,0,{code:DOUYIN_RESOLUTION_LIMIT},binding.id,binding);
          return true;
        }
        return rejectDouyinAdjacent(entry,binding.id,binding.uri,binding.url);
      },
      async quarantine(id){
        if(dependencies.current()!==entry||!entry.queue?.quarantinePrefetch(id))return false;entry.player?.invalidatePrefetch?.(id);await entry.queue.persist();return true;},
    });
  };

  const douyinActions = (entry: RouteEntry) => {
    const item = entry.queue?.itemAtOffset();
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
      if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
    }
  };

  const reloadVideo=async(entry:RouteEntry,positionMs:number,stillCurrent:()=>boolean=()=>true,mode:DouyinReloadMode='feed')=>{
    const current=()=>dependencies.current()===entry&&stillCurrent();
    if(!entry.playback||!current())return;
    if(entry.retryPlayback){await entry.retryPlayback(positionMs,{manual:true,freshOnly:true,isCurrent:current});return;}
    const previous=entry.playback;
    let next:PlaybackSource;
    if(entry.queue){
      const item=entry.queue.itemAtOffset();
      if(!item)throw new Error('Missing Douyin playback item');
      const queue=entry.queue,authorization=douyinClient.playbackAuthorizationVersion();
      let queueGeneration=queue.playbackGeneration();
      const selected=()=>current()&&entry.playback===previous&&entry.queue===queue&&queue.itemAtOffset()?.awemeId===item.awemeId
        &&queue.playbackGeneration()===queueGeneration&&douyinClient.playbackAuthorizationVersion()===authorization;
      const previousItem=mode!=='current'&&previous.url?douyinPreload.sourceFor?.(previous.url):undefined;
      const previousUrls=previousItem?[previousItem.playUrl,...douyinPlaybackMirrors(previousItem)]:[previous.url??previous.videoUrl??''];
      if(mode==='current')await douyinPreload.invalidate(item.awemeId);
      if(!selected())return;
      const resolved=await (dependencies.network?.()??directNetworkWork).run(()=>reloadDouyinPlayback(douyinClient,item.awemeId,selected,item,mode,previousUrls)).catch(async error=>{
        if(mode!=='current'||douyinPlaybackFailure(error).code!==DOUYIN_RESOLUTION_LIMIT)throw error;
        if(selected())await recoverDouyinVideo(entry,false,0,error);
        return undefined;
      });
      if(!resolved||!selected())return;
      let url=resolved.item.playUrl;
      if(mode!=='current'){
        await douyinPreload.invalidate(item.awemeId);
        if(!selected())return;
        url=await douyinPreload.playbackResolved(resolved.item,resolved.headers,selected);
        if(!selected())return;
      }
      next=freshVideoSource(previous,{url,...douyinDecoderProfile(resolved.item),headers:resolved.headers},positionMs);
      if(mode!=='current')next.bypassCache=false;
      entry.queue.refreshPrefetchItem(item.awemeId,resolved.item);
      // This reload owns the metadata mutation. Continue guarding against later
      // pager changes while persistence yields, using our new generation.
      queueGeneration=queue.playbackGeneration();
      entry.queue.updateCurrentUrl(resolved.item.playUrl);
      await entry.queue.persist();
      if(!selected())return;
    }else if(entry.rssDouyinRecovery){
      const resolved=await entry.rssDouyinRecovery.reload(previous,current,mode==='detail');
      if(!resolved||!current())return;
      next=freshVideoSource(previous,resolved,positionMs);
    }else next=freshVideoSource(previous,{url:previous.url,videoUrl:previous.videoUrl,audioUrl:previous.audioUrl,headers:previous.headers},positionMs);
    if(!current())return;
    entry.playback=next;dependencies.setPlayingSource(next);dependencies.setError('');
    dependencies.onActivityStateChange?.();
  };

  const recoverRssDouyinVideo = async (entry: RouteEntry, manual = false,positionMs?:number,error?:unknown) => {
    if((error as {code?:string}|undefined)?.code===DOUYIN_RESOLUTION_LIMIT)return;
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
        if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
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
      if(!isNetworkRecoveryCancellation(error))dependencies.setError(String(error));
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
    videoLoading,
    openRssVideo,
    biliNavigate,
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
    deleteBuiltin,
  };
}
