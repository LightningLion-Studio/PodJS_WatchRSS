import {ReadingModeControl} from "./ReadingModeControl.tsx";
import { Text, View, Image } from "@pocketjs/framework/components";
import { getDisplayMetrics } from "@podjs/framework/watch";
import type { SettingsScreenProps } from "./SettingsScreen.tsx";

type Props=SettingsScreenProps&{reader?:{playing:()=>boolean;setPlaying:(value:boolean)=>void};onReturn?:()=>void};
export function WatchSwitch(props:{checked:boolean;onChange:()=>void;accessibilityLabel?:string}) {
  const density=getDisplayMetrics().density;
  return <View onPress={props.onChange} accessibilityLabel={props.accessibilityLabel} accessibilityRole={props.accessibilityLabel?"checkbox":undefined} accessibilityState={props.accessibilityLabel?{checked:props.checked}:undefined} focusable class={props.checked?"relative rounded-[9999] bg-[#ff6026]":"relative rounded-[9999] bg-[#23272a]"} style={{width:60/density,height:35/density}}>
    <View class="absolute rounded-[9999] bg-[#000000]" style={{insetT:5/density,insetL:(props.checked?30:5)/density,width:25/density,height:25/density}}/>
  </View>;
}
function Speed(props:{value:number;onChange:(value:number)=>void;unit?:boolean;pageMode?:boolean}) {
  const valueWidth=()=>props.unit?96:54;
  const minimum=()=>props.pageMode?1:.5,maximum=()=>props.pageMode?120:10,step=()=>props.pageMode?1:.5;
  return <View class="relative h-[36]" style={{width:valueWidth()+64}}>
    <View accessibilityLabel={props.pageMode?"缩短翻页间隔":"降低滚动速度"} onPress={()=>{if(props.value>minimum())props.onChange(Math.max(minimum(),props.value-step()));}} focusable class="absolute left-[0] top-[2] w-[32] h-[32] rounded-full bg-[#242424] active:scale-96" style={{opacity:props.value>minimum()?1:.45}}><View class="absolute bg-[#ffffff]" style={{insetL:11.1467,insetT:15.3067,width:9.7067,height:1.3867}}/></View>
    <Text class="absolute left-[32] top-[7] text-lg leading-[22] text-center text-white" style={{width:valueWidth()}}>{`${props.pageMode?props.value.toFixed(0):props.value.toFixed(1)}${props.unit?(props.pageMode?" 秒/页":" 行/秒"):""}`}</Text>
    <View accessibilityLabel={props.pageMode?"延长翻页间隔":"提高滚动速度"} onPress={()=>{if(props.value<maximum())props.onChange(Math.min(maximum(),props.value+step()));}} focusable class="absolute right-[0] top-[2] w-[32] h-[32] rounded-full bg-[#242424] active:scale-96" style={{opacity:props.value<maximum()?1:.45}}><View class="absolute bg-[#ffffff]" style={{insetL:11.1467,insetT:15.3067,width:9.7067,height:1.3867}}/><View class="absolute bg-[#ffffff]" style={{insetL:15.3067,insetT:11.1467,width:1.3867,height:9.7067}}/></View>
  </View>;
}
export function AutoScrollSettingsScreen(props:Props) {
  const top=(value:number)=>value*Math.min(1,props.height/233);
  const controlWidth=()=>Math.min(158,props.width-60);
  return <View debugName="ScrollControlPanel" class="absolute inset-0 overflow-hidden">
    <Text class="absolute text-lg leading-[22] text-center text-white" style={{insetL:(props.width-110)/2,insetT:top(12),width:110}}>滚动控制</Text>
    <View class="absolute" style={{insetL:(props.width-controlWidth())/2,insetT:top(39)}}><ReadingModeControl width={controlWidth()} height={34} pageMode={props.state.readerPageMode} onChange={value=>props.onChange({readerPageMode:value})}/></View>
    {props.reader?<View class="absolute h-[30]" style={{insetL:30,insetR:30,insetT:top(79)}}>
      <Text class="absolute left-[0] text-sm leading-[17] text-white" style={{insetT:6}}>{props.state.readerPageMode?"自动翻页":"自动滚动"}</Text>
      <View onPress={()=>props.reader!.setPlaying(!props.reader!.playing())} accessibilityLabel={`${props.reader.playing()?"暂停":"开始"}${props.state.readerPageMode?"自动翻页":"自动滚动"}`} focusable class="absolute right-[0] top-[0] w-[30] h-[30] rounded-full bg-[#ff6026] items-center justify-center active:scale-96"><Image src={props.reader.playing()?"../assets/icons/pause.svg":"../assets/icons/play.svg"} class="w-[18] h-[18]"/></View>
    </View>:<Text class="absolute text-xs leading-[14] text-center text-[#bdbdbd]" style={{insetL:24,insetR:24,insetT:top(87)}}>阅读时双击打开此页</Text>}
    <Text class="absolute text-sm leading-[18] text-white" style={{insetL:34,insetT:top(114)}}>自动开始</Text>
    <View class="absolute" style={{insetR:34,insetT:top(114)}}><WatchSwitch checked={props.state.readerAutoStart} onChange={()=>props.onChange({readerAutoStart:!props.state.readerAutoStart})} accessibilityLabel="自动开始"/></View>
    <Text class="absolute text-sm leading-[18] text-white" style={{insetL:34,insetT:top(139)}}>屏幕常亮</Text>
    <View class="absolute" style={{insetR:34,insetT:top(139)}}><WatchSwitch checked={props.state.readerKeepAwake} onChange={()=>props.onChange({readerKeepAwake:!props.state.readerKeepAwake})} accessibilityLabel="屏幕常亮"/></View>
    <View class="absolute" style={{insetL:(props.width-160)/2,insetT:top(161)}}><Speed pageMode={props.state.readerPageMode} value={props.state.readerPageMode?props.state.readerPageSeconds:props.state.readerScrollSpeed} onChange={value=>props.onChange(props.state.readerPageMode?{readerPageSeconds:value}:{readerScrollSpeed:value})} unit/></View>
    <View onPress={props.onReturn} accessibilityLabel={props.reader?"返回文章":"返回设置"} focusable class="absolute h-[24] items-center justify-center active:scale-96" style={{insetL:(props.width-80)/2,insetT:top(198),width:80}}><Text class="text-sm text-[#ff6026]">{props.reader?"返回文章":"返回设置"}</Text></View>
  </View>;
}
