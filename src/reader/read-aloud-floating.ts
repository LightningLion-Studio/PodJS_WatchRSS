import type { DockPoint } from "@podjs/framework/watch-ui";

export type Point = DockPoint;
export interface MotionState { position: Point; velocity: Point }

export const READ_ALOUD_TOUCH_SIZE = 48;
export const READ_ALOUD_VISIBLE_SIZE = 40;
export const READ_ALOUD_FOLLOW_OMEGA = 13.55;
export const READ_ALOUD_FLING_TAU = 0.18;
export const READ_ALOUD_FLING_STOP_SPEED = 8;
export const READ_ALOUD_FLING_MAX_SECONDS = 6 * READ_ALOUD_FLING_TAU;
export const READ_ALOUD_SNAP_STIFFNESS = 200;
export const READ_ALOUD_SNAP_DAMPING_RATIO = 0.5;
export const READ_ALOUD_MAX_OVERSHOOT = 8;
/** Exact critical-damping step for a fixed target, preserving velocity on retarget. */
export function criticallyDampedStep(
  state: MotionState,
  target: Point,
  dtSeconds: number,
  omega = READ_ALOUD_FOLLOW_OMEGA,
): MotionState {
  const dt = Math.max(0, Math.min(0.05, dtSeconds));
  const decay = Math.exp(-omega * dt);
  const axis = (position: number, velocity: number, destination: number) => {
    const error = position - destination;
    const c = velocity + omega * error;
    return {
      position: destination + (error + c * dt) * decay,
      velocity: (velocity - omega * c * dt) * decay,
    };
  };
  const x = axis(state.position.x, state.velocity.x, target.x);
  const y = axis(state.position.y, state.velocity.y, target.y);
  return { position: { x: x.position, y: y.position }, velocity: { x: x.velocity, y: y.velocity } };
}

export function exponentialFlingPosition(
  start: Point,
  velocity: Point,
  elapsedSeconds: number,
  tau = READ_ALOUD_FLING_TAU,
): Point {
  const progress = 1 - Math.exp(-Math.max(0, elapsedSeconds) / tau);
  return { x: start.x + tau * velocity.x * progress, y: start.y + tau * velocity.y * progress };
}

export function exponentialFlingEnd(
  start: Point,
  velocity: Point,
  tau = READ_ALOUD_FLING_TAU,
): Point {
  return { x: start.x + tau * velocity.x, y: start.y + tau * velocity.y };
}

/** Semi-implicit underdamped spring step used for edge docking. */
export function dampedSnapStep(
  state: MotionState,
  target: Point,
  dtSeconds: number,
  stiffness = READ_ALOUD_SNAP_STIFFNESS,
  dampingRatio = READ_ALOUD_SNAP_DAMPING_RATIO,
): MotionState {
  const steps = Math.max(1, Math.ceil(Math.max(0, dtSeconds) / 0.008));
  const step = Math.max(0, dtSeconds) / steps;
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);
  let { x, y } = state.position;
  let vx = state.velocity.x;
  let vy = state.velocity.y;
  for (let i = 0; i < steps; i++) {
    const ax = stiffness * (target.x - x) - damping * vx;
    const ay = stiffness * (target.y - y) - damping * vy;
    vx += ax * step;
    vy += ay * step;
    x += vx * step;
    y += vy * step;
  }
  return { position: { x, y }, velocity: { x: vx, y: vy } };
}

/** Keep the underdamped snap visibly bouncy without letting it swing
 * more than the specified distance past its target. */
export function cappedDampedSnapStep(
  state: MotionState,
  target: Point,
  origin: Point,
  crossed: boolean,
  dtSeconds: number,
  maxOvershoot = READ_ALOUD_MAX_OVERSHOOT,
): { state: MotionState; crossed: boolean } {
  const next = dampedSnapStep(state, target, dtSeconds);
  const start = { x: origin.x - target.x, y: origin.y - target.y };
  const before = { x: state.position.x - target.x, y: state.position.y - target.y };
  const after = { x: next.position.x - target.x, y: next.position.y - target.y };
  const didCross = crossed || start.x * start.x + start.y * start.y < 1e-8 ||
    (before.x * start.x + before.y * start.y > 0 && after.x * start.x + after.y * start.y <= 0);
  const distance = Math.hypot(after.x, after.y);
  if (!didCross || distance <= maxOvershoot || distance === 0) return { state: next, crossed: didCross };

  const normal = { x: after.x / distance, y: after.y / distance };
  const outwardSpeed = next.velocity.x * normal.x + next.velocity.y * normal.y;
  const velocity = outwardSpeed > 0
    ? { x: next.velocity.x - normal.x * outwardSpeed, y: next.velocity.y - normal.y * outwardSpeed }
    : next.velocity;
  return {
    state: {
      position: { x: target.x + normal.x * maxOvershoot, y: target.y + normal.y * maxOvershoot },
      velocity,
    },
    crossed: didCross,
  };
}
