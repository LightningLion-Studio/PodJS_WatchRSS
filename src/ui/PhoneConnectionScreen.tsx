import {discovery} from '@podjs/framework/services';
import {hasCapability} from '@podjs/framework/watch';
import {subscribeLibraryProgress,libraryProgressSnapshot,libraryProgressText,libraryProgressDetail} from '../sync/progress.ts';
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { watchUiLines } from "./text-layout.ts";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";
import { MiniProgramPairingPanel } from './MiniProgramPairingPanel.tsx';
import { PHONE_PAGE } from './phone-connection-layout.ts';

/** Steps of the phone-App route; the watch listens on its own while WatchRSS is open. */
export const PHONE_APP_STEPS = ["手机与手表已蓝牙配对", "在手机打开腕上RSS手机端", "在手机端发起同步，手表保持亮屏"];

/**
 * Landing page: one primary route (WeChat scan, over the internet
 * inside) and the phone-App route folded behind a disclosure, so its download code never sits
 * next to a pairing code. Nothing starts until the user picks a route.
 */
export function PhoneConnectionScreen(props: { width: number; height: number; active: () => boolean; onError: (message: string) => void; ref: (value: { scroller: Scroller; onRootBack: () => boolean }) => void }) {
  const [progress, setProgress] = createSignal(libraryProgressSnapshot());
  onCleanup(subscribeLibraryProgress(setProgress));
  const [pairing, setPairing] = createSignal(false);
  const [download, setDownload] = createSignal(false);
  const [appOpen, setAppOpen] = createSignal(false);
  let mainRef: { scroller: Scroller } | undefined;
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
    const steps = PHONE_APP_STEPS.map((step, index): ScrollEntry => {
      const wrapped = watchUiLines(step, { width: inner() - 30, measure: line => measure(line, 1) });
      return { height: wrapped.length * 17 + 8, render: () => <View class="absolute inset-0">
        <Text class="absolute left-[8] top-[0]" style={{ fontSlot: 1, lineHeight: 17, textColor: PHONE_PAGE.primary }}>{String(index + 1)}</Text>
        <Text class="absolute left-[26] right-[4] top-[0]" style={{ fontSlot: 1, lineHeight: 17, textColor: PHONE_PAGE.foreground }}>{wrapped.join("\n")}</Text>
      </View> };
    });
    const prompt = watchUiLines("还没装？下载手机端App", { width: props.width - 56, measure: text => measure(text, 22) });
    return [
      { height: 26, render: () => <Text class="absolute inset-0 text-center" style={{ fontSlot: 23, lineHeight: 26, textColor: PHONE_PAGE.foreground }}>连接手机</Text> },
      gap(12),
      option("微信扫码连接", "用腕上RSS小程序扫一扫", () => setPairing(true), true),
      gap(8),
      option("手机App连接", appOpen() ? "按以下步骤操作" : "用腕上RSS手机端同步", () => setAppOpen(!appOpen()), false, appOpen() ? "收起" : "展开"),
      ...(appOpen() ? [
        gap(12), ...steps, gap(4),
        ...(hasCapability('net.discovery') ? [{ height: 48, render: () => <View class="absolute inset-0 rounded-[24] bg-[#2a2a2a] items-center justify-center" onPress={() => { if (props.active()) void discovery.requestPermission().then(value => { if (value !== 'granted') props.onError('请允许附近设备发现权限后重试'); }).catch(() => props.onError('附近设备发现权限申请失败')); }} focusable accessibilityRole="button" accessibilityLabel="启用附近手机发现"><Text style={{ fontSlot: 22, lineHeight: 21, textColor: PHONE_PAGE.foreground }}>启用附近手机发现</Text></View> }, gap(8)] : []),
        { height: Math.max(52, prompt.length * 21 + 16), render: () => <View onPress={act(() => setDownload(true))} focusable accessibilityRole="button" accessibilityLabel="下载手机端App" class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[8] text-[17px] leading-[21] text-[#f5f5f5]">{prompt.join("\n")}</Text></View> },
      ] : []),
      gap(12),
      // Live phone-App sync progress stays visible whichever route is open.
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
