import { layoutUiText, layoutUiTextLines, measuredLines, type TextMeasurer } from "@podjs/framework/text-lines";

// Player detail panel geometry. Everything is laid out on the player's 233-unit
// canvas (half of the 466 px round reference) and scaled to the screen, so every
// rectangle below is checked against the canvas circle. The panel is a
// continuously scrolling column: the info block, the full description and the controls.
export const CANVAS = 233;
const C = CANVAS / 2;
/** Clearance between any element corner and the screen circle. */
export const EDGE_MARGIN = 3;
const INNER = C - EDGE_MARGIN;

export interface Rect { x: number; y: number; width: number; height: number }
export const rectCorners = (r: Rect) => [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]] as const;
/** All four corners within the canvas circle less `margin`. */
export function insideCanvasCircle(r: Rect, margin = EDGE_MARGIN): boolean {
  return rectCorners(r).every(([x, y]) => Math.hypot(x - C, y - C) <= C - margin + 1e-6);
}
/** Widest centred box spanning the band y0..y1 whose corners stay inside the circle. */
export function chordWidth(y0: number, y1: number, margin = EDGE_MARGIN): number {
  const dy = Math.max(Math.abs(y0 - C), Math.abs(y1 - C)), r = C - margin;
  return dy >= r ? 0 : Math.floor(2 * Math.sqrt(r * r - dy * dy));
}
const centred = (width: number, y: number, height: number): Rect => ({ x: C - width / 2, y, width, height });

// ---- info page ---------------------------------------------------------------------------

export const INFO = {
  cover: { width: 120, height: 68, radius: 12 },
  portraitCover: { width: 66, height: 88, radius: 10 },
  title: { slot: 2, size: 16, lineHeight: 20, maxWidth: 196, color: "#ffffff" },
  author: { slot: 21, size: 13, lineHeight: 18, maxWidth: 170, icon: 14, iconGap: 4, color: "#ff6026" },
  description: { slot: 0, size: 12, lineHeight: 16, maxWidth: 196, color: "#a6a6a6" },
  gap: { cover: 8, title: 5, author: 5 },
  /** Content stays above the page indicator. */
  top: 18, bottom: 204,
} as const;

export interface DetailMeta { title?: string; author?: string; description?: string; hasCover: boolean; portraitCover?: boolean }
export interface TextLine { text: string; rect: Rect }
export interface InfoLayout { cover?: Rect; title: TextLine[]; author?: { rect: Rect; icon: Rect; text: Rect; label: string }; description: TextLine[]; /** The description did not fit whole; it gets its own page. */ descriptionMore: boolean }

// Placeholder descriptions ("-", "…") count as missing.
const clean = (text: string | undefined) => { const value = (text ?? "").replace(/\s+/g, " ").trim(); return /^[\s\-—–.。…·]*$/.test(value) ? "" : value; };
/** Douyin titles are the description; show that text once, as the description. */
export function detailText(meta: Pick<DetailMeta, "title" | "description">): { title: string; description: string } {
  const title=clean(meta.title),description=meta.title===meta.description?title:clean(meta.description);
  if (!description || description === title) return title.length > 36 && meta.description !== undefined ? { title: "", description: title } : { title, description: "" };
  return { title, description };
}

const INFO_TEXT_LIMIT = 400;
function textPrefix(text: string, points: number): string {
  if (text.length <= points) return text;
  let end = 0;
  for (const char of text) {
    if (points-- === 0) return text.slice(0, end);
    end += char.length;
  }
  return text;
}

/** Wrap with one width per line (each line follows the circle) and an ellipsis on the last line. */
export function flowLines(text: string, widths: readonly number[], measure: TextMeasurer): string[] {
  const lines: string[] = [];
  // Long descriptions only ever show a few lines; never lay out the whole body.
  let rest = textPrefix(text, INFO_TEXT_LIMIT).trim();
  for (let i = 0; i < widths.length && rest; i++) {
    const width = Math.max(1, widths[i]!), last = i === widths.length - 1;
    const line = (last ? measuredLines(rest, width, measure, 1) : layoutUiText(rest, { width, measure, maxLines: 1 }))[0] ?? "";
    if (!line) break;
    lines.push(line);
    rest = last ? "" : rest.slice(line.length).trimStart();
  }
  return lines;
}

interface Block { kind: "cover" | "title" | "author" | "description"; height: number; lines?: number }
const lineRects = (y: number, count: number, lineHeight: number, maxWidth: number) =>
  Array.from({ length: count }, (_, i) => { const top = y + i * lineHeight; return centred(Math.min(maxWidth, chordWidth(top, top + lineHeight)), top, lineHeight); });

/**
 * Stack cover, title, author and description, centred vertically between INFO.top and
 * INFO.bottom. Line widths come from the circle chord at each line's final position, so
 * text tapers with the round screen. When everything cannot fit, description lines go
 * first, then title lines; missing fields leave no gap.
 */
