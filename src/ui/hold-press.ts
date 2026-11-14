import { onCleanup } from "solid-js";
import type { NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";

/** Repeat period of a held button (the player's rewind/forward cadence). */
export const HOLD_REPEAT_MS = 200;

/**
 * Tap vs. hold for a button node: a tap calls `onPress`; holding past .5 s calls `onHold(elapsedMs)`
 * at once and then every HOLD_REPEAT_MS until release. Shared by the player's rewind/forward and the
 * detail panel's steppers, so both accelerate identically (see seekHoldStep/holdStepCount).
 */
export function createHoldPress(node: () => NodeMirror | undefined, options: { enabled?: () => boolean; onPress: () => void; onHold?: (elapsedMs: number) => void; onHoldEnd?: () => void }) {
  let holding = false, holdStart = 0, nextHold = 0;
  const enabled = () => options.enabled?.() !== false;
  const end = () => { if (holding) { holding = false; options.onHoldEnd?.(); } };
  const gesture = createGesture({ region: { node }, longPressSeconds: .5,
    onTap: () => { if (enabled()) options.onPress(); },
    onLongPress: () => { if (!enabled() || !options.onHold) return; holding = true; holdStart = Date.now(); nextHold = 0; },
    onUp: end, onCancel: end,
  });
  onFrame(() => { if (!holding || !options.onHold) return; const elapsed = Date.now() - holdStart; if (elapsed >= nextHold) { options.onHold(elapsed); nextHold = elapsed + HOLD_REPEAT_MS; } });
  onCleanup(() => gesture.dispose());
}
