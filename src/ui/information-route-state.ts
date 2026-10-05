import type { InformationSnapshot } from "./InformationScreens.tsx";

export interface InformationRouteState {
  informationSnapshot?: InformationSnapshot;
  informationSnapshotReader?: () => InformationSnapshot;
}

export function rememberInformationSnapshot(
  state: InformationRouteState,
  snapshot: InformationSnapshot,
): void {
  state.informationSnapshot = snapshot;
}

export function checkpointInformationSnapshot(
  state: InformationRouteState,
): InformationSnapshot | undefined {
  const snapshot = state.informationSnapshotReader?.();
  if (snapshot) rememberInformationSnapshot(state, snapshot);
  return snapshot ?? state.informationSnapshot;
}
