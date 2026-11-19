import { batch, createMemo, createSignal, For, createEffect, onCleanup, untrack, Show, type Accessor, type JSX } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture, type GestureOptions } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { getOps } from "@pocketjs/framework/host";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import * as watch from "@podjs/framework/watch";
import { RemoteImage } from "./RemoteImage.tsx";
import { playerGesture } from "./player-gestures.ts";
import { createHoldPress } from "./hold-press.ts";
import { formatPlayerTime, holdStepCount, seekHoldStep } from "./video-player.ts";
import { ABOUT, aboutLineIterator, CANVAS, columnLayout, CONTROL, controlCentreOffset, controlRow, detailText, ENTRY_ARROW, formatSpeed, INFO, INFO_HEIGHT, infoLayout, pillFill, speedFraction, stepSpeed, type Rect } from "./player-detail-layout.ts";

const PER_DEGREE = 1_000; // RelativeAxisUnits.PerDegree
const SLIDE_MS = 220;
/** Crown scroll distance per degree, in canvas units. */
const CROWN_PX = 4;
/** Height of the top and bottom fades over the scrolling column, in canvas units. */
const EDGE_FADE = 28;
const ABOUT_LINES_PER_FRAME = 2;
const OVERSCAN = 8;
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** Horizontal position of the panel: `x` is its left edge in screen px (width = closed, 0 = open). */
export interface DetailSlide { x: Accessor<number>; shown: Accessor<boolean>; open(): void; close(): void; begin(): boolean; move(dx: number): void; end(vx: number): void; cancel(): void; reset(): void }
export function createDetailSlide(width: () => number, onSettled?: (open: boolean) => void): DetailSlide {
  const [x, setX] = createSignal(width());
  const [animating, setAnimating] = createSignal(false);
  const [dragBase, setDragBase] = createSignal<number>();
  let from = 0, to = 0, started = 0;
  const animate = (target: number) => batch(() => {
    // A late move, release or cancel from the interrupted finger must not
    // replace an explicit Back or reopen the panel after a route reset.
    setDragBase();
    if (animating() && to === target) return;
    from = x();
    to = target;
    started = Date.now();
    setAnimating(from !== to);
    if (!animating()) onSettled?.(target === 0);
  });
  onFrame(() => {
    if (!animating()) return;
    const t = (Date.now() - started) / SLIDE_MS;
    if (t < 1) setX(from + (to - from) * ease(t));
    else batch(() => { setAnimating(false); setX(to); onSettled?.(to === 0); });
  }, animating);
  return {
    // Keep the dismiss recognizer alive if the held finger drags all the way
    // off-screen. It must still be able to reverse or receive the release.
    x, shown: () => x() < width() || (dragBase() ?? width()) < width(),
    open: () => animate(0), close: () => animate(width()),
    begin: () => {
      if (dragBase() !== undefined) return false;
      batch(() => { setDragBase(x()); setAnimating(false); });
      return true;
    },
    move: dx => {
      const base = dragBase();
      if (base !== undefined) setX(Math.max(0, Math.min(width(), base + dx)));
    },
    end: vx => {
      const base = dragBase();
      if (base === undefined) return;
      const w = width(), opening = base >= w;
      animate(vx < -400 ? 0 : vx > 400 ? w : opening ? (x() < w * .65 ? 0 : w) : (x() > w * .35 ? w : 0));
    },
    cancel: () => {
      const base = dragBase();
      if (base !== undefined) animate(base >= width() ? width() : 0);
    },
    reset: () => batch(() => { setDragBase(); setAnimating(false); setX(width()); }),
  };
}

type Control = "progress" | "volume" | "speed";
export interface PlayerDetailHandle { crown(delta: number): void }
export interface PlayerDetailProps {
  width: number; height: number; slide: DetailSlide; rotation?: Accessor<number>;
  title: () => string; author: () => string | undefined; description: () => string | undefined;
  cover: () => { url: string; bucket?: "bili-preview"; portrait: boolean } | undefined;
  positionMs: () => number; durationMs: () => number; seekable: () => boolean; onSeek: (deltaMs: number) => void;
  volumePercent: () => number; muted: () => boolean; onVolume: (steps: number, crown: boolean) => void;
  /** undefined when the host cannot change playback speed. */
  speed: () => number | undefined; onSpeed: (speed: number) => void;
  ref?: (handle: PlayerDetailHandle) => void;
}

