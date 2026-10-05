import type { ReaderPreset } from "../../reader/preset.ts";
import type { BrowserOrigin } from "../../browser/open.ts";
import { Show } from "solid-js";
import type { ShareHandler } from "../../sharing/policy.ts";
import {
  biliClient,
  douyinClient,
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
  preset: () => ReaderPreset;
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
  loginDouyin: () => Promise<void>;
  openUrl: (url: string, origin: BrowserOrigin) => Promise<void>;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
  recoverDouyinVideo: (entry: RouteEntry, manual?: boolean) => Promise<void>;
  recoverRssDouyinVideo: (entry: RouteEntry, manual?: boolean) => Promise<void>;
  douyinReady: (entry: RouteEntry) => void;
  douyinActions: (entry: RouteEntry) => void;
  changeDouyinVideo: (
    entry: RouteEntry,
    direction: "next" | "previous",
  ) => Promise<void>;
  prepareDouyinAdjacent:(entry:RouteEntry,direction:"next"|"previous")=>Promise<DouyinPreparedSource|undefined>;
  promoteDouyinAdjacent:(entry:RouteEntry,prepared:DouyinPreparedSource)=>Promise<boolean>;
  openHttpExport: (mode: HttpExportMode) => void;
  onDouyinLogoutSuccess: () => void;
}

export function MediaRoutes(props: MediaRoutesProps) {
  const updateBackground = (platform: "bili" | "douyin", value: boolean) => {
    props.saveMediaSetting(platform, "background-playback", value);
    if (platform === "bili") props.setBiliBackground(value);
    else props.setDouyinBackground(value);
  };

  return (
    <>
      <Show when={props.page() === "bili"}>
        <BiliScreen
          preset={props.preset()}
          active={props.active()}
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
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.page() === "douyin"}>
        <DouyinScreen
          preset={props.preset()}
          active={props.active()}
          onShare={props.share}
          width={props.width}
          height={props.height}
          route={props.entry.douyinRoute ?? { name: "entry" }}
          client={douyinClient}
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
      </Show>
      <Show when={props.page() === "video" && props.entry.playback}>
        <VideoPlayerScreen
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
          onProgress={(position, duration) =>
            void props.entry.checkpoint
              ?.onProgress(position, duration)
              .catch((error) => props.setError(String(error)))
          }
          onCheckpoint={(type, position, duration) => {
            if (type === "ready") props.douyinReady(props.entry);
            void props.entry.checkpoint
              ?.onCheckpoint(type, position, duration)
              .catch((error) => props.setError(String(error)));
          }}
          onPlaybackFailure={
            props.entry.queue
              ? () => void props.recoverDouyinVideo(props.entry)
              : props.entry.rssDouyinRecovery
                ? () => void props.recoverRssDouyinVideo(props.entry)
                : undefined
          }
          onRetry={
            props.entry.retryPlayback
              ? props.entry.retryPlayback
              : props.entry.queue
                ? () => props.recoverDouyinVideo(props.entry, true)
                : props.entry.rssDouyinRecovery
                  ? () => props.recoverRssDouyinVideo(props.entry, true)
                  : undefined
          }
          onActions={
            props.entry.queue
              ? () => props.douyinActions(props.entry)
              : undefined
          }
          onHeader={
            props.entry.queue
              ? () => void props.openDouyin({ name: "channel-info" })
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
              ? direction => props.prepareDouyinAdjacent(props.entry,direction)
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
