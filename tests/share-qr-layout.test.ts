import { expect, test } from "bun:test";
import { rectInsideCircle } from "@podjs/framework/watch-ui";
import {
  DEFAULT_SHARE_QR_WIDTH_RATIO,
  DETAIL_SHARE_QR_WIDTH_RATIO,
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
