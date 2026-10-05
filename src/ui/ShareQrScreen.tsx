import {getDisplayMetrics} from "@podjs/framework/watch";
import {shareQrPresentation} from "../sharing/policy.ts";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createSignal } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { QRCode } from "./QRCode.tsx";
import { shareQrLayout, shareQrPixelSize } from "./share-qr-layout.ts";

export interface ShareQrScreenProps { width: number; height: number; title: string; url: string; topHint?:string; qrWidthRatio?:number; onClose: () => void; onError?: (message: string) => void }

function Marquee(props: { text: string; top: number; left: number; width: number; size: 21 | 12 }) {
  const text=()=>props.text.split("\n",1)[0];
  const measured = () => Array.from(text()).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 255 ? props.size : Math.ceil(props.size * .55)), 0);
  const [offset, setOffset] = createSignal(0); let started = Date.now();
  onFrame(() => { const overflow = measured() - props.width; if (overflow <= 0) { if (offset() !== 0) setOffset(0); return; } const elapsed = Date.now() - started, pause = 1100, travel = overflow * 45, cycle = pause * 2 + travel; const phase = elapsed % cycle; setOffset(phase < pause ? 0 : phase < pause + travel ? -(phase - pause) / 45 : -overflow); });
  const textWidth = () => Math.max(props.width, measured());
  const overflow = () => measured() > props.width;
  return <View style={{ insetL: props.left, insetT: props.top, width: props.width, height: props.size + 5 }} class="absolute overflow-hidden"><Text style={{ width: textWidth(), translateX: offset() }} class={props.size === 21 ? (overflow() ? "absolute left-[0] top-[0] text-[21px] leading-[26] text-white text-left" : "absolute left-[0] top-[0] text-[21px] leading-[26] text-white text-center") : (overflow() ? "absolute left-[0] top-[0] text-xs leading-[14] text-[#b6b6b6] text-left" : "absolute left-[0] top-[0] text-xs leading-[14] text-[#b6b6b6] text-center")}>{text()}</Text></View>;
}

/** Android ShareQrScreen structure without blur/entry animation unsupported by PocketJS. */
export function ShareQrScreen(props: ShareQrScreenProps) {
  const content=()=>shareQrPresentation(props.title,props.url,props.topHint);
  const layout=()=>shareQrLayout(props.qrWidthRatio);
  let viewport: NodeMirror | undefined;
  createGesture({ region: { node: () => viewport }, axis: "y", onTap: () => props.onClose() });
  const scale = () => Math.min(props.width / 233, props.height / 233), left = () => (props.width - 233 * scale()) / 2, top = () => (props.height - 233 * scale()) / 2;
  const pixelSize=()=>shareQrPixelSize(layout().qrSize,scale(),getDisplayMetrics().density);
  return <View ref={node => viewport = node} onPress={props.onClose} focusable class="absolute inset-0 bg-black"><View class="absolute" style={{ insetL: left(), insetT: top(), width: 233, height: 233, scale: scale(), originX: 0, originY: 0 }}>
    <Marquee text={content().title} left={56.5} top={layout().titleTop} width={120} size={21} />
    <Marquee text={content().subtitle} left={21.5} top={layout().subtitleTop} width={190} size={12} />
    <View class="absolute items-center justify-center" style={{insetL:layout().qrLeft,insetT:layout().qrTop,width:layout().qrSize,height:layout().qrSize}}><QRCode nativeWatch pixelSize={pixelSize()} nativeBitmapSize={pixelSize()} value={content().link} size={layout().qrSize} onError={props.onError} /></View>
  </View></View>;
}

export default ShareQrScreen;