export function infoLayout(meta: DetailMeta, measure: (text: string, slot: number) => number, text=detailText(meta)): InfoLayout {
  const author = clean(meta.author);
  const title = textPrefix(text.title, INFO_TEXT_LIMIT);
  const description = textPrefix(text.description, INFO_TEXT_LIMIT);
  const maxTitle = description ? 2 : 3, maxDescription = title ? 3 : 5;
  const widths = new Map<string, number>();
  const measureSlot = (slot: number): TextMeasurer => value => {
    const key = `${slot}:${value}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const width = measure(value, slot);
    widths.set(key, width);
    return width;
  };
  const plan = (titleLines: number, descriptionLines: number) => {
    const blocks: Block[] = [];
    const cover = meta.portraitCover ? INFO.portraitCover : INFO.cover;
    if (meta.hasCover) blocks.push({ kind: "cover", height: cover.height });
    if (title && titleLines) blocks.push({ kind: "title", height: titleLines * INFO.title.lineHeight, lines: titleLines });
    if (author) blocks.push({ kind: "author", height: INFO.author.lineHeight });
    if (description && descriptionLines) blocks.push({ kind: "description", height: descriptionLines * INFO.description.lineHeight, lines: descriptionLines });
    const gapAfter = (kind: Block["kind"]) => INFO.gap[kind as keyof typeof INFO.gap] ?? 0;
    const height = blocks.reduce((sum, block, i) => sum + block.height + (i < blocks.length - 1 ? gapAfter(block.kind) : 0), 0);
    let y = INFO.top + Math.max(0, (INFO.bottom - INFO.top - height) / 2);
    const layout: InfoLayout = { title: [], description: [], descriptionMore: false };
    for (const block of blocks) {
      if (block.kind === "cover") layout.cover = centred(cover.width, y, cover.height);
      else if (block.kind === "title") {
        const rects = lineRects(y, block.lines!, INFO.title.lineHeight, INFO.title.maxWidth);
        layout.title = flowLines(title, rects.map(r => r.width), measureSlot(INFO.title.slot)).map((text, i) => ({ text, rect: rects[i]! }));
      } else if (block.kind === "author") {
        const width = Math.min(INFO.author.maxWidth, chordWidth(y, y + INFO.author.lineHeight));
        const label = measuredLines(author, width - INFO.author.icon - INFO.author.iconGap, measureSlot(INFO.author.slot), 1)[0] ?? "";
        const textWidth = Math.ceil(Math.min(width - INFO.author.icon - INFO.author.iconGap, measureSlot(INFO.author.slot)(label)));
        const row = centred(INFO.author.icon + INFO.author.iconGap + textWidth, y, INFO.author.lineHeight);
        layout.author = { rect: row, label, icon: { x: row.x, y: y + (INFO.author.lineHeight - INFO.author.icon) / 2, width: INFO.author.icon, height: INFO.author.icon }, text: { x: row.x + INFO.author.icon + INFO.author.iconGap, y, width: textWidth, height: INFO.author.lineHeight } };
      } else {
        const rects = lineRects(y, block.lines!, INFO.description.lineHeight, INFO.description.maxWidth);
        layout.description = flowLines(description, rects.map(r => r.width), measureSlot(INFO.description.slot)).map((text, i) => ({ text, rect: rects[i]! }));
      }
      y += block.height + gapAfter(block.kind);
    }
    layout.descriptionMore = !!description && (description !== text.description || !layout.description.length || layout.description.at(-1)!.text.endsWith("…"));
    return { layout, fits: height <= INFO.bottom - INFO.top && infoRects(layout).every(r => insideCanvasCircle(r)) };
  };
  // Measure how many lines each text needs at its widest, then shrink until the stack fits.
  const need = (text: string, slot: number, max: number) => text ? layoutUiText(text, { width: INFO.title.maxWidth, measure: measureSlot(slot), maxLines: max }).length : 0;
  let titleLines = need(title, INFO.title.slot, maxTitle), descriptionLines = need(description, INFO.description.slot, maxDescription);
  for (;;) {
    const result = plan(titleLines, descriptionLines);
    if (result.fits) return result.layout;
    if (descriptionLines > 1) descriptionLines--;
    else if (titleLines > 1) titleLines--;
    else if (descriptionLines) descriptionLines = 0;
    else return result.layout;
  }
}
export const infoRects = (layout: InfoLayout): Rect[] => [
  ...(layout.cover ? [layout.cover] : []), ...layout.title.map(line => line.rect),
  ...(layout.author ? [layout.author.rect, layout.author.icon, layout.author.text] : []), ...layout.description.map(line => line.rect),
];

// ---- scrolling column -------------------------------------------------------------------

// Below the info block the panel is one continuously scrolling column: the full description,
// then one row per control. Content y is in canvas units from the top of the column.

/** Full description below the info block, when the info block could not show it whole. */
export const ABOUT = { slot: 1, size: 14, lineHeight: 20, width: 184, caption: 16, captionGap: 6, gap: 18 } as const;
/** Longest description laid out, in code points; beyond it the text ends with an ellipsis. */
export const ABOUT_MAX_CHARS = 20_000;
/** Every line of the description at the column width. Bounded so a pathological body stays cheap. */
export function* aboutLineIterator(text: string, measure: (text: string, slot: number) => number, alreadyNormalized=false): Generator<string> {
  const normalized = alreadyNormalized?text:clean(text), prefix = textPrefix(normalized, ABOUT_MAX_CHARS);
  const body = prefix === normalized ? prefix : prefix + "…";
  if (body) yield* layoutUiTextLines(body, { width: ABOUT.width, measure: value => measure(value, ABOUT.slot) });
}
export const aboutHeight = (lines: number) => lines ? ABOUT.caption + ABOUT.captionGap + lines * ABOUT.lineHeight + ABOUT.gap : 0;

/**
 * One control row: caption, value, then [−] pill bar [+], then a detail line. Rects are
 * relative to the row top and centred on the canvas. The pill is the selectable target.
 */
export const CONTROL = {
  height: 124,
  caption: centred(140, 0, 16),
  value: centred(120, 18, 30),
  detail: centred(140, 92, 16),
  row: { y: 54, height: 34 },
  button: 34,
  buttonGap: 8,
  pill: { width: 112, height: 10, selectedHeight: 14 },
} as const;
export function controlRow(): { minus: Rect; plus: Rect; pillHit: Rect; pill: (selected: boolean) => Rect } {
  const { row, button, buttonGap, pill } = CONTROL, total = button * 2 + buttonGap * 2 + pill.width, x = C - total / 2;
  const by = row.y + (row.height - button) / 2, pillX = x + button + buttonGap;
  return {
    minus: { x, y: by, width: button, height: button },
    plus: { x: x + total - button, y: by, width: button, height: button },
    pillHit: { x: pillX, y: row.y, width: pill.width, height: row.height },
    pill: selected => { const h = selected ? pill.selectedHeight : pill.height; return { x: pillX, y: row.y + (row.height - h) / 2, width: pill.width, height: h }; },
  };
}
/** Filled part of a pill bar; never narrower than its own height so the caps stay round. */
export function pillFill(track: Rect, fraction: number): Rect | undefined {
  const f = Math.max(0, Math.min(1, fraction));
  if (!(f > 0)) return undefined;
  return { ...track, width: Math.max(track.height, track.width * f) };
}
/** Rows of a control, at row-relative positions, for the circle check at the canvas centre. */
export const controlRects = (selected = true): Rect[] => { const r = controlRow(); return [CONTROL.caption, CONTROL.value, CONTROL.detail, r.minus, r.plus, r.pill(selected)]; };

/** Column metrics: where each section starts and how far the column scrolls. */
export const INFO_HEIGHT = INFO.bottom + 8;
export function columnLayout(aboutLineCount: number, controls: number): { about: number; controls: number; height: number; max: number } {
  const about = INFO_HEIGHT, start = about + aboutHeight(aboutLineCount);
  // Trailing space lets the last row scroll to the vertical centre.
  const height = start + controls * CONTROL.height + Math.max(0, (CANVAS - CONTROL.height) / 2);
  return { about, controls: start, height, max: Math.max(0, height - CANVAS) };
}
/** Offset that centres control row `index` on the canvas. */
export const controlCentreOffset = (layout: { controls: number; max: number }, index: number) =>
  Math.max(0, Math.min(layout.max, layout.controls + index * CONTROL.height + CONTROL.height / 2 - C));

// ---- entry arrow ---------------------------------------------------------------------------

const entryHit = { x: 189, y: 84.5, width: 40, height: 64 };
const roundHitWidth = C + chordWidth(entryHit.y, entryHit.y + entryHit.height) / 2 - entryHit.x;
/** The inward-pointing tab and its touch target, in picture coordinates. */
export const ENTRY_ARROW = {
  tab: { x: 207, y: 96.5, width: 16, height: 40 },
  icon: { x: 205, y: 106.5, width: 20, height: 20 },
  hit: entryHit,
  roundHit: { ...entryHit, width: Math.min(entryHit.width, roundHitWidth) },
} as const;

// ---- value steps ---------------------------------------------------------------------------

export const SPEED_STEPS = [.5, .75, 1, 1.25, 1.5, 1.75, 2] as const;
export function stepSpeed(current: number, steps: number): number {
  const index = SPEED_STEPS.reduce((best, value, i) => Math.abs(value - current) < Math.abs(SPEED_STEPS[best]! - current) ? i : best, 0);
  return SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, index + steps))]!;
}
export const speedFraction = (speed: number) => (speed - SPEED_STEPS[0]) / (SPEED_STEPS[SPEED_STEPS.length - 1]! - SPEED_STEPS[0]);
export const formatSpeed = (speed: number) => `${Number.isInteger(speed) ? speed.toFixed(1) : Number(speed.toFixed(2))}×`;
