import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('BeianText');
import { Text, View } from "@pocketjs/framework/components";
import { textLayout, type TextLayoutOptions } from "@podjs/framework/services";
import { SystemTextLine, type SystemTextLineOptions } from "@podjs/framework/text";
import { hasCapability } from "@podjs/framework/watch";
import { createEffect, createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js";
import {composeLineHeightPx,composeSpToPx} from './compose-font-scale.ts';

const WATCH_FONT_ASSET = "fonts/watch-sans.ttf";

export interface BeianTextLine {
  heightPx: number;
  options?: SystemTextLineOptions;
}

/** Typography supplies line height, but Compose's single-line TrimBoth keeps
 * the font's natural height. Use the reference Compose version's font-scaling
 * curve with the host's current setting; Android platform SP differs from it. */
export function useBeianText(width: Accessor<number>, density: number) {
  const widthPx = createMemo(() => Math.max(1, Math.round(width() * density) - 2 * Math.round(18 * density)));
  const [measured, setMeasured] = createSignal<{ title: BeianTextLine; subtitle: BeianTextLine }>();
  const fallback = (lineHeight: number): BeianTextLine => ({ heightPx: Math.max(1, Math.round(lineHeight * density)) });
  createEffect(() => {
    const availablePx = widthPx();
    setMeasured(undefined);
    if (!hasCapability("text.layout") || !hasCapability("text.raster")) return;
    const paragraph = (text: string, size: number, lineHeight: number, colorArgb: number, fontScale: number): TextLayoutOptions => ({
      text, widthPx: availablePx, fontAsset: WATCH_FONT_ASSET,
      // Native registers this same variable resource as Normal/Medium/SemiBold.
      // Its Medium descriptor does not itself change the default wght=400 axis.
      fontWeight: 400,
      fontSizePx: composeSpToPx(size,density,fontScale),
      lineHeightPx: composeLineHeightPx(lineHeight,composeSpToPx(size,density,fontScale),density,fontScale),
      lineHeightMode: "span", fallbackLineSpacing: true, lineBreak: "simple",
      align: "center", textMotion: "static", colorArgb,
    });
    let current = true;
    const requests:ReturnType<typeof textLayout.layout>[]=[];
    onCleanup(() => { current = false; for(const request of requests)request.cancel(); });
    const line = (source: TextLayoutOptions, result: Awaited<ReturnType<typeof textLayout.layout>['result']>): BeianTextLine => {
      if (result.lines.length !== 1) throw Error("备案文字意外换行");
      const row = result.lines[0]!;
      const heightPx = row.bottomPx - row.topPx, baselinePx = row.baselinePx - row.topPx;
      if (!Number.isInteger(heightPx) || heightPx < 1 || heightPx > 1024 || !Number.isFinite(baselinePx) || baselinePx < 0 || baselinePx > heightPx)
        throw Error("备案文字测量结果无效");
      return { heightPx, options: { ...source, heightPx, baselinePx, paragraph: { ...source, lineIndex: 0 } } };
    };
    void(async()=>{
      const environment=hasCapability('text.environment')?await textLayout.environment():{fontScale:1};
      if(!current)return;
      if(!Number.isFinite(environment.fontScale)||environment.fontScale<=0)throw Error('系统字体缩放无效');
      const title = paragraph("工信部备案", 21, 26, 0xfff5f5f5,environment.fontScale);
      const subtitle = paragraph("beian.miit.gov.cn", 12, 14, 0xffb6b6b6,environment.fontScale);
      const titleRequest=textLayout.layout(title),subtitleRequest=textLayout.layout(subtitle);
      requests.push(titleRequest,subtitleRequest);
      const [titleResult,subtitleResult]=await Promise.all([titleRequest.result,subtitleRequest.result]);
      if(current)setMeasured({title:line(title,titleResult),subtitle:line(subtitle,subtitleResult)});
    })().catch(error => { if (current) logConsole.warn("Beian text layout", String(error)); });
  });
  return { widthPx, title: () => measured()?.title ?? fallback(26), subtitle: () => measured()?.subtitle ?? fallback(14) };
}

/** Visible atlas text is a temporary fallback, not the measured final render.
 * The owning row provides the stable accessibility node for both renderers. */
export function BeianText(props: { line: BeianTextLine; density: number; title?: boolean }) {
  const fallback = () => props.title
    ? <Text class="absolute inset-0 text-[21px] leading-[26] text-center text-[#f5f5f5]">工信部备案</Text>
    : <Text class="absolute inset-0 text-xs leading-[14] text-center text-[#b6b6b6]">beian.miit.gov.cn</Text>;
  return <View accessibilityHidden class="absolute inset-0">
    <Show when={props.line.options} fallback={fallback()}>{options =>
      <SystemTextLine options={options()} pixelScale={props.density} fallback={fallback()} />
    }</Show>
  </View>;
}

/** Compose measures non-weight Column children in order, giving each the
 * remaining height. size(120.dp) is constrained independently on each axis;
 * the Image then fits its unchanged square bitmap inside that measured frame. */
export function beianColumnLayout(width: number, height: number, density: number, titleHeightPx: number, subtitleHeightPx: number, qrAvailable: boolean) {
  const safePx = Math.round(18 * density), physicalWidth = Math.round(width * density);
  const availableWidthPx = Math.max(0, physicalWidth - 2 * safePx);
  const availableHeightPx = Math.max(0, Math.round(height * density) - 2 * safePx);
  let remainingHeightPx = availableHeightPx;
  const measureHeight = (requestedPx: number) => {
    const measuredPx = Math.min(Math.max(0, requestedPx), remainingHeightPx);
    remainingHeightPx -= measuredPx;
    return measuredPx;
  };
  const titlePx = measureHeight(titleHeightPx), titleGapPx = measureHeight(Math.round(8 * density));
  const subtitlePx = measureHeight(subtitleHeightPx), qrGapPx = measureHeight(Math.round(16 * density));
  const requestedQrPx = Math.round(120 * density);
  const qrWidthPx = qrAvailable ? Math.min(requestedQrPx, availableWidthPx) : 0;
  const qrHeightPx = qrAvailable ? measureHeight(requestedQrPx) : 0;
  const columnHeightPx = availableHeightPx - remainingHeightPx;
  const topPx = safePx + Math.round((availableHeightPx - columnHeightPx) / 2);
  const subtitleTopPx = topPx + titlePx + titleGapPx;
  return {
    left: safePx / density, width: availableWidthPx / density,
    titleTop: topPx / density, titleHeight: titlePx / density,
    subtitleTop: subtitleTopPx / density, subtitleHeight: subtitlePx / density,
    qrTop: (subtitleTopPx + subtitlePx + qrGapPx) / density,
    qrLeft: (safePx + Math.round((availableWidthPx - qrWidthPx) / 2)) / density,
    qrWidth: qrWidthPx / density, qrHeight: qrHeightPx / density,
  };
}
