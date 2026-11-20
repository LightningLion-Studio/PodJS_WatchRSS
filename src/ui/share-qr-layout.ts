import { safeCenteredSquareBelow, safeTopBlock } from "@podjs/framework/watch-ui";

export const DEFAULT_SHARE_QR_WIDTH_RATIO = 0.88;
export const DETAIL_SHARE_QR_WIDTH_RATIO = 0.7;
const CANVAS = 233;

export function shareQrLayout(value = DEFAULT_SHARE_QR_WIDTH_RATIO, round = true) {
  const ratio = Number.isFinite(value)
    ? Math.min(1, Math.max(0.1, value))
    : DEFAULT_SHARE_QR_WIDTH_RATIO;
  const title = round
    ? safeTopBlock(CANVAS, CANVAS, () => 26, { minTop: 14, maxWidth: 120 })!
    : { x: 56.5, y: 14, width: 120, height: 26 };
  const subtitleTop = title.y + title.height + 6;
  const subtitle = round
    ? safeTopBlock(CANVAS, CANVAS, () => 17, { minTop: subtitleTop, maxWidth: 190 })!
    : { x: 21.5, y: subtitleTop, width: 190, height: 17 };
  const qrTop = subtitle.y + subtitle.height + 8;
  const requestedSize = CANVAS * ratio;
  const size = Math.floor(Math.min(requestedSize, CANVAS - qrTop - 2));
  const qr = round
    ? safeCenteredSquareBelow(CANVAS, CANVAS, qrTop, requestedSize)!
    : { x: (CANVAS - size) / 2, y: Math.max(qrTop, (CANVAS - size) / 2), width: size, height: size };
  return { ratio, title, subtitle, qr };
}

export function shareQrPixelSize(
  logicalSize: number,
  canvasScale: number,
  density: number,
): number {
  const pixels = Math.round(logicalSize * canvasScale * density);
  return Math.min(512, Math.max(1, Number.isFinite(pixels) ? pixels : 1));
}
