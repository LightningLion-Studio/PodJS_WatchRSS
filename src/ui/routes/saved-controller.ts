import { batch, createSignal, onCleanup, type Setter } from "solid-js";
import { delay } from "@podjs/framework/services";
import type { SavedDisplayItem } from "../SavedItemsScreen.tsx";
import type { AppServices, Article, ArticleQuery } from "../service.ts";
import type { RouteEntry } from "./types.ts";

interface SavedControllerDependencies {
  services: AppServices;
  current: () => RouteEntry;
  setArticles: Setter<Article[]>;
  setLoading: Setter<boolean>;
  setError: Setter<string>;
  setCurrentQuery: (query: ArticleQuery) => void;
}

export function createSavedRouteController(
  dependencies: SavedControllerDependencies,
) {
  const [savedEntries, setSavedEntries] = createSignal<SavedDisplayItem[]>([]);
  const [savedUndo, setSavedUndo] = createSignal<{
    item: SavedDisplayItem;
    type: "favorite" | "watchLater";
  } | null>(null);
  let savedUndoTimer: ReturnType<typeof delay> | null = null;
  let savedUndoVersion = 0;
  let savedLoadVersion = 0;

  onCleanup(() => savedUndoTimer?.cancel());

  async function loadSaved(type: "favorite" | "watchLater") {
    const version = ++savedLoadVersion;
    dependencies.setLoading(true);
    dependencies.setError("");
    try {
      const rss: Article[] = [];
      for (let offset = 0; ; offset += 24) {
        const part = await dependencies.services.listArticles({
          saveType: type,
          offset,
          pageSize: 24,
        });
        rss.push(...part);
        if (part.length < 24) break;
      }
      const entries: SavedDisplayItem[] = rss.map((article) => ({
        key: `rss:${article.id}`,
        kind: "rss",
        articleId: article.id,
        title: article.title,
        summary: article.excerpt ?? "暂无摘要",
        channelTitle: article.channelTitle ?? "RSS",
        savedAt: article.savedAt ?? 0,
        sortOrder: article.saveSortOrder ?? -(article.savedAt ?? 0),
      }));
      if (
        version === savedLoadVersion &&
        dependencies.current().page ===
          (type === "favorite" ? "saved" : "watch-later")
      ) {
        batch(() => {
          dependencies.setArticles(rss);
          setSavedEntries(entries);
          dependencies.setCurrentQuery({ saveType: type });
        });
      }
    } catch (error) {
      if (version === savedLoadVersion) {
        dependencies.setError(String(error));
      }
    } finally {
      if (version === savedLoadVersion) dependencies.setLoading(false);
    }
  }

  function clearSavedUndo() {
    savedUndoVersion++;
    savedUndoTimer?.cancel();
    savedUndoTimer = null;
    setSavedUndo(null);
  }

  async function removeSaved(item: SavedDisplayItem) {
    const type =
      dependencies.current().page === "saved" ? "favorite" : "watchLater";
    try {
      await dependencies.services.setSaveState(item.articleId!, type, false);
      clearSavedUndo();
      setSavedUndo({ item, type });
      const version = savedUndoVersion;
      savedUndoTimer = delay(3000);
      void savedUndoTimer.result.then(
        () => {
          if (savedUndoVersion === version) setSavedUndo(null);
        },
        () => {},
      );
      setSavedEntries((entries) =>
        entries.filter((entry) => entry.key !== item.key),
      );
      dependencies.setArticles((items) =>
        items.filter((article) => article.id !== item.articleId),
      );
    } catch (error) {
      dependencies.setError(String(error));
    }
  }

  async function undoSaved() {
    const undo = savedUndo();
    if (!undo) return;
    clearSavedUndo();
    try {
      await dependencies.services.setSaveState(
        undo.item.articleId!,
        undo.type,
        true,
      );
      await loadSaved(undo.type);
    } catch (error) {
      dependencies.setError(String(error));
    }
  }

  async function reorderSaved(items: SavedDisplayItem[]) {
    const type =
      dependencies.current().page === "saved" ? "favorite" : "watchLater";
    try {
      setSavedEntries(items);
      await dependencies.services.reorderSavedArticles(
        type,
        items.map((item) => item.articleId!),
      );
    } catch (error) {
      dependencies.setError(String(error));
      await loadSaved(type);
    }
  }

  return {
    savedEntries,
    savedUndo,
    clearSavedUndo,
    loadSaved,
    removeSaved,
    undoSaved,
    reorderSaved,
  };
}
