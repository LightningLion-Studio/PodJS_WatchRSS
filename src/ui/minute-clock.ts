import {createEffect, createMemo, createSignal, onCleanup, type Accessor} from 'solid-js';
import {delay} from '@podjs/framework/services';

/** Wall time for minute-based UI. A resumed page immediately samples the current minute. */
export function useMinuteClock(active: Accessor<boolean>): Accessor<Date> {
  const enabled = createMemo(active);
  const [now, setNow] = createSignal(new Date());
  createEffect(() => {
    if (!enabled()) return;
    let live = true;
    let timer: ReturnType<typeof delay>;
    const update = () => {
      if (!live) return;
      const time = Date.now();
      setNow(previous => Math.floor(previous.getTime() / 60000) === Math.floor(time / 60000)
        ? previous : new Date(time));
      timer = delay(60000 - time % 60000);
      void timer.result.then(update, () => {});
    };
    update();
    onCleanup(() => { live = false; timer.cancel(); });
  });
  return now;
}
