export interface MediaVolumeState { min:number; max:number; current:number; fixed:boolean }
export interface MediaVolumePort { state():Promise<MediaVolumeState>; setIndex(index:number):Promise<MediaVolumeState> }

export function normalizePlaybackStartVolumeLimit(value:number|null):number|null {
  return value === null ? null : Number.isInteger(value) && value >= 0 && value <= 100 && value % 5 === 0 ? value : 10;
}

/** Native settings cycle through unlimited, mute, and every five percent. */
export function adjacentPlaybackStartVolumeLimit(value:number|null, direction:-1|1):number|null {
  const normalized = normalizePlaybackStartVolumeLimit(value);
  const index = normalized === null ? 0 : normalized / 5 + 1;
  const next = (index + direction + 22) % 22;
  return next === 0 ? null : (next - 1) * 5;
}

export function formatPlaybackStartVolumeLimit(value:number|null):string {
  const normalized = normalizePlaybackStartVolumeLimit(value);
  return normalized === null ? "无限制" : `${normalized}%`;
}

/** Mirrors native Float arithmetic and its minimum positive physical volume step. */
export function playbackStartVolumeTarget(limit:number|null, state:MediaVolumeState):number|null {
  if (limit === null || state.fixed || state.max <= state.min) return null;
  // Native settings normalize unsupported values to 10 percent.
  const percent = normalizePlaybackStartVolumeLimit(limit)!;
  const current = Math.min(state.max, Math.max(state.min, state.current));
  const target = percent <= 0 ? state.min : Math.min(state.max, Math.max(state.min + 1,
    Math.fround(state.min + Math.fround((state.max - state.min) * Math.fround(percent / 100)))));
  const rounded = Math.min(state.max, Math.max(state.min, Math.round(target)));
  return current > target && rounded !== current ? rounded : null;
}

export async function enforcePlaybackStartVolume(port:MediaVolumePort, limit:number|null, isCurrent:()=>boolean=()=>true):Promise<void> {
  if (limit === null || !isCurrent()) return;
  const state = await port.state();
  if (!isCurrent()) return;
  const target = playbackStartVolumeTarget(limit, state);
  if (target !== null) await port.setIndex(target);
}
