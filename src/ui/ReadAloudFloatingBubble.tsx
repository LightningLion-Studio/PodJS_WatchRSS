import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { Image, View, type NodeMirror } from '@pocketjs/framework/components';
import { createGesture } from '@pocketjs/framework/gesture';
import { onFrame } from '@pocketjs/framework/lifecycle';
import {
  clampBubbleCenter,
  cappedDampedSnapStep,
  criticallyDampedStep,
  exponentialFlingEnd,
  exponentialFlingPosition,
  nearestPoint,
  readAloudSafeCorners,
  READ_ALOUD_FLING_MAX_SECONDS,
  READ_ALOUD_FLING_STOP_SPEED,
  READ_ALOUD_FLING_TAU,
  READ_ALOUD_TOUCH_SIZE,
  type MotionState,
  type Point,
} from '../reader/read-aloud-floating.ts';
import type { SpeechPlaybackState } from '../reader/speech-playback.ts';

interface Props {
  width: number;
  height: number;
  round: boolean;
  active: boolean;
  page: string;
  state?: SpeechPlaybackState;
  onOpen: () => void;
}

interface DockState { right: boolean; verticalFraction: number }
const dock: DockState = { right: true, verticalFraction: 0.65 };
const now = () => globalThis.performance?.now?.() ?? Date.now();
const statePoint = (position: Point, velocity: Point = { x: 0, y: 0 }): MotionState => ({ position, velocity });
const clampPoint = (point: Point, props: Props) => clampBubbleCenter(point, props.width, props.height, props.round);

function initialPoint(props: Props): Point {
  const x = dock.right ? props.width - READ_ALOUD_TOUCH_SIZE / 2 - 4 : READ_ALOUD_TOUCH_SIZE / 2 + 4;
  return clampPoint({ x, y: props.height * dock.verticalFraction }, props);
}

function titleFor(state?: SpeechPlaybackState): string {
  if (!state) return '打开朗读控制';
  if (state.phase === 'error') return '朗读失败，打开朗读控制';
  if (state.phase === 'resolving') return '正在读取内容，打开朗读控制';
  if (state.phase === 'preparing') return '正在准备朗读，打开朗读控制';
  return state.playing ? '正在朗读，打开朗读控制' : '朗读已暂停，打开朗读控制';
}

