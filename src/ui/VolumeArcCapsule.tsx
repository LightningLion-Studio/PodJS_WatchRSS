import { Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { volumeArcExtent, volumeArcFill, volumeArcLayout, volumeArcOutline, volumeArcStyle } from "./volume-arc.ts";

/** Shared 233-unit canvas; callers scale it to the screen like the player controls. */
export const VOLUME_ARC = volumeArcLayout(233);
const L = VOLUME_ARC;
const bounds = (() => {
  const points = volumeArcOutline(L), xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.floor(Math.min(...xs)) - 1, y = Math.floor(Math.min(...ys)) - 1;
  return { x, y, width: Math.ceil(Math.max(...xs)) + 1 - x, height: Math.ceil(Math.max(...ys)) + 1 - y };
})();
// Arcs sit in a clip box around the capsule so the rasterizer only scans that corner.
const arc = (radius: number, width: number, fromDeg: number, toDeg: number) => {
  const s = volumeArcStyle(L, radius, width, fromDeg, toDeg);
  return { ...s, insetL: s.insetL - bounds.x, insetT: s.insetT - bounds.y };
};
const OUTLINE = arc(L.radius, L.thickness, L.startDeg, L.endDeg);
const BODY = arc(L.radius, L.thickness - L.outline * 2, L.startDeg, L.endDeg);
const TRACK = arc(L.tickRadius, L.tickWidth, L.tickStartDeg, L.tickEndDeg);
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
  const fill = () => { const value = volumeArcFill(L, props.percent); return value && arc(L.tickRadius, L.tickWidth, value.fromDeg, value.toDeg); };
  return <View debugName="VolumeArcCapsule" accessibilityLabel={`音量 ${props.percent}%`} class="absolute" style={{ insetL: place().left, insetT: place().top, width: 233, height: 233, scale: place().scale, originX: 0, originY: 0 }}>
    <View class="absolute overflow-hidden" style={{ insetL: bounds.x, insetT: bounds.y, width: bounds.width, height: bounds.height }}>
      <View class="absolute" style={{ ...OUTLINE, bgColor: "#ffffff73" }} />
      <View class="absolute" style={{ ...BODY, bgColor: "#0e1012f0" }} />
      <View class="absolute" style={{ ...TRACK, bgColor: "#b6b6b680" }} />
      <Show when={fill()}>{style => <View class="absolute" style={{ ...style(), bgColor: "#ff6026" }} />}</Show>
    </View>
    <Show when={props.muted || props.percent <= 0} fallback={<Image src="../assets/icons/speech-volume-overlay.svg" class="absolute" style={{ insetL: L.icon.x - ICON / 2, insetT: L.icon.y - ICON / 2, width: ICON, height: ICON, rotate: L.icon.rotate }} />}>
      <Image src="../assets/icons/speech-volume-off-overlay.svg" class="absolute" style={{ insetL: L.icon.x - ICON / 2, insetT: L.icon.y - ICON / 2, width: ICON, height: ICON, rotate: L.icon.rotate }} />
    </Show>
    <Text class="absolute text-base text-center text-[#f5f5f5]" style={{ insetL: L.text.x - TEXT_W / 2, insetT: L.text.y - TEXT_H / 2, width: TEXT_W, height: TEXT_H, lineHeight: TEXT_H, rotate: L.text.rotate }}>{`${props.percent}%`}</Text>
  </View>;
}
