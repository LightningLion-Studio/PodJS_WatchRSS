import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {bakeSvg} from "../node_modules/@pocketjs/framework/framework/compiler/bake-svg.ts";
import {volumeArcLayout} from "../src/ui/volume-arc.ts";

const icon = (name: string) => readFileSync(new URL("../assets/icons/" + name, import.meta.url), "utf8");

test("rotated player artwork and the volume capsule use linear filtering", () => {
  const images = JSON.parse(readFileSync(new URL("../src/images.json", import.meta.url), "utf8"));
  for (const name of ["player-loading", "video-loading-ring", "video-loading-arc", "volume-capsule", "speech-volume-overlay", "speech-volume-off-overlay"]) {
    expect(images["../assets/icons/" + name + ".svg"]?.linear).toBe(true);
  }
});

test("linear sampling at transparent spinner edges retains the stroke color", () => {
  for (const name of ["video-loading-arc.svg", "video-loading-ring.svg"]) {
    const {rgba} = bakeSvg(icon(name), 2);
    expect([...rgba.slice(0, 4)]).toEqual([255, 255, 255, 0]);
  }
});

test("baked volume artwork matches the round-capped outline and keeps physical edge coverage", () => {
  const svg = icon("volume-capsule.svg");
  const box = /viewBox="([\d. -]+)"/.exec(svg)![1]!.split(/\s+/).map(Number);
  const [left, top, width, height] = box as [number, number, number, number];
  const layout = volumeArcLayout(233);
  const {width: w, height: h, rgba} = bakeSvg(svg, 2);
  // One texel per physical watch pixel also lets a 1× receiver average exactly four texels.
  expect([w, h]).toEqual([width * 2, height * 2]);
  const r = layout.radius, half = layout.thickness / 2, levels = new Set<number>();
  const cap = (deg: number) => [r * Math.cos(deg * Math.PI / 180), r * Math.sin(deg * Math.PI / 180)] as const;
  const start = cap(layout.startDeg), end = cap(layout.endDeg);
  let exterior = 0, interior = 0;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const x = left + (col + .5) / w * width - layout.cx, y = top + (row + .5) / h * height - layout.cy;
    const angle = Math.atan2(y, x) * 180 / Math.PI;
    const distance = angle >= layout.startDeg && angle <= layout.endDeg ? Math.abs(Math.hypot(x, y) - r)
      : Math.min(Math.hypot(x - start[0], y - start[1]), Math.hypot(x - end[0], y - end[1]));
    const alpha = rgba[(row * w + col) * 4 + 3]!;
    if (distance > half + .6) { exterior++; if (alpha !== 0) throw Error("capsule paints beyond its outer stroke"); }
    if (distance < half - 1.2) { interior++; if (alpha < 240) throw Error("capsule body has a hole"); }
    if (Math.abs(distance - half) < .55 && alpha > 0 && alpha < 115) levels.add(alpha);
  }
  expect(exterior).toBeGreaterThan(1000);
  expect(interior).toBeGreaterThan(1000);
  expect(levels.size).toBeGreaterThanOrEqual(12);
});
