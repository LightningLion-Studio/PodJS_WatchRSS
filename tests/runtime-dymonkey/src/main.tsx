import { mount } from "@pocketjs/framework/solid";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { attachGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { hitNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { __onHostEvent, getDisplayMetrics, onAxisDelta, onSystemBack, RelativeAxis } from "@podjs/framework/watch";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { playerGesture } from "../../../src/ui/player-gestures.ts";
import { VideoPlayerScreen, type PlaybackSource, type VideoPlayerHandle } from "../../../src/ui/VideoPlayerScreen.tsx";

const { logicalWidth: width, logicalHeight: height } = getDisplayMetrics();
if (width !== 233 || height !== 233) throw Error("DYMONKEY requires a 233-unit viewport");
const { pod } = globalThis as unknown as { pod: { emit(message: string): void } };
const emit = (value: Record<string, unknown>) => pod.emit(JSON.stringify(value));

const caption = "清晨六点，从江边出发，沿着旧城墙一路骑到山脚。这里记录了早餐店、修车师傅和初夏的海风。";
const coldDescription = Array.from({ length: 3600 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
// Yi letters form one word under the line breaker's generic letter rule.
const coldWord = Array.from({ length: 1100 }, (_, i) => String.fromCodePoint(0xa000 + i)).join("").repeat(4);
const descriptions = [caption, caption.repeat(2), caption.repeat(3), caption.repeat(4),
  caption.repeat(5), caption.repeat(6), coldWord, coldDescription];
const feed: PlaybackSource[] = Array.from({ length: 8 }, (_, index) => ({
  awemeId: `fixture-${index}`, platform: "douyin", immersive: true,
  title: `离线视频 ${index}`, author: "本地测试", description: descriptions[index],
  url: `file:///fixture-${index}.mp4`, digitalCrownVolume: true,
}));

// These controls are assertion canaries. The isolated fixture never mounts
// an account route or imports a client. Each canary also guards its action
// if an input path somehow bypasses the coordinate guard.
const forbidden = ["like", "follow", "comment", "favorite", "share", "login", "logout"] as const;
const blocked = new Map<NodeMirror, string>();
const forbiddenRect = (index: number) => ({ x: 199, y: 42 + index * 22, w: 27, h: 19 });
const fail = (action: string): never => { throw Error(`forbidden Monkey input: ${action}`); };

function App() {
  const [entered, setEntered] = createSignal(true);
  const [index, setIndex] = createSignal(0);
  const [sourceRevision, refreshSource] = createSignal(0);
  const source = createMemo(() => { sourceRevision(); return { ...feed[index()]! }; });
  let root: NodeMirror | undefined;
  let player: VideoPlayerHandle | undefined;
  let side: VideoPlayerHandle["sideSwipe"] | undefined;
  let now = 1000;
  Date.now = () => now;

  onCleanup(onSystemBack(() => { if (!entered()) return false; setEntered(false); player = undefined; return true; }));
  onCleanup(onAxisDelta(RelativeAxis.Primary, delta => { player?.onCrown(delta); }));
  const viewport = () => ({ x: 0, y: 0, w: width, h: height });
  const gesture = attachGesture(playerGesture({
    region: { rect: () => entered() && player?.canSwipeBack() ? { x: 0, y: 0, w: width, h: height } : null },
    axis: "x",
    panSlop: 8,
    onPanStart: c => {
      if (c.dx < 0 && player?.sideSwipe.begin()) { side = player.sideSwipe; side.move(c.dx); }
    },
    onPanMove: c => side?.move(c.dx),
    onPanEnd: c => { const current = side; side = undefined; current?.end(c.vx); },
    onCancel: () => { const current = side; side = undefined; current?.cancel(); },
  }, () => player?.gestureRotation() ?? 0, viewport));
  onCleanup(() => gesture.dispose());

  onCleanup(__onHostEvent(event => {
    if (event.t !== "dymonkey.input") return;
    const { op, x, y } = event;
    // A closed command set in the test build. Coordinate approvals use the
    // previous committed frame, before the next native input is submitted.
    if (op === "point") {
      if (typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) fail("coordinate");
      if (!entered()) for (const [i, name] of forbidden.entries()) {
        const r = forbiddenRect(i);
        if ((x as number) >= r.x && (x as number) < r.x + r.w && (y as number) >= r.y && (y as number) < r.y + r.h) fail(name);
      }
      const boundsHit = getOps().hitTestBounds?.(x as number, y as number);
      for (let node of [hitNode(x as number, y as number), find(root, n => n.id === boundsHit) ?? null]) {
        while (node) {
          const action = blocked.get(node);
          if (action) fail(action);
          node = node.parent;
        }
      }
    } else if (op === "tick") {
      now += 17;
    } else if (op === "enter" && !entered()) {
      setEntered(true);
    } else {
      fail(String(op));
    }
    if (op !== "tick") emit({ t: "dymonkey.approved", op });
  }));

  const find = (node: NodeMirror | undefined, matches: (node: NodeMirror) => boolean): NodeMirror | undefined => {
    if (node && matches(node)) return node;
    for (const child of node?.children ?? []) {
      const match = find(child, matches);
      if (match) return match;
    }
  };
  onFrame(() => {
    const column = find(root, n => n.debugName === "PlayerDetailColumn");
    emit({ t: "dymonkey.state", entered: entered(), index: index(), now,
      rotation: player?.gestureRotation(), sidebar: player ? !player.canSwipeBack() : false,
      arrow: !!find(root, n => n.debugName === "PlayerDetailArrow"), panel: !!column });
  });

  return <View ref={node => { root = node; }} class="absolute inset-0 bg-[#193041]">
    <Show when={entered()} fallback={<>
      <Text class="absolute left-[24] top-[82] text-white">离线视频</Text>
      <For each={forbidden}>{(name, i) => {
        const r = forbiddenRect(i());
        return <View ref={node => { blocked.set(node, name); onCleanup(() => blocked.delete(node)); }}
          class="absolute bg-[#702843]" style={{ insetL: r.x, insetT: r.y, width: r.w, height: r.h }}
          onPress={() => fail(name)} accessibilityLabel={name} accessibilityRole="button" focusable />;
      }}</For>
    </>}>
      <VideoPlayerScreen source={source()} width={width} height={height} active offset={0} round
        ref={value => { player = value; }} onActions={() => fail("long press")}
        onReload={(_position, current) => { if (current()) refreshSource(n => n + 1); }}
        onNext={() => { setIndex(i => (i + 1) % feed.length); }}
        onPrevious={() => { setIndex(i => (i + feed.length - 1) % feed.length); }} />
    </Show>
  </View>;
}

mount(() => <App />);
