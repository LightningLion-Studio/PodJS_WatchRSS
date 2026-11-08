import { isDeletableLocalContentChannel } from "../core/imported-content.ts";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { createMemo, createSignal, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { chunkLines } from "./round-rows.tsx";
import { WatchSwitch } from "./AutoScrollSettingsScreen.tsx";
import { measuredLines, watchTitleLines } from "../reader/measured-text.ts";
import type { Channel } from "./service.ts";

type Base = {width:number;height:number;channel:Channel;busy:boolean;ref?:(handle:{scroller:Scroller})=>void};
const measure=(text:string)=>getOps().measureText(text,20);
// Long intros/URLs become several rows so every line can scroll fully into view on a round screen.
const textEntry=(text:string,width:number):ScrollEntry[]=>chunkLines(measuredLines(text,width,measure,100),14,width).map(lines=>
  ({height:lines.length*14,render:()=> <Text class="absolute inset-0 text-[11px] leading-[14] text-center text-[#b6b6b6]">{lines.join("\n")}</Text>}));
function button(label:string,width:number,action:()=>void,enabled=true,danger=false):ScrollEntry {
  return {height:48,render:()=> <View onPress={enabled?action:undefined} focusable={enabled} class="absolute top-[0] h-[48] rounded-[47] bg-[#2a2a2a] items-center justify-center active:scale-96" style={{width:Math.min(160,width),insetL:Math.max(0,(width-160)/2)}}><Text class={danger?"text-[17px] leading-[23] text-[#ff5252]":enabled?"text-[17px] leading-[23] text-[#f5f5f5]":"text-[17px] leading-[23] text-[#939393]"}>{label}</Text></View>};
}
export function ChannelDetailScreen(props:Base&{onSettings:()=>void;onSearch:()=>void;onShare:()=>void;onMarkRead:()=>void}) {
  const entries=createMemo(()=>{
    const width=props.width-36,c=props.channel;
    const title=watchTitleLines(c.title,width,text=>getOps().measureText(text,23));
    const date=c.lastFetchedAt?new Date(c.lastFetchedAt):null;
    const updated=date?`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")} ${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`:"未更新";
    return [
      {height:title.length*26,render:()=> <Text class="absolute inset-0 text-[21px] leading-[26] text-center text-[#f5f5f5]">{title.join("\n")}</Text>},
      ...textEntry(c.description??"暂无简介",width),...textEntry(c.url,width),...textEntry(`更新: ${updated}`,width),...textEntry(`未读 ${c.unreadCount??0}`,width),
      button("设置",width,props.onSettings,!props.busy),button("搜索",width,props.onSearch,!props.busy),button("分享",width,props.onShare,!props.busy),button("标记已读",width,props.onMarkRead,!props.busy&&(c.unreadCount??0)>0)
    ];
  });
  return <ScrollEntries height={props.height} entries={entries()} gap={4} ref={props.ref}/>;
}
function dangerRow(label:string,action:()=>void,enabled:boolean):ScrollEntry {
  return {height:52,render:()=> <View onPress={enabled?action:undefined} focusable={enabled} class="absolute inset-0 rounded-[47] bg-[#2a2a2a] active:scale-96">
    <Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#e54d4d]" style={{opacity:enabled?1:.6}}>{label}</Text>
    <Image src="../assets/icons/delete-outline.svg" class="absolute right-[10] top-[11] w-[30] h-[30]" style={{opacity:enabled?1:.6}}/>
  </View>};
}
export function ChannelSettingsScreen(props:Base&{original:boolean;onOriginal:()=>void;hasPlayableMedia:boolean;background:boolean;onBackground:()=>void;onDelete:()=>void;onClear:()=>Promise<void>}) {
  const [confirm,setConfirm]=createSignal<false|"delete"|"clear">(false);
  const spacer=(height:number):ScrollEntry=>({height,render:()=>null});
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:32.5,render:()=> <Text class="absolute left-[4] right-[4] top-[3.5] text-[21px] leading-[26] text-center text-[#f5f5f5]">频道设置</Text>},
    spacer(9),
    {height:52,render:()=> <View class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">原文阅读模式</Text><View class="absolute right-[15] top-[17.25]"><WatchSwitch checked={props.original} onChange={()=>{if(!props.busy)props.onOriginal();}}/></View></View>},
    {height:18,render:()=> <Text class="absolute left-[10] right-[0] top-[4] text-xs leading-[14] text-[#b6b6b6]">刷新时抓取原文正文与图片</Text>},
    ...(props.hasPlayableMedia?[spacer(8),{height:52,render:()=> <View class="absolute inset-0 rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">在后台继续播放</Text><View class="absolute right-[15] top-[17.25]"><WatchSwitch checked={props.background} onChange={()=>{if(!props.busy)props.onBackground();}}/></View></View>}]:[]),
    spacer(8),
    ...(isDeletableLocalContentChannel(props.channel.url)?[dangerRow("清空内容",()=>setConfirm("clear"),!props.busy),spacer(8)]:[]),
    dangerRow("删除频道",()=>setConfirm("delete"),!props.busy),spacer(20)
  ]);
  return <><ScrollEntries height={props.height} entries={entries()} gap={0} inputActive={()=>!confirm()} ref={props.ref}/><Show when={confirm()}><DeleteConfirmDialog width={props.width} height={props.height} title={confirm()==="clear"?"清空内容":"删除频道"} message={confirm()==="clear"?"清空后将移除这个频道内的本地条目":"删除后将移除本地缓存"} busy={props.busy} onCancel={()=>setConfirm(false)} onConfirm={()=>{if(confirm()==="clear")void props.onClear().then(()=>setConfirm(false));else props.onDelete();}}/></Show></>;
}
