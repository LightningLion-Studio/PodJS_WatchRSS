import { Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { StrokeArc } from "@podjs/framework/stroke-arc";
import { volumeArcExtent, volumeArcFill, volumeArcLayout } from "./volume-arc.ts";

/** Shared 233-unit canvas; callers scale it to the screen like the player controls. */
export const VOLUME_ARC = volumeArcLayout(233);
const L = VOLUME_ARC;
const TEXT_W = 60, TEXT_H = 20, ICON = L.icon.size;

export function canvasPlacement(width: number, height: number) {
  return { left: (width - 233) / 2, top: (height - 233) / 2, scale: Math.min(width, height) / 233 };
}

/** Screen-space left edge of the capsule across a horizontal band, for content that must yield to it. */
export function volumeArcLeftEdge(width: number, height: number, y0: number, y1: number): number | undefined {
  const c = canvasPlacement(width, height), toCanvas = (y: number) => L.cy + (y - c.top - L.cy) / c.scale;
  const extent = volumeArcExtent(L, toCanvas(y0), toCanvas(y1));
  return extent && c.left + L.cx + (extent.minX - L.cx) * c.scale;
}

/** Round-screen crown volume feedback: a capsule along the top-right edge, next to the crown. */
export function VolumeArcCapsule(props: { width: number; height: number; percent: number; muted?: boolean }) {
  const place = () => canvasPlacement(props.width, props.height);
  const fill = () => volumeArcFill(L, props.percent);
  return <View debugName="VolumeArcCapsule" accessibilityLabel={`音量 ${props.percent}%`} class="absolute" style={{ insetL: place().left, insetT: place().top, width: 233, height: 233, scale: place().scale, originX: 0, originY: 0 }}>
    <Image accessibilityHidden src="../assets/icons/volume-capsule.svg" class="absolute" style={{insetL: 155, insetT: 18, width: 70, height: 80}}/>
    <Show when={fill()}>{level => <StrokeArc cx={L.cx} cy={L.cy} radius={L.tickRadius} strokeWidth={L.tickWidth}
      start={level().fromDeg + 90} sweep={level().toDeg - level().fromDeg} color={0xff6026ff} scale={place().scale}/>}</Show>
    <Show when={props.muted || props.percent <= 0} fallback={<Image src="../assets/icons/speech-volume-overlay.svg" class="absolute" style={{ insetL: L.icon.x - ICON / 2, insetT: L.icon.y - ICON / 2, width: ICON, height: ICON, rotate: L.icon.rotate }} />}>
      <Image src="../assets/icons/speech-volume-off-overlay.svg" class="absolute" style={{ insetL: L.icon.x - ICON / 2, insetT: L.icon.y - ICON / 2, width: ICON, height: ICON, rotate: L.icon.rotate }} />
    </Show>
    <Text class="absolute text-base text-center text-[#f5f5f5]" style={{ insetL: L.text.x - TEXT_W / 2, insetT: L.text.y - TEXT_H / 2, width: TEXT_W, height: TEXT_H, lineHeight: TEXT_H, rotate: L.text.rotate }}>{`${props.percent}%`}</Text>
  </View>;
}
