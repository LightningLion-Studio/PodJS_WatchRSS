import { Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { recommendationGroups, type RecommendedChannel } from "../rss/recommendations.ts";
import { layoutText } from "../reader/index.ts";
export function wrapBody(text: string, width: number): string[] {
  return layoutText(text, { width, measure: value => Array.from(value).reduce((n,c) => n+(c.codePointAt(0)! > 255 ? 12 : 6),0) });
}
export function RecommendationScreen(props: {height:number; width:number; groupId?:string; onGroup:(id:string)=>void; onAdd:(channel:RecommendedChannel)=>void; ref?:(value:{scroller:Scroller})=>void}) {
  const group = () => recommendationGroups.find(g => g.id === props.groupId);
  const entries = ():ScrollEntry[] => [
    {height:48,render:()=> <View class="absolute inset-0 items-center"><Text class="absolute left-[0] right-[0] text-center top-[4] text-[21px] leading-[26] text-[#f5f5f5]">RSS推荐</Text><Text class="absolute left-[0] right-[0] text-center top-[30] text-xs leading-[14] text-[#b6b6b6]">{group()?.name ?? "点击媒体查看频道"}</Text></View>},
    ...(group() ? group()!.channels.map(channel => {
      const lines = wrapBody(channel.url, props.width-36-48).slice(0,2);
      return {height:16+21+2+14*lines.length,render:()=> <View class="absolute left-[0] right-[0] top-[0] bottom-[0] rounded-[16] bg-[#1c1f21]">
        <Text class="absolute left-[12] right-[34] top-[8] text-[17px] leading-[21] text-[#f5f5f5]">{channel.title}</Text>
        <Text class="absolute left-[12] right-[34] top-[31] text-xs leading-[14] text-[#b6b6b6]">{lines.join("\n")}</Text>
        <View onPress={()=>props.onAdd(channel)} focusable class="absolute right-[6] top-[20] w-[20] h-[20] rounded-full bg-[#2a2a2a] items-center justify-center"><Text class="text-[17px] leading-[21] text-[#f5f5f5]">+</Text></View>
      </View>};
    }) : recommendationGroups.map(item => {
      const lines = wrapBody(item.description,props.width-60);
      return {height:12+20+2+lines.length*14,render:()=> <View onPress={()=>props.onGroup(item.id)} focusable class="absolute inset-0 rounded-[16] bg-[#1c1f21]">
        <Text class="absolute left-[12] right-[12] top-[6] text-base leading-[20] text-[#f5f5f5]">{item.name}</Text>
        <Text class="absolute left-[12] right-[12] top-[28] text-xs leading-[14] text-[#b6b6b6]">{lines.join("\n")}</Text>
      </View>};
    })),
    {height:40,render:()=> <View/>}
  ];
  return <ScrollEntries height={props.height} entries={entries()} gap={group()?6:4} ref={props.ref}/>;
}
