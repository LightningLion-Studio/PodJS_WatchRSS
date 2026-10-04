import { defaultReaderPreset } from "../../src/reader/preset.ts";
const base = defaultReaderPreset("fixture", " 原生预设 ");
const cases = [base,
  defaultReaderPreset("light", "默认浅色", false, 22),
  { ...base, schemaVersion: 1, title: { fontScale: 2, fontWeight: 600 }, subtitle: { fontSizeSp: 17 } },
  { ...base, categoryTypographyEnabled: true, body: { ...base.body, fontAssetId: "body-font", fontFaceIndex: 3, variationSettings: "'wght' 530" }, title: { useOwnFont: false, fontAssetId: "ignored-font", fontFaceIndex: 5, variationSettings: "'wght' 750", fontScale: 2 }, subtitle: { useOwnFont: true }, quote: { useOwnFont: true, fontAssetId: "quote-font", fontSizeSp: 19, fontScale: 2.5 }, code: { italic: true, underline: false, colorArgb: 0 }, link: { alignment: "CENTER", strikethrough: true } },
  { ...base, categoryTypographyEnabled: true, body: { ...base.body, fontSizeSp: 100, fontWeight: 999, lineHeightEm: .1, letterSpacingEm: -2, paragraphSpacingDp: 99, firstLineIndentEm: 12, horizontalPaddingDp: -5 }, title: { fontFaceIndex: -4, fontSizeSp: 1, fontScale: 6, fontWeight: 50, lineHeightEm: 8, letterSpacingEm: 3 }, background: { ...base.background, type: "VIDEO", assetId: "video", posterAssetId: "poster", zoom: 99, focusX: -1, focusY: 8, rotationDegrees: 270, blurDp: 100, brightness: 4, saturation: -2, overlayOpacity: 8, videoTrimStartMs: 90_000, videoTrimEndMs: 999_999, videoSpeed: 20, loop: false } },
  { ...base, body: { ...base.body, fontSizeSp: 1, fontWeight: 1, lineHeightEm: 9, letterSpacingEm: 3, alignment: "invalid", lineBreakMode: "invalid", hyphenation: "invalid", renderMode: "invalid", fontSynthesis: "invalid" }, background: { ...base.background, type: "invalid", fit: "invalid", videoTrimStartMs: -1000, videoTrimEndMs: -500 } },
];
await Bun.write(new URL("../../tests/fixtures/reader-presets-input.json", import.meta.url), JSON.stringify(cases, null, 2) + "\n");
