import {createMemo} from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import {createTextEnvironment,type TextEnvironment} from "@podjs/framework/text-environment";
import { SystemTextLine,type SystemTextCache } from "@podjs/framework/text";
import type { ContentStyle } from "../reader/content.ts";
import { readerTextClass, type ReaderRow } from "../reader/content-layout.ts";
import type { ReaderFontResolver } from "../reader/font-assets.ts";
import { DEFAULT_READER_TEXT, resolvedReaderStyle, type ReaderPreset } from "../reader/preset.ts";
import { requiresReaderSystemText, readerTextLineOptions } from "../reader/system-text.ts";

type TextRow = ReaderRow & { kind: "text" };

export type ReaderTextEnvironment=Pick<TextEnvironment,"pixelScale"|"rasterSupported"|"fontMetrics">;
export const createReaderTextEnvironment=createTextEnvironment;

/** The shared reader text primitive used by article, full-preview and selector rows. */
export function ReaderTextRow(props: {
  row: TextRow;
  /** Position the line directly inside a window row. */
  top?: number;
  cache?:SystemTextCache;
  environment?: ReaderTextEnvironment;
  style: ContentStyle;
  fontSize: number;
  width: number;
  preset?: ReaderPreset;
  fonts?: ReaderFontResolver;
  profile?: "compose" | "preview";
  textAlign?: number;
  rasterHeightExtraPx?: number;
  onCarets?: (positions: readonly number[] | undefined,row:TextRow) => void;
}) {
  const row = createMemo(() => props.textAlign === undefined ? props.row : ({ ...props.row, textAlign: props.textAlign }));
  const environment = createMemo(() => props.environment ?? createReaderTextEnvironment());
  const pixelScale = () => environment().pixelScale;
  const style = createMemo(() => props.preset
    ? (props.style === "body" ? props.preset.body : resolvedReaderStyle(props.preset, props.style))
    : { ...DEFAULT_READER_TEXT, fontSizeSp: props.fontSize });
  const fallback = (visible?:()=>boolean) => <Text {...(visible?{accessibilityHidden:true}:{})} class={readerTextClass(props.row.fontSlot)} style={{
    ...(visible?{opacity:visible()?1:0}:{}),
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
  const options = createMemo(() => raster() ? readerTextLineOptions(row(), props.style, props.fontSize, props.width, pixelScale(), props.preset, environment().fontMetrics(props.row.fontSlot), props.fonts, props.profile,props.rasterHeightExtraPx??0) : undefined);
  const textWidth = () => Math.min(props.width, getOps().measureText(props.row.text, props.row.fontSlot) * props.row.scale);
  const left = () => (props.textAlign ?? props.row.textAlign) === 1 ? (props.width - textWidth()) / 2 : 0;
  const baseline = () => props.row.nativeBaseline ?? props.row.lineHeight * .8;
  return <>
    {raster()
      ? <SystemTextLine
          pixelScale={pixelScale()}
          cache={props.cache}
          {...(props.top===undefined?{}:{get top(){return props.top;},renderFallback:(visible:()=>boolean)=>fallback(visible)})}
          options={options()!}
          onCarets={((owner:TextRow)=>positions=>props.onCarets?.(positions,owner))(props.row)}
          fallback={fallback()}
        />
      : props.top===undefined?fallback():<View class="absolute left-[0] right-[0]" style={{insetT:props.top,height:props.row.lineHeight}}>{fallback()}</View>}
    {!raster() && style().underline && <View class="absolute" style={{ insetL: left(), insetT: (props.top??0) + baseline() + 2, width: textWidth(), height: 1, bgColor: props.row.color }}/>}
    {!raster() && style().strikethrough && <View class="absolute" style={{ insetL: left(), insetT: (props.top??0) + baseline() - style().fontSizeSp * .3, width: textWidth(), height: 1, bgColor: props.row.color }}/>}
  </>;
}
