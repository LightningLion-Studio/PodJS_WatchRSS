import { describe, expect, test } from "bun:test";
import { ABOUT, ABOUT_MAX_CHARS, aboutLineIterator, CANVAS, chordWidth, columnLayout, CONTROL, controlCentreOffset, controlRects, controlRow, detailText, EDGE_MARGIN, ENTRY_ARROW, flowLines, INFO, INFO_HEIGHT, infoLayout, infoRects, insideCanvasCircle, pillFill, SPEED_STEPS, speedFraction, stepSpeed } from "../src/ui/player-detail-layout.ts";
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
  test("an overflowing description continues below the info block at the column width", () => {
    const layout = infoLayout({ title: titles[2], author: "UP", description: longCjk, hasCover: true }, measure);
    expect(layout.descriptionMore).toBe(true);
    expect(infoLayout({ title: "标题", description: "一句话简介", hasCover: true }, measure).descriptionMore).toBe(false);
    for (const text of [longCjk, longLatin, "短简介"]) {
      const lines = Array.from(aboutLineIterator(text, measure));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(measure(line, ABOUT.slot)).toBeLessThanOrEqual(ABOUT.width + 1e-6);
      expect(lines.at(-1)!.endsWith("…")).toBe(false);
    }
    // At the centre band, where text is read, a full-width line is inside the circle.
    expect(chordWidth(C - ABOUT.lineHeight / 2, C + ABOUT.lineHeight / 2)).toBeGreaterThanOrEqual(ABOUT.width);
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
  test("a control row centred on the canvas fits, with a pill bar between its steppers", () => {
    const offset = C - CONTROL.height / 2, at = (r: { x: number; y: number; width: number; height: number }) => ({ ...r, y: r.y + offset });
    for (const selected of [false, true]) for (const rect of controlRects(selected)) expect(insideCanvasCircle(at(rect))).toBe(true);
    const row = controlRow(), pill = row.pill(false), selected = row.pill(true);
    expect(row.minus.x + row.minus.width).toBeLessThan(pill.x);
    expect(pill.x + pill.width).toBeLessThan(row.plus.x);
    expect(pill.width).toBeGreaterThan(pill.height * 4);
    expect(selected.y + selected.height / 2).toBeCloseTo(pill.y + pill.height / 2);
    for (const rect of [pill, selected]) expect(rect.y).toBeGreaterThanOrEqual(row.pillHit.y);
    expect(pillFill(pill, 0)).toBeUndefined();
    expect(pillFill(pill, .001)!.width).toBe(pill.height);
    expect(pillFill(pill, .5)!.width).toBe(pill.width / 2);
    expect(pillFill(pill, 7)!.width).toBe(pill.width);
    expect(insideCanvasCircle(ENTRY_ARROW.tab)).toBe(true);
    expect(insideCanvasCircle(ENTRY_ARROW.icon)).toBe(true);
  });
  test("the round touch target contains the tab and icon with all corners inside the circle", () => {
    const { roundHit: hit, tab, icon } = ENTRY_ARROW;
    expect(insideCanvasCircle(hit)).toBe(true);
    for (const rect of [tab, icon]) {
      expect(rect.x).toBeGreaterThanOrEqual(hit.x);
      expect(rect.y).toBeGreaterThanOrEqual(hit.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(hit.x + hit.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(hit.y + hit.height);
    }
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
  test("the column scrolls until the last control row is centred", () => {
    const layout = columnLayout(12, 3);
    expect(layout.about).toBe(INFO_HEIGHT);
    expect(layout.controls).toBeGreaterThan(layout.about + 12 * ABOUT.lineHeight);
    expect(controlCentreOffset(layout, 2)).toBe(layout.max);
    expect(controlCentreOffset(layout, 0)).toBe(layout.controls + CONTROL.height / 2 - C);
    expect(columnLayout(0, 2).controls).toBe(INFO_HEIGHT);
  });
});

test('the complete description remains readable past 400 characters',()=>{
 const text='简介👩‍👧‍👦与拉丁text'.repeat(160)+'末尾验证',lines=Array.from(aboutLineIterator(text,measure));
 for(const line of lines)expect(measure(line,ABOUT.slot)).toBeLessThanOrEqual(ABOUT.width);
 expect(lines.join('')).toBe(text);expect(lines.length).toBeGreaterThan(20);
 const long='甲'.repeat(ABOUT_MAX_CHARS-10)+'结束标记';expect(Array.from(aboutLineIterator(long,measure)).join('')).toBe(long);
 const over=Array.from(aboutLineIterator('乙'.repeat(ABOUT_MAX_CHARS+5),measure)).join('');expect(over.endsWith('…')).toBe(true);expect(Array.from(over)).toHaveLength(ABOUT_MAX_CHARS+1);
});
