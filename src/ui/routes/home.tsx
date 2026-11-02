import {douyinBench} from '../../douyin/bench.ts';
import {douyinClient} from '../../media-services.ts';
import { Show, createSignal, onCleanup } from "solid-js";
import type { SpeechPlaybackState } from "../../reader/speech-playback.ts";
import { AccountStatusScreen } from "../AccountStatusScreen.tsx";
import { manualCloudSync, applicationCloudApproval, applicationCloudActions, applicationCloudHandoff } from "../../cloud/application.ts";
import { cloudRemediationActions } from "../cloud-sync-view.ts";
import { clearLocalPrivateLibrary } from "../../services.ts";
import { readCloudAccountStatus, subscribeCloudAccountStatus } from "../../cloud/status.ts";
import { CloudSyncScreen } from "../CloudSyncScreen.tsx";
import { coalescedRequest } from "../cloud-sync-view.ts";
import HomeScreen, { type HomeScreenProps } from "../HomeScreen.tsx";
import { PhoneConnectionScreen } from "../PhoneConnectionScreen.tsx";
import { ProfileScreen } from "../ProfileScreen.tsx";
import type { ProfileEntryKey } from "../profile-entries.ts";
import type { BiliRoute } from "../bili/index.tsx";
import type { DouyinRoute } from "../douyin/index.tsx";
import type { HomePlatformLoginState } from "../home-extras.ts";
import type { AppServices, Channel } from "../service.ts";
import { profileDestination } from "./meta.ts";
import type { Page, RouteEntry } from "./types.ts";

const cloudActions = cloudRemediationActions(applicationCloudActions);

type ChannelAction = (
  id: string,
  action: "move" | "pin" | "read" | "delete" | "clear",
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
  speechSpectrum: () => readonly number[];
  services: AppServices;
  go: (page: Page) => Promise<void>;
  /** Pops back to the home page, dropping intermediate pages. */
  goHome: () => void;
  openSpeech: () => void;
  openAdd: () => void;
  refresh: () => Promise<void>;
  openBili: (route: BiliRoute) => Promise<void>;
  openDouyin: (route: DouyinRoute) => Promise<void>;
  openFeed: (channel: Channel) => void;
  channelAction: ChannelAction;
  moveNotesToTop: () => void;
  toggleNotesPinned: () => void;
  openInformation: (page: "about" | "contact-developer" | "beian") => void;
  setError: (message: string) => void;
}

/** App-wide so leaving and reopening 云同步 joins the running manual sync instead of queueing another. */
const manualCloud = coalescedRequest(() => manualCloudSync());

export function HomeRoutes(props: HomeRoutesProps) {
  // A cloud failure must not wait for the user to reopen the cloud page. The
  // active route alone mounts this existing round-list choice surface.
  const [cloudOwnerChoice,setCloudOwnerChoice]=createSignal(!!readCloudAccountStatus()?.ownerChoiceRequired);
  onCleanup(subscribeCloudAccountStatus(()=>setCloudOwnerChoice(!!readCloudAccountStatus()?.ownerChoiceRequired)));
  const openChannel = (channel: Channel) => {
    if (channel.url === "builtin:bili") {
      void props.openBili({ name: "entry" });
    } else if (channel.url === "builtin:douyin") {
      douyinBench.homeEntry(douyinClient);
      void props.openDouyin({ name: "entry" });
    } else {
      props.openFeed(channel);
    }
  };

  const selectProfileItem = (key: ProfileEntryKey) => {
    const target = profileDestination(key);
    if ("information" in target) props.openInformation(target.information);
    else void props.go(target.page);
  };

  return (
    <>
      <Show when={props.page() === "home"}>
        <HomeScreen
          active={props.active()}
          width={props.width}
          channels={props.channels()}
          notesPlacement={props.notesPlacement}
          height={props.height}
          refreshing={props.refreshing()}
          busy={props.busy()}
          platformLoginState={props.platformLoginState()}
          speechState={props.speechState()}
          speechSpectrum={props.speechSpectrum()}
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
          onClearChannel={(channel) =>
            props.channelAction(channel.id, "clear")
          }
          onMoveNotesToTop={props.moveNotesToTop}
          onToggleNotesPinned={props.toggleNotesPinned}
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
      <Show when={props.page() === "cloud-sync"}>
        <CloudSyncScreen
          width={props.width}
          height={props.height}
          active={props.active}
          load={props.services.readAccountStatus}
          subscribe={props.services.subscribeAccountStatus}
          available={() => readCloudAccountStatus() !== undefined}
          sync={manualCloud}
          approval={applicationCloudApproval}
          handoff={applicationCloudHandoff}
          actions={cloudActions}
          clearLocal={clearLocalPrivateLibrary}
          onPhone={() => void props.go("phone-connection")}
          onError={props.setError}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "phone-connection"}>
        <PhoneConnectionScreen
          width={props.width}
          height={props.height}
          active={props.active}
          onError={props.setError}
          onPaired={props.goHome}
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.active() && cloudOwnerChoice()}>
        <CloudSyncScreen width={props.width} height={props.height} active={props.active}
          load={props.services.readAccountStatus} subscribe={props.services.subscribeAccountStatus}
          available={()=>true} sync={manualCloud} actions={cloudActions} clearLocal={clearLocalPrivateLibrary}
          onPhone={()=>void props.go("phone-connection")} onError={props.setError} ref={()=>{}}/>
      </Show>
    </>
  );
}
