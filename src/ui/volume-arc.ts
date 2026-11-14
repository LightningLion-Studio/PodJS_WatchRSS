// Round-screen crown volume capsule (issue #2): an arc hugging the top-right
// edge next to the crown. Design values are px on a 466 px round screen and
// scale with the canvas side. Angles are screen degrees from 3 o'clock,
// clockwise positive (so negative = upward); arc paths end at the cap centres.
const DESIGN = {
  side: 466, radius: 198, thickness: 58, startDeg: -56, endDeg: -21,
  tickRadius: 220, tickWidth: 3, tickStartDeg: -50, tickEndDeg: -24,
  outline: 1.5, textDeg: -33.5, textRotate: 56.5, iconDeg: -55, iconRotate: 35, iconSize: 28,
} as const;

export interface VolumeArcLayout {
  side: number; cx: number; cy: number;
  radius: number; thickness: number; startDeg: number; endDeg: number;
  tickRadius: number; tickWidth: number; tickStartDeg: number; tickEndDeg: number; outline: number;
  text: { x: number; y: number; rotate: number };
  icon: { x: number; y: number; rotate: number; size: number };
}
export interface Point { x: number; y: number }
export interface ArcStyle { insetL: number; insetT: number; width: number; height: number; arcStart: number; arcSweep: number; arcWidth: number }

const rad = (deg: number) => deg * Math.PI / 180;
export function volumeArcPoint(layout: Pick<VolumeArcLayout, "cx" | "cy">, deg: number, radius: number): Point {
  return { x: layout.cx + radius * Math.cos(rad(deg)), y: layout.cy + radius * Math.sin(rad(deg)) };
}

export function volumeArcLayout(side = 233): VolumeArcLayout {
  const k = side / DESIGN.side, c = side / 2, centre = { cx: c, cy: c };
  const at = (deg: number) => volumeArcPoint(centre, deg, DESIGN.radius * k);
  return {
    side, cx: c, cy: c,
    radius: DESIGN.radius * k, thickness: DESIGN.thickness * k, startDeg: DESIGN.startDeg, endDeg: DESIGN.endDeg,
    tickRadius: DESIGN.tickRadius * k, tickWidth: DESIGN.tickWidth * k, tickStartDeg: DESIGN.tickStartDeg, tickEndDeg: DESIGN.tickEndDeg,
    outline: DESIGN.outline * k,
    text: { ...at(DESIGN.textDeg), rotate: DESIGN.textRotate },
    icon: { ...at(DESIGN.iconDeg), rotate: DESIGN.iconRotate, size: DESIGN.iconSize * k },
  };
}

/** PocketJS arc node (0 deg = 12 o'clock, clockwise) stroking `radius` with round caps, in canvas units. */
export function volumeArcStyle(layout: VolumeArcLayout, radius: number, width: number, fromDeg: number, toDeg: number): ArcStyle {
  const outer = radius + width / 2;
  return { insetL: layout.cx - outer, insetT: layout.cy - outer, width: outer * 2, height: outer * 2, arcStart: fromDeg + 90, arcSweep: toDeg - fromDeg, arcWidth: width };
}

/** The level fills the outer tick from the lower (crown-side) end upward. */
export function volumeArcFill(layout: VolumeArcLayout, percent: number): { fromDeg: number; toDeg: number } | undefined {
  const p = Math.max(0, Math.min(100, percent)) / 100;
  if (!(p > 0)) return undefined;
  return { fromDeg: layout.tickEndDeg - (layout.tickEndDeg - layout.tickStartDeg) * p, toDeg: layout.tickEndDeg };
}

/** Whether a point lies in the capsule (annular sector plus round caps). */
export function volumeArcContains(layout: VolumeArcLayout, x: number, y: number): boolean {
  const half = layout.thickness / 2 + 1e-6, d = Math.hypot(x - layout.cx, y - layout.cy);
  const deg = Math.atan2(y - layout.cy, x - layout.cx) * 180 / Math.PI;
  if (deg >= layout.startDeg && deg <= layout.endDeg && Math.abs(d - layout.radius) <= half) return true;
  return [layout.startDeg, layout.endDeg].some(end => { const p = volumeArcPoint(layout, end, layout.radius); return Math.hypot(x - p.x, y - p.y) <= half; });
}

