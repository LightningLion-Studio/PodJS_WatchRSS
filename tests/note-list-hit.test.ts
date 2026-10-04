import { expect, test } from "bun:test";
import { NOTE_LIST_LAYOUT, noteAtLongPress } from "../src/ui/note-list-hit.ts";

test("note long press targets the scrolled row, excluding header, prompt and gaps", () => {
  const ids=["alpha","bravo","charlie"];
  const first=NOTE_LIST_LAYOUT.verticalPadding+NOTE_LIST_LAYOUT.headerHeight+NOTE_LIST_LAYOUT.gap+NOTE_LIST_LAYOUT.promptHeight+NOTE_LIST_LAYOUT.gap;
  expect(noteAtLongPress(ids,100,first-1,233,0)).toBeNull();
  expect(noteAtLongPress(ids,100,first,233,0)).toBe("alpha");
  expect(noteAtLongPress(ids,100,first+NOTE_LIST_LAYOUT.noteHeight-1,233,0)).toBe("alpha");
  expect(noteAtLongPress(ids,100,first+NOTE_LIST_LAYOUT.noteHeight,233,0)).toBeNull();
  expect(noteAtLongPress(ids,100,first+NOTE_LIST_LAYOUT.noteHeight+NOTE_LIST_LAYOUT.gap,233,0)).toBe("bravo");
  expect(noteAtLongPress(ids,100,20,233,0)).toBeNull();
  expect(noteAtLongPress(ids,100,100,233,0)).toBeNull();
  expect(noteAtLongPress(ids,100,153,233,0)).toBe("alpha");
  expect(noteAtLongPress(ids,100,237,233,0)).toBeNull();
  expect(noteAtLongPress(ids,100,153,233,92)).toBe("bravo");
  expect(noteAtLongPress(ids,17,153,233,0)).toBeNull();
  expect(noteAtLongPress(ids,215,153,233,0)).toBeNull();
});

test("note hit testing follows measured card heights instead of a fixed row step",()=>{
  const ids=["short","long","last"],heights=[69,107,88];
  const first=NOTE_LIST_LAYOUT.verticalPadding+NOTE_LIST_LAYOUT.headerHeight+NOTE_LIST_LAYOUT.gap+NOTE_LIST_LAYOUT.promptHeight+NOTE_LIST_LAYOUT.gap;
  expect(noteAtLongPress(ids,100,first+68,233,0,heights)).toBe("short");
  expect(noteAtLongPress(ids,100,first+69,233,0,heights)).toBeNull();
  expect(noteAtLongPress(ids,100,first+69+NOTE_LIST_LAYOUT.gap,233,0,heights)).toBe("long");
  expect(noteAtLongPress(ids,100,first+69+NOTE_LIST_LAYOUT.gap+106,233,0,heights)).toBe("long");
  expect(noteAtLongPress(ids,100,first+69+NOTE_LIST_LAYOUT.gap+107,233,0,heights)).toBeNull();
  expect(noteAtLongPress(ids,100,first+69+NOTE_LIST_LAYOUT.gap+107+NOTE_LIST_LAYOUT.gap,233,0,heights)).toBe("last");
});
