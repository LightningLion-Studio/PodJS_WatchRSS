import type { ReaderPreset } from "../../reader/preset.ts";
import type { BrowserOrigin } from "../../browser/open.ts";
import { Show, createRenderEffect, onCleanup } from "solid-js";
import { entryDisclosure } from "../entry-disclosure.ts";
import { PendingDisclosure } from "../PlatformNotice.tsx";
import type { ShareHandler } from "../../sharing/policy.ts";
import {
  biliClient,
  douyinClient,
  douyinPreload,
  douyinStock,
  loadLocalBiliDetail,
} from "../../media-services.ts";
import { BiliScreen, type BiliRoute } from "../bili/index.tsx";
import {
  DouyinScreen,
  type DouyinPlayRequest,
  type DouyinRoute,
} from "../douyin/index.tsx";
import {
  VideoPlayerScreen,
  type PlaybackSource,
} from "../VideoPlayerScreen.tsx";
import type { AppServices, Channel } from "../service.ts";
import type { Page, RouteEntry } from "./types.ts";
import type { HttpExportMode } from "../../remote-input/exports.ts";
import type { DouyinPreparedSource } from "../douyin/video-sessions.ts";

interface MediaRoutesProps {
  createBatteryTelemetry?:()=>import("@podjs/framework/telemetry").ActiveBatterySession;
  preset: () => ReaderPreset;
  readerKeepAwake?:()=>boolean;
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  round: boolean;
  backOffset: () => number;
  services: AppServices;
  channels: () => Channel[];
  playingSource: () => PlaybackSource | undefined;
  biliOriginal: () => boolean;
  douyinOriginal: () => boolean;
  biliBackground: () => boolean;
  douyinBackground: () => boolean;
  setBiliOriginal: (value: boolean) => Promise<void>;
  setDouyinOriginal: (value: boolean) => Promise<void>;
  setBiliBackground: (value: boolean) => void;
  setDouyinBackground: (value: boolean) => void;
  saveMediaSetting: (
    platform: "bili" | "douyin",
    key: "background-playback",
    value: boolean,
  ) => void;
  deleteBuiltin: (platform: "bili" | "douyin") => Promise<void>;
  share: ShareHandler;
  openBili: (route: BiliRoute) => Promise<void>;
  openDouyin: (route: DouyinRoute) => Promise<void>;
  playDouyin: (request: DouyinPlayRequest) => void;
  primeDouyinEntry?:(entry:RouteEntry,owner:unknown,items:import("../../douyin/types.ts").DouyinItem[],anchor:string|null,seq?:number)=>void;
  stopDouyinEntry?:(owner:unknown)=>void;
  loginDouyin: () => Promise<void>;
  openUrl: (url: string, origin: BrowserOrigin) => Promise<void>;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
  recoverDouyinVideo: (entry: RouteEntry, manual?: boolean, positionMs?:number, error?:unknown) => Promise<void>;
  recoverRssDouyinVideo: (entry: RouteEntry, manual?: boolean,positionMs?:number,error?:unknown) => Promise<void>;
  douyinReady: (entry: RouteEntry) => void;
  douyinActions: (entry: RouteEntry) => void;
  changeDouyinVideo: (
    entry: RouteEntry,
    direction: "next" | "previous",
  ) => Promise<void>;
  prepareDouyinAdjacent:(entry:RouteEntry,direction:"next"|"previous",distance?:1|2)=>Promise<DouyinPreparedSource|undefined>;
  promoteDouyinAdjacent:(entry:RouteEntry,prepared:DouyinPreparedSource)=>Promise<boolean>;
  openHttpExport: (mode: HttpExportMode) => void;
  onDouyinLogoutSuccess: () => void;
}

