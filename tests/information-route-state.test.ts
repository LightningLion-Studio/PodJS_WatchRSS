import { expect, test } from "bun:test";
import {
  checkpointInformationSnapshot,
  rememberInformationSnapshot,
  type InformationRouteState,
} from "../src/ui/information-route-state.ts";
import type { InformationSnapshot } from "../src/ui/InformationScreens.tsx";

const snapshot = (scrollOffset: number): InformationSnapshot => ({
  content: "正文",
  error: null,
  isLoading: false,
  reloadKey: 2,
  listAnchor: { index: 3, offsetPx: scrollOffset },
  scrollOffset,
});

test("information route retains content, loading state and the latest scroll checkpoint", () => {
  const route: InformationRouteState = {};
  rememberInformationSnapshot(route, {
    ...snapshot(40),
    content: null,
    isLoading: true,
  });
  expect(route.informationSnapshot).toMatchObject({
    content: null,
    isLoading: true,
    scrollOffset: 40,
  });

  route.informationSnapshotReader = () => snapshot(96);
  expect(checkpointInformationSnapshot(route)).toEqual(snapshot(96));
  expect(route.informationSnapshot).toEqual(snapshot(96));

  route.informationSnapshotReader = undefined;
  expect(checkpointInformationSnapshot(route)).toEqual(snapshot(96));
});
