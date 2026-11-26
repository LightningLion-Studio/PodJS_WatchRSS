import {NetworkRecoveryContext} from '../../network/context';
import type {NetworkRecovery} from '../../network/recovery';
import {idleHit} from '../../diagnostics/idle-counters';
import {displayPower} from '@podjs/framework/services';
import {hasCapability} from '@podjs/framework/watch';
import {benchmark} from '@podjs/framework/benchmark';
import {douyinBench} from '../../douyin/bench.ts';
import {douyinClient} from '../../media-services.ts';
import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import type { SpeechPlaybackState } from "../../reader/speech-playback.ts";
import { AccountStatusScreen } from "../AccountStatusScreen.tsx";
import { manualCloudSync, applicationCloudApproval, applicationCloudApprover, applicationCloudActions, applicationCloudHandoff, applicationCloudProgress } from "../../cloud/application.ts";
import { cloudRemediationActions } from "../cloud-sync-view.ts";
import { clearLocalPrivateLibrary } from "../../services.ts";
import { readCloudAccountStatus, subscribeCloudAccountStatus } from "../../cloud/status.ts";
import { CloudSyncScreen } from "../CloudSyncScreen.tsx";
import { SyncV2Screen } from "../SyncV2Screen.tsx";
import type { SyncV2Target } from "../sync-v2-view.ts";
import { applicationSyncV2Ui, applicationSyncV2OwnDeviceId } from "../../cloud/application.ts";
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

const keepCloudAwake=(owner:string,active:boolean)=>hasCapability('display.power')?displayPower.keepAwake(owner,active):Promise.resolve();
const cloudActions = cloudRemediationActions(applicationCloudActions);
const [syncV2Target, setSyncV2Target] = createSignal<SyncV2Target>("choice");

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
  ownerChoiceNetwork?: NetworkRecovery;
  foreground?: () => boolean;
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
const manualCloud = coalescedRequest((scope,retry,generation) => manualCloudSync('recent128',scope,retry,generation));

export function HomeRoutes(props: HomeRoutesProps) {idleHit(4);
  const cloudActive=()=>props.active()&&(props.foreground?.()??true);
  let homeObserved=false;
  createEffect(()=>{if(homeObserved||!props.active()||props.page()!=='home'||!props.channels().length)return;homeObserved=true;const seq=benchmark.begin('startup_stage',{startup_stage:'home_mounted'});benchmark.presented('home_first_frame',seq);});

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
          onBrowseReady={ready=>{props.entry.browseReady=ready;}}
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
          active={()=>cloudActive()&&!cloudOwnerChoice()}
          progress={applicationCloudProgress}
          keepAwake={keepCloudAwake}
          load={props.services.readAccountStatus}
          subscribe={props.services.subscribeAccountStatus}
          readCloud={readCloudAccountStatus}
          available={() => readCloudAccountStatus() !== undefined}
          sync={manualCloud}
          approval={applicationCloudApproval}
          approver={applicationCloudApprover}
          handoff={applicationCloudHandoff}
          actions={cloudActions}
          clearLocal={clearLocalPrivateLibrary}
          onPhone={() => void props.go("phone-connection")}
          syncV2={applicationSyncV2Ui()}
          onSyncV2={(target) => { setSyncV2Target(target); void props.go("sync-v2"); }}
          onError={props.setError}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "sync-v2" && applicationSyncV2Ui()}>
        {(port) => (
          <SyncV2Screen
            width={props.width}
            height={props.height}
            active={props.active}
            target={syncV2Target}
            port={port()}
            ownDeviceId={applicationSyncV2OwnDeviceId()}
            onDone={() => void props.go("cloud-sync")}
            onError={props.setError}
            ref={(value) => (props.entry.list = value)}
          />
        )}
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
        <NetworkRecoveryContext.Provider value={props.ownerChoiceNetwork}>
        <CloudSyncScreen width={props.width} height={props.height} active={cloudActive}
          load={props.services.readAccountStatus} subscribe={props.services.subscribeAccountStatus}
          readCloud={readCloudAccountStatus} available={()=>true} sync={manualCloud} actions={cloudActions} clearLocal={clearLocalPrivateLibrary}
          onPhone={()=>void props.go("phone-connection")} onError={props.setError} ref={()=>{}}/>
        </NetworkRecoveryContext.Provider>
      </Show>
    </>
  );
}