/** Outline samples of the capsule, optionally rotated about the centre (degrees, clockwise). */
export function volumeArcOutline(layout: VolumeArcLayout, rotateDeg = 0, stepDeg = 1): Point[] {
  const points: Point[] = [], half = layout.thickness / 2, r = layout.radius;
  const push = (p: Point) => points.push(rotateDeg ? volumeArcPoint(layout, Math.atan2(p.y - layout.cy, p.x - layout.cx) * 180 / Math.PI + rotateDeg, Math.hypot(p.x - layout.cx, p.y - layout.cy)) : p);
  for (let deg = layout.startDeg; deg <= layout.endDeg + 1e-9; deg += stepDeg / 4) { push(volumeArcPoint(layout, deg, r + half)); push(volumeArcPoint(layout, deg, r - half)); }
  for (const end of [layout.startDeg, layout.endDeg]) {
    const c = volumeArcPoint(layout, end, r);
    for (let deg = 0; deg < 360; deg += stepDeg) push(volumeArcPoint({ cx: c.x, cy: c.y }, deg, half));
  }
  return points;
}

/** Horizontal extent of the capsule within the band y0..y1, or undefined when it does not reach the band. */
export function volumeArcExtent(layout: VolumeArcLayout, y0: number, y1: number, rotateDeg = 0): { minX: number; maxX: number } | undefined {
  let minX = Infinity, maxX = -Infinity;
  for (const p of volumeArcOutline(layout, rotateDeg)) if (p.y >= y0 && p.y <= y1) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
  return minX <= maxX ? { minX, maxX } : undefined;
}

/** Icons of a horizontal control row, as icon rects (not hit boxes). */
export interface RowIcon { left: number; width: number }
/**
 * Keep a control row clear of the capsule. Moves the row away from it (packing the icons
 * within the circle chord if needed); if that would cramp them below `minGap`, the icons
 * under the capsule are hidden instead. Returns per-icon x offsets and hidden flags.
 */
export function avoidVolumeArc(layout: VolumeArcLayout, icons: readonly RowIcon[], top: number, height: number, rotateDeg = 0, gap = 4, minGap = 8): { dx: number[]; hidden: boolean[] } {
  const none = { dx: icons.map(() => 0), hidden: icons.map(() => false) };
  const extent = volumeArcExtent(layout, top - gap, top + height + gap, rotateDeg);
  if (!extent || !icons.length) return none;
  const collides = (left: number, width: number) => left < extent.maxX + gap && left + width > extent.minX - gap;
  if (!icons.some(icon => collides(icon.left, icon.width))) return none;
  const R = layout.side / 2 - 1, dy = Math.max(Math.abs(top - layout.cy), Math.abs(top + height - layout.cy));
  const chord = dy < R ? Math.sqrt(R * R - dy * dy) : 0, lo = layout.cx - chord, hi = layout.cx + chord;
  const fromRight = extent.minX + extent.maxX > 2 * layout.cx;
  const min = fromRight ? lo : Math.max(lo, extent.maxX + gap), max = fromRight ? Math.min(hi, extent.minX - gap) : hi;
  const first = icons[0]!, last = icons[icons.length - 1]!, span = last.left + last.width - first.left;
  let lefts: number[];
  if (span <= max - min) {
    const shift = fromRight ? Math.min(0, max - (first.left + span)) : Math.max(0, min - first.left);
    lefts = icons.map(icon => icon.left + shift);
  } else {
    const total = icons.reduce((sum, icon) => sum + icon.width, 0), space = icons.length > 1 ? (max - min - total) / (icons.length - 1) : 0;
    if (space < minGap) return { dx: none.dx, hidden: icons.map(icon => collides(icon.left, icon.width)) };
    let x = min; lefts = icons.map(icon => { const left = x; x += icon.width + space; return left; });
  }
  return { dx: icons.map((icon, i) => lefts[i]! - icon.left), hidden: none.hidden };
}
