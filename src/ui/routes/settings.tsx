import {DebugSummaryPlaceholder} from '../DebugSummaryPlaceholder.tsx';
import {debugGate} from '../../debug/host.ts';
import type {DebugBluetoothSession} from '../../debug/bluetooth.ts';
import {DebugToolsScreen} from '../DebugToolsScreen.tsx';
import { Show } from "solid-js";
import { enqueueRemoteInput } from "../../remote-input/inbox.ts";
import type { ReaderPresetState } from "../../reader/preset-store.ts";
import { AutoScrollSettingsScreen } from "../AutoScrollSettingsScreen.tsx";
import { LlmPromptPresetScreen } from "../LlmPromptPresetScreen.tsx";
import { LlmUsageScreen } from "../LlmUsageScreen.tsx";
import { ReaderPresetScreen } from "../ReaderPresetScreen.tsx";
import { RemoteInputScreen } from "../RemoteInputScreen.tsx";
import {
  AdvancedSettingsScreen,
  SettingsScreen,
  SpeechSettingsScreen,
  type SettingsRoute,
} from "../SettingsScreen.tsx";
import { TtsConfigScreen } from "../TtsConfigScreen.tsx";
import type { AppServices } from "../service.ts";
import type { SettingsState } from "../../settings/index.ts";
import type { Page, RouteEntry } from "./types.ts";

interface PresetActions {
  setThemeMode: (
    mode: Parameters<ReaderPresetScreenProps["onMode"]>[0],
  ) => ReaderPresetState;
  selectPreset: (
    kind: Parameters<ReaderPresetScreenProps["onSelect"]>[0],
    id: Parameters<ReaderPresetScreenProps["onSelect"]>[1],
  ) => ReaderPresetState;
  updateSchedule: (
    patch: Parameters<ReaderPresetScreenProps["onSchedule"]>[0],
  ) => ReaderPresetState;
  setSunLocation: (latitude: number, longitude: number) => ReaderPresetState;
}

type ReaderPresetScreenProps = Parameters<typeof ReaderPresetScreen>[0];

interface SettingsRoutesProps {
  createDebugBluetooth?:()=>DebugBluetoothSession;
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  services: AppServices;
  settings: () => SettingsState;
  presetState: () => ReaderPresetState | undefined;
  presetActions: PresetActions;
  updatePreset: (change: () => ReaderPresetState) => void;
  updateSettings: (patch: Partial<SettingsState>) => void;
  navigate: (route: SettingsRoute) => void;
  systemShareAvailable: () => boolean;
  reloadSettings: () => void;
  popPage: (skipInternal?: boolean) => boolean;
  setError: (message: string) => void;
}

export function SettingsRoutes(props: SettingsRoutesProps) {
  return (
    <>
      <Show when={props.page()==="debug-summary"&&debugGate.allowed}><DebugSummaryPlaceholder id={props.entry.articleId??""} width={props.width} height={props.height} active={props.active} services={props.services} preset={()=>props.settings().llmPromptPreset} showTokens={()=>props.settings().llmShowTokenUsage}/></Show>
      <Show when={props.page()==="debug-tools"&&debugGate.allowed}><DebugToolsScreen width={props.width} height={props.height} active={props.active} services={props.services} entry={props.entry} createBluetooth={props.createDebugBluetooth}/></Show>
      <Show when={props.page() === "settings-llm-usage"}>
        <LlmUsageScreen
          width={props.width}
          height={props.height}
          active={props.active}
          load={() => props.services.readSummaryUsage!()}
          clear={() => props.services.clearSummaryUsage!()}
          subscribe={props.services.subscribeSummaryUsage}
          onBack={() => props.popPage()}
          onError={props.setError}
          ref={(value) => {
            props.entry.list = value;
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show
        when={props.page() === "settings-reader-presets" && props.presetState()}
      >
        {(state) => (
          <ReaderPresetScreen
            width={props.width}
            height={props.height}
            state={state()}
            active={props.active}
            onMode={(mode) =>
              props.updatePreset(() => props.presetActions.setThemeMode(mode))
            }
            onSelect={(kind, id) =>
              props.updatePreset(() =>
                props.presetActions.selectPreset(kind, id),
              )
            }
            onSchedule={(patch) =>
              props.updatePreset(() =>
                props.presetActions.updateSchedule(patch),
              )
            }
            onLocation={(latitude, longitude) =>
              props.updatePreset(() =>
                props.presetActions.setSunLocation(latitude, longitude),
              )
            }
            onError={props.setError}
            ref={(value) => {
              props.entry.list = value;
              props.entry.internalBack = value.goBack;
            }}
          />
        )}
      </Show>
      <Show when={props.page() === "settings-llm-preset"}>
        <LlmPromptPresetScreen
          width={props.width}
          height={props.height}
          state={props.settings()}
          onChange={props.updateSettings}
          onNavigate={props.navigate}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "remote-input"}>
        <RemoteInputScreen
          exportMode={props.entry.exportMode}
          width={props.width}
          height={props.height}
          active={props.active}
          onUrl={enqueueRemoteInput}
          onDismiss={() => props.popPage()}
          onError={props.setError}
          ref={(value) => {
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.page() === "tts-config"}>
        <TtsConfigScreen
          width={props.width}
          height={props.height}
          active={props.active}
          onSaved={props.reloadSettings}
          onDismiss={() => props.popPage()}
          onError={props.setError}
          ref={(value) => {
            props.entry.internalBack = value.onRootBack;
          }}
        />
      </Show>
      <Show when={props.page() === "settings"}>
        <SettingsScreen
          hasSummaryAccount={props.services.hasSummaryAccount}
          active={props.active}
          width={props.width}
          height={props.height}
          state={props.settings()}
          onChange={props.updateSettings}
          onNavigate={props.navigate}
          onUnsupported={props.setError}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show
        when={
          props.page() === "settings-auto-scroll" ||
          props.page() === "reader-scroll-controls"
        }
      >
        <AutoScrollSettingsScreen
          width={props.width}
          height={props.height}
          state={props.settings()}
          onChange={props.updateSettings}
          onNavigate={props.navigate}
          reader={
            props.page() === "reader-scroll-controls"
              ? props.entry.reader
              : undefined
          }
          onReturn={
            props.page() === "reader-scroll-controls"
              ? () => props.popPage()
              : undefined
          }
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "settings-speech"}>
        <SpeechSettingsScreen
          width={props.width}
          height={props.height}
          state={props.settings()}
          onChange={props.updateSettings}
          onNavigate={props.navigate}
          input={(title, value) => props.services.input(title, value)}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
      <Show when={props.page() === "settings-advanced"}>
        <AdvancedSettingsScreen
          systemShareSupported={props.systemShareAvailable()}
          width={props.width}
          height={props.height}
          state={props.settings()}
          onChange={props.updateSettings}
          onNavigate={props.navigate}
          onUnsupported={props.setError}
          ref={(value) => (props.entry.list = value)}
        />
      </Show>
    </>
  );
}
