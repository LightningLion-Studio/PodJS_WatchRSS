import { kv } from "@podjs/framework/watch";
import type { NotesHomePlacement } from "./home-model.ts";

const ORDER_KEY = "watchrss.home.notes-sort-order";
const PINNED_KEY = "watchrss.home.notes-pinned";

/** Mirrors native HomeEntryPlacementStore for the movable notes home entry. */
export class HomeEntryPlacementStore {
  constructor(private readonly now = Date.now) {}

  read(): NotesHomePlacement {
    let sortOrder = Number(kv.get<number>(ORDER_KEY));
    if (!Number.isSafeInteger(sortOrder) || sortOrder <= 0) {
      sortOrder = this.now();
      kv.set(ORDER_KEY, sortOrder);
    }
    return {sortOrder, isPinned: kv.get<boolean>(PINNED_KEY) === true};
  }

  moveNotesToTop(): NotesHomePlacement {
    kv.set(ORDER_KEY, this.now());
    return this.read();
  }

  setNotesPinned(pinned: boolean): NotesHomePlacement {
    kv.set(PINNED_KEY, pinned);
    if (pinned) kv.set(ORDER_KEY, this.now());
    return this.read();
  }
}
