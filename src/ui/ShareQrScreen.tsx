import {getDisplayMetrics} from "@podjs/framework/watch";
import {shareQrPresentation} from "../sharing/policy.ts";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createMemo, createSignal } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { QRCode } from "./QRCode.tsx";
import { shareQrLayout, shareQrPixelSize } from "./share-qr-layout.ts";

export interface ShareQrScreenProps { active?: () => boolean; width: number; height: number; title: string; url: string; topHint?:string; qrWidthRatio?:number; onClose: () => void; onError?: (message: string) => void }

function Marquee(props: { active?: () => boolean; text: string; top: number; left: number; width: number; size: 21 | 12 }) {
  const text=()=>props.text.split("\n",1)[0];
  const measured = createMemo(() => Array.from(text()).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 255 ? props.size : Math.ceil(props.size * .55)), 0));
  const [offset, setOffset] = createSignal(0); const started = Date.now();
  onFrame(() => { if (props.active?.() === false) return; const overflow = measured() - props.width; if (overflow <= 0) { if (offset() !== 0) setOffset(0); return; } const elapsed = Date.now() - started, pause = 1100, travel = overflow * 45, cycle = pause * 2 + travel; const phase = elapsed % cycle; setOffset(phase < pause ? 0 : phase < pause + travel ? -(phase - pause) / 45 : -overflow); }, () => props.active?.() !== false && measured() > props.width);
  const textWidth = () => Math.max(props.width, measured());
  const overflow = () => measured() > props.width;
  return <View style={{ insetL: props.left, insetT: props.top, width: props.width, height: props.size + 5 }} class="absolute overflow-hidden"><Text style={{ width: textWidth(), translateX: overflow() ? offset() : 0 }} class={props.size === 21 ? (overflow() ? "absolute left-[0] top-[0] text-[21px] leading-[26] text-white text-left" : "absolute left-[0] top-[0] text-[21px] leading-[26] text-white text-center") : (overflow() ? "absolute left-[0] top-[0] text-xs leading-[14] text-[#b6b6b6] text-left" : "absolute left-[0] top-[0] text-xs leading-[14] text-[#b6b6b6] text-center")}>{text()}</Text></View>;
}

/** Android ShareQrScreen structure without blur/entry animation unsupported by PocketJS. */
export function ShareQrScreen(props: ShareQrScreenProps) {
  const content=()=>shareQrPresentation(props.title,props.url,props.topHint);
  const metrics = getDisplayMetrics();
  const layout = createMemo(() => shareQrLayout(props.qrWidthRatio, metrics.shape === "round"));
  let viewport: NodeMirror | undefined;
  createGesture({ region: { node: () => viewport }, axis: "y", onTap: () => props.onClose() });
  const scale = () => Math.min(props.width / 233, props.height / 233), left = () => (props.width - 233 * scale()) / 2, top = () => (props.height - 233 * scale()) / 2;
  const pixelSize=()=>shareQrPixelSize(layout().qr.width,scale(),metrics.density);
  return <View ref={node => viewport = node} onPress={props.onClose} focusable class="absolute inset-0 bg-black"><View class="absolute" style={{ insetL: left(), insetT: top(), width: 233, height: 233, scale: scale(), originX: 0, originY: 0 }}>
    <Marquee active={props.active} text={content().title} left={layout().title.x} top={layout().title.y} width={layout().title.width} size={21} />
    <Marquee active={props.active} text={content().subtitle} left={layout().subtitle.x} top={layout().subtitle.y} width={layout().subtitle.width} size={12} />
    <View class="absolute items-center justify-center" style={{insetL:layout().qr.x,insetT:layout().qr.y,width:layout().qr.width,height:layout().qr.height}}><QRCode quietZone={4} pixelSize={pixelSize()} value={content().link} size={layout().qr.width} onError={props.onError} /></View>
  </View></View>;
}

export default ShareQrScreen;
