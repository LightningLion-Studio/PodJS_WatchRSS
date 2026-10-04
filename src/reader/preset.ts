/** Data contract from Android ReaderPresetModels.kt, schema version 2. */
export type ReaderAlignment = "START" | "CENTER" | "JUSTIFY";
export type TypographyRole = "title" | "subtitle" | "quote" | "code" | "link";
export interface ReaderTextStyle {
  fontAssetId: string | null; fontFaceIndex: number; variationSettings: string;
  fontSizeSp: number; fontWeight: number; italic: boolean; underline: boolean; strikethrough: boolean;
  colorArgb: number; lineHeightEm: number; letterSpacingEm: number; paragraphSpacingDp: number;
  firstLineIndentEm: number; horizontalPaddingDp: number; alignment: ReaderAlignment;
  lineBreakMode: "SYSTEM" | "SIMPLE" | "PARAGRAPH"; hyphenation: "NONE" | "AUTO";
  renderMode: "SYSTEM" | "READABILITY" | "LINEAR_SMOOTH"; fontSynthesis: "ENABLED" | "DISABLED";
}
type Overridable = Pick<ReaderTextStyle, "fontAssetId" | "fontFaceIndex" | "variationSettings" | "fontSizeSp" | "fontWeight" | "italic" | "underline" | "strikethrough" | "colorArgb" | "lineHeightEm" | "letterSpacingEm" | "alignment">;
export type ReaderTextOverride = { [K in keyof Overridable]?: Overridable[K] | null } & { useOwnFont?: boolean; fontScale?: number | null };
export interface ReaderBackground {
  type: "SOLID" | "IMAGE" | "VIDEO"; colorArgb: number; assetId: string | null;
  fit: "CROP" | "FIT" | "FILL"; focusX: number; focusY: number; zoom: number; rotationDegrees: number;
  blurDp: number; brightness: number; saturation: number; overlayColorArgb: number; overlayOpacity: number;
  videoTrimStartMs: number; videoTrimEndMs: number; videoSpeed: number; loop: boolean; posterAssetId: string | null;
}
export interface ReaderPreset {
  schemaVersion: 2; id: string; name: string; body: ReaderTextStyle; categoryTypographyEnabled: boolean;
  title: ReaderTextOverride; subtitle: ReaderTextOverride; quote: ReaderTextOverride; code: ReaderTextOverride; link: ReaderTextOverride;
  background: ReaderBackground; codeBackgroundColorArgb: number; accentColorArgb: number;
  updatedAt: number; modifiedBy: string; deleted: boolean;
}
export const FALLBACK_PRESET_ID = "reader-system-fallback";
export const DEFAULT_READER_TEXT: Readonly<ReaderTextStyle> = Object.freeze({
  fontAssetId: null, fontFaceIndex: 0, variationSettings: "", fontSizeSp: 14, fontWeight: 400,
  italic: false, underline: false, strikethrough: false, colorArgb: 0xfff2f2f2,
  lineHeightEm: 1.35, letterSpacingEm: 0, paragraphSpacingDp: 6, firstLineIndentEm: 0, horizontalPaddingDp: 14,
  alignment: "START", lineBreakMode: "PARAGRAPH", hyphenation: "NONE", renderMode: "READABILITY", fontSynthesis: "ENABLED",
});
export const DEFAULT_READER_BACKGROUND: Readonly<ReaderBackground> = Object.freeze({
  type: "SOLID", colorArgb: 0xff000000, assetId: null, fit: "CROP", focusX: .5, focusY: .5, zoom: 1,
  rotationDegrees: 0, blurDp: 0, brightness: 1, saturation: 1, overlayColorArgb: 0xff000000, overlayOpacity: 0,
  videoTrimStartMs: 0, videoTrimEndMs: 60_000, videoSpeed: 1, loop: true, posterAssetId: null,
});
export function defaultCodeBackground(color: number): number {
  const channel = (shift: number) => Math.floor((((color >>> shift) & 255) * 82 + ((0xffd8a52b >>> shift) & 255) * 18 + 50) / 100);
  return (0xff000000 | channel(16) << 16 | channel(8) << 8 | channel(0)) >>> 0;
}
export function defaultReaderPreset(id = FALLBACK_PRESET_ID, name = "安全默认", dark = true, fontSizeSp = 14): ReaderPreset {
  const background = { ...DEFAULT_READER_BACKGROUND, colorArgb: dark ? 0xff000000 : 0xfff8f3ec };
  return { schemaVersion: 2, id, name, body: { ...DEFAULT_READER_TEXT, fontSizeSp, colorArgb: dark ? 0xfff2f2f2 : 0xff221f1b }, categoryTypographyEnabled: false,
    title: {}, subtitle: {}, quote: {}, code: {}, link: {}, background, codeBackgroundColorArgb: defaultCodeBackground(background.colorArgb), accentColorArgb: dark ? 0xffff5a36 : 0xffd94720, updatedAt: 0, modifiedBy: "", deleted: false };
}

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const finite = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const bool = (v: unknown, fallback = false) => typeof v === "boolean" ? v : fallback;
const string = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const nullableString = (v: unknown) => typeof v === "string" && v.trim() ? v : null;
function enumeration<T extends string>(v: unknown, choices: readonly T[], fallback: T): T { return choices.includes(v as T) ? v as T : fallback; }
const bodyBounds: Partial<Record<keyof ReaderTextStyle, [number, number]>> = {
  fontSizeSp: [10, 64], fontWeight: [100, 900], lineHeightEm: [.8, 3], letterSpacingEm: [-.1, .5],
  paragraphSpacingDp: [0, 64], firstLineIndentEm: [0, 4], horizontalPaddingDp: [0, 64],
};
function textStyle(raw: unknown): ReaderTextStyle {
  const j = record(raw), result = { ...DEFAULT_READER_TEXT };
  for (const key of Object.keys(result) as (keyof ReaderTextStyle)[]) {
    const fallback = result[key];
    if (typeof fallback === "number") {
      const bounds = bodyBounds[key], n = finite(j[key], fallback);
      (result as unknown as RecordValue)[key] = bounds ? clamp(n, ...bounds) : n;
    } else if (typeof fallback === "boolean") (result as unknown as RecordValue)[key] = bool(j[key], fallback);
  }
  return { ...result, fontAssetId: nullableString(j.fontAssetId), fontFaceIndex: Math.trunc(result.fontFaceIndex), fontWeight: Math.trunc(result.fontWeight), variationSettings: string(j.variationSettings),
    alignment: enumeration(j.alignment, ["START", "CENTER", "JUSTIFY"], "START"), lineBreakMode: enumeration(j.lineBreakMode, ["SYSTEM", "SIMPLE", "PARAGRAPH"], "PARAGRAPH"),
    hyphenation: enumeration(j.hyphenation, ["NONE", "AUTO"], "NONE"), renderMode: enumeration(j.renderMode, ["SYSTEM", "READABILITY", "LINEAR_SMOOTH"], "READABILITY"), fontSynthesis: enumeration(j.fontSynthesis, ["ENABLED", "DISABLED"], "ENABLED") };
}
function override(raw: unknown): ReaderTextOverride {
  const j = record(raw), result: ReaderTextOverride = { useOwnFont: bool(j.useOwnFont), fontAssetId: nullableString(j.fontAssetId), variationSettings: nullableString(j.variationSettings) };
  for (const key of ["fontFaceIndex", "fontSizeSp", "fontScale", "fontWeight", "colorArgb", "lineHeightEm", "letterSpacingEm"] as const) {
    const v = j[key];
    if (typeof v !== "number" || !Number.isFinite(v)) { result[key] = null; continue; }
    const bounds = key === "fontScale" ? [.5, 2.5] as const : key === "fontFaceIndex" ? [0, Number.MAX_SAFE_INTEGER] as const : bodyBounds[key];
    const n = bounds ? clamp(v, bounds[0], bounds[1]) : v;
    result[key] = key === "fontFaceIndex" || key === "fontWeight" ? Math.trunc(n) : n;
  }
  for (const key of ["italic", "underline", "strikethrough"] as const) result[key] = typeof j[key] === "boolean" ? j[key] : null;
  result.alignment = ["START", "CENTER", "JUSTIFY"].includes(j.alignment as string) ? j.alignment as ReaderAlignment : null;
  return result;
}
function background(raw: unknown): ReaderBackground {
  const j = record(raw), result = { ...DEFAULT_READER_BACKGROUND };
  const bounds: Partial<Record<keyof ReaderBackground, [number, number]>> = {
    focusX: [0, 1], focusY: [0, 1], zoom: [.25, 8], rotationDegrees: [-180, 180], blurDp: [0, 64],
    brightness: [0, 2], saturation: [0, 2], overlayOpacity: [0, 1], videoSpeed: [.25, 4],
  };
  for (const key of Object.keys(result) as (keyof ReaderBackground)[]) {
    const fallback = result[key];
    if (typeof fallback !== "number") continue;
    const n = finite(j[key], fallback), range = bounds[key];
    (result as unknown as RecordValue)[key] = range ? clamp(n, ...range) : n;
  }
  // Native normalization uses the incoming start for both end bounds, before copying.
  const incomingStart = Math.trunc(result.videoTrimStartMs);
  return { ...result, type: enumeration(j.type, ["SOLID", "IMAGE", "VIDEO"], "SOLID"), fit: enumeration(j.fit, ["CROP", "FIT", "FILL"], "CROP"),
    assetId: nullableString(j.assetId), posterAssetId: nullableString(j.posterAssetId), loop: bool(j.loop, true),
    videoTrimStartMs: Math.max(0, incomingStart), videoTrimEndMs: clamp(Math.trunc(result.videoTrimEndMs), incomingStart, incomingStart + 60_000) };
}

