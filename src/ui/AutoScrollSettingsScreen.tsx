import { createMemo, Show } from "solid-js";
import { Text, View, Image } from "@pocketjs/framework/components";
import { getDisplayMetrics } from "@podjs/framework/watch";
import { getOps } from "@pocketjs/framework/host";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import type { SettingsScreenProps } from "./SettingsScreen.tsx";
import { layoutText } from "../reader/index.ts";

const AWAKE_DETAIL="仅在自动滚动时保持亮屏，暂停或离开后恢复";
type Props=SettingsScreenProps&{reader?:{playing:()=>boolean;setPlaying:(value:boolean)=>void};onReturn?:()=>void};
export function WatchSwitch(props:{checked:boolean;onChange:()=>void;accessibilityLabel?:string}) {
  const density=getDisplayMetrics().density;
  return <View onPress={props.onChange} accessibilityLabel={props.accessibilityLabel} accessibilityRole={props.accessibilityLabel?"checkbox":undefined} accessibilityState={props.accessibilityLabel?{checked:props.checked}:undefined} focusable class={props.checked?"relative rounded-[9999] bg-[#ff6026]":"relative rounded-[9999] bg-[#23272a]"} style={{width:60/density,height:35/density}}>
    <View class="absolute rounded-[9999] bg-[#000000]" style={{insetT:5/density,insetL:(props.checked?30:5)/density,width:25/density,height:25/density}}/>
  </View>;
}
function Speed(props:{value:number;onChange:(value:number)=>void;unit?:boolean}) {
  const valueWidth=()=>props.unit?96:54;
  return <View class="relative h-[36]" style={{width:valueWidth()+64}}>
    <View onPress={()=>{if(props.value>.5)props.onChange(Math.max(.5,props.value-.5));}} focusable class="absolute left-[0] top-[2] w-[32] h-[32] rounded-full bg-[#242424]" style={{opacity:props.value>.5?1:.45}}><View class="absolute bg-[#ffffff]" style={{insetL:11.1467,insetT:15.3067,width:9.7067,height:1.3867}}/></View>
    <Text class="absolute left-[32] top-[7] text-lg leading-[22] text-center text-white" style={{width:valueWidth()}}>{`${props.value.toFixed(1)}${props.unit?" 行/秒":""}`}</Text>
    <View onPress={()=>{if(props.value<10)props.onChange(Math.min(10,props.value+.5));}} focusable class="absolute right-[0] top-[2] w-[32] h-[32] rounded-full bg-[#242424]" style={{opacity:props.value<10?1:.45}}><View class="absolute bg-[#ffffff]" style={{insetL:11.1467,insetT:15.3067,width:9.7067,height:1.3867}}/><View class="absolute bg-[#ffffff]" style={{insetL:15.3067,insetT:11.1467,width:1.3867,height:9.7067}}/></View>
  </View>;
}
export function AutoScrollSettingsScreen(props:Props) {
  const toggle=()=>props.onChange({readerAutoStart:!props.state.readerAutoStart});
  const awake=()=>props.onChange({readerKeepAwake:!props.state.readerKeepAwake});
  const speed=(value:number)=>props.onChange({readerScrollSpeed:value});
  const detail=()=>props.state.readerAutoStart?"已开启，进入文章并恢复阅读位置后自动滚动":"已关闭，仍可在阅读器中手动启动";
  const wrap=(text:string)=>layoutText(text,{width:props.width-46,measure:text=>getOps().measureText(text,0)});
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:34,render:()=> <View class="absolute inset-0 items-center justify-center"><Text class="text-[21px] leading-[26] text-[#f5f5f5]">自动滚动控制</Text></View>},
    {height:56+wrap(detail()).length*14,render:()=> <View class="absolute inset-0"><View class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">打开文章自动开始</Text><View class="absolute right-[15] top-[17.25]"><WatchSwitch checked={props.state.readerAutoStart} onChange={toggle}/></View></View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{wrap(detail()).join("\n")}</Text></View>},
    {height:56+wrap(AWAKE_DETAIL).length*14,render:()=> <View class="absolute inset-0"><View class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">屏幕常亮</Text><View class="absolute right-[15] top-[17.25]"><WatchSwitch checked={props.state.readerKeepAwake} onChange={awake} accessibilityLabel="屏幕常亮"/></View></View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{wrap(AWAKE_DETAIL).join("\n")}</Text></View>},
    {height:84,render:()=> <View class="absolute inset-0"><View class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a]"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">速度</Text><View class="absolute right-[10] top-[8]"><Speed value={props.state.readerScrollSpeed} onChange={speed}/></View></View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{wrap(`每秒 ${props.state.readerScrollSpeed.toFixed(1)} 行，范围 0.5–10.0 行`).join("\n")}</Text></View>},
    {height:84,render:()=> <Text class="text-xs leading-[14] text-center text-[#b6b6b6]">{wrap("你也可以在阅读器中双击进入自动滚动控制").join("\n")}</Text>},
  ]);
  return <Show when={props.reader} fallback={<ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref}/>}>
    {reader=><View class="absolute left-[18] right-[18] top-[10] bottom-[0]">
      <Text class="absolute left-[0] right-[0] top-[0] text-lg leading-[22] text-center text-white">自动滚动控制</Text>
      <Image src="../assets/icons/swipe-up.svg" class="absolute left-[0] top-[39] w-[24] h-[24]"/>
      <Text class="absolute left-[33] top-[33] text-lg leading-[22] text-white">当前文章</Text>
      <Text class="absolute left-[33] top-[54] text-xs leading-[14] text-[#bdbdbd]">{reader().playing()?"正在自动滚动":"自动滚动已暂停"}</Text>
      <View onPress={()=>reader().setPlaying(!reader().playing())} focusable class="absolute right-[2] top-[28] w-[46] h-[46] rounded-full bg-[#ff6026] items-center justify-center"><Image src={reader().playing()?"../assets/icons/pause.svg":"../assets/icons/play.svg"} class="w-[24] h-[24]"/></View>
      <Text class="absolute left-[0] top-[86.5] text-sm leading-[17] text-white">自动开始</Text>
      <View class="absolute right-[0] top-[86.25]"><WatchSwitch checked={props.state.readerAutoStart} onChange={toggle}/></View>
      <Text class="absolute left-[0] top-[114.5] text-sm leading-[17] text-white">屏幕常亮</Text>
      <View class="absolute right-[0] top-[114.25]"><WatchSwitch checked={props.state.readerKeepAwake} onChange={awake} accessibilityLabel="屏幕常亮"/></View>
      <View class="absolute top-[142]" style={{insetL:(props.width-36-160)/2}}><Speed value={props.state.readerScrollSpeed} onChange={speed} unit/></View>
      <View onPress={props.onReturn} focusable class="absolute left-[0] right-[0] top-[181] h-[36] items-center"><Text class="absolute left-[0] right-[0] top-[8] text-sm text-center text-[#ff6026]">返回文章</Text></View>
    </View>}
  </Show>;
}
