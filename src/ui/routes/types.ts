import type { BiliPlaybackCheckpointController } from "../../bili/playback.ts";
import type { DouyinPlaybackQueue } from "../../douyin/playback-queue.ts";
import type { DouyinRssRecovery } from "../../douyin/rss-recovery.ts";
import type { Article } from "../service.ts";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinRoute } from "../douyin/index.tsx";
import type { PlaybackSource } from "../VideoPlayerScreen.tsx";
import type { ReaderBodyHandle } from "../ReaderBody.tsx";
import type {
  InformationPage,
  InformationSnapshot,
} from "../InformationScreens.tsx";
import type { VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { HttpExportMode } from "../../remote-input/exports.ts";

export type Page =
  | "debug-tools"
  | "debug-summary"
  | "add-rss"
  | "remote-input"
  | "log-upload"
  | "bluetooth-connection"
  | "phone-connection-unavailable"
  | "tts-config"
  | "reader-preview"
  | "phone-connection"
  | "account-status"
  | "speech-playback"
  | "settings-reader-presets"
  | "settings-llm-usage"
  | "settings-llm-preset"
  | "channel-detail"
  | "channel-settings"
  | "channel-share"
  | "reader-image"
  | "settings-auto-scroll"
  | "reader-scroll-controls"
  | "settings-speech"
  | "rss-actions"
  | "rss-share"
  | "bili"
  | "douyin"
  | "video"
  | "watch-later"
  | "home"
  | "profile"
  | "articles"
  | "saved"
  | "search"
  | "settings"
  | "settings-advanced"
  | "notes"
  | "note-detail"
  | "note-actions"
  | "recommendations"
  | "information"
  | "reader";

export type RouteEntry = {
  memory?: import("../../navigation/activity-navigation.ts").RouteMemory;
  articleId?: string;
  videoTarget?: import("../../navigation/activity-navigation.ts").VideoTarget;

  addUrl?: string;
  imageUrl?: string;
  imageFilePath?: string;
  reader?: ReaderBodyHandle;
  readerArticle?: Article;
  readerFromWatchLater?: boolean;
  page: Page;
  channelId?: string;
  biliRoute?: BiliRoute;
  douyinRoute?: DouyinRoute;
  playback?: PlaybackSource;
  checkpoint?: BiliPlaybackCheckpointController;
  retryPlayback?: (positionMs: number) => Promise<void>;
  queue?: DouyinPlaybackQueue;
  rssDouyinRecovery?: DouyinRssRecovery;
  douyinRecovering?: boolean;
  douyinFailures?: Set<string>;
  noteId?: string;
  informationPage?: InformationPage;
  informationSnapshot?: InformationSnapshot;
  informationSnapshotReader?: () => InformationSnapshot;
  exportMode?: HttpExportMode;
  phoneAbilityLabel?: string;
  returnRemoteUrl?: boolean;
  acousticRequest?: import("../../phoneconnection/external.ts").AcousticExternalRequest;
  unavailableMessage?: string;
  recommendationGroup?: string;
  list?: Pick<VirtualListHandle, "scroller">;
  disclosureList?: Pick<VirtualListHandle, "scroller">;
  internalBack?: () => boolean;
  player?: {
    onCrown: (delta: number) => boolean;
    canSwipeBack?: () => boolean;
  };
};

export type SetPage = (next: Page, data?: Partial<RouteEntry>) => void;
