import { describe, expect, test } from "bun:test";
import { avoidVolumeArc, volumeArcContains, volumeArcExtent, volumeArcFill, volumeArcLayout, volumeArcOutline, volumeArcPoint, volumeArcStyle } from "../src/ui/volume-arc.ts";
import { textWidthBound } from "../src/ui/round-bounds.ts";

const inCircle = (side: number, x: number, y: number, margin = 0) => Math.hypot(x - side / 2, y - side / 2) <= side / 2 - margin + 1e-6;
const rotatedRect = (cx: number, cy: number, w: number, h: number, deg: number) => {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + x! * c - y! * s, y: cy + x! * s + y! * c }));
};

describe("round crown volume capsule geometry", () => {
  test("466 px design values scale to the 233 canvas", () => {
    const l = volumeArcLayout(233);
    expect([l.radius, l.thickness, l.tickRadius, l.startDeg, l.endDeg]).toEqual([99, 29, 110, -56, -21]);
    expect(l.text.rotate).toBe(56.5);
    expect(l.icon.rotate).toBe(35);
    const text = volumeArcPoint(l, -33.5, 99);
    expect(l.text.x).toBeCloseTo(text.x, 9);
    expect(l.text.y).toBeCloseTo(text.y, 9);
    // Labels follow the local tangent: rotation = polar angle + 90 degrees.
    expect(l.text.rotate).toBeCloseTo(-33.5 + 90, 9);
    expect(l.icon.rotate).toBeCloseTo(-55 + 90, 9);
    expect(volumeArcLayout(466).radius).toBe(198);
  });

  test("the body arc maps to PocketJS 12-o'clock clockwise angles", () => {
    const l = volumeArcLayout(233);
    expect(volumeArcStyle(l, l.radius, l.thickness, l.startDeg, l.endDeg)).toEqual({ insetL: 3, insetT: 3, width: 227, height: 227, arcStart: 34, arcSweep: 35, arcWidth: 29 });
  });

  for (const side of [233, 192, 227, 240]) test(`${side}: every capsule point stays inside the circle with an edge gap`, () => {
    const l = volumeArcLayout(side);
    for (const p of volumeArcOutline(l)) expect(inCircle(side, p.x, p.y, 6 * side / 466 - 1e-3)).toBe(true);
    // It stays in the top-right quadrant, next to the crown.
    for (const p of volumeArcOutline(l)) { expect(p.x).toBeGreaterThan(side / 2); expect(p.y).toBeLessThan(side / 2); }
  });

  for (const percent of [0, 21, 70, 100]) test(`${percent}%: fill, tick and label stay inside the capsule`, () => {
    const l = volumeArcLayout(233), fill = volumeArcFill(l, percent);
    if (percent === 0) expect(fill).toBeUndefined();
    else {
      expect(fill!.toDeg).toBe(-24);
      expect((fill!.toDeg - fill!.fromDeg) / (l.tickEndDeg - l.tickStartDeg)).toBeCloseTo(percent / 100, 9);
      // Fill and its round caps sit on the tick inside the capsule.
      for (const deg of [fill!.fromDeg, (fill!.fromDeg + fill!.toDeg) / 2, fill!.toDeg]) {
        const p = volumeArcPoint(l, deg, l.tickRadius);
        for (const q of rotatedRect(p.x, p.y, l.tickWidth, l.tickWidth, 0)) expect(volumeArcContains(l, q.x, q.y)).toBe(true);
      }
    }
    // The longest label of this level, measured with the CJK/Latin upper bound, fits along the arc.
    const width = textWidthBound(`${percent}%`, 16), height = 12;
    for (const q of rotatedRect(l.text.x, l.text.y, width, height, l.text.rotate)) {
      expect(volumeArcContains(l, q.x, q.y)).toBe(true);
      expect(Math.hypot(q.x - l.cx, q.y - l.cy)).toBeLessThan(l.tickRadius - l.tickWidth / 2);
    }
    for (const q of rotatedRect(l.icon.x, l.icon.y, l.icon.size * .75, l.icon.size * .75, l.icon.rotate)) expect(volumeArcContains(l, q.x, q.y)).toBe(true);
  });

  test("the label clears the icon along the arc", () => {
    const l = volumeArcLayout(233), labelHalf = textWidthBound("100%", 16) / 2, iconHalf = l.icon.size / 2;
    expect(Math.hypot(l.text.x - l.icon.x, l.text.y - l.icon.y) - labelHalf - iconHalf).toBeGreaterThan(4);
  });

  test("clears the player's top row at rotation 0 and blanks icons it cannot fit", () => {
    const l = volumeArcLayout(233);
    const triple = [{ left: 57.5, width: 24 }, { left: 104.5, width: 24 }, { left: 151.5, width: 24 }];
    const moved = avoidVolumeArc(l, triple, 18, 24);
    expect(moved.hidden).toEqual([false, false, false]);
    const edge = volumeArcExtent(l, 14, 46)!.minX;
    const lefts = triple.map((icon, i) => icon.left + moved.dx[i]!);
    expect(lefts[2]! + 24).toBeLessThanOrEqual(edge - 4 + 1e-6);
    for (let i = 1; i < 3; i++) expect(lefts[i]! - lefts[i - 1]! - 24).toBeGreaterThanOrEqual(8);
    for (const x of lefts) for (const [px, py] of [[x, 18], [x + 24, 18], [x, 42], [x + 24, 42]]) expect(inCircle(233, px!, py!, 1)).toBe(true);
    // Bottom row is untouched at rotation 0; rotated 180 the capsule lands on rewind, which is blanked.
    const bottom = [{ left: 57.5, width: 24 }, { left: 102.5, width: 28 }, { left: 151.5, width: 24 }];
    expect(avoidVolumeArc(l, bottom, 194, 28)).toEqual({ dx: [0, 0, 0], hidden: [false, false, false] });
    expect(avoidVolumeArc(l, bottom, 194, 28, -180).hidden).toEqual([true, false, false]);
  });
});
