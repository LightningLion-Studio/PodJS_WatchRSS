import { createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import * as watch from "@podjs/framework/watch";
import { RemoteImage } from "./RemoteImage.tsx";
import { createHoldPress } from "./hold-press.ts";
import { formatPlayerTime, holdStepCount, seekHoldStep } from "./video-player.ts";
import { ABOUT, aboutLayout, CANVAS, CONTROL, controlButtons, detailText, ENTRY_ARROW, formatSpeed, gaugeArc, INFO, infoLayout, pageDots, settlePage, speedFraction, stepSpeed, type Rect } from "./player-detail-layout.ts";

const PER_DEGREE = 1_000; // RelativeAxisUnits.PerDegree
const SLIDE_MS = 220, PAGE_MS = 260;
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** Horizontal position of the panel: `x` is its left edge in screen px (width = closed, 0 = open). */
export interface DetailSlide { x: Accessor<number>; shown: Accessor<boolean>; open(): void; close(): void; begin(): void; move(dx: number): void; end(vx: number): void; reset(): void }
export function createDetailSlide(width: () => number, onSettled?: (open: boolean) => void): DetailSlide {
  const [x, setX] = createSignal(width());
  let from = 0, to = 0, started = 0, animating = false, base = 0;
  const animate = (target: number) => { from = x(); to = target; started = Date.now(); animating = from !== to; if (!animating) onSettled?.(target === 0); };
  onFrame(() => {
    if (!animating) return;
    const t = (Date.now() - started) / SLIDE_MS;
    setX(from + (to - from) * ease(t));
    if (t >= 1) { animating = false; setX(to); onSettled?.(to === 0); }
  }, () => animating);
  return {
    x, shown: () => x() < width(),
    open: () => animate(0), close: () => animate(width()),
    begin: () => { animating = false; base = x(); },
    move: dx => setX(Math.max(0, Math.min(width(), base + dx))),
    end: vx => { const w = width(), opening = base >= w; animate(vx < -400 ? 0 : vx > 400 ? w : opening ? (x() < w * .65 ? 0 : w) : (x() > w * .35 ? w : 0)); },
    reset: () => { animating = false; setX(width()); },
  };
}

type Control = "progress" | "volume" | "speed";
export interface PlayerDetailHandle { crown(delta: number): void }
export interface PlayerDetailProps {
  width: number; height: number; slide: DetailSlide;
  title: () => string; author: () => string | undefined; description: () => string | undefined;
  cover: () => { url: string; bucket?: "bili-preview"; portrait: boolean } | undefined;
  positionMs: () => number; durationMs: () => number; seekable: () => boolean; onSeek: (deltaMs: number) => void;
  volumePercent: () => number; muted: () => boolean; onVolume: (steps: number, crown: boolean) => void;
  /** undefined when the host cannot change playback speed. */
  speed: () => number | undefined; onSpeed: (speed: number) => void;
  ref?: (handle: PlayerDetailHandle) => void;
}

/** Inward-pointing tab at the player's right edge; opens the detail panel. Canvas coordinates. */
export function PlayerDetailArrow(props: { left: number; top: number; scale: number; onOpen: () => void }) {
  const t = ENTRY_ARROW;
  // The pressable hit area is the parent, so taps on the tab or icon walk up to it.
  return <View debugName="PlayerDetailArrow" class="absolute" style={{ insetL: props.left, insetT: props.top, width: CANVAS, height: CANVAS, scale: props.scale, originX: 0, originY: 0 }}>
    <View accessibilityLabel="详情与播放控制" accessibilityRole="button" focusable onPress={props.onOpen} class="absolute bg-[#00000002]" style={{ insetL: t.hit.x, insetT: t.hit.y, width: t.hit.width, height: t.hit.height }}>
      <View class="absolute rounded-[8] bg-[#000000a6]" style={{ insetL: t.tab.x - t.hit.x, insetT: t.tab.y - t.hit.y, width: t.tab.width, height: t.tab.height }}>
        <View class="absolute inset-0 rounded-[8] bg-[#ffffff26]" />
      </View>
      <Image src="../assets/icons/player-detail-open.svg" class="absolute" style={{ insetL: t.icon.x - t.hit.x, insetT: t.icon.y - t.hit.y, width: t.icon.width, height: t.icon.height }} />
    </View>
  </View>;
}

const box = (r: Rect) => ({ insetL: r.x, insetT: r.y, width: r.width, height: r.height });

export function PlayerDetailPanel(props: PlayerDetailProps) {
  const scale = () => Math.min(props.width, props.height) / CANVAS;
  const left = () => (props.width - CANVAS * scale()) / 2, top = () => (props.height - CANVAS * scale()) / 2;
  const cover = createMemo(() => props.cover(), undefined, { equals: (a, b) => a?.url === b?.url && a?.portrait === b?.portrait && a?.bucket === b?.bucket });
  const info = createMemo(() => {
    const value = cover();
    return infoLayout({ title: props.title(), author: props.author(), description: props.description(), hasCover: !!value, portraitCover: value?.portrait }, (text, slot) => getOps().measureText(text, slot));
  });
  const about = createMemo(() => info().descriptionMore ? aboutLayout(detailText({ title: props.title(), description: props.description() }).description, (text, slot) => getOps().measureText(text, slot)) : []);
  type Page = "info" | "about" | Control;
  const pages = createMemo<Page[]>(() => ["info", ...(about().length ? ["about" as const] : []), "progress", "volume", ...(props.speed() === undefined ? [] : ["speed" as const])]);
  const [page, setPage] = createSignal(0), [drag, setDrag] = createSignal(0), [selected, setSelected] = createSignal<Control>();
  // Page settle animation, in canvas units.
  const [settle, setSettle] = createSignal<number>();
  let settleFrom = 0, settleStarted = 0;
  const offset = () => settle() ?? -page() * CANVAS + drag();
  const goTo = (next: number) => {
    const target = Math.max(0, Math.min(pages().length - 1, next));
    if (selected() && pages()[target] !== selected()) setSelected();
    settleFrom = offset(); settleStarted = Date.now(); setPage(target); setDrag(0); setSettle(settleFrom);
  };
  onFrame(() => {
    if (settle() === undefined) return;
    const t = (Date.now() - settleStarted) / PAGE_MS, to = -page() * CANVAS;
    if (t >= 1) setSettle(); else setSettle(settleFrom + (to - settleFrom) * ease(t));
  }, () => settle() !== undefined);

  // Crown: the selected control, otherwise page by page.
  let pageCrown = 0, speedCrown = 0;
  props.ref?.({ crown(delta) {
    const degrees = delta / PER_DEGREE, control = selected();
    if (control === "progress") { if (props.seekable()) props.onSeek(Math.round(degrees * 250)); return; }
    if (control === "volume") { props.onVolume(Math.sign(delta), true); return; }
    if (control === "speed") {
      speedCrown += degrees; const steps = Math.trunc(speedCrown / 12);
      if (steps) { speedCrown -= steps * 12; const current = props.speed(); if (current !== undefined) props.onSpeed(stepSpeed(current, steps)); }
      return;
    }
    if (settle() !== undefined) return;
    pageCrown += degrees;
    if (Math.abs(pageCrown) >= 15) { const direction = Math.sign(pageCrown); pageCrown = 0; goTo(page() + direction); }
  } });

  let root: NodeMirror | undefined;
  const toCanvas = (px: number) => px / scale();
  const pager = createGesture({ region: { node: () => root }, axis: "y", panSlop: 8,
    onTap: contact => { const hit = hitNode(contact.x, contact.y, contact.surface); let pressable = hit; while (pressable && !pressable.onPress) pressable = pressable.parent; if (hit && pressable) pressNode(hit); else setSelected(); },
    onPanStart: contact => { setSettle(); setSelected(); setDrag(toCanvas(contact.dy)); },
    onPanMove: contact => { const dy = toCanvas(contact.dy), atEdge = (page() === 0 && dy > 0) || (page() === pages().length - 1 && dy < 0); setDrag(atEdge ? dy * .3 : dy); },
    onPanEnd: contact => goTo(settlePage(page(), drag(), contact.vy, CANVAS, pages().length)),
    onCancel: () => goTo(page()),
  });
  // Left-to-right drags slide the panel back off the player; right-to-left drags are ignored.
  let closing = false;
  const dismiss = createGesture({ region: { node: () => root }, axis: "x", panSlop: 8,
    onPanStart: contact => { closing = contact.dx > 0; if (closing) { props.slide.begin(); props.slide.move(contact.dx); } },
    onPanMove: contact => { if (closing) props.slide.move(contact.dx); },
    onPanEnd: contact => { if (closing) props.slide.end(contact.vx); closing = false; },
    onCancel: () => { if (closing) props.slide.end(0); closing = false; },
  });
  // System back returns to the player without leaving the route.
  const removeBack = watch.onSystemBack?.(() => { if (!props.slide.shown()) return false; props.slide.close(); return true; });
  onCleanup(() => { pager.dispose(); dismiss.dispose(); removeBack?.(); });


  const InfoPage = () => <>
    <Show when={info().cover && cover()}>{cover => <View class="absolute overflow-hidden bg-[#1c1c1c]" style={{ ...box(info().cover!), radius: cover().portrait ? INFO.portraitCover.radius : INFO.cover.radius }}>
      <RemoteImage url={cover().url} cacheBucket={cover().bucket} width={info().cover!.width} height={info().cover!.height} fit="cover" class="absolute inset-0" />
    </View>}</Show>
    <For each={info().title}>{line => <Text class="absolute text-base leading-[20] text-white text-center" style={box(line.rect)}>{line.text}</Text>}</For>
    <Show when={info().author}>{author => <>
      <Image src="../assets/icons/player-detail-author.svg" class="absolute" style={box(author().icon)} />
      <Text class="absolute text-[13px] leading-[18] text-[#ff6026]" style={box(author().text)}>{author().label}</Text>
    </>}</Show>
    <For each={info().description}>{line => <Text class="absolute text-xs leading-[16] text-[#a6a6a6] text-center" style={box(line.rect)}>{line.text}</Text>}</For>
  </>;

  // A control page: caption, [−] value [+], detail line and an edge gauge. Only the value,
  // detail and gauge fill depend on the adjusted value, so a tick repaints just those nodes.
  const ControlPage = (p: { kind: Control; caption: string; value: () => string; detail: () => string; fraction: () => number; minus: string; plus: string; enabled: () => boolean; step: (direction: -1 | 1, elapsedMs?: number) => void }) => {
    const active = () => selected() === p.kind, buttons = controlButtons();
    const gaugeWidth = () => active() ? CONTROL.gauge.selectedWidth : CONTROL.gauge.width;
    const track = () => gaugeArc(1, gaugeWidth())!, fill = () => gaugeArc(p.fraction(), gaugeWidth());
    const Stepper = (s: { rect: Rect; icon: string; direction: -1 | 1; label: string }) => {
      let node: NodeMirror | undefined;
      createHoldPress(() => node, { enabled: p.enabled, onPress: () => p.step(s.direction), onHold: elapsed => p.step(s.direction, elapsed) });
      return <View ref={value => node = value} debugName={`PlayerDetail-${p.kind}-${s.direction > 0 ? "plus" : "minus"}`} accessibilityLabel={s.label} accessibilityRole="button" focusable onPress={() => { if (p.enabled()) p.step(s.direction); }}
        class="absolute rounded-[9999] items-center justify-center bg-[#262626] active:scale-96" style={{ ...box(s.rect), opacity: p.enabled() ? 1 : .4 }}>
        <Image src={s.icon} style={{ width: 26, height: 26 }} />
      </View>;
    };
    return <>
      <View class="absolute" style={{ ...track(), bgColor: "#ffffff1f" }} />
      <Show when={fill()}>{style => <View class="absolute" style={{ ...style(), bgColor: "#ff6026" }} />}</Show>
      <Text class="absolute text-xs leading-[16] text-center" style={{ ...box(CONTROL.caption), textColor: active() ? "#ff6026" : "#b6b6b6" }}>{active() ? `${p.caption} · 表冠调节` : p.caption}</Text>
      <View debugName={`PlayerDetail-${p.kind}-value`} accessibilityLabel={`${p.caption}，轻点后用表冠调节`} accessibilityRole="button" focusable onPress={() => setSelected(active() ? undefined : p.kind)}
        class="absolute rounded-[24] items-center justify-center" style={{ ...box(CONTROL.value), bgColor: active() ? "#ff6026" : "#ffffff14" }}>
        <Text class="text-2xl leading-[30] text-white">{p.value()}</Text>
      </View>
      <Stepper rect={buttons.minus} icon={p.minus} direction={-1} label={`${p.caption}减`} />
      <Stepper rect={buttons.plus} icon={p.plus} direction={1} label={`${p.caption}加`} />
      <Text class="absolute text-xs leading-[16] text-[#8a8a8a] text-center" style={box(CONTROL.detail)}>{p.detail()}</Text>
    </>;
  };

  const AboutPage = () => <>
    <Text class="absolute text-xs leading-[16] text-[#ff6026] text-center" style={box(ABOUT.caption)}>简介</Text>
    <For each={about()}>{line => <Text class="absolute text-sm leading-[20] text-[#d0d0d0] text-center" style={box(line.rect)}>{line.text}</Text>}</For>
  </>;
  const page$ = (kind: Page): (() => JSX.Element) => {
    if (kind === "info") return InfoPage;
    if (kind === "about") return AboutPage;
    if (kind === "progress") return () => <ControlPage kind="progress" caption="播放进度" minus="../assets/icons/player-rewind.svg" plus="../assets/icons/player-forward.svg" enabled={props.seekable}
      value={() => formatPlayerTime(props.positionMs())} detail={() => `共 ${formatPlayerTime(props.durationMs())}`}
      fraction={() => props.durationMs() > 0 ? props.positionMs() / props.durationMs() : 0}
      step={(direction, elapsed) => props.onSeek(elapsed === undefined ? 4_000 * direction : seekHoldStep(elapsed, direction))} />;
    if (kind === "volume") return () => <ControlPage kind="volume" caption="音量" minus="../assets/icons/speech-minus.svg" plus="../assets/icons/speech-plus.svg" enabled={() => true}
      value={() => `${props.volumePercent()}%`} detail={() => props.muted() ? "已静音" : props.volumePercent() <= 0 ? "无声" : "媒体音量"}
      fraction={() => props.volumePercent() / 100}
      step={(direction, elapsed) => props.onVolume(direction * (elapsed === undefined ? 1 : holdStepCount(elapsed)), false)} />;
    return () => <ControlPage kind="speed" caption="播放速度" minus="../assets/icons/speech-minus.svg" plus="../assets/icons/speech-plus.svg" enabled={() => props.speed() !== undefined}
      value={() => formatSpeed(props.speed() ?? 1)} detail={() => (props.speed() ?? 1) === 1 ? "正常速度" : "0.5× – 2.0×"}
      fraction={() => speedFraction(props.speed() ?? 1)}
      step={(direction, elapsed) => props.onSpeed(stepSpeed(props.speed() ?? 1, direction * (elapsed === undefined ? 1 : holdStepCount(elapsed))))} />;
  };
  // Only pages that can be on screen (the current one and, while moving, its neighbours) mount.
  const visible = (index: number) => Math.abs(-offset() / CANVAS - index) < 1;

  return <View ref={value => root = value} debugName="PlayerDetailPanel" class="absolute left-[0] top-[0] bg-[#000000]" style={{ width: props.width, height: props.height, translateX: props.slide.x() }}>
    <View class="absolute overflow-hidden" style={{ insetL: left(), insetT: top(), width: CANVAS, height: CANVAS, scale: scale(), originX: 0, originY: 0 }}>
      <View class="absolute left-[0] top-[0]" style={{ width: CANVAS, height: CANVAS * pages().length, translateY: offset() }}>
        <For each={pages()}>{(kind, index) => <Show when={visible(index())}>
          <View debugName={`PlayerDetailPage-${kind}`} class="absolute left-[0]" style={{ insetT: index() * CANVAS, width: CANVAS, height: CANVAS }}>{page$(kind)()}</View>
        </Show>}</For>
      </View>
      <For each={pageDots(pages().length, page())}>{dot => <View class="absolute rounded-[9999]" style={{ ...box(dot), bgColor: dot.active ? "#ffffff" : "#ffffff4d" }} />}</For>
    </View>
  </View>;
}
