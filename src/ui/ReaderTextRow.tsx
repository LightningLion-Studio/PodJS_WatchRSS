import {createMemo} from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import {createTextEnvironment,type TextEnvironment} from "@podjs/framework/text-environment";
import { SystemTextLine } from "@podjs/framework/text";
import type { ContentStyle } from "../reader/content.ts";
import { readerTextClass, type ReaderRow } from "../reader/content-layout.ts";
import type { ReaderFontResolver } from "../reader/font-assets.ts";
import { DEFAULT_READER_TEXT, resolvedReaderStyle, type ReaderPreset } from "../reader/preset.ts";
import { requiresReaderSystemText, systemTextOptions } from "../reader/system-text.ts";

type TextRow = ReaderRow & { kind: "text" };

export type ReaderTextEnvironment=Pick<TextEnvironment,"pixelScale"|"rasterSupported"|"fontMetrics">;
export const createReaderTextEnvironment=createTextEnvironment;

/** The shared reader text primitive used by article, full-preview and selector rows. */
export function ReaderTextRow(props: {
  row: TextRow;
  environment?: ReaderTextEnvironment;
  style: ContentStyle;
  fontSize: number;
  width: number;
  preset?: ReaderPreset;
  fonts?: ReaderFontResolver;
  profile?: "compose" | "preview";
  textAlign?: number;
  rasterHeightExtraPx?: number;
  onCarets?: (positions: readonly number[] | undefined) => void;
}) {
  const row = createMemo(() => ({ ...props.row, textAlign: props.textAlign ?? props.row.textAlign }));
  const environment = createMemo(() => props.environment ?? createReaderTextEnvironment());
  const pixelScale = () => environment().pixelScale;
  const style = createMemo(() => props.preset
    ? (props.style === "body" ? props.preset.body : resolvedReaderStyle(props.preset, props.style))
    : { ...DEFAULT_READER_TEXT, fontSizeSp: props.fontSize });
  const fallback = () => <Text class={readerTextClass(props.row.fontSlot)} style={{
    insetT: props.row.textOffsetY ?? 0,
    width: props.width / props.row.scale,
    fontSlot: props.row.fontSlot,
    scale: props.row.scale,
    originX: -.5,
    originY: -.5,
    lineHeight: props.row.lineHeight / props.row.scale,
    textColor: props.row.color,
    tracking: (props.row.tracking ?? 0) / props.row.scale,
    textAlign: props.textAlign ?? props.row.textAlign ?? 0,
  }}>{props.row.text}</Text>;
  const raster = createMemo(() => requiresReaderSystemText(props.row.text, props.preset, props.style) && environment().rasterSupported);
  const options = createMemo(() => raster() ? {
    ...systemTextOptions(row(), props.style, props.fontSize, props.width, pixelScale(), props.preset, environment().fontMetrics(props.row.fontSlot), props.fonts, props.profile),
    heightPx: Math.min(1024, Math.ceil(props.row.lineHeight * pixelScale()) + (props.rasterHeightExtraPx ?? 0)),
  } : undefined);
  const textWidth = () => Math.min(props.width, getOps().measureText(props.row.text, props.row.fontSlot) * props.row.scale);
  const left = () => (props.textAlign ?? props.row.textAlign) === 1 ? (props.width - textWidth()) / 2 : 0;
  const baseline = () => props.row.nativeBaseline ?? props.row.lineHeight * .8;
  return <>
    {raster()
      ? <SystemTextLine
          pixelScale={pixelScale()}
          options={options()!}
          onCarets={props.onCarets}
          fallback={fallback()}
        />
      : fallback()}
    {!raster() && style().underline && <View class="absolute" style={{ insetL: left(), insetT: baseline() + 2, width: textWidth(), height: 1, bgColor: props.row.color }}/>} 
    {!raster() && style().strikethrough && <View class="absolute" style={{ insetL: left(), insetT: baseline() - style().fontSizeSp * .3, width: textWidth(), height: 1, bgColor: props.row.color }}/>} 
  </>;
}