/** Inward-pointing tab at the player's right edge; opens the detail panel. Canvas coordinates. */
export function PlayerDetailArrow(props: { left: number; top: number; scale: number; rotation: number; round: boolean; onOpen: () => void }) {
  const { tab, icon } = ENTRY_ARROW;
  const hit = () => props.round ? ENTRY_ARROW.roundHit : ENTRY_ARROW.hit;
  // Rotate the parent of both the ink and the pressable hit area about the picture centre.
  return <View debugName="PlayerDetailArrow" class="absolute" style={{ insetL: props.left, insetT: props.top, width: CANVAS, height: CANVAS, scale: props.scale, rotate: props.rotation, originX: 0, originY: 0 }}>
    <View accessibilityLabel="详情与播放控制" accessibilityRole="button" focusable onPress={props.onOpen} class="absolute bg-[#00000002]" style={box(hit())}>
      <View class="absolute rounded-[8] bg-[#000000a6]" style={{ insetL: tab.x - hit().x, insetT: tab.y - hit().y, width: tab.width, height: tab.height }}>
        <View class="absolute inset-0 rounded-[8] bg-[#ffffff26]" />
      </View>
      <Image src="../assets/icons/player-detail-open.svg" class="absolute" style={{ insetL: icon.x - hit().x, insetT: icon.y - hit().y, width: icon.width, height: icon.height }} />
    </View>
  </View>;
}

const box = (r: Rect) => ({ insetL: r.x, insetT: r.y, width: r.width, height: r.height });

