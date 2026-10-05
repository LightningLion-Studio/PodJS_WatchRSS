import { Show } from "solid-js";
import { biliVideoTarget, douyinVideoTarget } from "../../reader/media.ts";
import {
  SavedItemsScreen,
  type SavedDisplayItem,
} from "../SavedItemsScreen.tsx";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinRoute } from "../douyin/index.tsx";
import type { Article } from "../service.ts";
import type { Page, RouteEntry } from "./types.ts";
import type { HttpExportMode } from "../../remote-input/exports.ts";

interface SavedRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  items: () => SavedDisplayItem[];
  articles: () => Article[];
  loading: () => boolean;
  undoVisible: () => boolean;
  openArticle: (article: Article, fromWatchLater?: boolean) => Promise<void>;
  openBili: (route: BiliRoute) => Promise<void>;
  openDouyin: (route: DouyinRoute) => Promise<void>;
  remove: (item: SavedDisplayItem) => Promise<void>;
  undo: () => Promise<void>;
  reorder: (items: SavedDisplayItem[]) => Promise<void>;
  setError: (message: string) => void;
  openExport: (mode: HttpExportMode) => void;
}

export function SavedRoutes(props: SavedRoutesProps) {
  const openItem = (item: SavedDisplayItem) => {
    if (item.kind === "rss") {
      const article = props
        .articles()
        .find((value) => value.id === item.articleId);
      if (!article) return;

      const bili = article.link?.includes("/video/")
        ? biliVideoTarget(article.link)
        : null;
      const douyin = douyinVideoTarget(article.link);
      if (bili) {
        void props.openBili({ name: "detail", ...bili });
      } else if (douyin?.awemeId) {
        void props.openDouyin({ name: "detail", awemeId: douyin.awemeId });
      } else {
        void props.openArticle(article, props.page() === "watch-later");
      }
    } else if (item.awemeId) {
      void props.openDouyin({ name: "detail", awemeId: item.awemeId });
    }
  };

  return (
    <Show when={props.page() === "saved" || props.page() === "watch-later"}>
      <SavedItemsScreen
        width={props.width}
        height={props.height}
        active={props.active()}
        type={props.page() === "saved" ? "favorite" : "watchLater"}
        items={props.items()}
        loading={props.loading()}
        undoVisible={props.undoVisible()}
        onOpen={openItem}
        onRemove={(item) => void props.remove(item)}
        onUndo={() => void props.undo()}
        onReorder={(items) => void props.reorder(items)}
        onError={props.setError}
        onSync={() => props.openExport(props.page() === "saved" ? "favorite" : "watchLater")}
        ref={(value) => (props.entry.list = value)}
      />
    </Show>
  );
}
