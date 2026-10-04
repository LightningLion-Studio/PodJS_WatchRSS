import type { ReaderPreset } from "./preset.ts";
import { readerColor } from "./content-layout.ts";

/** DetailScreen.kt uses sRGB luminance to choose its reader action surfaces. */
export function readerChrome(preset: ReaderPreset) {
  const color = preset.background.colorArgb;
  const linear = (shift: number) => { const value = ((color >>> shift) & 255) / 255; return value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4); };
  const dark = .2126 * linear(16) + .7152 * linear(8) + .0722 * linear(0) < .5;
  const active = readerColor(preset.accentColorArgb);
  const containerAlpha = dark ? 1 : .96, alpha = .18 + containerAlpha * .82;
  const blended = (shift: number) => Math.round((((preset.accentColorArgb >>> shift) & 255) * .18 + ((dark ? 0xff23272a : 0xffffffff) >>> shift & 255) * containerAlpha * .82) / alpha);
  const summaryAction = readerColor((Math.round(alpha * 255) << 24 | blended(16) << 16 | blended(8) << 8 | blended(0)) >>> 0);
  return { dark, content: readerColor(preset.body.colorArgb), active,
    summaryAction,
    action: dark ? "#23272a" : "#fffffff5", border: dark ? "#00000000" : "#d9cfc3",
    activeAction: dark ? "#23272a" : "#fff0e6", activeBorder: dark ? "#00000000" : `${active.slice(0, 7)}99`,
  };
}
