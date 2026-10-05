import { Show, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";

export interface BiliSideMenuItem { label: string; enabled: boolean; onPress: () => void }

/** Native BiliFeedScreen side menu ("快速入口"): a 44dp right-edge strip opens it with a leftward
 * drag past 20dp; the panel is min(68% width, 180dp), full height, 18dp radius on the surface
 * colour over a 45% background scrim; tapping the scrim or dragging right 20dp closes it.
 * Items are 44dp surfaceVariant pills (16dp radius, 12sp), disabled at 45% alpha. */
export function BiliSideMenu(props: { width: number; height: number; active: () => boolean; items: () => BiliSideMenuItem[]; ref?: (handle: { isEdge: (x: number) => boolean; edgeSwipe: (dx: number) => void }) => void }) {
  const menuWidth = () => Math.min(props.width * 0.68, 180);
  const [open, setOpen] = createSignal(false);
  const [offset, setOffset] = createSignal(1); // 1 = hidden, 0 = shown (fraction of the panel width)
  let animation: { from: number; to: number; start: number } | null = null;
  const animate = (to: number) => { animation = { from: offset(), to, start: Date.now() }; };
  onFrame(() => {
    if (!animation) return;
    const part = Math.min(1, (Date.now() - animation.start) / 220), eased = 1 - (1 - part) ** 3;
    setOffset(animation.from + (animation.to - animation.from) * eased);
    if (part >= 1) animation = null;
  });
  const show = () => { setOpen(true); animate(0); };
  const hide = () => { setOpen(false); animate(1); };
  createGesture({ region: { rect: () => !open() && props.active() ? { x: props.width - 44, y: 0, w: 44, h: props.height } : null }, axis: "x", panSlop: 8,
    onPanEnd: c => { if (c.dx <= -20) show(); } });
  createGesture({ region: { rect: () => open() ? { x: props.width - menuWidth(), y: 0, w: menuWidth(), h: props.height } : null }, axis: "x", panSlop: 8,
    onPanEnd: c => { if (c.dx >= 20) hide(); } });
  props.ref?.({ isEdge: x => !open() && props.active() && x >= props.width - 44, edgeSwipe: dx => { if (dx <= -20) show(); } });
  const run = (item: BiliSideMenuItem) => { if (!item.enabled) return; hide(); item.onPress(); };
  return <Show when={open() || offset() < 1}>
    <View class="absolute inset-0" style={{ bgColor: `#0b1211${Math.round((1 - offset()) * 0.45 * 255).toString(16).padStart(2, "0")}` }} onPress={hide} focusable accessibilityRole="button" accessibilityLabel="关闭快速入口" />
    <View class="absolute top-[0] bottom-[0] rounded-[18] bg-[#1c1f21] overflow-hidden" style={{ insetL: props.width - menuWidth() + offset() * menuWidth(), width: menuWidth() }} accessibilityLabel="快速入口">
      <Text class="absolute left-[6] right-[6] top-[6] h-[20] overflow-hidden text-[17px] leading-[20] text-[#f5f5f5]">快速入口</Text>
      {props.items().map((item, index) => <View onPress={item.enabled ? () => run(item) : undefined} focusable={item.enabled} accessibilityRole="button" accessibilityLabel={item.label}
        class="absolute left-[6] right-[6] h-[44] rounded-[16] bg-[#23272a] items-center justify-center" style={{ insetT: 6 + 20 + 6 + index * 50, opacity: item.enabled ? 1 : .45 }}>
        <Text class="text-xs leading-[14] text-[#f5f5f5]">{item.label}</Text>
      </View>)}
    </View>
  </Show>;
}