export function PlayerDetailPanel(props: PlayerDetailProps) {
  const scale = () => Math.min(props.width, props.height) / CANVAS;
  const left = () => (props.width - CANVAS) / 2, top = () => (props.height - CANVAS) / 2;
  const cover = createMemo(() => props.cover(), undefined, { equals: (a, b) => a?.url === b?.url && a?.portrait === b?.portrait && a?.bucket === b?.bucket });
  const info = createMemo(() => {
    const value = cover();
    return infoLayout({ title: props.title(), author: props.author(), description: props.description(), hasCover: !!value, portraitCover: value?.portrait }, (text, slot) => getOps().measureText(text, slot));
  });
  const measure = (text: string, slot: number) => getOps().measureText(text, slot);
  const description = createMemo(() => detailText({ title: props.title(), description: props.description() }).description);
  const fullDescription = createMemo(() => info().descriptionMore ? description() : "");
  const [about, setAbout] = createSignal<string[]>([]);
  const [aboutCount, setAboutCount] = createSignal(0);
  let aboutJob: Generator<string> | undefined;
  const controls = createMemo<Control[]>(() => ["progress", "volume", ...(props.speed() === undefined ? [] : ["speed" as const])]);
  const column = createMemo(() => columnLayout(aboutCount(), controls().length));
  const aboutTop = INFO_HEIGHT + ABOUT.caption + ABOUT.captionGap;
  const [selected, setSelected] = createSignal<Control>();
  const scroller = createScroller({ max: () => column().max, extent: () => CANVAS });
  onFrame(() => scroller.step(), () => scroller.state() !== "idle" && scroller.state() !== "tracking");
  // Wrap one viewport ahead. Publish lines as they are ready so the first
  // scroll can read them without waiting for the end of the description.
  createEffect(() => {
    const text = fullDescription();
    aboutJob = text ? aboutLineIterator(text, measure) : undefined;
    batch(() => { setAbout([]); setAboutCount(0); });
  });
  const needsAboutLines = () => !!aboutJob && !selected() &&
    aboutTop + aboutCount() * ABOUT.lineHeight < scroller.offset() + CANVAS * 2;
  onFrame(() => {
    const iterator = aboutJob;
    if (!iterator || !needsAboutLines()) return;
    const lines = about();
    for (let i = 0; i < ABOUT_LINES_PER_FRAME; i++) {
      const next = iterator.next();
      if (next.done) { aboutJob = undefined; break; }
      lines.push(next.value);
    }
    setAboutCount(lines.length);
  }, needsAboutLines);

  createEffect(() => { description(); untrack(() => { scroller.scrollTo(0, { immediate: true }); setSelected(); }); });
  // Capabilities may disappear while a source is being replaced: drop a vanished
  // selection and keep the offset inside the shorter column.
  createEffect(() => {
    const max = column().max, control = untrack(selected);
    if (control && !controls().includes(control)) setSelected();
    // A centring tween keeps its old target, so judge the destination as well as the position.
    if (untrack(() => Math.max(scroller.offset(), scroller.intent())) > max) untrack(() => scroller.scrollTo(Math.min(scroller.offset(), max), { immediate: true }));
  });
  const select = (control: Control | undefined) => {
    setSelected(control);
    if (control) scroller.scrollTo(controlCentreOffset(column(), controls().indexOf(control)));
  };
  // Crown: the selected control, otherwise a continuous scroll.
  let speedCrown = 0;
  createEffect(() => { selected(); speedCrown = 0; });
  props.ref?.({ crown(delta) {
    const degrees = delta / PER_DEGREE, control = selected();
    if (control === "progress") { if (props.seekable()) props.onSeek(Math.round(degrees * 250)); return; }
    if (control === "volume") { props.onVolume(Math.sign(delta), true); return; }
    if (control === "speed") {
      speedCrown += degrees; const steps = Math.trunc(speedCrown / 12);
      if (steps) { speedCrown -= steps * 12; const current = props.speed(); if (current !== undefined) props.onSpeed(stepSpeed(current, steps)); }
      return;
    }
    scroller.scrollBy(degrees * CROWN_PX, { durMs: 120 });
  } });

  let root: NodeMirror | undefined;
  let scrolling: number | undefined;
  const toCanvas = (px: number) => px / scale();
  const viewport = () => ({ x: 0, y: 0, w: props.width, h: props.height });
  const createPanelGesture = (options: GestureOptions) =>
    createGesture(props.rotation ? playerGesture(options, props.rotation, viewport) : options);
  const pager = createPanelGesture({ region: { node: () => root }, axis: "y", panSlop: 8,
    // A touch catches a fling; an edge spring keeps returning, or the overscroll would freeze.
    onDown: () => { if (scroller.state() === "fling" || scroller.state() === "tween") scroller.stop(); },
    onTap: contact => { const hit = hitNode(contact.x, contact.y, contact.surface); let pressable = hit; while (pressable && !pressable.onPress) pressable = pressable.parent; if (hit && pressable) pressNode(hit); else setSelected(); },
    onPanStart: contact => {
      if (scrolling !== undefined) return;
      scrolling = contact.id;
      setSelected();
      scroller.beginDrag();
    },
    onPanMove: contact => { if (scrolling === contact.id) scroller.drag(-toCanvas(contact.fdy)); },
    onPanEnd: contact => {
      if (scrolling !== contact.id) return;
      scrolling = undefined;
      scroller.endDrag(-toCanvas(contact.vy));
    },
    onCancel: contact => {
      if (scrolling !== contact.id) return;
      scrolling = undefined;
      scroller.endDrag(0);
    },
  });
  // A rightward drag in picture coordinates slides the panel off the player.
  let closing: number | undefined;
  const dismiss = createPanelGesture({ region: { node: () => root }, axis: "x", panSlop: 8,
    onPanStart: contact => {
      if (contact.dx <= 0 || !props.slide.begin()) return;
      closing = contact.id;
      props.slide.move(contact.dx);
    },
    onPanMove: contact => { if (closing === contact.id) props.slide.move(contact.dx); },
    onPanEnd: contact => {
      if (closing !== contact.id) return;
      closing = undefined;
      props.slide.end(contact.vx);
    },
    onCancel: contact => {
      if (closing !== contact.id) return;
      closing = undefined;
      props.slide.cancel();
    },
  });
  // System back returns to the player without leaving the route.
  const removeBack = watch.onSystemBack?.(() => { if (!props.slide.shown()) return false; props.slide.close(); return true; });
  onCleanup(() => {
    aboutJob = undefined;
    scrolling = closing = undefined;
    scroller.stop();
    pager.dispose();
    dismiss.dispose();
    removeBack?.();
  });


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

  // A control row: caption, value, [−] pill bar [+] and a detail line. Only the value,
  // detail and fill depend on the adjusted value, so a tick repaints just those nodes.
  const ControlRow = (p: { kind: Control; caption: string; value: () => string; detail: () => string; fraction: () => number; minus: string; plus: string; enabled: () => boolean; step: (direction: -1 | 1, elapsedMs?: number) => void }) => {
    const active = () => selected() === p.kind, row = controlRow();
    const track = () => row.pill(active()), fill = () => pillFill(track(), p.fraction());
    const Stepper = (s: { rect: Rect; icon: string; direction: -1 | 1; label: string }) => {
      let node: NodeMirror | undefined;
      createHoldPress(() => node, { enabled: p.enabled, onPress: () => p.step(s.direction), onHold: elapsed => p.step(s.direction, elapsed) });
      return <View ref={value => node = value} debugName={`PlayerDetail-${p.kind}-${s.direction > 0 ? "plus" : "minus"}`} accessibilityLabel={s.label} accessibilityRole="button" focusable onPress={() => { if (p.enabled()) p.step(s.direction); }}
        class="absolute rounded-[9999] items-center justify-center bg-[#262626] active:scale-96" style={{ ...box(s.rect), opacity: p.enabled() ? 1 : .4 }}>
        <Image src={s.icon} style={{ width: 22, height: 22 }} />
      </View>;
    };
    return <>
      <Text class="absolute text-xs leading-[16] text-center" style={{ ...box(CONTROL.caption), textColor: active() ? "#ff6026" : "#b6b6b6" }}>{active() ? `${p.caption} · 表冠调节` : p.caption}</Text>
      <Text class="absolute text-2xl leading-[30] text-center" style={{ ...box(CONTROL.value), textColor: active() ? "#ff6026" : "#ffffff" }}>{p.value()}</Text>
      <Stepper rect={row.minus} icon={p.minus} direction={-1} label={`${p.caption}减`} />
      <View debugName={`PlayerDetail-${p.kind}-value`} accessibilityLabel={`${p.caption}，轻点后用表冠调节`} accessibilityRole="button" focusable onPress={() => select(active() ? undefined : p.kind)}
        class="absolute bg-[#00000002]" style={box(row.pillHit)}>
        <View class="absolute rounded-[9999]" style={{ insetL: 0, insetT: track().y - row.pillHit.y, width: track().width, height: track().height, bgColor: active() ? "#ffffff38" : "#ffffff1f" }} />
        <Show when={fill()}>{rect => <View class="absolute rounded-[9999] bg-[#ff6026]" style={{ insetL: 0, insetT: rect().y - row.pillHit.y, width: rect().width, height: rect().height }} />}</Show>
      </View>
      <Stepper rect={row.plus} icon={p.plus} direction={1} label={`${p.caption}加`} />
      <Text class="absolute text-xs leading-[16] text-[#8a8a8a] text-center" style={box(CONTROL.detail)}>{p.detail()}</Text>
    </>;
  };
  const control$ = (kind: Control): JSX.Element => {
    if (kind === "progress") return <ControlRow kind="progress" caption="播放进度" minus="../assets/icons/player-rewind.svg" plus="../assets/icons/player-forward.svg" enabled={props.seekable}
      value={() => formatPlayerTime(props.positionMs())} detail={() => `共 ${formatPlayerTime(props.durationMs())}`}
      fraction={() => props.durationMs() > 0 ? props.positionMs() / props.durationMs() : 0}
      step={(direction, elapsed) => props.onSeek(elapsed === undefined ? 4_000 * direction : seekHoldStep(elapsed, direction))} />;
    if (kind === "volume") return <ControlRow kind="volume" caption="音量" minus="../assets/icons/speech-minus.svg" plus="../assets/icons/speech-plus.svg" enabled={() => true}
      value={() => `${props.volumePercent()}%`} detail={() => props.muted() ? "已静音" : props.volumePercent() <= 0 ? "无声" : "媒体音量"}
      fraction={() => props.volumePercent() / 100}
      step={(direction, elapsed) => props.onVolume(direction * (elapsed === undefined ? 1 : holdStepCount(elapsed)), false)} />;
    return <ControlRow kind="speed" caption="播放速度" minus="../assets/icons/speech-minus.svg" plus="../assets/icons/speech-plus.svg" enabled={() => props.speed() !== undefined}
      value={() => formatSpeed(props.speed() ?? 1)} detail={() => (props.speed() ?? 1) === 1 ? "正常速度" : "0.5× – 2.0×"}
      fraction={() => speedFraction(props.speed() ?? 1)}
      step={(direction, elapsed) => props.onSpeed(stepSpeed(props.speed() ?? 1, direction * (elapsed === undefined ? 1 : holdStepCount(elapsed))))} />;
  };
  const visible = (y: number, height: number) => y + height > scroller.offset() - OVERSCAN && y < scroller.offset() + CANVAS + OVERSCAN;
  // Keep one reactive range instead of a visibility subscription per line.
  const aboutRange = createMemo(() => {
    const top = scroller.offset() - aboutTop;
    const start = Math.max(0, Math.min(aboutCount(), Math.floor((top - OVERSCAN) / ABOUT.lineHeight)));
    const end = Math.max(start, Math.min(aboutCount(), Math.ceil((top + CANVAS + OVERSCAN) / ABOUT.lineHeight)));
    return { start, end };
  }, undefined, { equals: (a, b) => a.start === b.start && a.end === b.end });
  const visibleAbout = createMemo(() => {
    const { start, end } = aboutRange();
    return Array.from({ length: end - start }, (_, i) => start + i);
  });
  const aboutLeft = (CANVAS - ABOUT.width) / 2;

  return <View ref={value => root = value} debugName="PlayerDetailPanel" class="absolute left-[0] top-[0] bg-[#000000]" style={{ width: props.width, height: props.height, translateX: props.slide.x() }}>
    <View class="absolute overflow-hidden" style={{ insetL: left(), insetT: top(), width: CANVAS, height: CANVAS, scale: scale(), originX: 0, originY: 0 }}>
      <View debugName="PlayerDetailColumn" class="absolute left-[0] top-[0]" style={{ width: CANVAS, height: column().height, translateY: -scroller.offset() }}>
        <Show when={visible(0, INFO_HEIGHT)}><View debugName="PlayerDetailInfo" class="absolute left-[0] top-[0]" style={{ width: CANVAS, height: INFO_HEIGHT }}><InfoPage /></View></Show>
        <Show when={aboutCount() && visible(column().about, ABOUT.caption)}>
          <Text class="absolute text-xs leading-[16] text-[#ff6026] text-center" style={{ insetL: aboutLeft, insetT: column().about, width: ABOUT.width, height: ABOUT.caption }}>简介</Text>
        </Show>
        <For each={visibleAbout()}>{index =>
          <Text debugName="PlayerDetailAboutLine" class="absolute text-sm leading-[20] text-[#d0d0d0]" style={{ insetL: aboutLeft, insetT: aboutTop + index * ABOUT.lineHeight, width: ABOUT.width, height: ABOUT.lineHeight }}>{about()[index]}</Text>
        }</For>
        <For each={controls()}>{(kind, index) => <Show when={visible(column().controls + index() * CONTROL.height, CONTROL.height)}>
          <View debugName={`PlayerDetailControl-${kind}`} class="absolute left-[0]" style={{ insetT: column().controls + index() * CONTROL.height, width: CANVAS, height: CONTROL.height }}>{control$(kind)}</View>
        </Show>}</For>
      </View>
      {/* Content leaving the round screen fades out instead of being cut by its edge. */}
      <View class="absolute left-[0] top-[0] bg-gradient-to-b from-[#000000] to-transparent" style={{ width: CANVAS, height: EDGE_FADE }} />
      <View class="absolute left-[0] bg-gradient-to-b from-transparent to-[#000000]" style={{ insetT: CANVAS - EDGE_FADE, width: CANVAS, height: EDGE_FADE }} />
    </View>
  </View>;
}
