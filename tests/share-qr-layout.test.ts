import { expect, test } from "bun:test";
import {
  DEFAULT_SHARE_QR_WIDTH_RATIO,
  DETAIL_SHARE_QR_WIDTH_RATIO,
  shareQrLayout,
  shareQrPixelSize,
} from "../src/ui/share-qr-layout.ts";

test("share QR width ratio follows the native default and clamps to 0.1..1", () => {
  expect(DEFAULT_SHARE_QR_WIDTH_RATIO).toBe(0.88);
  expect(DETAIL_SHARE_QR_WIDTH_RATIO).toBe(0.7);
  expect(shareQrLayout().ratio).toBe(0.88);
  expect(shareQrLayout(0).ratio).toBe(0.1);
  expect(shareQrLayout(4).ratio).toBe(1);
  expect(shareQrLayout(Number.NaN).ratio).toBe(0.88);
});

test("share QR geometry derives its rendered width from the configured ratio", () => {
  const detail = shareQrLayout(DETAIL_SHARE_QR_WIDTH_RATIO);
  expect(detail.qrSize).toBeCloseTo(233 * 0.7);
  expect(detail.qrLeft).toBeCloseTo((233 - detail.qrSize) / 2);
  expect(detail.qrTop + detail.qrSize).toBeLessThanOrEqual(233);
  expect(shareQrLayout(0.5).qrSize).toBeCloseTo(116.5);
  expect(shareQrPixelSize(233, 1, 3)).toBe(512);
  expect(shareQrPixelSize(23.3, 1, 2)).toBe(47);
});