export function decodeReaderPreset(raw: unknown): ReaderPreset {
  const j = record(typeof raw === "string" ? JSON.parse(raw) : raw);
  const version = Math.trunc(finite(j.schemaVersion, 1));
  if (version > 2) throw new Error("不支持的阅读器预设版本");
  if (typeof j.id !== "string" || !j.id || typeof j.name !== "string") throw new Error("阅读器预设缺少标识或名称");
  const bg = background(j.background);
  return { schemaVersion: 2, id: j.id, name: j.name.trim().slice(0, 40), body: textStyle(j.body), categoryTypographyEnabled: version < 2 || bool(j.categoryTypographyEnabled),
    title: override(j.title), subtitle: override(j.subtitle), quote: override(j.quote), code: override(j.code), link: override(j.link),
    background: bg, codeBackgroundColorArgb: finite(j.codeBackgroundColorArgb, defaultCodeBackground(bg.colorArgb)), accentColorArgb: finite(j.accentColorArgb, 0xffff5a36),
    updatedAt: Math.trunc(finite(j.updatedAt, 0)), modifiedBy: string(j.modifiedBy), deleted: bool(j.deleted) };
}

function resolveOverride(base: ReaderTextStyle, custom: ReaderTextOverride): ReaderTextStyle {
  const result = { ...base };
  for (const key of ["fontWeight", "italic", "underline", "strikethrough", "colorArgb", "lineHeightEm", "letterSpacingEm", "alignment"] as const)
    if (custom[key] != null) (result as unknown as RecordValue)[key] = custom[key];
  if (custom.useOwnFont) {
    result.fontAssetId = custom.fontAssetId ?? null;
  }
  result.fontFaceIndex = custom.fontFaceIndex ?? base.fontFaceIndex;
  result.variationSettings = custom.variationSettings ?? base.variationSettings;
  result.fontSizeSp = custom.fontSizeSp ?? (custom.fontScale == null ? base.fontSizeSp : Math.fround(Math.fround(base.fontSizeSp) * Math.fround(custom.fontScale)));
  return result;
}
export function resolvedReaderStyle(preset: ReaderPreset, role: TypographyRole): ReaderTextStyle {
  const alpha = (a: number) => ((preset.body.colorArgb & 0xffffff) | a << 24) >>> 0;
  const defaults: Record<TypographyRole, ReaderTextOverride> = {
    title: { fontScale: 1.55, fontWeight: 700 }, subtitle: { fontScale: 1.12, colorArgb: alpha(0xcb) },
    quote: { fontScale: 1, colorArgb: alpha(0xd0) }, code: { fontScale: .9 }, link: { fontScale: 1, colorArgb: preset.accentColorArgb },
  };
  const category = resolveOverride(preset.body, defaults[role]);
  if (!preset.categoryTypographyEnabled) return category;
  const custom = preset[role], result = resolveOverride(category, custom);
  // Explicit category scale is relative to BODY, not the default category size.
  if (custom.fontSizeSp == null && custom.fontScale != null) result.fontSizeSp = Math.fround(Math.fround(preset.body.fontSizeSp) * Math.fround(custom.fontScale));
  return result;
}
