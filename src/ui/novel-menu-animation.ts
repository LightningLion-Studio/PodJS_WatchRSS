export const NOVEL_MENU_OPEN_MS = 260;
export const NOVEL_MENU_CLOSE_MS = 220;
export const NOVEL_MENU_SCRIM_MAX_ALPHA = 0.45;
export const NOVEL_MENU_CONTROLS_FADE_START = 0.65;

export interface RevealGeometry {
  centerX: number;
  centerY: number;
  startRadius: number;
  coverRadius: number;
}

const bezier = (t: number, a: number, b: number) => {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
};

/** Compose's FastOutSlowInEasing (cubic-bezier(.4, 0, .2, 1)). */
export function novelMenuEasing(progress: number): number {
  const x = Math.max(0, Math.min(1, progress));
  let low = 0, high = 1, t = x;
  for (let i = 0; i < 18; i++) {
    const value = bezier(t, 0.4, 0.2);
    if (Math.abs(value - x) < 1e-6) break;
    if (value < x) low = t; else high = t;
    t = (low + high) / 2;
  }
  return bezier(t, 0, 1);
}

export function novelMenuAnimatedProgress(from: number, to: number, elapsedMs: number, durationMs: number): number {
  const progress = durationMs <= 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / durationMs));
  return from + (to - from) * novelMenuEasing(progress);
}

export function novelMenuRevealGeometry(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  startRadius: number,
): RevealGeometry {
  const coverRadius = Math.max(
    Math.hypot(centerX, centerY),
    Math.hypot(width - centerX, centerY),
    Math.hypot(centerX, height - centerY),
    Math.hypot(width - centerX, height - centerY),
  );
  return { centerX, centerY, startRadius, coverRadius };
}

export function novelMenuRevealRadius(progress: number, geometry: RevealGeometry): number {
  return geometry.startRadius + (geometry.coverRadius - geometry.startRadius) * Math.max(0, Math.min(1, progress));
}

export function novelMenuScrimAlpha(progress: number): number {
  return NOVEL_MENU_SCRIM_MAX_ALPHA * Math.max(0, Math.min(1, progress));
}

export function novelMenuControlsAlpha(progress: number): number {
  return Math.max(0, Math.min(1, (progress - NOVEL_MENU_CONTROLS_FADE_START) / (1 - NOVEL_MENU_CONTROLS_FADE_START)));
}
