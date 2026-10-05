import { Show } from "solid-js";
import type { RecommendedChannel } from "../../rss/recommendations.ts";
import {
  InformationScreen,
  type InformationPage,
} from "../InformationScreens.tsx";
import { RecommendationScreen } from "../RecommendationScreen.tsx";
import type { Page, RouteEntry, SetPage } from "./types.ts";

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
          onOpenUrl={(url) => void props.openUrl(url)}
          legalBaseUrl="https://sly-data-plane.watchrss.cn"
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
    </>
  );
}
