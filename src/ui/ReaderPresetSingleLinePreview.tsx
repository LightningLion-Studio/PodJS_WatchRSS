import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('ReaderPresetSingleLinePreview');
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { textLayout } from "@podjs/framework/services";
import { getDisplayMetrics, getFontMetrics, hasCapability } from "@podjs/framework/watch";
import type { ContentBlock } from "../reader/content.ts";
import { createContentLayouter, type NativeBlockLayouts } from "../reader/content-layout.ts";
import type { ReaderFontResolver } from "../reader/font-assets.ts";
import type { ReaderPreset } from "../reader/preset.ts";
import { requestReaderLayout } from "../reader/platform-layout.ts";
import type { ReaderBackgroundSnapshot } from "../reader/background-assets.ts";
import { ReaderBackground } from "./ReaderBackground.tsx";
import { ReaderTextRow } from "./ReaderTextRow.tsx";

/** Native-equivalent selector row: real BODY typography over the real background. */
export function ReaderPresetSingleLinePreview(props: {
  preset: ReaderPreset;
  snapshot: ReaderBackgroundSnapshot;
  fonts: ReaderFontResolver;
  width: number;
  height: number;
  active: boolean;
}) {
  const contentWidth = () => Math.max(1, props.width - 16);
  const block = createMemo<ContentBlock>(() => ({ type: "text", style: "body", text: `${props.preset.name} · 正文预览` }));
  const [native, setNative] = createSignal<NativeBlockLayouts>(new Map());
  const layOut = createContentLayouter((text, slot) => getOps().measureText(text, slot), undefined, getFontMetrics);
  createEffect(() => {
    const current = block(), width = contentWidth(), preset = props.preset;
    setNative(new Map());
    if (!hasCapability("text.layout")) return;
    const metrics = getDisplayMetrics();
    const task = requestReaderLayout([current], width, preset.body.fontSizeSp, metrics.physicalWidth / metrics.logicalWidth, preset, args => textLayout.layout(args), setNative, error => logConsole.warn("Reader preset line layout", String(error)), props.fonts, "preview");
    onCleanup(() => task.cancel());
  });
  const row = createMemo(() => layOut([block()], contentWidth(), props.preset.body.fontSizeSp, {}, props.preset, native()).rows.find(value => value.kind === "text"));
  return <View class="absolute inset-0 overflow-hidden">
    <ReaderBackground background={props.preset.background} snapshot={props.snapshot} width={props.width} height={props.height} active={props.active}/>
    <Show when={row()}>{value => <View class="absolute left-[8] right-[8] overflow-hidden" style={{ insetT: Math.max(0, (props.height - value().lineHeight) / 2), height: Math.min(props.height, value().lineHeight) }}>
      <ReaderTextRow row={value()} style="body" fontSize={props.preset.body.fontSizeSp} width={contentWidth()} preset={props.preset} fonts={props.fonts} profile="preview" rasterHeightExtraPx={2}/>
    </View>}</Show>
  </View>;
}
