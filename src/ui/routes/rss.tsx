import { Show } from "solid-js";
import {
  CHANNEL_SHARE_QR_HINT,
  type ShareHandler,
} from "../../sharing/policy.ts";
import { wireFields } from "../../sync/article-batches.ts";
import { AddRssScreen } from "../AddRssScreen.tsx";
import {
  ChannelDetailScreen,
  ChannelSettingsScreen,
} from "../ChannelScreens.tsx";
import { RssActionsScreen, RssFeedScreen } from "../RssScreens.tsx";
import { RssSearchScreen } from "../RssSearchScreen.tsx";
import { ShareQrScreen } from "../ShareQrScreen.tsx";
import { DETAIL_SHARE_QR_WIDTH_RATIO } from "../share-qr-layout.ts";
import type { AppServices, Article, Channel } from "../service.ts";
import type { Page, RouteEntry, SetPage } from "./types.ts";

type ChannelAction = (
  id: string,
  action:
    | "original"
    | "background"
    | "move"
    | "pin"
    | "read"
    | "delete"
    | "clear",
) => Promise<void>;

interface RssRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  services: AppServices;
  channels: () => Channel[];
  articles: () => Article[];
  article: () => Article | null;
  query: () => string;
  searchResults: () => Article[];
  searchLoading: () => boolean;
  busy: () => boolean;
  feedLoadingMore: () => boolean;
  feedHasMore: () => boolean;
  originalModes: () => Record<string, boolean>;
  channelPlayback: () => Record<
    string,
    { hasPlayableMedia: boolean; continuePlaybackInBackground: boolean }
  >;
  systemShareEnabled: () => boolean;
  setPage: SetPage;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
  openAddedChannel: (channel: Channel) => Promise<void>;
  searchChannelArticles: (channelId: string, keyword: string) => Promise<void>;
  updateSearchKeyword: (channelId: string, keyword: string) => void;
  openArticle: (article: Article) => Promise<void>;
  openArticleActions: (article: Article) => Promise<void>;
  openChannelSettings: (channelId: string) => Promise<void>;
  searchChannel: (channelId: string) => void;
  channelAction: ChannelAction;
  share: ShareHandler;
  toggleFeedSave: (
    article: Article,
    type: "favorite" | "watchLater",
  ) => Promise<void>;
  refresh: () => Promise<void>;
  loadMoreFeedArticles: () => void;
  deleteArticle: () => Promise<void>;
  saveArticleState: (
    type: "favorite" | "watchLater",
    saved: boolean,
    navigateBack?: boolean,
  ) => Promise<void>;
}

