import { createEffect, createSignal, onCleanup } from "solid-js";
import { cancelActiveTouches, createGesture, pushTouchBlock } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BackMotion } from "@podjs/framework/navigation";

export function createBluetoothWarningNavigation(options: {
  width: number;
  height: number;
  active: () => boolean;
  shown: () => boolean;
  hide: () => void;
}) {
  const { width, height, active, shown, hide } = options;
  const motion = new BackMotion(width);
  const [offset, setOffset] = createSignal(0);
  const reset = () => { motion.reset(); setOffset(0); };
  const dismiss = () => {
    if (!shown()) return;
    cancelActiveTouches();
    reset();
    hide();
  };

  createEffect(() => {
    if (shown()) onCleanup(pushTouchBlock());
  });
  createEffect(() => { if (!active()) reset(); });
  createGesture({
    region: {
      rect: () => shown() && active() && motion.phase !== "settling"
        ? { x: 0, y: 0, w: width, h: height } : null,
    },
    allowWhenBlocked: true,
    axis: "x",
    panSlop: 8,
    onPanStart: contact => { motion.begin(contact.dx); setOffset(motion.offset); },
    onPanMove: contact => { motion.move(contact.dx); setOffset(motion.offset); },
    onPanEnd: contact => motion.release(contact.vx, Date.now()),
    onCancel: () => { if (motion.phase === "dragging") motion.release(0, Date.now(), true); },
  });
  onFrame(() => {
    const result = motion.tick(Date.now());
    if (result === "commit") dismiss();
    else setOffset(motion.offset);
  }, () => shown() && motion.phase === "settling");

  return {
    dismiss,
    offset,
    onContinue: () => { if (motion.phase === "idle") dismiss(); },
    onBack: () => {
      if (!shown()) return false;
      if (motion.phase === "idle") {
        motion.begin(0);
        motion.release(0, Date.now(), false, true);
      }
      return true;
    },
  };
}
