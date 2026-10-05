import { Show } from "solid-js";
import type { SpeechPlaybackState } from "../../reader/speech-playback.ts";
import { AccountStatusScreen } from "../AccountStatusScreen.tsx";
import HomeScreen, { type HomeScreenProps } from "../HomeScreen.tsx";
import { PhoneConnectionScreen } from "../PhoneConnectionScreen.tsx";
import { ProfileScreen } from "../ProfileScreen.tsx";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinRoute } from "../douyin/index.tsx";
import type { HomePlatformLoginState } from "../home-extras.ts";
import type { AppServices, Channel } from "../service.ts";
import type { Page, RouteEntry } from "./types.ts";

type ChannelAction = (
  id: string,
  action: "move" | "pin" | "read" | "delete",
) => Promise<void>;

interface HomeRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  channels: () => Channel[];
  notesPlacement: HomeScreenProps["notesPlacement"];
  refreshing: () => boolean;
  busy: () => boolean;
  platformLoginState: () => HomePlatformLoginState;
  speechState: () => SpeechPlaybackState | undefined;
  services: AppServices;
  go: (page: Page) => Promise<void>;
  openSpeech: () => void;
  openAdd: () => void;
  refresh: () => Promise<void>;
  openBili: (route: BiliRoute) => Promise<void>;
  openDouyin: (route: DouyinRoute) => Promise<void>;
  openFeed: (channel: Channel) => void;
  channelAction: ChannelAction;
  openInformation: (page: "about" | "contact-developer" | "beian") => void;
  setError: (message: string) => void;
}

export function HomeRoutes(props: HomeRoutesProps) {
  const openChannel = (channel: Channel) => {
    if (channel.url === "builtin:bili") {
      void props.openBili({ name: "entry" });
    } else if (channel.url === "builtin:douyin") {
      void props.openDouyin({ name: "entry" });
    } else {
      props.openFeed(channel);
    }
  };

  const selectProfileItem = (index: number) => {
    if (index === 0) void props.go("account-status");
    else if (index === 1) void props.go("saved");
    else if (index === 2) void props.go("watch-later");
    else if (index === 3) void props.go("phone-connection");
    else if (index === 4) void props.go("settings");
    else if (index === 5) props.openInformation("about");
    else if (index === 6) props.openInformation("contact-developer");
    else props.setError("此页面尚未迁移");
  };

  return (
    <>
      <Show when={props.page() === "home"}>
        <HomeScreen
          width={props.width}
          channels={props.channels()}
          notesPlacement={props.notesPlacement}
          height={props.height}
          refreshing={props.refreshing()}
          busy={props.busy()}
          platformLoginState={props.platformLoginState()}
          speechState={props.speechState()}
          onSpeech={props.openSpeech}
          onRefresh={() => void props.refresh()}
          onProfile={() => void props.go("profile")}
          onNotes={() => void props.go("notes")}
          onRecommend={() => void props.go("recommendations")}
          onAdd={props.openAdd}
          onChannel={openChannel}
          onMoveChannelToTop={(channel) =>
            props.channelAction(channel.id, "move")
          }
          onToggleChannelPinned={(channel) =>
            props.channelAction(channel.id, "pin")
          }
          onMarkChannelRead={(channel) =>
            props.channelAction(channel.id, "read")
          }
          onDeleteChannel={(channel) =>
            props.channelAction(channel.id, "delete")
          }
          onBeian={() => props.openInformation("beian")}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "profile"}>
        <ProfileScreen
          height={props.height}
          onSelect={selectProfileItem}
          onBeian={() => props.openInformation("beian")}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "account-status"}>
        <AccountStatusScreen
          width={props.width}
          height={props.height}
          active={props.active}
          load={props.services.readAccountStatus}
          subscribe={props.services.subscribeAccountStatus}
          onError={props.setError}
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.page() === "phone-connection"}>
        <PhoneConnectionScreen
          width={props.width}
          height={props.height}
          active={props.active}
          onError={props.setError}
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
    </>
  );
}
