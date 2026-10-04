import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { getDisplayMetrics } from "@podjs/framework/watch";
import { adjacentPlaybackStartVolumeLimit, formatPlaybackStartVolumeLimit, normalizePlaybackStartVolumeLimit } from "../media/start-volume.ts";
import { WatchSwitch } from "./AutoScrollSettingsScreen.tsx";
import type { SettingsScreenProps } from "./SettingsScreen.tsx";
import type { ScrollEntry } from "./ScrollEntries.tsx";
import { watchUiLines } from "./text-layout.ts";

export function mediaVolumeSettingsRows(props: SettingsScreenProps, width: number): ScrollEntry[] {
  const density = getDisplayMetrics().density;
  const lines = (text: string, available: number, slot = 0) => watchUiLines(text, {
    width: available, measure: value => getOps().measureText(value, slot),
  });
  const unavailable = () => props.onUnsupported?.("仅在启用滚轮调节音量后可使用音量调节防干扰");
  const toggle = (label: string, descriptions: string[], key: "mediaVolumeControl" | "mediaVolumeGuard", enabled = true): ScrollEntry => {
    const labelWidth = width - 25 - 60 / density;
    const labelLines = lines(label, labelWidth, 22);
    const pillHeight = Math.max(52, 16 + labelLines.length * 21);
    const details = descriptions.map(text => lines(text, width - 10));
    const change = () => {
      // Consult current state again: a mounted row must not toggle a now-disabled guard.
      if (key === "mediaVolumeGuard" && !props.state.mediaVolumeControl) unavailable();
      else props.onChange({ [key]: !props.state[key] });
    };
    let top = pillHeight;
    const detailRows = details.map(text => { const y = top + 4; top = y + text.length * 14; return { y, text }; });
    return { height: top, render: () => <View class="absolute inset-0">
      <View onPress={enabled ? undefined : unavailable} focusable={!enabled} class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{ height: pillHeight }}>
        <Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{ insetT: (pillHeight - labelLines.length * 21) / 2, width: labelWidth }}>{labelLines.join("\n")}</Text>
        <View class="absolute right-[15]" style={{ insetT: (pillHeight - 35 / density) / 2, opacity: enabled ? 1 : .5 }}><WatchSwitch checked={props.state[key]} onChange={change}/></View>
      </View>
      {detailRows.map(detail => <Text class="absolute left-[10] text-xs leading-[14] text-[#b6b6b6]" style={{ insetT: detail.y }}>{detail.text.join("\n")}</Text>)}
    </View> };
  };
  const labelWidth = width - 120;
  const label = lines("静音开播", labelWidth, 22);
  const pillHeight = Math.max(52, 16 + label.length * 21);
  const description = lines("开始播放时仅在当前音量高于上限时压低音量", width - 10);
  const limit = normalizePlaybackStartVolumeLimit(props.state.playbackStartVolumeLimit);
  const status = lines(limit === null ? "当前不限制开播音量" : `开播时高于 ${limit}% 才压低`, width - 10);
  const step = (direction: -1 | 1) => props.onChange({ playbackStartVolumeLimit: adjacentPlaybackStartVolumeLimit(props.state.playbackStartVolumeLimit, direction) });
  return [
    toggle("使用滚轮调节音量", ["播放器内可用滚轮调节媒体音量"], "mediaVolumeControl"),
    toggle("音量调节防干扰", [!props.state.mediaVolumeControl ? "已随滚轮音量调节停用" : props.state.mediaVolumeGuard ? "已开启" : "已关闭", "滚轮连续上调时会先停在约21%，停一下再滚可继续升高"], "mediaVolumeGuard", props.state.mediaVolumeControl),
    { height: pillHeight + 8 + (description.length + status.length) * 14, render: () => <View class="absolute inset-0">
      <View class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{ height: pillHeight }}>
        <Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{ insetT: (pillHeight - label.length * 21) / 2, width: labelWidth }}>{label.join("\n")}</Text>
        <View class="absolute right-[10] w-[100]" style={{ insetT: (pillHeight - 21) / 2, height: 21 }}>
          <View onPress={() => step(-1)} focusable class="absolute left-[0] top-[0.5] w-[20] h-[20] rounded-full bg-[#444444]"><View class="absolute left-[5] top-[9.5] w-[10] h-[1] bg-[#f5f5f5]"/></View>
          <Text class="absolute left-[24] top-[0] w-[52] text-center text-[17px] leading-[21] text-[#f5f5f5]">{formatPlaybackStartVolumeLimit(props.state.playbackStartVolumeLimit)}</Text>
          <View onPress={() => step(1)} focusable class="absolute right-[0] top-[0.5] w-[20] h-[20] rounded-full bg-[#444444]"><View class="absolute left-[5] top-[9.5] w-[10] h-[1] bg-[#f5f5f5]"/><View class="absolute left-[9.5] top-[5] w-[1] h-[10] bg-[#f5f5f5]"/></View>
        </View>
      </View>
      <Text class="absolute left-[10] text-xs leading-[14] text-[#b6b6b6]" style={{ insetT: pillHeight + 4 }}>{description.join("\n")}</Text>
      <Text class="absolute left-[10] text-xs leading-[14] text-[#b6b6b6]" style={{ insetT: pillHeight + 8 + description.length * 14 }}>{status.join("\n")}</Text>
    </View> },
  ];
}
