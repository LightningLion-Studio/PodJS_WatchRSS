import { measuredLines, type TextMeasurer } from "../reader/measured-text.ts";

// Player detail panel geometry. Everything is laid out on the player's 233-unit
// canvas (half of the 466 px round reference) and scaled to the screen, so every
// rectangle below is checked against the canvas circle. The panel is a vertical
// pager whose rest positions are whole pages: at rest only one page is on screen.
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
  const title = clean(meta.title), description = clean(meta.description);
  if (!description || description === title) return title.length > 36 && meta.description !== undefined ? { title: "", description: title } : { title, description: "" };
  return { title, description };
}

/** Wrap with one width per line (each line follows the circle) and an ellipsis on the last line. */
export function flowLines(text: string, widths: readonly number[], measure: TextMeasurer): string[] {
  const lines: string[] = [];
  // Long descriptions only ever show a few lines; never lay out the whole body.
  let rest = Array.from(text).slice(0, 400).join("").trim();
  for (let i = 0; i < widths.length && rest; i++) {
    const width = Math.max(1, widths[i]!), last = i === widths.length - 1;
    const line = measuredLines(rest, width, measure, last ? 1 : Infinity)[0] ?? "";
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
export function infoLayout(meta: DetailMeta, measure: (text: string, slot: number) => number): InfoLayout {
  const { title, description } = detailText(meta), author = clean(meta.author);
  const maxTitle = description ? 2 : 3, maxDescription = title ? 3 : 5;
  const measureSlot = (slot: number): TextMeasurer => text => measure(text, slot);
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
        const textWidth = Math.ceil(Math.min(width - INFO.author.icon - INFO.author.iconGap, measure(label, INFO.author.slot)));
        const row = centred(INFO.author.icon + INFO.author.iconGap + textWidth, y, INFO.author.lineHeight);
        layout.author = { rect: row, label, icon: { x: row.x, y: y + (INFO.author.lineHeight - INFO.author.icon) / 2, width: INFO.author.icon, height: INFO.author.icon }, text: { x: row.x + INFO.author.icon + INFO.author.iconGap, y, width: textWidth, height: INFO.author.lineHeight } };
      } else {
        const rects = lineRects(y, block.lines!, INFO.description.lineHeight, INFO.description.maxWidth);
        layout.description = flowLines(description, rects.map(r => r.width), measureSlot(INFO.description.slot)).map((text, i) => ({ text, rect: rects[i]! }));
      }
      y += block.height + gapAfter(block.kind);
    }
    layout.descriptionMore = !!description && (!layout.description.length || layout.description.at(-1)!.text.endsWith("…"));
    return { layout, fits: height <= INFO.bottom - INFO.top && infoRects(layout).every(r => insideCanvasCircle(r)) };
  };
  // Measure how many lines each text needs at its widest, then shrink until the stack fits.
  const need = (text: string, slot: number, max: number) => text ? Math.min(max, measuredLines(text, INFO.title.maxWidth, measureSlot(slot), max).length) : 0;
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

// ---- description page --------------------------------------------------------------------

/** The full description, when it does not fit the info page: a caption and circle-flowing lines. */
export const ABOUT = { caption: centred(120, 24, 16), slot: 1, size: 14, lineHeight: 20, maxWidth: 200, top: 46, bottom: 204 } as const;
export function aboutLayout(description: string, measure: (text: string, slot: number) => number): TextLine[] {
  const text = detailText({ title: "", description }).description || clean(description);
  const count = Math.floor((ABOUT.bottom - ABOUT.top) / ABOUT.lineHeight);
  const needed = Math.min(count, measuredLines(text, ABOUT.maxWidth, value => measure(value, ABOUT.slot), count).length);
  const y = ABOUT.top + (ABOUT.bottom - ABOUT.top - needed * ABOUT.lineHeight) / 2;
  const rects = lineRects(y, needed, ABOUT.lineHeight, ABOUT.maxWidth);
  return flowLines(text, rects.map(r => r.width), value => measure(value, ABOUT.slot)).map((line, i) => ({ text: line, rect: rects[i]! }));
}

