import { Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { createEffect, createMemo, createSignal } from "solid-js";
import { layoutText } from "../reader/index.ts";
import { QRCode } from "./QRCode.tsx";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { safeQrLayout } from "./safe-qr-layout.ts";

export interface SafeQrScreenProps {
  width: number;
  height: number;
  title: string;
  value?: string;
  status: string;
  actionLabel: string;
  onAction: () => void;
  onRefresh?: () => void;
  onError?: (message: string) => void;
  ref?: (value: { scroller: Scroller }) => void;
}

/** Fixed round-screen composition. QRCode owns its exact one-module quiet area. */
export function SafeQrScreen(props: SafeQrScreenProps) {
  const layout = () => safeQrLayout(233, 233);
  const scale = () => Math.min(props.width, props.height) / 233;
  const titleFont = () => 13 * layout().scale, statusFont = () => 11 * layout().scale, statusLineHeight = () => 14 * layout().scale;
  const title = createMemo(() => layoutText(props.title, { width: layout().title.width, measure: text => Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 255 ? titleFont() : Math.ceil(titleFont() * .55)), 0) }).join("\n"));
  const statusLines = createMemo(() => layoutText(props.status, { width: layout().status.width, measure: text => Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 255 ? statusFont() : Math.ceil(statusFont() * .55)), 0) }));
  const [statusPage, setStatusPage] = createSignal(0), statusPages = createMemo(() => statusLines().length > 2 ? statusLines().length : 1);
  createEffect(() => { props.status; setStatusPage(0); });
  const visibleStatus = createMemo(() => statusPages() === 1 ? statusLines() : [statusLines()[statusPage()] || "", `${statusPage() + 1}/${statusPages()} 点击续读`]);
  const entry = createMemo<ScrollEntry>(() => ({ height: props.height, render: () => <View class="absolute" style={{insetL:(props.width-233*scale())/2,insetT:(props.height-233*scale())/2,width:233,height:233,scale:scale(),originX:0,originY:0}}>
    <Text style={{ insetL: layout().title.x, insetT: layout().title.y, width: layout().title.width, height: layout().title.height, lineHeight: 15 }} class="absolute text-[13px] text-white text-center">{title()}</Text>
    <View style={{ insetL: layout().qr.x, insetT: layout().qr.y, width: layout().qr.width, height: layout().qr.height }} class="absolute items-center justify-center">
      {props.value ? <QRCode value={props.value} size={Math.floor(layout().qr.width)} onError={props.onError} /> : null}
    </View>
    <View onPress={statusPages() > 1 ? () => setStatusPage((statusPage() + 1) % statusPages()) : undefined} focusable={statusPages() > 1} style={{ insetL: layout().status.x, insetT: layout().status.y, width: layout().status.width, height: layout().status.height }} class="absolute"><Text style={{ lineHeight: statusLineHeight() }} class="absolute inset-0 text-[11px] text-[#b6b6b6] text-center">{visibleStatus().join("\n")}</Text></View>
    <View onPress={props.onAction} focusable style={{ insetL: layout().action.x, insetT: layout().action.y, width: layout().action.width, height: layout().action.height }} class="absolute rounded-[7] bg-[#2a2a2a] items-center justify-center"><Text class="text-[9px] leading-[13] text-white">{props.actionLabel}</Text></View>
  </View> }));
  return <ScrollEntries fixed height={props.height} entries={[entry()]} gap={0} padding={0} onRefresh={props.onRefresh} ref={props.ref} />;
}

export default SafeQrScreen;
