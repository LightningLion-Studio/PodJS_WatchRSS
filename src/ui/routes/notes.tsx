import { Show } from "solid-js";
import { noteImageSource } from "../../notes/presentation.ts";
import { memoRepository } from "../../services.ts";
import {
  NoteActionsScreen,
  NoteDetailScreen,
  NotesListScreen,
} from "../NotesScreen.tsx";
import type { AppServices } from "../service.ts";
import type { Page, RouteEntry, SetPage } from "./types.ts";

type NoteDetailProps = Parameters<typeof NoteDetailScreen>[0];

interface NotesRoutesProps {
  entry: RouteEntry;
  onStateChange?:()=>void;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  services: AppServices;
  refreshKey: () => number;
  bumpRefreshKey: () => void;
  preset: () => NoteDetailProps["preset"];
  backgroundSnapshot: () => NoteDetailProps["backgroundSnapshot"];
  setPage: SetPage;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
}

export function NotesRoutes(props: NotesRoutesProps) {
  const finishEditing = () => {
    props.bumpRefreshKey();
    props.popPage(true);
  };

  return (
    <>
      <Show when={props.page() === "notes"}>
        <NotesListScreen
          width={props.width}
          height={props.height}
          repository={memoRepository}
          refreshKey={props.refreshKey()}
          onOpenNote={(noteId) => props.setPage("note-detail", { noteId })}
          onCreateNote={() => props.setPage("note-detail")}
          onOpenActions={(noteId) => props.setPage("note-actions", { noteId })}
          onError={props.setError}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "note-detail"}>
        <NoteDetailScreen
          width={props.width}
          height={props.height}
          repository={memoRepository}
          refreshKey={props.refreshKey()}
          noteId={props.entry.noteId}
          onNoteIdentity={id=>{props.entry.noteId=id;props.onStateChange?.();}}
          preset={props.preset()}
          backgroundSnapshot={props.backgroundSnapshot()}
          active={props.active()}
          onImage={(path) => {
            const source = noteImageSource(path);
            props.setPage("reader-image", {
              imageUrl: source.url,
              imageFilePath: source.filePath,
            });
          }}
          input={(title, value) => props.services.input(title, value)}
          onBack={finishEditing}
          onError={props.setError}
          ref={(value) => {
            props.entry.list = value.scroller
              ? { scroller: value.scroller }
              : undefined;
            props.entry.internalBack = value.goBack;
          }}
        />
      </Show>
      <Show when={props.page() === "note-actions" && props.entry.noteId}>
        <NoteActionsScreen
          width={props.width}
          height={props.height}
          repository={memoRepository}
          refreshKey={props.refreshKey()}
          noteId={props.entry.noteId!}
          onDone={finishEditing}
          onError={props.setError}
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.goBack;
          }}
        />
      </Show>
    </>
  );
}
