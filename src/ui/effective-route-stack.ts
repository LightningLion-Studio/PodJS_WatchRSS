import { batch, createMemo, createSignal } from "solid-js";

export function createEffectiveRouteStack<Entry>(initial: Entry[]) {
  // The actual stack is the routes followed by the optional warning page.
  const [actualStack, setActualStack] = createSignal({
    routes: initial,
    warning: false,
  });
  const effectiveStack = createMemo(() => actualStack().routes);
  const warningShown = () => actualStack().warning;
  const showWarning = () => setActualStack(state => ({ ...state, warning: true }));
  const hideWarning = () => setActualStack(state => ({ ...state, warning: false }));

  function commitStack(next: Entry[] | ((entries: Entry[]) => Entry[]), dismissWarning: () => void) {
    const previous = effectiveStack();
    const entries = typeof next === "function" ? next(previous) : next;
    if (entries === previous) return previous;
    const changed = entries.length !== previous.length ||
      entries.some((entry, index) => !Object.is(entry, previous[index]));
    batch(() => {
      if (changed && warningShown()) dismissWarning();
      setActualStack(state => ({ routes: entries, warning: changed ? false : state.warning }));
    });
    return entries;
  }

  return { effectiveStack, warningShown, showWarning, hideWarning, commitStack };
}
