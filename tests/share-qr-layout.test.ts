import { expect, test } from "bun:test";
import { rectInsideCircle } from "@podjs/framework/watch-ui";
import {
  DEFAULT_SHARE_QR_WIDTH_RATIO,
  DETAIL_SHARE_QR_WIDTH_RATIO,
  shareMiddleEllipsis,
  shareQrLayout,
  shareQrPixelSize,
} from "../src/ui/share-qr-layout.ts";

test("requested share QR ratio retains the native range", () => {
  expect(DEFAULT_SHARE_QR_WIDTH_RATIO).toBe(0.88);
  expect(DETAIL_SHARE_QR_WIDTH_RATIO).toBe(0.7);
  expect(shareQrLayout().ratio).toBe(0.88);
  expect(shareQrLayout(0).ratio).toBe(0.1);
  expect(shareQrLayout(4).ratio).toBe(1);
  expect(shareQrLayout(Number.NaN).ratio).toBe(0.88);
});

test("the titles and all four QR corners fit on the round canvas", () => {
  const circle = { cx: 116.5, cy: 116.5, radius: 116.5 };
  for (const ratio of [0.1, 0.5, DETAIL_SHARE_QR_WIDTH_RATIO, DEFAULT_SHARE_QR_WIDTH_RATIO, 1]) {
    const { title, subtitle, qr } = shareQrLayout(ratio);
    for (const rect of [title, subtitle, qr]) expect(rectInsideCircle(rect, circle, 2)).toBe(true);
    expect(qr.width).toBeLessThanOrEqual(233 * ratio);
    expect(qr.y).toBeGreaterThan(subtitle.y + subtitle.height);
    expect(subtitle.y).toBeGreaterThan(title.y + title.height);
  }
  expect(shareQrLayout(0.5).qr.width).toBe(116);
  expect(shareQrPixelSize(233, 1, 3)).toBe(512);
  expect(shareQrPixelSize(23.3, 1, 2)).toBe(47);
});

test("a six-character 21px share title fits its rounded text rectangle", () => {
  expect(shareQrLayout(DETAIL_SHARE_QR_WIDTH_RATIO).title.width).toBeGreaterThanOrEqual(6 * 21);
});

test("a long share URL retains both ends under the caption width", () => {
  const url = "https://example.test/post/round-watch";
  const measure = (value: string) => Array.from(value).length;
  const short = shareMiddleEllipsis(url, 23, measure);
  expect(short).toBe("https://exa…round-watch");
  expect(measure(short)).toBeLessThanOrEqual(23);
  expect(shareMiddleEllipsis(url, 50, measure)).toBe(url);
});
