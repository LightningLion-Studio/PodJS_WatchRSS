import { describe, expect, test } from "bun:test";
import { rectInsideCircle, safeQrLayout } from "../src/ui/safe-qr-layout.ts";

describe("safe QR geometry", () => {
  for (const [width, height] of [[233, 233], [192, 192], [160, 160], [280, 233], [233, 280]]) {
    test(`${width}x${height} keeps every corner in the safe circle`, () => {
      const layout = safeQrLayout(width, height);
      for (const rect of [layout.title, layout.qr, layout.status, layout.action]) expect(rectInsideCircle(rect, layout, layout.scale)).toBe(true);
    });
  }
});