export function MediaRoutes(props: MediaRoutesProps) {
  const batteryTelemetry=props.createBatteryTelemetry?.();
  onCleanup(()=>{void props.entry.initialVideoPool?.releaseAll().catch(()=>{});void batteryTelemetry?.stop();douyinPreload.stop(props.entry);});
  createRenderEffect(()=>{if(!props.active())douyinPreload.stop(props.entry);});
  const updateBackground = (platform: "bili" | "douyin", value: boolean) => {
    props.saveMediaSetting(platform, "background-playback", value);
    if (platform === "bili") props.setBiliBackground(value);
    else props.setDouyinBackground(value);
  };
  // Native Bili/Douyin entry Activities block on the first-use or platform confirmation.
  const disclosure = (page: "bili" | "douyin") => {
    const route = page === "bili" ? props.entry.biliRoute : props.entry.douyinRoute;
    return (route?.name ?? "entry") === "entry" ? entryDisclosure(props.entry, { page, name: "entry" }) : undefined;
  };
  const blocked = (page: "bili" | "douyin") => !!disclosure(page)?.pending();
  // A blocking dialog swallows Back, like native AlertDialog with an empty onDismissRequest.
  createRenderEffect(() => {
    if (props.page() === "douyin") props.entry.internalBack = () => blocked("douyin");
  });

  return (
    <>
      <Show when={props.page() === "bili"}>
        <BiliScreen
          preset={props.preset()}
          active={props.active() && !blocked("bili")}
          loadLocalDetail={loadLocalBiliDetail}
          onShare={props.share}
          width={props.width}
          height={props.height}
          route={props.entry.biliRoute ?? { name: "entry" }}
          client={biliClient}
          settings={{
            showOriginalContent: true,
            originalContentEnabled: props.biliOriginal(),
            onOriginalContentChange: (value) =>
              void props.setBiliOriginal(value),
            showContinuePlaybackInBackground: true,
            continuePlaybackInBackgroundEnabled: props.biliBackground(),
            onContinuePlaybackInBackgroundChange: (value) =>
              updateBackground("bili", value),
            deleteEnabled: props
              .channels()
              .some((item) => item.url === "builtin:bili"),
            onDeleteChannel: () => props.deleteBuiltin("bili"),
            onSyncWatchRecords: () => props.openHttpExport("bili"),
          }}
          onNavigate={(route) =>
            void props
              .openBili(route)
              .catch((error) => props.setError(String(error)))
          }
          onBack={() => props.popPage()}
          input={(title, value, options) => props.services.input(title, value, options)}
          inputRecovery={props.services.inputRecovery}
          onError={props.setError}
          onOpenUrl={(url) => void props.openUrl(url, "bili")}
          ref={(value) => {
            if (value.scroller) {
              props.entry.list = { scroller: value.scroller };
            }
            props.entry.internalBack = () => blocked("bili") || (value.onRootBack?.() ?? false);
          }}
        />
        <PendingDisclosure width={props.width} height={props.height} pending={() => props.active() ? disclosure("bili")?.pending() : undefined} onConfirm={() => disclosure("bili")?.confirm()} ref={value => { props.entry.disclosureList = value; }} />
      </Show>
      <Show when={props.page() === "douyin"}>
        <DouyinScreen
          preset={props.preset()}
          readerKeepAwake={props.readerKeepAwake?.()}
          active={props.active() && !blocked("douyin")}
          onShare={props.share}
          width={props.width}
          height={props.height}
          route={props.entry.douyinRoute ?? { name: "entry" }}
          client={douyinClient}
          restoreStock={()=>douyinStock.restore()}
          onPreloadWindow={(owner,items,anchor,seq)=>{douyinPreload.start(owner,items,anchor??undefined,'entry');void props.primeDouyinEntry?.(props.entry,owner,items,anchor,seq);}}
          onPreloadStop={owner=>{douyinPreload.stop(owner);props.stopDouyinEntry?.(owner);}}
          settings={{
            originalContentEnabled: props.douyinOriginal(),
            onOriginalContentChange: (value) =>
              void props.setDouyinOriginal(value),
            continuePlaybackInBackgroundEnabled: props.douyinBackground(),
            onContinuePlaybackInBackgroundChange: (value) =>
              updateBackground("douyin", value),
            onDeleteChannel: () => props.deleteBuiltin("douyin"),
          }}
          onNavigate={props.openDouyin}
          onBack={() => props.popPage()}
          onPlay={props.playDouyin}
          onRequestQrLogin={() => void props.loginDouyin()}
          input={(title, value) => props.services.input(title, value)}
          onUnsupported={props.setError}
          onLogoutSuccess={props.onDouyinLogoutSuccess}
          ref={(value) => (props.entry.list = value)}
        />
        <PendingDisclosure width={props.width} height={props.height} pending={() => props.active() ? disclosure("douyin")?.pending() : undefined} onConfirm={() => disclosure("douyin")?.confirm()} ref={value => { props.entry.disclosureList = value; }} />
      </Show>
      <Show when={props.page() === "video" && props.entry.playback}>
        <VideoPlayerScreen
          initialPool={props.entry.initialVideoPool}
          onAdjacentPoster={direction=>{const state=props.entry.queue?.snapshot();return state?.playlist[state.index+(direction==='next'?1:-1)]?.coverUrl;}}
          onBluetoothAllowed={value=>douyinPreload.allowBluetooth(value,props.entry)}
          onPlaybackActiveChanged={(source,active)=>{void batteryTelemetry?.update(source,active);}}
          width={props.width}
          height={props.height}
          source={
            props.active()
              ? (props.playingSource() ?? props.entry.playback!)
              : props.entry.playback!
          }
          active={props.active()}
          offset={props.active() ? props.backOffset() : 0}
          round={props.round}
          onOpenWeb={() =>
            void props.openUrl(
              (props.playingSource() ?? props.entry.playback)?.webUrl ?? "",
              (props.playingSource() ?? props.entry.playback)?.platform ?? "rss",
            )
          }
          onProgress={(position, duration) => {
            // A preview prefix must not overwrite full-video resume/history state.
            if (props.entry.playback?.url?.startsWith("managed-cache/bili-preview/")) return;
            void props.entry.checkpoint
              ?.onProgress(position, duration)
              .catch((error) => props.setError(String(error)));
          }}
          onFirstFrame={() => props.douyinReady(props.entry)}
          onCheckpoint={(type, position, duration) => {
            if (props.entry.playback?.url?.startsWith("managed-cache/bili-preview/")) return;
            void props.entry.checkpoint
              ?.onCheckpoint(type, position, duration)
              .catch((error) => props.setError(String(error)));
          }}
          onPlaybackFailure={
            props.entry.queue
              ? (position,error) => props.recoverDouyinVideo(props.entry,false,position,error)
              : props.entry.rssDouyinRecovery
                ? (position,error) => void props.recoverRssDouyinVideo(props.entry,false,position,error)
                : props.entry.playback?.platform === "bili" && props.entry.retryPlayback
                  ? (position,error) => void props.entry.retryPlayback!(position,{error}).catch(error => props.setError(String(error)))
                  : undefined
          }
          onRetry={
            props.entry.retryPlayback
              ? position => props.entry.retryPlayback!(position, {manual:true})
              : props.entry.queue
                ? position => props.recoverDouyinVideo(props.entry, true,position)
                : props.entry.rssDouyinRecovery
                  ? position => props.recoverRssDouyinVideo(props.entry, true,position)
                  : undefined
          }
          onActions={
            props.entry.queue
              ? () => props.douyinActions(props.entry)
              : undefined
          }
          onNext={
            props.entry.queue
              ? () => props.changeDouyinVideo(props.entry, "next")
              : undefined
          }
          onPrevious={
            props.entry.queue
              ? () => props.changeDouyinVideo(props.entry, "previous")
              : undefined
          }
          onPrepareAdjacent={
            props.entry.queue
              ? (direction,distance) => props.prepareDouyinAdjacent(props.entry,direction,distance)
              : undefined
          }
          onPromoteAdjacent={
            props.entry.queue
              ? prepared => props.promoteDouyinAdjacent(props.entry,prepared)
              : undefined
          }
          ref={(handle) => (props.entry.player = handle)}
        />
      </Show>
    </>
  );
}
