import { speechSourceOffset, type SpeechSegment } from "./speech-segments.ts";

export interface SpeechProgress { type: "start" | "range" | "done" | "stop"; start?: number; end?: number; elapsedMs?: number }
export interface SpeechHighlight {
  articleId: string; useOriginalContent: boolean; segmentIndex: number;
  start: number; end: number; sourceStart: number; sourceEnd: number;
  isFallback: boolean; isTitle: boolean; contentBlockIndex?: number; importedChunkIndex?: number;
}
const whitespace = (char: string) => /[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(char);
const digit = (char: string) => /\p{Decimal_Number}/u.test(char);
const alphanumeric = (char: string) => /[\p{Letter}\p{Decimal_Number}]/u.test(char);
const cjk = (char: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char);
const stopChars = "，,。.;；：:！!？?、";
const skipChars = stopChars + "()[]{}/\\-+_";
function charUnits(text: string, index: number): number {
  const char = text[index]!;
  if (whitespace(char)) return 0;
  if (cjk(char)) return 1;
  if (digit(char)) return .95;
  if (/[A-Za-z]/.test(char)) return digit(text[index - 1] ?? "") || digit(text[index + 1] ?? "") ? .72 : .28;
  if ("()[]{}/\\-+_.".includes(char) && (alphanumeric(text[index - 1] ?? "") || alphanumeric(text[index + 1] ?? ""))) return .04;
  return .18;
}
export function fallbackSpeechUnits(text: string): number {
  let units = 0;
  for (let index = 0; index < text.length; index++) units += charUnits(text, index);
  return Math.max(1, units);
}
export function fallbackReadableOffset(text: string, progress: number): number {
  if (!text.length) return 0;
  const target = fallbackSpeechUnits(text) * Math.fround(Math.max(0, Math.min(1, progress)));
  let offset = 0, accumulated = 0;
  if (target > 0) for (; offset < text.length - 1; offset++) { accumulated += charUnits(text, offset); if (accumulated >= target) break; }
  while (offset < text.length && whitespace(text[offset]!)) offset++;
  if (offset === text.length) { while (offset > 0 && whitespace(text[offset - 1]!)) offset--; return Math.max(0, offset - 1); }
  while (skipChars.includes(text[offset]!) && offset + 1 < text.length) {
    offset++; while (offset < text.length && whitespace(text[offset]!)) offset++;
    offset = Math.min(offset, text.length - 1);
  }
  return offset;
}
export function fallbackHighlightOffsets(text: string, progress: number): {start: number; end: number} {
  if (!text.length) return {start: 0, end: 0};
  let start = fallbackReadableOffset(text, progress);
  if (!cjk(text[start]!)) while (start > 0 && alphanumeric(text[start - 1]!) && !cjk(text[start - 1]!)) start--;
  let end = start;
  if (cjk(text[start]!)) {
    let visible = 0;
    while (end < text.length && visible < 6) {
      const char = text[end++]!;
      if (!whitespace(char)) visible++;
      if (visible >= 2 && stopChars.includes(char)) break;
    }
  } else {
    while (end < text.length && alphanumeric(text[end]!) && !cjk(text[end]!)) end++;
    if (end === start) end++;
  }
  return {start, end: Math.max(start + 1, Math.min(text.length, end))};
}
export function fallbackDurationMs(text: string, rate: number, unitsPerSecond = 3.75): number {
  return Math.max(1200, Math.min(240000, Math.round(fallbackSpeechUnits(text) / (unitsPerSecond * Math.fround(Math.max(.1, rate))) * 1000)));
}
export function calibratedSpeechUnits(previous: number, text: string, elapsedMs: number, rate: number): number {
  const measured = fallbackSpeechUnits(text) / (Math.max(400, Math.trunc(elapsedMs)) / 1000) / Math.fround(Math.max(.1, rate));
  return previous * .65 + Math.max(1.8, Math.min(5.8, measured)) * (1 - .65);
}
export function segmentHighlight(segment: SpeechSegment, articleId: string, useOriginalContent: boolean, segmentIndex: number, start: number, end: number, isFallback: boolean): SpeechHighlight {
  start = Math.max(0, Math.min(segment.text.length, Math.trunc(start) || 0));
  end = Math.max(start, Math.min(segment.text.length, Math.trunc(end) || 0));
  return {articleId, useOriginalContent, segmentIndex, start, end, sourceStart: speechSourceOffset(segment, start), sourceEnd: speechSourceOffset(segment, end), isFallback, isTitle: segment.isTitle, contentBlockIndex: segment.contentBlockIndex, ...(segment.importedChunkIndex !== undefined ? {importedChunkIndex:segment.importedChunkIndex} : {})};
}
