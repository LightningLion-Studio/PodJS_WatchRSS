export type PlayerScaleMode = "standard" | "expanded" | "shrunk";
export interface CrownVolumeGuardState { sessionCap?: number; lastEventMs: number }

export function nextScaleMode(mode: PlayerScaleMode): PlayerScaleMode {
  return mode === "standard" ? "expanded" : mode === "expanded" ? "shrunk" : "standard";
}

export function formatPlayerTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--";
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function seekHoldStep(elapsedMs: number, direction: -1 | 1): number {
  const multiplier = Math.pow(1.35, Math.max(0, elapsedMs) / 1000);
  return Math.min(60_000, Math.round(4_000 * multiplier)) * direction;
}

export function progressWidth(positionMs: number, durationMs: number, width: number): number {
  if (durationMs <= 0 || width <= 0) return 0;
  return width * Math.max(0, Math.min(1, positionMs / durationMs));
}

export function guardedCrownVolume(current: number, requestedDelta: number, maxSteps: number, enabled: boolean, previous: CrownVolumeGuardState, nowMs: number): { volume: number; state: CrownVolumeGuardState } {
  const clamped = Math.max(0, Math.min(1, current));
  if (requestedDelta === 0) return { volume: clamped, state: previous };
  const fresh = !Number.isFinite(previous.lastEventMs) || nowMs - previous.lastEventMs > 600;
  let cap = fresh || requestedDelta < 0 || !enabled ? undefined : previous.sessionCap;
  let volume = Math.max(0, Math.min(1, clamped + requestedDelta));
  if (enabled && requestedDelta > 0) {
    const activation = Math.round(Math.max(1, maxSteps) * .21) / Math.max(1, maxSteps);
    const effective = cap ?? (clamped < activation ? .21 : undefined);
    if (effective !== undefined) { cap = effective; volume = Math.min(volume, effective); }
  }
  return { volume, state: { sessionCap: cap, lastEventMs: nowMs } };
}

export function playerScale(mode: PlayerScaleMode, viewWidth: number, viewHeight: number, videoWidth: number, videoHeight: number): { scaleX: number; scaleY: number } {
  if (viewWidth <= 0 || viewHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return { scaleX: 1, scaleY: 1 };
  const viewAspect = viewWidth / viewHeight, videoAspect = videoWidth / videoHeight;
  const standard = videoAspect > viewAspect ? { scaleX: 1, scaleY: viewAspect / videoAspect } : { scaleX: videoAspect / viewAspect, scaleY: 1 };
  if (mode === "standard") return standard;
  if (mode === "expanded") return videoAspect > viewAspect ? { scaleX: videoAspect / viewAspect, scaleY: 1 } : { scaleX: 1, scaleY: viewAspect / videoAspect };
  const contentWidth = viewWidth * standard.scaleX, contentHeight = viewHeight * standard.scaleY;
  const factor = Math.min(1, viewWidth / Math.sqrt(contentWidth * contentWidth + contentHeight * contentHeight));
  return { scaleX: standard.scaleX * factor, scaleY: standard.scaleY * factor };
}

export function playerPanRange(mode: PlayerScaleMode, viewWidth: number, viewHeight: number, videoWidth: number, videoHeight: number, rotationDeg = 0): { axis: "x" | "y"; range: number } {
  if (Math.round(rotationDeg / 90) % 2 !== 0) [videoWidth, videoHeight] = [videoHeight, videoWidth];
  const portrait = videoHeight > videoWidth, axis = portrait ? "y" : "x";
  if (mode !== "expanded") return { axis, range: 0 };
  const scale = playerScale(mode, viewWidth, viewHeight, videoWidth, videoHeight);
  const contentWidth = viewWidth * scale.scaleX, contentHeight = viewHeight * scale.scaleY;
  const radius = Math.min(viewWidth, viewHeight) / 2;
  if (portrait) {
    const halfWidth = Math.min(contentWidth / 2, radius);
    return { axis, range: Math.max(0, contentHeight / 2 - Math.sqrt(Math.max(0, radius * radius - halfWidth * halfWidth))) };
  }
  const halfHeight = Math.min(contentHeight / 2, radius);
  return { axis, range: Math.max(0, contentWidth / 2 - Math.sqrt(Math.max(0, radius * radius - halfHeight * halfHeight))) };
}
