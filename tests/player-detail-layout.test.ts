import { describe, expect, test } from "bun:test";
import { ABOUT, aboutLayout, CANVAS, CONTROL, chordWidth, controlButtons, controlRects, detailText, EDGE_MARGIN, ENTRY_ARROW, flowLines, gaugeOuterRadius, INFO, infoLayout, infoRects, insideCanvasCircle, pageDots, settlePage, SPEED_STEPS, speedFraction, stepSpeed } from "../src/ui/player-detail-layout.ts";
import { holdStepCount, seekHoldStep } from "../src/ui/video-player.ts";
import { volumeArcLayout, volumeArcOutline } from "../src/ui/volume-arc.ts";

// Upper-bound glyph advance (CJK = size, Latin = .62 size): wraps no shorter than the device font.
const SIZE: Record<number, number> = { 0: 12, 1: 14, 2: 16, 21: 13 };
const measure = (text: string, slot: number) => Array.from(text).reduce((w, ch) => w + (ch.codePointAt(0)! > 255 ? 1 : .62) * (SIZE[slot] ?? 16), 0);
const C = CANVAS / 2;

const longCjk = "这是一段非常长的视频简介，用来验证圆形屏幕上的多行文本会随着圆弧收窄，并且在最后一行用省略号截断，不会越过屏幕边缘。".repeat(4);
const longLatin = "A really long description with Latin words that wraps across several lines and keeps going well past what fits ".repeat(5);
const titles = ["", "短标题", "【4K】一个很长很长的哔哩哔哩视频标题，会占满两行甚至更多行的内容需要截断", longLatin];
const authors = [undefined, "UP", "一个名字特别特别特别特别特别特别长的作者账号名称", "averyveryverylongauthornamewithoutspaces_0123456789"];
const descriptions = [undefined, "-", "一句话简介", longCjk, longLatin];

