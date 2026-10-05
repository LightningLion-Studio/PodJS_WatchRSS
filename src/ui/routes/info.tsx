import { onCleanup, Show } from "solid-js";
import type { RecommendedChannel } from "../../rss/recommendations.ts";
import {
  InformationScreen,
  type InformationPage,
} from "../InformationScreens.tsx";
import { RecommendationScreen } from "../RecommendationScreen.tsx";
import { LogUploadScreen } from "../LogUploadScreen.tsx";
import { createHostLogUploadOptions } from "../../logs/host.ts";
import type { Page, RouteEntry, SetPage } from "./types.ts";
import {
  checkpointInformationSnapshot,
  rememberInformationSnapshot,
} from "../information-route-state.ts";

type InformationProps = Parameters<typeof InformationScreen>[0];

interface InfoRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  foreground: () => boolean;
  width: number;
  height: number;
  preset: () => InformationProps["preset"];
  fonts: () => InformationProps["fonts"];
  backgroundSnapshot: () => InformationProps["backgroundSnapshot"];
  setPage: SetPage;
  openInformation: (page: InformationPage) => void;
  addRecommendation: (channel: RecommendedChannel) => void;
  openUrl: (url: string) => Promise<void>;
}

export function InfoRoutes(props: InfoRoutesProps) {
  onCleanup(() => {
    checkpointInformationSnapshot(props.entry);
    props.entry.informationSnapshotReader = undefined;
  });
  return (
    <>
      <Show when={props.page() === "recommendations"}>
        <RecommendationScreen
          width={props.width}
          height={props.height}
          groupId={props.entry.recommendationGroup}
          onGroup={(recommendationGroup) =>
            props.setPage("recommendations", { recommendationGroup })
          }
          onAdd={props.addRecommendation}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "information"}>
        <InformationScreen
          width={props.width}
          height={props.height}
          preset={props.preset()}
          fonts={props.fonts()}
          backgroundSnapshot={props.backgroundSnapshot()}
          active={() => props.active() && props.foreground()}
          page={props.entry.informationPage ?? "about"}
          onNavigate={props.openInformation}
          onUploadLogs={() => props.setPage("log-upload")}
          onOpenUrl={(url) => void props.openUrl(url)}
          legalBaseUrl="https://sly-data-plane.watchrss.cn"
          restoredState={props.entry.informationSnapshot}
          onSnapshotChange={(snapshot) =>
            rememberInformationSnapshot(props.entry, snapshot)
          }
          ref={(value) => {
            props.entry.list = value;
            props.entry.informationSnapshotReader = value.snapshot;
          }}
        />
      </Show>
      <Show when={props.page() === "log-upload"}>
        <LogUploadScreen
          height={props.height}
          options={createHostLogUploadOptions()}
          active={() => props.active() && props.foreground()}
        />
      </Show>
    </>
  );
}
