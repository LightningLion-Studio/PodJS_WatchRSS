import { createMemo, createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { watchUiLines } from "./text-layout.ts";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";

export function PhoneConnectionScreen(props: { width: number; height: number; active: () => boolean; onError: (message: string) => void; ref: (value: { scroller: Scroller; onRootBack: () => boolean }) => void }) {
  const [download, setDownload] = createSignal(false);
  const back = () => { if (!download()) return false; setDownload(false); return true; };
  const entries = createMemo<ScrollEntry[]>(() => {
    const description = watchUiLines("请在与手表蓝牙配对了的手机上下载并打开腕上RSS手机端后操作", { width: props.width - 36, measure: text => getOps().measureText(text, 1) });
    const prompt = watchUiLines("下载手机端App以完成手机连接同步", { width: props.width - 56, measure: text => getOps().measureText(text, 22) });
    return [
      { height: 26, render: () => <Text class="absolute inset-0 text-[21px] leading-[26] text-center text-[#f5f5f5]">连接手机</Text> },
      { height: 9, render: () => null },
      { height: description.length * 17, render: () => <Text class="absolute inset-0 text-sm leading-[17] text-center text-[#b6b6b6]">{description.join("\n")}</Text> },
      { height: 9, render: () => null },
      { height: Math.max(52, prompt.length * 21 + 16), render: () => <View onPress={() => setDownload(true)} focusable class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[8] text-[17px] leading-[21] text-[#f5f5f5]">{prompt.join("\n")}</Text></View> },
      { height: 52, render: () => null },
    ];
  });
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={0} inputActive={() => props.active() && !download()} ref={value => props.ref({ ...value, onRootBack: back })} />
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="手机连接同步" onDismiss={() => setDownload(false)} onError={props.onError} /></Show>
  </View>;
}