describe("player detail layout stays inside the round screen", () => {
  test("every info combination keeps all corners inside the circle and above the page dots", () => {
    let checked = 0;
    for (const title of titles) for (const author of authors) for (const description of descriptions) for (const hasCover of [false, true]) for (const portraitCover of [false, true]) {
      if (!title && !description && !author && !hasCover) continue;
      const layout = infoLayout({ title, author, description, hasCover, portraitCover }, measure);
      for (const rect of infoRects(layout)) {
        expect(insideCanvasCircle(rect)).toBe(true);
        expect(rect.y).toBeGreaterThanOrEqual(INFO.top - 1e-6);
        expect(rect.y + rect.height).toBeLessThanOrEqual(INFO.bottom + 1e-6);
      }
      for (const line of [...layout.title, ...layout.description]) expect(measure(line.text, line === layout.title[0] || layout.title.includes(line) ? INFO.title.slot : INFO.description.slot)).toBeLessThanOrEqual(line.rect.width + 1e-6);
      if (layout.author) expect(measure(layout.author.label, INFO.author.slot)).toBeLessThanOrEqual(layout.author.text.width + 1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });
  test("long texts are clamped with an ellipsis and missing fields leave no gap", () => {
    const full = infoLayout({ title: titles[2], author: authors[2], description: longCjk, hasCover: true }, measure);
    expect(full.cover).toBeDefined();
    expect(full.title.length).toBeLessThanOrEqual(2);
    expect(full.description.length).toBeGreaterThanOrEqual(1);
    expect(full.description.at(-1)!.text.endsWith("…")).toBe(true);
    expect(full.author!.label.endsWith("…")).toBe(true);
    const bare = infoLayout({ title: "标题", hasCover: false }, measure);
    expect(bare.cover).toBeUndefined();
    expect(bare.description).toEqual([]);
    expect(bare.author).toBeUndefined();
    // A single block is centred, not pinned to the top.
    expect(Math.abs(bare.title[0]!.rect.y + bare.title[0]!.rect.height / 2 - (INFO.top + INFO.bottom) / 2)).toBeLessThan(1);
    expect(infoLayout({ title: "标题", description: "-", hasCover: false }, measure).description).toEqual([]);
  });
  test("an overflowing description gets its own page that fits", () => {
    const layout = infoLayout({ title: titles[2], author: "UP", description: longCjk, hasCover: true }, measure);
    expect(layout.descriptionMore).toBe(true);
    expect(infoLayout({ title: "标题", description: "一句话简介", hasCover: true }, measure).descriptionMore).toBe(false);
    expect(insideCanvasCircle(ABOUT.caption)).toBe(true);
    for (const text of [longCjk, longLatin, "短简介"]) {
      const lines = aboutLayout(text, measure);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(insideCanvasCircle(line.rect)).toBe(true);
        expect(line.rect.y).toBeGreaterThanOrEqual(ABOUT.top);
        expect(line.rect.y + line.rect.height).toBeLessThanOrEqual(ABOUT.bottom + 1e-6);
        expect(measure(line.text, ABOUT.slot)).toBeLessThanOrEqual(line.rect.width + 1e-6);
      }
    }
    expect(aboutLayout(longCjk, measure).at(-1)!.text.endsWith("…")).toBe(true);
  });
  test("lines taper with the circle", () => {
    const layout = infoLayout({ title: "短", description: longCjk, hasCover: true }, measure);
    const widths = layout.description.map(line => line.rect.width);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThanOrEqual(widths[i - 1]!);
    for (const line of layout.description) expect(line.rect.width).toBe(Math.min(INFO.description.maxWidth, chordWidth(line.rect.y, line.rect.y + line.rect.height)));
  });
  test("Douyin descriptions are shown once", () => {
    expect(detailText({ title: "日常vlog", description: "日常vlog" })).toEqual({ title: "日常vlog", description: "" });
    expect(detailText({ title: longCjk, description: longCjk }).title).toBe("");
    expect(detailText({ title: "标题", description: "简介" })).toEqual({ title: "标题", description: "简介" });
  });
  test("flowLines wraps one width per line and stops at the last", () => {
    const lines = flowLines("一二三四五六七八九十一二三四五六七八九十", [60, 48, 36], text => Array.from(text).length * 12);
    expect(lines).toEqual(["一二三四五", "六七八九", "十一…"]);
  });
  test("control pages, gauge, page dots and the entry arrow fit", () => {
    for (const rect of controlRects()) expect(insideCanvasCircle(rect)).toBe(true);
    for (const count of [3, 4]) for (let active = 0; active < count; active++) for (const dot of pageDots(count, active)) expect(insideCanvasCircle(dot)).toBe(true);
    expect(gaugeOuterRadius(true)).toBeLessThanOrEqual(C - EDGE_MARGIN);
    // Stepper circles (what is painted) stay inside the gauge's inner edge.
    const b = controlButtons(), inner = CONTROL.gauge.radius - CONTROL.gauge.selectedWidth / 2;
    for (const rect of [b.minus, b.plus]) expect(Math.hypot(rect.x + rect.width / 2 - C, rect.y + rect.height / 2 - C) + rect.width / 2).toBeLessThan(inner);
    // Page dots sit in the gauge's open bottom.
    const gaugeEndY = C + CONTROL.gauge.radius * Math.sin(Math.PI / 6) + CONTROL.gauge.selectedWidth;
    for (const dot of pageDots(4, 0)) expect(dot.y).toBeGreaterThan(gaugeEndY);
    expect(insideCanvasCircle(ENTRY_ARROW.tab)).toBe(true);
    expect(insideCanvasCircle(ENTRY_ARROW.icon)).toBe(true);
  });
  test("the entry arrow does not touch the crown volume capsule", () => {
    const tab = ENTRY_ARROW.tab;
    for (const p of volumeArcOutline(volumeArcLayout(CANVAS)))
      expect(p.x >= tab.x && p.x <= tab.x + tab.width && p.y >= tab.y && p.y <= tab.y + tab.height).toBe(false);
  });
  test("chord widths match the circle", () => {
    expect(chordWidth(C - 1, C + 1)).toBe(Math.floor(2 * Math.sqrt((C - EDGE_MARGIN) ** 2 - 1)));
    expect(chordWidth(0, 10)).toBe(0);
  });
});

describe("player detail values", () => {
  test("speed steps clamp to 0.5–2×", () => {
    expect(SPEED_STEPS[0]).toBe(.5);
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -9)).toBe(.5);
    expect(stepSpeed(2, 3)).toBe(2);
    expect(stepSpeed(1.1, 0)).toBe(1);
    expect(speedFraction(.5)).toBe(0);
    expect(speedFraction(2)).toBe(1);
  });
  test("hold steps accelerate like the seek buttons", () => {
    expect(holdStepCount(0)).toBe(1);
    expect(holdStepCount(2_000)).toBe(Math.round(seekHoldStep(2_000, 1) / 4_000));
    expect(holdStepCount(60_000)).toBe(15);
  });
  test("pager settles by distance or fling", () => {
    expect(settlePage(0, -80, 0, CANVAS, 4)).toBe(1);
    expect(settlePage(1, 30, 0, CANVAS, 4)).toBe(1);
    expect(settlePage(1, 10, 900, CANVAS, 4)).toBe(0);
    expect(settlePage(3, -100, -900, CANVAS, 4)).toBe(3);
  });
});