export function RssRoutes(props: RssRoutesProps) {
  const channel = () =>
    props.channels().find((item) => item.id === props.entry.channelId);

  return (
    <>
      <Show when={props.page() === "add-rss"}>
        <AddRssScreen
          width={props.width}
          height={props.height}
          active={props.active()}
          initialUrl={props.entry.addUrl ?? ""}
          preview={props.services.previewChannel}
          confirm={props.services.confirmAddChannel}
          input={props.services.input}
          openInlineInput={props.services.openInlineInput}
          onAdded={(value) =>
            void props
              .openAddedChannel(value)
              .catch((error) => props.setError(String(error)))
          }
          onExisting={(value) =>
            void props
              .openAddedChannel(value)
              .catch((error) => props.setError(String(error)))
          }
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.page() === "search"}>
        <RssSearchScreen
          width={props.width}
          height={props.height}
          active={props.active()}
          keyword={props.query()}
          results={props.searchResults()}
          loading={props.searchLoading()}
          onInput={() => {
            void props.services
              .input("搜索文章", props.query())
              .then((value) => {
                if (value !== null && props.entry.channelId) {
                  void props.searchChannelArticles(
                    props.entry.channelId,
                    value,
                  );
                }
              })
              .catch((error) => props.setError(String(error)));
          }}
          onKeywordChange={(value) => {
            if (props.entry.channelId) {
              props.updateSearchKeyword(props.entry.channelId, value);
            }
          }}
          openInlineInput={props.services.openInlineInput}
          onOpen={(value) => void props.openArticle(value)}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show
        when={
          ["channel-detail", "channel-settings", "channel-share"].includes(
            props.page(),
          ) && channel()
        }
      >
        {(selected) => (
          <>
            <Show when={props.page() === "channel-detail"}>
              <ChannelDetailScreen
                width={props.width}
                height={props.height}
                channel={selected()}
                busy={props.busy()}
                onSettings={() => void props.openChannelSettings(selected().id)}
                onSearch={() => props.searchChannel(selected().id)}
                onShare={() =>
                  props.share(
                    {
                      origin: "channel",
                      title: selected().title,
                      link: selected().url,
                    },
                    () =>
                      props.setPage("channel-share", {
                        channelId: selected().id,
                      }),
                  )
                }
                onMarkRead={() =>
                  void props.channelAction(selected().id, "read")
                }
                ref={(value) => (props.entry.list = value)}
              />
            </Show>
            <Show when={props.page() === "channel-settings"}>
              <ChannelSettingsScreen
                width={props.width}
                height={props.height}
                channel={selected()}
                busy={props.busy()}
                original={props.originalModes()[selected().id] ?? false}
                hasPlayableMedia={
                  props.channelPlayback()[selected().id]?.hasPlayableMedia ??
                  false
                }
                background={
                  props.channelPlayback()[selected().id]
                    ?.continuePlaybackInBackground ?? false
                }
                onBackground={() =>
                  void props.channelAction(selected().id, "background")
                }
                onOriginal={() =>
                  void props.channelAction(selected().id, "original")
                }
                onClear={() => props.channelAction(selected().id, "clear")}
                onDelete={() =>
                  void props.channelAction(selected().id, "delete")
                }
                ref={(value) => (props.entry.list = value)}
              />
            </Show>
            <Show when={props.page() === "channel-share"}>
              <ShareQrScreen
                width={props.width}
                height={props.height}
                title={selected().title}
                url={selected().url}
                topHint={CHANNEL_SHARE_QR_HINT}
                onClose={() => props.popPage()}
                onError={props.setError}
              />
            </Show>
          </>
        )}
      </Show>
      <Show when={props.page() === "articles"}>
        <RssFeedScreen
          width={props.width}
          height={props.height}
          active={props.active()}
          originalEnabled={channel()?.useOriginalContent}
          onOriginalPaused={(paused) => {
            if (props.entry.channelId) {
              props.services.setOriginalUpdatesPaused(
                props.entry.channelId,
                paused,
              );
            }
          }}
          onOriginalContents={(ids) => {
            if (props.entry.channelId) {
              void props.services
                .requestOriginalContents(props.entry.channelId, ids)
                .catch(() => {});
            }
          }}
          title={channel()?.title ?? "文章"}
          onInfo={() => {
            if (props.entry.channelId) {
              props.setPage("channel-detail", {
                channelId: props.entry.channelId,
              });
            }
          }}
          items={props.articles()}
          refreshing={props.busy()}
          loadingMore={props.feedLoadingMore()}
          canNext={props.feedHasMore()}
          onOpen={(value) => void props.openArticle(value)}
          onActions={(value) => void props.openArticleActions(value)}
          onFavorite={(value) => void props.toggleFeedSave(value, "favorite")}
          onWatchLater={(value) =>
            void props.toggleFeedSave(value, "watchLater")
          }
          onRefresh={() => void props.refresh()}
          onNext={props.loadMoreFeedArticles}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "rss-actions" && props.article()}>
        {(selected) => (
          <RssActionsScreen
            width={props.width}
            height={props.height}
            article={selected()}
            channelUrl={
              props.channels().find((item) => item.id === selected().channelId)
                ?.url
            }
            onDelete={() => void props.deleteArticle()}
            systemShare={props.systemShareEnabled()}
            busy={props.busy()}
            onBack={() => props.popPage()}
            onShare={() =>
              props.share(
                {
                  origin: "detail",
                  title: wireFields.trim(selected().title),
                  link: wireFields.trim(selected().link ?? ""),
                },
                () => props.setPage("rss-share"),
              )
            }
            onSave={(type, saved) => void props.saveArticleState(type, saved)}
            ref={(value) => {
              props.entry.list = value;
              props.entry.internalBack = value.goBack;
            }}
          />
        )}
      </Show>
      <Show when={props.page() === "rss-share" && props.article()}>
        {(selected) => (
          <ShareQrScreen
            width={props.width}
            height={props.height}
            title={selected().title}
            url={selected().link ?? ""}
            qrWidthRatio={DETAIL_SHARE_QR_WIDTH_RATIO}
            onClose={() => props.popPage()}
            onError={props.setError}
          />
        )}
      </Show>
    </>
  );
}