// ---- control pages -----------------------------------------------------------------------

/** One adjustable value per page: caption, [−] value [+], a detail line and an edge gauge. */
export const CONTROL = {
  caption: centred(120, 54, 16),
  value: centred(88, 92.5, 48),
  detail: centred(110, 146, 16),
  button: 50,
  buttonGap: 6,
  /** Gauge: a 240° arc, open at the bottom, filled clockwise from lower left. */
  gauge: { radius: 107, width: 4, selectedWidth: 6, startDeg: 150, sweepDeg: 240 },
} as const;
export const controlButtons = (): { minus: Rect; plus: Rect } => {
  const v = CONTROL.value, size = CONTROL.button, y = v.y + (v.height - size) / 2;
  return { minus: { x: v.x - CONTROL.buttonGap - size, y, width: size, height: size }, plus: { x: v.x + v.width + CONTROL.buttonGap, y, width: size, height: size } };
};
export const controlRects = (): Rect[] => { const b = controlButtons(); return [CONTROL.caption, CONTROL.value, CONTROL.detail, b.minus, b.plus]; };
/** Bounding box of the gauge stroke (its outer edge is the circle that matters). */
export const gaugeOuterRadius = (selected = false) => CONTROL.gauge.radius + (selected ? CONTROL.gauge.selectedWidth : CONTROL.gauge.width) / 2;

/** PocketJS arc style (0° = 12 o'clock, clockwise) for a gauge fraction, on the 233 canvas. */
export function gaugeArc(fraction: number, width: number): { insetL: number; insetT: number; width: number; height: number; arcStart: number; arcSweep: number; arcWidth: number } | undefined {
  const f = Math.max(0, Math.min(1, fraction));
  if (!(f > 0)) return undefined;
  const outer = CONTROL.gauge.radius + width / 2;
  return { insetL: C - outer, insetT: C - outer, width: outer * 2, height: outer * 2, arcStart: CONTROL.gauge.startDeg + 90, arcSweep: CONTROL.gauge.sweepDeg * f, arcWidth: width };
}

// ---- page indicator and entry arrow --------------------------------------------------------

/** Horizontal page dots in the gauge's open bottom. */
export function pageDots(count: number, active: number): (Rect & { active: boolean })[] {
  const size = 5, activeWidth = 12, gap = 5, y = 214;
  const total = (count - 1) * (size + gap) + activeWidth;
  let x = C - total / 2;
  return Array.from({ length: count }, (_, i) => { const width = i === active ? activeWidth : size, dot = { x, y, width, height: size, active: i === active }; x += width + gap; return dot; });
}

/** The inward-pointing tab at the right edge of the player, and its larger touch target. */
export const ENTRY_ARROW = { tab: { x: 207, y: 96.5, width: 16, height: 40 }, icon: { x: 205, y: 106.5, width: 20, height: 20 }, hit: { x: 189, y: 84.5, width: 40, height: 64 } } as const;

// ---- value steps ---------------------------------------------------------------------------

export const SPEED_STEPS = [.5, .75, 1, 1.25, 1.5, 1.75, 2] as const;
export function stepSpeed(current: number, steps: number): number {
  const index = SPEED_STEPS.reduce((best, value, i) => Math.abs(value - current) < Math.abs(SPEED_STEPS[best]! - current) ? i : best, 0);
  return SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, index + steps))]!;
}
export const speedFraction = (speed: number) => (speed - SPEED_STEPS[0]) / (SPEED_STEPS[SPEED_STEPS.length - 1]! - SPEED_STEPS[0]);
export const formatSpeed = (speed: number) => `${Number.isInteger(speed) ? speed.toFixed(1) : Number(speed.toFixed(2))}×`;

/** Pager settle target from release offset/velocity, in pages. */
export function settlePage(page: number, dragPx: number, velocity: number, pageHeight: number, count: number): number {
  const delta = Math.abs(velocity) > 400 ? -Math.sign(velocity) : Math.abs(dragPx) > pageHeight * .25 ? -Math.sign(dragPx) : 0;
  return Math.max(0, Math.min(count - 1, page + delta));
}
