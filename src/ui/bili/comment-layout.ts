import type { BiliCommentContent } from '../../bili/types.ts';
export type CommentRun = { text: string; color?: string; image?: string; emote?: boolean };
/** Links remain literal, as in native CommentRichText. Mentions are styled, not navigable. */
export function commentRuns(content?: BiliCommentContent): CommentRun[] {
  const message = content?.message ?? '', emotes = content?.emote ?? {};
  const keys = Object.keys(emotes).filter(Boolean).sort((a, b) => b.length - a.length);
  const runs: CommentRun[] = [];
  let index = 0, mention = false;
  while (index < message.length) {
    const key = keys.find(key => message.startsWith(key, index));
    if (key) { runs.push({ text: emotes[key]!.text ?? key, image: emotes[key]!.url, emote: true }); index += key.length; continue; }
    const char = String.fromCodePoint(message.codePointAt(index)!);
    if (/\s/u.test(char)) mention = false;
    if (char === '@') mention = !!message[index + 1] && !/[\s@]/u.test(message[index + 1]!);
    const color = mention ? '#00a1d6' : undefined, last = runs.at(-1);
    if (last && !last.emote && last.color === color) last.text += char;
    else runs.push({ text: char, color });
    index += char.length;
  }
  return runs;
}
export interface PositionedRun extends CommentRun { x: number; y: number; width: number }
/** Measure with the same font slot used for rendering; no six-line truncation. */
export function layoutCommentRuns(runs: CommentRun[], width: number, measure: (text: string) => number, lineHeight = 21, emoteSize = 20) {
  const fragments: PositionedRun[] = [];
  let x = 0, y = 0;
  const newline = () => { x = 0; y += lineHeight; };
  for (const run of runs) {
    if (run.emote) {
      if (x > 0 && x + emoteSize > width) newline();
      fragments.push({ ...run, x, y, width: emoteSize }); x += emoteSize; continue;
    }
    for (const char of Array.from(run.text)) {
      if (char === '\r') continue;
      if (char === '\n') { newline(); continue; }
      const last = fragments.at(-1);
      const joins = last && !last.emote && last.y === y && last.color === run.color;
      const advance = joins ? measure(last.text + char) - measure(last.text) : measure(char);
      if (x > 0 && x + advance > width) newline();
      if (joins && last.y === y) { last.text += char; last.width = measure(last.text); x = last.x + last.width; }
      else { const size = measure(char); fragments.push({ text: char, color: run.color, x, y, width: size }); x += size; }
    }
  }
  return { fragments, height: y + lineHeight };
}
export function vipColor(color?: string) {
  if (/^#[\da-f]{6}$/i.test(color ?? '')) return color!;
  if (/^#[\da-f]{8}$/i.test(color ?? '')) return `#${color!.slice(3)}${color!.slice(1, 3)}`; // Android ARGB -> RGBA.
  return '#f5f5f5';
}
