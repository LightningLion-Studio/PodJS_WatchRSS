import { Show } from "solid-js";
import { resolveUrl } from "../../core/parser.ts";
import type {
  SpeechPlayback,
  SpeechPlaybackState,
} from "../../reader/speech-playback.ts";
import type { ShareHandler } from "../../sharing/policy.ts";
import type { SettingsState } from "../../settings/index.ts";
import { ImagePreviewScreen } from "../ImagePreviewScreen.tsx";
import { ReaderPreviewScreen } from "../ReaderPreviewScreen.tsx";
import { ReaderScreen } from "../ReaderScreen.tsx";
import { SpeechPlaybackScreen } from "../SpeechPlaybackScreen.tsx";
import type { BackMotion } from "@podjs/framework/navigation";
import type { AppServices, Article } from "../service.ts";
import type { Page, RouteEntry, SetPage } from "./types.ts";

type ReaderProps = Parameters<typeof ReaderScreen>[0];
type ReaderPreviewProps = Parameters<typeof ReaderPreviewScreen>[0];

interface ReaderRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  density: number;
  stack: () => RouteEntry[];
  motion: BackMotion;
  setBackOffset: (value: number) => void;
  services: AppServices;
  settings: () => SettingsState;
  busy: () => boolean;
  speechState: () => SpeechPlaybackState | undefined;
  speechPlayback: SpeechPlayback;
  previewState: () => ReaderPreviewProps["state"] | null | undefined;
  preset: () => ReaderProps["preset"];
  lineHeight: () => number;
  article: () => Article | null;
  setArticle: (article: Article) => void;
  openArticle: (article: Article) => Promise<void>;
  openNovelChapter: (article: Article,pageMode:boolean) => Promise<void>;
  setPage: SetPage;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
  saveArticleState: (
    type: "favorite" | "watchLater",
    saved: boolean,
    navigateBack?: boolean,
  ) => Promise<void>;
  share: ShareHandler;
  toast: (message: string) => Promise<unknown>;
  openRssVideo: (article: Article, url: string) => Promise<void>;
}

