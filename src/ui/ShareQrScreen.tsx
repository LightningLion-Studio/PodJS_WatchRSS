import {getDisplayMetrics} from "@podjs/framework/watch";
import {shareQrPresentation} from "../sharing/policy.ts";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createMemo } from "solid-js";
import { getOps } from "@pocketjs/framework/host";
import type { QrRect } from "@podjs/framework/watch-ui";
import { measuredLines } from "../reader/measured-text.ts";
import { QRCode } from "./QRCode.tsx";
import { shareMiddleEllipsis, shareQrLayout, shareQrPixelSize } from "./share-qr-layout.ts";

export interface ShareQrScreenProps { active?: () => boolean; width: number; height: number; title: string; url: string; topHint?:string; qrWidthRatio?:number; onClose: () => void; onError?: (message: string) => void }

function ShareCaption(props: { rect: QrRect; text: string; title?: boolean }) {
  const fontSlot = () => props.title ? 3 : 0;
  const scale = () => props.title ? 21 / 18 : 1;
  const caption = createMemo(() => {
    const text = props.text.split(/\r?\n/, 1)[0] ?? "";
    const measure = (value: string) => getOps().measureText(value, fontSlot()) * scale();
    const width = props.rect.width - 4;
    return props.title ? measuredLines(text, width, measure, 1)[0] : shareMiddleEllipsis(text, width, measure);
  });
  return <View style={{ insetL:props.rect.x, insetT:props.rect.y, width:props.rect.width, height:props.rect.height }}
    class="absolute overflow-hidden" accessibilityRole="text" accessibilityLabel={props.text}>
    <Text class="absolute text-center" accessibilityHidden style={{
      insetL:0, insetT:0, width:props.rect.width / scale(),
      fontSlot:fontSlot(), scale:scale(), originX:-.5, originY:-.5, lineHeight:props.rect.height / scale(),
      textColor:props.title ? "#ffffff" : "#b6b6b6",
    }}>{caption()}</Text>
  </View>;
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
    <ShareCaption title rect={layout().title} text={content().title} />
    <ShareCaption rect={layout().subtitle} text={content().subtitle} />
    <View class="absolute items-center justify-center" style={{insetL:layout().qr.x,insetT:layout().qr.y,width:layout().qr.width,height:layout().qr.height}}><QRCode quietZone={4} pixelSize={pixelSize()} value={content().link} size={layout().qr.width} onError={props.onError} /></View>
  </View></View>;
}

export default ShareQrScreen;
