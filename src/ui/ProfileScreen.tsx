import { Text, View } from "@pocketjs/framework/components";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { ProfileIcon, type ProfileIconName } from "./ProfileIcon.tsx";
import type { Scroller } from "@pocketjs/framework/kinetics";
export function ProfileScreen(props: {height:number; onSelect:(index:number)=>void; onBeian:()=>void; ref?:(value:{scroller:Scroller})=>void}) {
  const titles = ["账号", "我的收藏", "稍后再看", "连接手机", "设置", "关于", "联系开发者"];
  const icons:ProfileIconName[] = ["person","star","play-circle","phone-android","settings","info","person"];
  const entries:ScrollEntry[] = [
    {height:25.5,render:()=><View class="absolute inset-0 items-center justify-center"><Text style={{translateY:-1.25}} class="text-[21px] leading-[26] text-[#f5f5f5]">我的</Text></View>},
    ...titles.map((title,index)=>({height:52,render:()=><View onPress={()=>props.onSelect(index)} focusable class="absolute inset-0 rounded-[47] bg-[#2a2a2a]">
      <View class="absolute left-[10] top-[11] w-[30] h-[30]"><ProfileIcon name={icons[index]} size={30}/></View>
      <Text class="absolute left-[49] right-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{title}</Text>
    </View>})),
    {height:58,render:()=><View onPress={props.onBeian} focusable class="absolute left-[0] right-[0] bottom-[0] h-[14] items-center justify-center"><Text class="text-xs leading-[14] text-[#b6b6b6]">浙ICP备2024111886号-5A</Text></View>}
  ];
  return <ScrollEntries height={props.height} entries={entries} gap={8} ref={props.ref}/>;
}