export function ReaderRoutes(props: ReaderRoutesProps) {
  const speechReturnsToArticle = () => {
    const previous = props.stack()[props.stack().indexOf(props.entry) - 1];
    const currentArticle = props.speechState()?.article;
    return (
      previous?.page === "reader" &&
      !!currentArticle &&
      previous.readerArticle?.id === currentArticle.id
    );
  };

  const openCurrentSpeechArticle = () => {
    if (speechReturnsToArticle()) {
      props.popPage();
      return;
    }
    const currentArticle = props.speechState()?.article;
    if (currentArticle) void props.openArticle(currentArticle);
  };

  return (
    <>
      <Show when={props.page() === "reader-image" && props.entry.imageUrl}>
        <ImagePreviewScreen
          url={props.entry.imageUrl!}
          filePath={props.entry.imageFilePath}
          width={props.width}
          height={props.height}
          density={props.density}
          active={props.active()}
          onExit={() => props.popPage()}
          onError={props.setError}
          onBackGesture={(phase, dx, velocity) => {
            if (phase === "start") {
              props.motion.begin(dx);
              props.setBackOffset(props.motion.offset);
            } else if (phase === "move") {
              props.motion.move(dx);
              props.setBackOffset(props.motion.offset);
            } else if (props.motion.phase === "dragging") {
              props.motion.release(velocity, Date.now(), phase === "cancel");
            }
          }}
        />
      </Show>
      <Show when={props.page() === "speech-playback"}>
        <SpeechPlaybackScreen
          volumeEnabled={props.settings().mediaVolumeControl}
          volumeGuard={props.settings().mediaVolumeGuard}
          width={props.width}
          height={props.height}
          active={props.active()}
          state={props.speechState() ?? props.speechPlayback.state}
          onToggle={() => void props.speechPlayback.toggle()}
          onPrevious={() => void props.speechPlayback.previous()}
          onNext={() => void props.speechPlayback.next()}
          onStop={() => {
            void props.speechPlayback.stop();
            props.popPage();
          }}
          onAutoAdvance={() => props.speechPlayback.toggleAutoAdvance()}
          onRate={(step) => void props.speechPlayback.changeRate(step)}
          currentArticleActionText={
            speechReturnsToArticle() ? "返回文章" : "查看当前文章"
          }
          onOpenCurrentArticle={openCurrentSpeechArticle}
        />
      </Show>
      <Show when={props.page() === "reader-preview" && props.previewState()}>
        {(state) => (
          <ReaderPreviewScreen
            state={state()}
            width={props.width}
            height={props.height}
            active={props.active() && props.motion.phase === "idle"}
            ref={(value) => {
              props.entry.list = value;
            }}
          />
        )}
      </Show>
      <Show when={props.page() === "reader" && props.entry.readerArticle}>
        {(rss) => (
          <ReaderScreen
            initialNovelPageMode={props.entry.novelPageMode}
            onOpenChapter={props.openNovelChapter}
            onBackHandler={handler=>{props.entry.internalBack=handler;}}
            mediaCacheMode={props.settings().mediaCacheMode}
            highlight={props.speechState()?.highlight}
            llmEnabled={props.settings().llmEnabled}
            llmAutoSummarize={props.settings().llmAutoSummarize}
            llmPromptPreset={props.settings().llmPromptPreset}
            llmShowTokenUsage={props.settings().llmShowTokenUsage}
            article={rss()}
            services={props.services}
            width={props.width}
            height={props.height}
            preset={props.preset()}
            fontSize={props.preset().body.fontSizeSp}
            lineHeight={props.lineHeight()}
            active={props.active() && props.motion.phase === "idle"}
            autoStart={props.settings().readerAutoStart}
            keepAwake={props.settings().readerKeepAwake}
            speed={props.settings().readerScrollSpeed}
            favorite={
              (props.article()?.id === rss().id ? props.article() : rss())
                ?.saved ?? false
            }
            speaking={
              props.speechState()?.playing === true &&
              props.speechState()?.article?.id === rss().id
            }
            busy={props.busy()}
            onFavorite={() => {
              const selected =
                props.article()?.id === rss().id ? props.article()! : rss();
              props.setArticle(selected);
              void props.saveArticleState("favorite", !selected.saved, false);
            }}
            onShare={() => {
              const selected =
                props.article()?.id === rss().id ? props.article()! : rss();
              props.share(
                {
                  origin: "detail",
                  title: selected.title,
                  link: selected.link,
                },
                () => {
                  props.setArticle(selected);
                  props.setPage("rss-share");
                },
              );
            }}
            onSpeak={(article) => {
              void props.speechPlayback.start(article);
              void props.toast("已开始朗读，长按文章可打开朗读页面");
            }}
            onSpeechControls={(article, anchor) => {
              if (
                props.speechState()?.phase === "idle" ||
                !props.speechState() ||
                props.speechState()?.article?.id !== article.id
              ) {
                void props.speechPlayback.start(
                  article,
                  props.speechPlayback.state.rate,
                  anchor,
                );
              }
              props.setPage("speech-playback");
            }}
            onMedia={(article, block) => {
              if (block.type === "video") {
                void props
                  .openRssVideo(article, block.url)
                  .catch((error) => props.setError(String(error)));
              } else {
                props.setPage("reader-image", {
                  imageUrl: resolveUrl(block.url, article.link) ?? block.url,
                  imageFilePath: article.offlineMedia?.[block.url],
                });
              }
            }}
            onControls={(reader) =>
              props.setPage("reader-scroll-controls", { reader })
            }
            onError={props.setError}
            ref={(value) => {
              props.entry.list = value;
              props.entry.reader = value;
            }}
          />
        )}
      </Show>
    </>
  );
}
