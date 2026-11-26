import { batch } from "solid-js";

export function createRouteOwnership<Entry>(options: {
  content: () => Entry;
  backPhase: () => string;
  warningShown?: () => boolean;
  dismissWarning?: () => void;
  disposed?: () => boolean;
}) {
  // Compare content routes so opening or closing a warning preserves ownership.
  const canReceiveData = (source: Entry) =>
    !options.disposed?.() && options.content() === source;

  // Master suppresses pushes during content back motion. Motion belonging to
  // the warning would not exist on master.
  const canCommitNavigation = (source: Entry, requiresIdle = true) =>
    canReceiveData(source) &&
    (!requiresIdle || options.warningShown?.() || options.backPhase() === "idle");

  function commitNavigation(source: Entry, apply: () => void, requiresIdle = true) {
    if (!canCommitNavigation(source, requiresIdle)) return false;
    batch(() => {
      if (options.warningShown?.()) options.dismissWarning?.();
      apply();
    });
    return true;
  }

  return { canReceiveData, canCommitNavigation, commitNavigation };
}

export type RouteOwnership<Entry> = ReturnType<typeof createRouteOwnership<Entry>>;
