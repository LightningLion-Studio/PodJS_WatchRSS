import {createMemo} from "solid-js";
import {Text,View} from "@pocketjs/framework/components";
import {getOps} from "@pocketjs/framework/host";
import {watchUiLines} from "./text-layout.ts";
import {SUMMARY_PRESETS} from "../llm/summary.ts";
import {ScrollEntries,type ScrollEntry} from "./ScrollEntries.tsx";
import type {SettingsScreenProps} from "./SettingsScreen.tsx";
export const SUMMARY_PROMPTS=["请用简洁的中文对以下文章进行摘要，不超过80字。","请提取以下文章的关键信息，以要点形式列出，不超过5条。","请对以下文章进行深度分析，包括主要观点和潜在影响，用中文回答。","请用一句话（不超过30字）概括以下文章的核心内容。"] as const;
export function LlmPromptPresetScreen(props:SettingsScreenProps){
 const entries=createMemo<ScrollEntry[]>(()=>[
  {height:33.5,render:()=> <View class="absolute inset-0 items-center"><Text class="absolute left-[0] right-[0] top-[4] text-center text-[21px] leading-[26] text-[#f5f5f5]">提示词预设</Text></View>},
  ...SUMMARY_PRESETS.map((label,index)=>{
   const lines=watchUiLines(SUMMARY_PROMPTS[index],{width:props.width-82,measure:text=>getOps().measureText(text,0)}).slice(0,2);
   const selected=()=>props.state.llmPromptPreset===index+1;
   return {height:39.5+lines.length*14,render:()=> <View onPress={()=>props.onChange({llmPromptPreset:index+1})} focusable class="absolute inset-0 rounded-[12]" style={{bgColor:selected()?"#140803":"#23272a"}}>
    <View class="absolute left-[12] top-[10] w-[14] h-[14] rounded-full items-center justify-center" style={{bgColor:selected()?"#ff6026":"#23272a"}}><View class={selected()?"w-[6] h-[6] rounded-full bg-[#000000]":"w-[12] h-[12] rounded-full bg-[#272b2e]"}/></View>
    <Text class="absolute left-[34] right-[12] top-[10] text-sm leading-[17]" style={{textColor:selected()?"#ff6026":"#f5f5f5"}}>{label}</Text>
    <Text class="absolute left-[34] right-[12] top-[30] text-xs leading-[14] text-[#b6b6b6]">{lines.join("\n")}</Text>
   </View>};
  }),{height:44,render:()=> <View/>}
 ]);
 return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref}/>;
}
