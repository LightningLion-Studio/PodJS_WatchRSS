import { For, Show, createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import type { Scroller } from "@pocketjs/framework/kinetics";
import type { Channel } from "./service.ts";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { homeChannelAtLongPress, movableHomeEntries, shouldShowHomeEmptyState, type HomeHitEntry, type NotesHomePlacement } from "./home-model.ts";
import { homeChannelSummary, homeSpeechCard, homeSpeechSpectrumBars, type HomePlatformLoginState } from "./home-extras.ts";
import type { SpeechPlaybackState } from "../reader/speech-playback.ts";
import { getOps } from "@pocketjs/framework/host";
import { measuredLines } from "../reader/measured-text.ts";

export interface HomeScreenProps {
  channels: Channel[]; notesPlacement: NotesHomePlacement; height: number; width: number;
  refreshing: boolean; busy: boolean;
  platformLoginState: HomePlatformLoginState;
  speechState?: SpeechPlaybackState; speechSpectrum?: readonly number[];
  onProfile: () => void; onNotes: () => void; onRecommend: () => void;
  onSpeech: () => void;
  onAdd: () => void; onChannel: (channel: Channel) => void; onBeian: () => void;
  onRefresh: () => void; onMoveChannelToTop: (channel: Channel) => Promise<void>;
  onToggleChannelPinned: (channel: Channel) => Promise<void>;
  onMarkChannelRead: (channel: Channel) => Promise<void>;
  onDeleteChannel: (channel: Channel) => Promise<void>;
  ref?: (list: {scroller: Scroller}) => void;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp), pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function actionEntry(label:string, action:()=>void, enabled=true, danger=false):ScrollEntry {
  return {height:52,render:()=> <View onPress={enabled?action:undefined} focusable={enabled} accessibilityRole="button" accessibilityLabel={label} class="absolute inset-0 rounded-[47] bg-[#2a2a2a] items-center justify-center">
    <Text class={danger?"text-[17px] leading-[23] text-[#e54d4d]":enabled?"text-[17px] leading-[23] text-[#f5f5f5]":"text-[17px] leading-[23] text-[#777777]"}>{label}</Text>
  </View>};
}

function ChannelActions(props:{width:number;height:number;channel:Channel;busy:boolean;onClose:()=>void;onMove:()=>Promise<void>;onPin:()=>Promise<void>;onRead:()=>Promise<void>;onDelete:()=>Promise<void>}) {
  const [confirmDelete,setConfirmDelete]=createSignal(false);
  const run=(operation:()=>Promise<void>)=>{if(props.busy)return;void operation().then(props.onClose);};
  const canRead=()=>!props.channel.url.startsWith("builtin:")&&(props.channel.unreadCount??0)>0;
  const entries=createMemo<ScrollEntry[]>(()=>[
    actionEntry("移动到顶部",()=>run(props.onMove),!props.busy),
    actionEntry(props.channel.isPinned?"取消置顶":"置顶",()=>run(props.onPin),!props.busy),
    actionEntry("标记已读",()=>run(props.onRead),!props.busy&&canRead()),
    actionEntry("删除",()=>setConfirmDelete(true),!props.busy,true),
    actionEntry("取消",props.onClose,!props.busy),
  ]);
  return <View class="absolute inset-0 bg-[#000000]">
    <ScrollEntries height={props.height} entries={entries()} gap={8} inputActive={()=>!confirmDelete()&&!props.busy}/>
    <Show when={confirmDelete()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除频道" message="删除后将移除本地缓存" busy={props.busy} onCancel={()=>setConfirmDelete(false)} onConfirm={()=>run(props.onDelete)}/></Show>
  </View>;
}

// OWW242 round resource geometry: 18dp insets and 6dp gaps.
// Glyph origins include the measured difference between Compose and atlas baselines.
export default function HomeScreen(props: HomeScreenProps) {
  const [selected,setSelected]=createSignal<Channel>();
  let scroller:Scroller|undefined;
  // Native HomeDefaultItem: 14dp start / 6dp end / 14.5dp vertical padding, title maxLines 1,
  // summary maxLines 2 (one Text, "\n"-separated), unread dot 6dp after a 4dp gap, offset -4dp.
  const cardWidth = () => props.width - 36;
  const card = (opts: {title: string; summary: string; onPress?: () => void; summaryLines: 1 | 2; pinned?: boolean; titleSize: 16 | 17; dot?: boolean}): ScrollEntry => {
    const columnWidth = cardWidth() - 14 - 6 - (opts.dot ? 10 : 0);
    const titleSlot = opts.titleSize === 16 ? 2 : 22;
    const title = measuredLines(opts.title, columnWidth, text => getOps().measureText(text, titleSlot), 1).join("\n");
    const summary = measuredLines(opts.summary, columnWidth, text => getOps().measureText(text, 1), opts.summaryLines).join("\n");
    const height = 14.5 * 2 + 19 + 17 * opts.summaryLines;
    return {height, render: () => <View onPress={opts.onPress} focusable={!!opts.onPress} accessibilityRole={opts.onPress ? "button" : undefined}
      accessibilityLabel={`${opts.title}，${opts.summary.replace("\n", "，")}`}
      class={opts.pinned ? "absolute inset-0 rounded-[16] bg-[#23272a]" : "absolute inset-0 rounded-[16] bg-[#1c1f21]"}>
      <Text style={{fontSlot: titleSlot, width: columnWidth}} class={opts.titleSize === 16 ? "absolute left-[14] top-[14.5] h-[19] overflow-hidden text-base leading-[19] text-[#f5f5f5]" : "absolute left-[14] top-[14.5] h-[19] overflow-hidden text-[17px] leading-[19] text-[#f5f5f5]"}>{title}</Text>
      <Text style={{width: columnWidth, height: 17 * opts.summaryLines}} class="absolute left-[14] top-[33.5] overflow-hidden text-sm leading-[17] text-[#b6b6b6]">{summary}</Text>
      <Show when={opts.dot}><View class="absolute w-[6] h-[6] rounded-full bg-[#ff6026]" style={{insetL: cardWidth() - 10 - 6, insetT: (height - 6) / 2}}/></Show>
    </View>};
  };
  const channelCard=(channel:Channel):ScrollEntry=>{
    const builtin=channel.url==="builtin:bili"||channel.url==="builtin:douyin";
    return card({title:channel.title,summary:homeChannelSummary(channel,props.platformLoginState,formatTime),onPress:()=>props.onChannel(channel),
      summaryLines:2,pinned:!!channel.isPinned,titleSize:16,dot:!builtin&&(channel.unreadCount??0)>0});
  };
  const speechCard=():ScrollEntry|undefined=>{
    const model=homeSpeechCard(props.speechState);
    if(!model)return undefined;
    const bars=()=>homeSpeechSpectrumBars(props.speechSpectrum, !!props.speechState?.playing);
    return {height:84,render:()=> <View debugName="HomeSpeechCard" onPress={props.onSpeech} focusable accessibilityRole="button" accessibilityLabel={model.title} class="absolute inset-0 rounded-[16] bg-[#252a2d] border-[#ff6026] border-[1]">
      <Text class="absolute left-[14] right-[58] top-[13] h-[21] overflow-hidden text-[17px] leading-[21] text-[#f5f5f5]">{model.title}</Text>
      <Text class="absolute left-[14] right-[58] top-[32.5] h-[38] overflow-hidden text-sm leading-[19] text-[#b6b6b6]">{model.summary}</Text>
      <View debugName="HomeSpeechSpectrum" class="absolute right-[12] top-[25] w-[38] h-[34]">
        <For each={bars()}>{bar=><View class="absolute rounded-[2.2] bg-[#ff6026]" style={bar}/>}</For>
      </View>
    </View>};
  };
  const rows=createMemo<Array<{entry:ScrollEntry;channel?:Channel}>>(()=>[
    {entry:{height: 73, render: () => <View class="absolute inset-0 items-center">
      <View onPress={props.onProfile} focusable style={{insetL:(props.width-36-44)/2}} class="absolute top-[4] w-[44] h-[44] rounded-full bg-[#1c1f21] border-[#ff6026] border-[0.7] items-center justify-center">
        <Text class="text-sm leading-[17] text-[#f5f5f5]">我</Text>
      </View>
      <View class="absolute top-[52] left-[0] right-[0] items-center justify-center"><Text class="text-[9px] leading-[17] text-[#b6b6b6]">点击进入我的</Text></View>
    </View>}},
    ...(speechCard()?[{entry:speechCard()!}]:[]),
    ...movableHomeEntries(props.channels,props.notesPlacement).map(item=>item.kind==="notes"
      ? {entry:card({title:"备忘录",summary:"纯文本编辑 · 手机同步",onPress:props.onNotes,summaryLines:1,pinned:item.isPinned,titleSize:16})}
      : {entry:channelCard(item.channel),channel:item.channel}),
    ...(shouldShowHomeEmptyState(props.channels)?[{entry:card({title:"还没有 RSS 频道",summary:"点击下方添加你的第一个订阅源",summaryLines:1,titleSize:17})}]:[]),
    {entry:card({title:"RSS推荐",summary:"一键加入官方支持频道",onPress:props.onRecommend,summaryLines:1,titleSize:17})},
    {entry:{height:56,render:() => <View class="absolute inset-0 items-center"><View onPress={props.onAdd} focusable style={{insetL:(props.width-36-48)/2}} class="absolute top-[4] w-[48] h-[48] rounded-[47] bg-[#23272a] items-center justify-center"><Text class="text-base leading-[17] text-[#f5f5f5]">+</Text></View></View>}},
    {entry:{height:25,render:() => <View onPress={props.onBeian} focusable class="absolute inset-0 items-center justify-center"><Text class="text-[9px] leading-[17] text-[#b6b6b6]">浙ICP备2024111886号-5A</Text></View>}},
  ]);
  const entries=()=>rows().map(row=>row.entry);
  const hitEntries=()=>rows().map<HomeHitEntry>(row=>({height:row.entry.height,channel:row.channel}));
  return <View class="absolute inset-0 bg-[#000000]">
    <ScrollEntries height={props.height} entries={entries()} inputActive={()=>!selected()&&!props.busy} onRefresh={props.onRefresh} onLongPress={contact=>{
      const channel=homeChannelAtLongPress(hitEntries(),contact.x,contact.y,props.width,scroller?.offset()??0);
      if(channel){scroller?.stop();setSelected(channel);}
    }} ref={handle=>{scroller=handle.scroller;props.ref?.(handle);}}/>
    <Show when={props.refreshing}><View class="absolute top-[8] left-[68] right-[68] h-[24] rounded-[12] bg-[#214536] items-center justify-center"><Text class="text-xs text-[#9ff0c9]">正在刷新全部…</Text></View></Show>
    <Show when={selected()}>{channel=><ChannelActions width={props.width} height={props.height} channel={channel()} busy={props.busy} onClose={()=>setSelected()} onMove={()=>props.onMoveChannelToTop(channel())} onPin={()=>props.onToggleChannelPinned(channel())} onRead={()=>props.onMarkChannelRead(channel())} onDelete={()=>props.onDeleteChannel(channel())}/>}</Show>
  </View>;
}
