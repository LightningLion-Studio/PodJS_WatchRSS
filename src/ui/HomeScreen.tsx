import { createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import type { Scroller } from "@pocketjs/framework/kinetics";
import type { Channel } from "./service.ts";
export interface HomeScreenProps {
  channels: Channel[]; height: number; width: number;
  onProfile: () => void; onNotes: () => void; onRecommend: () => void;
  onAdd: () => void; onChannel: (channel: Channel) => void; onBeian: () => void;
  ref?: (list: {scroller: Scroller}) => void;
}
function formatTime(timestamp: number): string {
  const d = new Date(timestamp), pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// OWW242 round resource geometry: 18dp insets and 6dp gaps.
// Glyph origins include the measured difference between Compose and atlas baselines.
export default function HomeScreen(props: HomeScreenProps) {
  const card = (title: string, summary: string, onPress?: () => void, twoLines = false, pinned = false, titleClass = "text-[17px]"): ScrollEntry => ({
    height: twoLines ? 84 : 65,
    render: () => <View onPress={onPress} focusable={!!onPress} class={pinned ? "absolute inset-0 rounded-[16] bg-[#333333]" : "absolute inset-0 rounded-[16] bg-[#1c1f21]"}>
      <Text style={{fontSlot:titleClass === "text-base" ? 2 : 22}} class="absolute left-[14] right-[6] top-[13] h-[21] overflow-hidden text-[17px] leading-[21] text-[#f5f5f5]">{title}</Text>
      <Text class="absolute left-[14] right-[6] top-[32.5] h-[38] overflow-hidden text-sm leading-[19] text-[#b6b6b6]">{summary}</Text>
    </View>
  });
  const entries = createMemo<ScrollEntry[]>(() => [
    {height: 73, render: () => <View class="absolute inset-0 items-center">
      <View onPress={props.onProfile} focusable style={{insetL:(props.width-36-44)/2}} class="absolute top-[4] w-[44] h-[44] rounded-full bg-[#1c1f21] border-[#ff6026] border-[0.7] items-center justify-center">
        <Text class="text-sm leading-[17] text-[#f5f5f5]">我</Text>
      </View>
      <View class="absolute top-[52] left-[0] right-[0] items-center justify-center"><Text class="text-[9px] leading-[17] text-[#b6b6b6]">点击进入我的</Text></View>
    </View>},
    card("备忘录", "纯文本编辑 · 手机同步", props.onNotes, false, false, "text-base"),
    ...(["bili","douyin"] as const).flatMap(platform=>{
      const channel=props.channels.find(item=>item.url===`builtin:${platform}`);
      return !channel?[]:[card(channel.title,`${channel.description||"进入后登录获取推荐内容"}\n更新: ${channel.lastFetchedAt?formatTime(channel.lastFetchedAt):"未更新"}`,()=>props.onChannel(channel),true)];
    }),
    ...props.channels.filter(channel => !channel.url.startsWith("builtin:")).map(channel => card(channel.title, `${channel.isPinned ? "置顶 · " : ""}${channel.description || channel.url}\n${channel.unreadCount ? `未读 ${channel.unreadCount} · ` : ""}更新: ${channel.lastFetchedAt ? formatTime(channel.lastFetchedAt) : "未更新"}`, () => props.onChannel(channel), true, channel.isPinned)),
    
    card("RSS推荐", "一键加入官方支持频道", props.onRecommend),
    {height:56,render:() => <View class="absolute inset-0 items-center"><View onPress={props.onAdd} focusable style={{insetL:(props.width-36-48)/2}} class="absolute top-[4] w-[48] h-[48] rounded-[47] bg-[#23272a] items-center justify-center"><Text class="text-base leading-[17] text-[#f5f5f5]">+</Text></View></View>},
    {height:25,render:() => <View onPress={props.onBeian} focusable class="absolute inset-0 items-center justify-center"><Text class="text-[9px] leading-[17] text-[#b6b6b6]">浙ICP备2024111886号-5A</Text></View>}
  ]);
  return <ScrollEntries height={props.height} entries={entries()} ref={props.ref} />;
}
