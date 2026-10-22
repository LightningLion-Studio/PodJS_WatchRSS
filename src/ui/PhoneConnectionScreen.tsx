import {subscribeLibraryProgress,libraryProgressSnapshot,libraryProgressText,libraryProgressDetail} from '../sync/progress.ts';
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { watchUiLines } from "./text-layout.ts";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";
import { MiniProgramPairingPanel } from './MiniProgramPairingPanel.tsx';
import { consumePendingPairingRequest, subscribePairingRequests } from './pairing-request.ts';
import { PHONE_PAGE } from './phone-connection-layout.ts';

/**
 * Landing page: scan binding is the one route; the phone App syncs over Bluetooth on its own while
 * WatchRSS is open. Nothing starts until the user picks it.
 */
export function PhoneConnectionScreen(props: { width: number; height: number; active: () => boolean; onError: (message: string) => void; ref: (value: { scroller: Scroller; onRootBack: () => boolean }) => void }) {
  const [progress, setProgress] = createSignal(libraryProgressSnapshot());
  onCleanup(subscribeLibraryProgress(setProgress));
  const [pairing, setPairing] = createSignal(false);
  const [download, setDownload] = createSignal(false);
  let mainRef: { scroller: Scroller } | undefined;
  // Opened by a phone's scan request: show the code at once; a manual visit still waits for a tap.
  const openRequestedPairing = () => {
    if (!props.active() || pairing() || !consumePendingPairingRequest()) return false;
    setDownload(false);
    setPairing(true);
    return true;
  };
  onCleanup(subscribePairingRequests(openRequestedPairing));
  openRequestedPairing();
  const closePairing = () => { setPairing(false); if (mainRef) props.ref({ ...mainRef, onRootBack: back }); };
  const back = () => { if (!download()) return false; setDownload(false); return true; };
  const act = (fn: () => void) => () => { if (props.active()) fn(); };
  const measure = (text: string, slot: number) => getOps().measureText(text, slot);
  const inner = () => props.width - 36;

  const option = (title: string, subtitle: string, press: () => void, primary: boolean, trailing?: string): ScrollEntry => ({
    height: 64, render: () => <View class="absolute inset-0 rounded-[32]" style={{ bgColor: primary ? PHONE_PAGE.primary : "#2a2a2a" }} focusable accessibilityRole="button" accessibilityLabel={`${title}，${subtitle}`} onPress={act(press)}>
      <Text class="absolute left-[20] top-[11]" style={{ fontSlot: 22, lineHeight: 21, textColor: primary ? PHONE_PAGE.onPrimary : PHONE_PAGE.foreground }}>{title}</Text>
      <Text class="absolute left-[20] top-[34]" style={{ fontSlot: 0, lineHeight: 14, textColor: primary ? "#000000b8" : PHONE_PAGE.secondary }}>{subtitle}</Text>
      {trailing ? <Text class="absolute right-[18] top-[22]" style={{ fontSlot: 0, lineHeight: 14, textColor: PHONE_PAGE.secondary }}>{trailing}</Text> : null}
    </View>,
  });
  const gap = (height: number): ScrollEntry => ({ height, render: () => null });
  const lines = (text: string, slot: number, lineHeight: number, color: string, width = inner()): ScrollEntry => {
    const wrapped = watchUiLines(text, { width, measure: line => measure(line, slot) });
    return { height: wrapped.length * lineHeight, render: () => <Text class="absolute inset-0 text-center" style={{ fontSlot: slot, lineHeight, textColor: color }}>{wrapped.join("\n")}</Text> };
  };

  const entries = createMemo<ScrollEntry[]>(() => {
    const prompt = watchUiLines("还没装？下载手机端App", { width: props.width - 56, measure: text => measure(text, 1) });
    return [
      { height: 26, render: () => <Text class="absolute inset-0 text-center" style={{ fontSlot: 23, lineHeight: 26, textColor: PHONE_PAGE.foreground }}>连接手机</Text> },
      gap(12),
      option("扫码绑定", "用手机 App 或小程序扫一扫", () => setPairing(true), true),
      gap(10),
      // Binding needs the phone App or mini program; the download code stays one tap away, never beside a pairing code.
      { height: Math.max(36, prompt.length * 17 + 12), render: () => <View onPress={act(() => setDownload(true))} focusable accessibilityRole="button" accessibilityLabel="下载手机端App" class="absolute inset-0 items-center justify-center"><Text class="text-center" style={{ fontSlot: 1, lineHeight: 17, textColor: PHONE_PAGE.secondary }}>{prompt.join("\n")}</Text></View> },
      gap(12),
      // Live phone-App sync progress stays visible here.
      ...[libraryProgressText(progress()), libraryProgressDetail(progress())].map(text => lines(text, 1, 17, PHONE_PAGE.secondary, props.width - 56)),
      gap(52),
    ];
  });
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={0} inputActive={() => props.active() && !download() && !pairing()} ref={value => { mainRef = value; if (!pairing()) props.ref({ ...value, onRootBack: back }); }} />
    <Show when={pairing()}><MiniProgramPairingPanel width={props.width} height={props.height} active={props.active} onClose={closePairing} ref={value => props.ref(value)} /></Show>
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="手机连接同步" onDismiss={() => setDownload(false)} onError={props.onError} /></Show>
  </View>;
}
