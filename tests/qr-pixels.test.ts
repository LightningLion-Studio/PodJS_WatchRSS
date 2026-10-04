import { expect, test } from "bun:test";
import qrcode from "qrcode-generator";
import { qrPixels } from "../src/ui/qr-pixels";

for (const value of ["https://example.com/login", "https://example.com/" + "a".repeat(450)]) {
  test(`QR preserves every module and exactly one quiet module (${value.length})`, () => {
    const qr = qrcode(0, "M"); qr.addData(value); qr.make();
    const count = qr.getModuleCount(), total = count + 2;
    const data = qrPixels(value);
    for (let y = 0; y < total; y++) for (let x = 0; x < total; x++) {
      const px = Math.floor((Math.round(x * 256 / total) + Math.round((x + 1) * 256 / total)) / 2);
      const py = Math.floor((Math.round(y * 256 / total) + Math.round((y + 1) * 256 / total)) / 2);
      const dark = x > 0 && y > 0 && x <= count && y <= count && qr.isDark(y - 1, x - 1);
      expect(data[(py * 256 + px) * 4]).toBe(dark ? 0 : 255);
    }
    expect(data.length).toBe(256 * 256 * 4);
  });
}
