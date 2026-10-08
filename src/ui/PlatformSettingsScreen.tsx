import { Show, createMemo, createSignal } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { measuredLines } from "../reader/measured-text.ts";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { WatchSwitch } from "./AutoScrollSettingsScreen.tsx";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";

const measure17 = (text: string) => getOps().measureText(text, 22);
export const spacerEntry = (height: number): ScrollEntry => ({ height, render: () => null });
/** Native SettingsPillRow: 52dp pill, 10dp start / 15dp end padding, bodyLarge 17/21 label + WatchSwitch. */
export function switchRow(label: string, checked: boolean, onChange?: () => void): ScrollEntry {
  return { height: 52, render: () => <View class="absolute inset-0 rounded-[47] bg-[#2a2a2a]">
    <Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
    <View class="absolute right-[15] top-[17.25]"><WatchSwitch checked={checked} onChange={() => onChange?.()} accessibilityLabel={label} /></View>
  </View> };
}
/** Native SettingsDangerRow: danger red label + 30dp trailing icon, 60% when disabled. */
export function dangerEntry(label: string, icon: string, onPress?: () => void): ScrollEntry {
  return { height: 52, render: () => <View onPress={onPress} focusable={!!onPress} accessibilityRole="button" accessibilityLabel={label} class="absolute inset-0 rounded-[47] bg-[#2a2a2a]">
    <Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#e54d4d]" style={{ opacity: onPress ? 1 : .6 }}>{label}</Text>
    <Image src={icon} class="absolute right-[10] top-[11] w-[30] h-[30]" style={{ opacity: onPress ? 1 : .6 }} />
  </View> };
}

export interface PlatformSettingsProps {
  width: number; height: number; loggedIn: () => boolean | undefined;
  showOriginalContent?: boolean; originalContentEnabled: boolean; onToggleOriginal: () => void;
  showContinuePlaybackInBackground?: boolean; continuePlaybackInBackgroundEnabled: boolean; onToggleContinuePlaybackInBackground?: () => void;
  deleteEnabled?: boolean; onDelete?: () => unknown; onLogout: () => Promise<void>; onError: (error: unknown) => void;
  ref?: (value: { scroller: Scroller; onRootBack: () => boolean }) => void;
}
/** Native BiliSettingsScreen — DouyinSettingsActivity reuses it verbatim (same captions and download prompt). */
export function PlatformSettingsScreen(props: PlatformSettingsProps) {
  const [confirmDelete, setConfirmDelete] = createSignal(false), [download, setDownload] = createSignal(false), [deleting, setDeleting] = createSignal(false);
  const entries = createMemo<ScrollEntry[]>(() => {
    const width = props.width, loggedIn = props.loggedIn();
    const prompt = measuredLines("下载手机端app以在手机上编辑和同步内容", width - 36 - 20, measure17, 2).join("\n");
    return [
      { height: 32, render: () => <Text class="absolute left-[0] right-[0] top-[0] text-[21px] leading-[26] text-center text-[#f5f5f5]">设置</Text> },
      { height: 14, bounds: { x: 0, y: -1.5, width: props.width - 36, height: 14 }, render: () => <Text class="absolute left-[0] right-[0] top-[-1.5] text-xs leading-[14] text-center text-[#b6b6b6]">{loggedIn === undefined ? "" : loggedIn ? "已登录" : "未登录"}</Text> },
      ...(props.showOriginalContent
        ? [spacerEntry(7.5), switchRow("原文阅读模式", props.originalContentEnabled, props.onToggleOriginal),
           { height: 18, render: () => <Text class="absolute left-[10] right-[0] top-[4] text-xs leading-[14] text-[#b6b6b6]">刷新时抓取原文正文与图片</Text> }, spacerEntry(8)]
        : [spacerEntry(4)]),
      ...(props.showContinuePlaybackInBackground ? [switchRow("在后台继续播放", props.continuePlaybackInBackgroundEnabled, props.onToggleContinuePlaybackInBackground), spacerEntry(8)] : []),
      { height: 65, render: () => <View onPress={() => setDownload(true)} focusable accessibilityRole="button" accessibilityLabel="下载手机端app以在手机上编辑和同步内容" class="absolute left-[0] right-[0] top-[0] h-[57] rounded-[16] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[8.5] text-[17px] leading-[20] text-[#f5f5f5]">{prompt}</Text></View> },
      dangerEntry("退出登录", "../assets/icons/exit-to-app.svg", loggedIn ? () => { void props.onLogout().catch(props.onError); } : undefined),
      spacerEntry(4),
      dangerEntry("删除频道", "../assets/icons/delete-outline.svg", props.deleteEnabled && props.onDelete ? () => setConfirmDelete(true) : undefined),
      spacerEntry(20),
    ];
  });
  const rootBack = () => { if (download()) { setDownload(false); return true; } if (!confirmDelete()) return false; setConfirmDelete(false); return true; };
  return <View class="absolute inset-0">
    <ScrollEntries height={props.height} entries={entries()} gap={0} inputActive={() => !confirmDelete() && !download()} ref={value => props.ref?.({ scroller: value.scroller, onRootBack: rootBack })} />
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="同步B站观看记录" onDismiss={() => setDownload(false)} onError={message => props.onError(new Error(message))} /></Show>
    <Show when={confirmDelete()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除频道" message="删除后将移除本地缓存" busy={deleting()} onCancel={() => setConfirmDelete(false)} onConfirm={() => { setDeleting(true); void Promise.resolve(props.onDelete?.()).catch(props.onError).finally(() => { setDeleting(false); setConfirmDelete(false); }); }} /></Show>
  </View>;
}

