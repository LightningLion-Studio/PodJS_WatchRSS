import { describe, expect, test } from 'bun:test';
import {
  NOVEL_MENU_CLOSE_MS,
  NOVEL_MENU_CONTROLS_FADE_START,
  NOVEL_MENU_OPEN_MS,
  novelMenuAnimatedProgress,
  novelMenuControlsAlpha,
  novelMenuEasing,
  novelMenuRevealGeometry,
  novelMenuRevealRadius,
  novelMenuScrimAlpha,
} from '../src/ui/novel-menu-animation.ts';

describe('novel menu reveal animation', () => {
  test('opening and closing use the native durations and easing endpoints', () => {
    expect(NOVEL_MENU_OPEN_MS).toBe(260);
    expect(NOVEL_MENU_CLOSE_MS).toBe(220);
    expect(novelMenuAnimatedProgress(0, 1, 0, NOVEL_MENU_OPEN_MS)).toBe(0);
    expect(novelMenuAnimatedProgress(0, 1, NOVEL_MENU_OPEN_MS, NOVEL_MENU_OPEN_MS)).toBe(1);
    expect(novelMenuAnimatedProgress(1, 0, NOVEL_MENU_CLOSE_MS, NOVEL_MENU_CLOSE_MS)).toBe(0);
    expect(novelMenuEasing(0.5)).toBeGreaterThan(0.7);
    expect(novelMenuEasing(0.5)).toBeLessThan(0.85);
  });

  test('the reveal starts at the bubble and reaches the farthest viewport corner', () => {
    const geometry = novelMenuRevealGeometry(192, 192, 96, 162, 16);
    expect(novelMenuRevealRadius(0, geometry)).toBe(16);
    const cover = novelMenuRevealRadius(1, geometry);
    expect(cover).toBe(geometry.coverRadius);
    expect(cover).toBeGreaterThanOrEqual(Math.hypot(96, 162));
    expect(cover).toBeGreaterThanOrEqual(Math.hypot(96, 30));
  });

  test('scrim follows reveal progress and menu controls fade in after 65 percent', () => {
    expect(novelMenuScrimAlpha(0)).toBe(0);
    expect(novelMenuScrimAlpha(1)).toBe(0.45);
    expect(novelMenuControlsAlpha(NOVEL_MENU_CONTROLS_FADE_START)).toBe(0);
    expect(novelMenuControlsAlpha(1)).toBe(1);
  });
});
