import { describe, expect, test } from 'bun:test';
import { clampDockCenter } from '@podjs/framework/watch-ui';
import {
  cappedDampedSnapStep,
  criticallyDampedStep,
  dampedSnapStep,
  exponentialFlingEnd,
  exponentialFlingPosition,
  type MotionState,
} from '../src/reader/read-aloud-floating.ts';

describe('read-aloud floating motion', () => {
  test('critical follower preserves velocity when its target is retargeted', () => {
    let state: MotionState = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    for (let i = 0; i < 10; i++) state = criticallyDampedStep(state, { x: 100, y: 0 }, 0.016);
    expect(state.position.x).toBeGreaterThan(0);
    expect(state.velocity.x).toBeGreaterThan(0);
    const retargeted = criticallyDampedStep(state, { x: 200, y: 0 }, 0.016);
    expect(retargeted.position.x).toBeGreaterThan(state.position.x);
    expect(retargeted.velocity.x).toBeGreaterThan(0);
  });

  test('critical follower settles to about 95 percent in 350ms', () => {
    let state: MotionState = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    for (let i = 0; i < 22; i++) state = criticallyDampedStep(state, { x: 100, y: 0 }, 0.016);
    expect(state.position.x).toBeGreaterThan(94);
    expect(state.position.x).toBeLessThan(97);
  });

  test('exponential fling integrates to p0 plus tau times release velocity', () => {
    const start = { x: 50, y: 60 }, velocity = { x: 800, y: -500 }, tau = 0.18;
    expect(exponentialFlingEnd(start, velocity, tau)).toEqual({ x: 194, y: -30 });
    const nearEnd = exponentialFlingPosition(start, velocity, 6 * tau, tau);
    expect(Math.abs(nearEnd.x - 194)).toBeLessThan(1.5);
    expect(Math.abs(nearEnd.y + 30)).toBeLessThan(1);
  });

  test('spring snap stays bouncy but caps post-target travel at eight dp', () => {
    const target = { x: 284, y: 36 };
    const origin = { x: 160, y: 120 };
    let state: MotionState = { position: origin, velocity: { x: 0, y: 0 } };
    let crossed = false;
    let passedTarget = false;
    for (let i = 0; i < 160; i++) {
      const next = cappedDampedSnapStep(state, target, origin, crossed, 0.016);
      state = next.state;
      crossed = next.crossed;
      if (crossed && Math.hypot(state.position.x - target.x, state.position.y - target.y) > 0.1) passedTarget = true;
      state = { ...state, position: clampDockCenter(state.position, 320, 240, false, 28) };
    }
    expect(passedTarget).toBe(true);
    expect(crossed).toBe(true);
    expect(Math.hypot(state.position.x - target.x, state.position.y - target.y)).toBeLessThanOrEqual(8 + 1e-8);
    expect(state.position.x).toBeGreaterThanOrEqual(28);
    expect(state.position.y).toBeGreaterThanOrEqual(28);
  });
});
