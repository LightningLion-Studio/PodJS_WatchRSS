export const DEFAULT_SHARE_QR_WIDTH_RATIO = 0.88;
export const DETAIL_SHARE_QR_WIDTH_RATIO = 0.7;

export interface ShareQrLayout {
  ratio: number;
  qrSize: number;
  qrLeft: number;
  qrTop: number;
  titleTop: number;
  subtitleTop: number;
}

/** Matches ShareQrScreen's native 0.1..1 width contract on a 233dp canvas. */
export function shareQrLayout(value = DEFAULT_SHARE_QR_WIDTH_RATIO): ShareQrLayout {
  const ratio = Number.isFinite(value)
    ? Math.min(1, Math.max(0.1, value))
    : DEFAULT_SHARE_QR_WIDTH_RATIO;
  const qrSize = 233 * ratio;
  const panelTop = (233 - (60 + qrSize)) / 2;
  return {
    ratio,
    qrSize,
    qrLeft: (233 - qrSize) / 2,
    qrTop: panelTop + 60,
    titleTop: panelTop,
    subtitleTop: panelTop + 32,
  };
}

export function shareQrPixelSize(
  logicalSize: number,
  canvasScale: number,
  density: number,
): number {
  const pixels = Math.round(logicalSize * canvasScale * density);
  return Math.min(512, Math.max(1, Number.isFinite(pixels) ? pixels : 1));
}
