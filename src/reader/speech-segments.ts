import type { Article } from "../ui/service.ts";
import { parseContent } from "./content.ts";
import type { ContentBlock } from "./content.ts";
import { rowAtOffset, type ContentLayout, type ReaderRow } from "./content-layout.ts";

export interface SpeechSegment {
  text: string;
  sourceOffsets: number[];
  isTitle: boolean;
  contentBlockIndex?: number;
  importedChunkIndex?: number;
}
export interface SpeechAnchor {
  contentBlockIndex?: number; contentCharOffset?: number;
  importedChunkIndex?: number; importedCharOffset?: number;
}

/** Convert the normalized layout coordinate back to the block's raw UTF-16 text. */
function sourceCharOffset(row: ReaderRow, blocks: readonly ContentBlock[], inRow = 0): number {
  if (row.sourceStart !== undefined) return row.sourceStart + inRow;
  let base = 0;
  for (let index = 0; index < row.blockIndex; index++) { const block = blocks[index]!; if (block.type === "text") base += block.text.replace(/\r\n?/g, "\n").length + 1; }
  const block = blocks[row.blockIndex]!;
  let raw = 0, normalized = 0;
  if (block.type === "text") while (raw < block.text.length && normalized < row.character - base + inRow) { if (block.text[raw] === "\r" && block.text[raw + 1] === "\n") raw++; raw++; normalized++; }
  return raw;
}

export function pressedSpeechCharOffset(text: string, offset: number): number {
  let index = Math.max(0, Math.min(text.length, Math.trunc(offset) || 0));
  while (index < text.length && whitespace.test(text[index]!)) index++;
  return index;
}

export function boundarySpeechCharOffset(text: string, offset: number): number {
  const start = Math.max(0, Math.min(text.length, Math.trunc(offset) || 0));
  for (let index = start; index < text.length; index++) if ("，,。.;；！!？?".includes(text[index]!)) return pressedSpeechCharOffset(text, index + 1);
  return start;
}

/** Native fallback for long presses outside a text layout: next boundary in visible text. */
export function visibleSpeechAnchor(layout: ContentLayout, blocks: readonly ContentBlock[], offset: number, headerHeight: number): SpeechAnchor | undefined {
  const row = layout.rows.find(row => row.kind === "text" && row.top + row.height > offset - headerHeight);
  if (!row) return undefined;
  const block = blocks[row.blockIndex]!;
  if (block.type !== "text") return undefined;
  return { contentBlockIndex: row.blockIndex, contentCharOffset: boundarySpeechCharOffset(block.text, sourceCharOffset(row, blocks)) };
}

/** Coordinates are relative to the reader viewport, including its horizontal padding.
 * Uses the same measured advances, tracking and scale as the drawn row. */
export function pressedSpeechAnchor(layout: ContentLayout, blocks: readonly ContentBlock[], x: number, y: number, offset: number, headerHeight: number, width: number, measure: (text: string, slot: number) => number, padding = 14, carets?: ReadonlyMap<ReaderRow,readonly number[]>): SpeechAnchor | undefined {
  const contentY = y + offset - headerHeight;
  if (contentY < 0) return undefined;
  const row = layout.rows[rowAtOffset(layout.rows, contentY)];
  if (!row || row.kind !== "text" || contentY >= row.top + row.height || contentY < row.top + row.gap) return visibleSpeechAnchor(layout, blocks, offset, headerHeight);
  const block = blocks[row.blockIndex]!;
  if (block.type !== "text") return undefined;
  const nativeCarets=carets?.get(row);
  if(nativeCarets?.length===row.text.length+1){
    const touch=x-padding;let closest=0,distance=Infinity,index=0;
    for(const character of row.text){const next=Math.abs(touch-nativeCarets[index]!);if(next<distance){distance=next;closest=index;}index+=character.length;}
    if(Math.abs(touch-nativeCarets[row.text.length]!)<distance)closest=row.text.length;
    return {contentBlockIndex:row.blockIndex,contentCharOffset:pressedSpeechCharOffset(block.text,sourceCharOffset(row,blocks,closest))};
  }
  const advance = (text: string) => measure(text, row.fontSlot) * row.scale + Math.max(0, Array.from(text).length - 1) * (row.tracking ?? 0);
  const left = padding + (row.textAlign === 1 ? (width - 2 * padding - advance(row.text)) / 2 : 0);
  const touch = x - left;
  let previous = 0, position = 0, chosen = row.text.length;
  // Code-point boundaries prevent producing half of a surrogate pair.
  for (const character of row.text) {
    const next = position + character.length, edge = advance(row.text.slice(0, next));
    if (touch < (previous + edge) / 2) { chosen = position; break; }
    previous = edge; position = next;
  }
  return { contentBlockIndex: row.blockIndex, contentCharOffset: pressedSpeechCharOffset(block.text, sourceCharOffset(row, blocks, chosen)) };
}
const endings = new Set("。！？!?;；.:：");
// Kotlin Char.isWhitespace also includes Unicode space separators and U+001C–001F.
const whitespace = /[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function normalize(text: string, base: number): { text: string; sourceOffsets: number[] } {
  const chars: string[] = [], sourceOffsets: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (whitespace.test(char)) {
      if (chars.length && !space) { chars.push(" "); sourceOffsets.push(base + i); space = true; }
    } else { chars.push(char); sourceOffsets.push(base + i); space = false; }
  }
  if (space) { chars.pop(); sourceOffsets.pop(); }
  return { text: chars.join(""), sourceOffsets };
}