export function ReadAloudFloatingBubble(props: Props) {
  const [position, setPosition] = createSignal<Point>(initialPoint(props));
  const [visible, setVisible] = createSignal(false);
  let node: NodeMirror | undefined;
  let target = position();
  let motion = statePoint(position());
  let pointerOffset: Point = { x: 0, y: 0 };
  let dragging = false;
  let phase: 'idle' | 'fling' | 'snap' = 'idle';
  let phaseStart = 0;
  let phaseStartPoint = position();
  let phaseVelocity: Point = { x: 0, y: 0 };
  let snapTarget = position();
  let snapOrigin = position();
  let snapCrossed = false;
  let lastFrame = 0;

  const isVisible = () => !!props.active && props.page !== 'speech-playback' && props.state?.phase !== 'idle' && !!props.state;
  const updateVisible = () => {
    const next = isVisible();
    setVisible(previous => {
      if (previous && !next) {
        dragging = false;
        phase = 'idle';
        motion = statePoint(motion.position);
        target = motion.position;
        lastFrame = 0;
      }
      return next;
    });
  };
  const updatePosition = (next: Point) => {
    const safe = clampPoint(next, props);
    setPosition(safe);
    motion = { position: safe, velocity: motion.velocity };
  };

  createGesture({
    region: { node: () => visible() ? node : undefined },
    axis: 'any',
    panSlop: 7,
    onTap: () => { if (isVisible()) props.onOpen(); },
    onPanStart: contact => {
      dragging = true;
      phase = 'idle';
      lastFrame = now();
      pointerOffset = { x: motion.position.x - contact.startX, y: motion.position.y - contact.startY };
      target = motion.position;
    },
    onPanMove: contact => {
      if (!dragging) return;
      target = clampPoint({ x: contact.x + pointerOffset.x, y: contact.y + pointerOffset.y }, props);
      const frameNow = now();
      const dt = lastFrame ? Math.min(0.05, Math.max(0, frameNow - lastFrame) / 1000) : 0;
      lastFrame = frameNow;
      motion = criticallyDampedStep(motion, target, dt);
      const safe = clampPoint(motion.position, props);
      if (safe.x !== motion.position.x || safe.y !== motion.position.y) motion = { position: safe, velocity: { x: 0, y: 0 } };
      setPosition(motion.position);
    },
    onPanEnd: contact => {
      if (!dragging) return;
      dragging = false;
      phase = 'fling';
      phaseStart = now();
      phaseStartPoint = motion.position;
      phaseVelocity = { x: contact.vx, y: contact.vy };
      lastFrame = phaseStart;
    },
    onCancel: () => {
      if (!dragging) return;
      dragging = false;
      beginSnap({ x: 0, y: 0 });
    },
  });

  function beginSnap(velocity: Point, projectedEnd: Point = motion.position) {
    snapTarget = nearestPoint(clampPoint(projectedEnd, props), readAloudSafeCorners(props.width, props.height, props.round));
    motion = { position: clampPoint(motion.position, props), velocity };
    snapOrigin = motion.position;
    snapCrossed = Math.hypot(snapOrigin.x - snapTarget.x, snapOrigin.y - snapTarget.y) < 1e-4;
    phase = 'snap';
    lastFrame = now();
  }

  onFrame(() => {
    const frameNow = now();
    if (!props.active || !visible()) { lastFrame = frameNow; return; }
    const dt = lastFrame ? Math.min(0.05, Math.max(0, frameNow - lastFrame) / 1000) : 0;
    lastFrame = frameNow;
    if (dragging) {
      motion = criticallyDampedStep(motion, target, dt);
      const safe = clampPoint(motion.position, props);
      if (safe.x !== motion.position.x || safe.y !== motion.position.y) motion = { position: safe, velocity: { x: 0, y: 0 } };
      setPosition(motion.position);
      return;
    }
    if (phase === 'fling') {
      const elapsed = Math.max(0, frameNow - phaseStart) / 1000;
      const endpoint = clampPoint(exponentialFlingEnd(phaseStartPoint, phaseVelocity), props);
      const speed = Math.hypot(phaseVelocity.x, phaseVelocity.y) * Math.exp(-elapsed / READ_ALOUD_FLING_TAU);
      const raw = exponentialFlingPosition(phaseStartPoint, phaseVelocity, elapsed);
      const safe = clampPoint(raw, props);
      const remainingVelocity = { x: phaseVelocity.x * Math.exp(-elapsed / READ_ALOUD_FLING_TAU), y: phaseVelocity.y * Math.exp(-elapsed / READ_ALOUD_FLING_TAU) };
      motion = { position: safe, velocity: remainingVelocity };
      setPosition(safe);
      const hitBoundary = safe.x !== raw.x || safe.y !== raw.y;
      if (speed <= READ_ALOUD_FLING_STOP_SPEED || elapsed >= READ_ALOUD_FLING_MAX_SECONDS || hitBoundary) {
        beginSnap(hitBoundary ? { x: 0, y: 0 } : remainingVelocity, endpoint);
      }
      return;
    }
    if (phase === 'snap') {
      const snap = cappedDampedSnapStep(motion, snapTarget, snapOrigin, snapCrossed, dt);
      motion = snap.state;
      snapCrossed = snap.crossed;
      const safe = clampPoint(motion.position, props);
      if (safe.x !== motion.position.x || safe.y !== motion.position.y) motion = { position: safe, velocity: { x: 0, y: 0 } };
      setPosition(motion.position);
      if (Math.hypot(snapTarget.x - motion.position.x, snapTarget.y - motion.position.y) < 0.15 && Math.hypot(motion.velocity.x, motion.velocity.y) < 1) {
        motion = statePoint(snapTarget);
        updatePosition(snapTarget);
        phase = 'idle';
        dock.right = snapTarget.x >= props.width / 2;
        dock.verticalFraction = snapTarget.y / Math.max(1, props.height);
      }
    }
  });

  createEffect(() => {
    props.width; props.height; props.round;
    const safe = clampPoint(position(), props);
    if (safe.x !== position().x || safe.y !== position().y) {
      motion = { position: safe, velocity: { x: 0, y: 0 } };
      setPosition(safe);
    }
  });
  createEffect(updateVisible);
  onCleanup(() => { phase = 'idle'; dragging = false; });

  return <Show when={visible()}>
    <View
      ref={value => { node = value; }}
      debugName="ReadAloudFloatingBubble"
      focusable
      accessibilityRole="button"
      accessibilityLabel={titleFor(props.state)}
      class="absolute w-[48] h-[48] rounded-full items-center justify-center active:scale-96"
      style={{ insetL: position().x - READ_ALOUD_TOUCH_SIZE / 2, insetT: position().y - READ_ALOUD_TOUCH_SIZE / 2 }}
    >
      <View class="absolute w-[40] h-[40] rounded-full bg-[#1c1f21] items-center justify-center">
        <Image src="../assets/icons/speech-volume.svg" class="w-[22] h-[22]" />
      </View>
    </View>
  </Show>;
}