/** Native controller's 240-unit sentence grouping, retaining UTF-16 source coordinates. */
export function speechSegmentSlices(text: string, base = 0, limit = 240): SpeechSegment[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Speech segment limit must be an integer of at least two");
  const normalized = normalize(text, base), parts: SpeechSegment[] = [];
  const add = (start: number, end: number) => {
    while (start < end && normalized.text[start] === " ") start++;
    while (end > start && normalized.text[end - 1] === " ") end--;
    while (start < end) {
      let next = Math.min(start + limit, end);
      // Preserve an emoji at the native hard-split boundary instead of handing TTS half a pair.
      if (next < end && /[\ud800-\udbff]/.test(normalized.text[next - 1]!)) next--;
      parts.push({ text: normalized.text.slice(start, next), sourceOffsets: normalized.sourceOffsets.slice(start, next), isTitle: false });
      start = next;
    }
  };
  let start = 0;
  for (let i = 0; i < normalized.text.length; i++) if (endings.has(normalized.text[i]!)) { add(start, i + 1); start = i + 1; }
  add(start, normalized.text.length);
  const result: SpeechSegment[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (previous && previous.text.length + 1 + part.text.length <= limit) {
      previous.text += " " + part.text;
      previous.sourceOffsets.push(previous.sourceOffsets.at(-1)!, ...part.sourceOffsets);
    } else result.push(part);
  }
  return result;
}

/** Skip media while preserving the exact block index used by the reader's scroll anchors. */
export function articleSpeechSegments(article: Article, anchor?: SpeechAnchor): SpeechSegment[] {
  const result: SpeechSegment[] = [];
  if (!anchor) {
    const title = normalize(article.title, 0);
    if (title.text) {
      if (!endings.has(title.text.at(-1)!)) { title.text += "。"; title.sourceOffsets.push(title.sourceOffsets.at(-1)! + 1); }
      result.push({ ...title, isTitle: true });
    }
  }
  const blocks = article.contentBlocks ?? parseContent(article.rawContent ?? article.content);
  blocks.forEach((block, index) => {
    if (block.type !== "text" || (anchor?.contentBlockIndex !== undefined && index < anchor.contentBlockIndex)) return;
    const offset = anchor?.contentBlockIndex === index ? Math.max(0, Math.min(block.text.length, Math.trunc(anchor.contentCharOffset ?? 0) || 0)) : 0;
    for (const segment of speechSegmentSlices(block.text.slice(offset), offset)) result.push({ ...segment, contentBlockIndex: index });
  });
  return result;
}

export function speechSourceOffset(segment: SpeechSegment, textOffset: number): number {
  const offset = Math.max(0, Math.min(segment.text.length, Math.trunc(textOffset) || 0));
  return segment.sourceOffsets[offset] ?? ((segment.sourceOffsets.at(-1) ?? -1) + 1);
}
