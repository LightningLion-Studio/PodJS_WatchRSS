import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {createMemo,type JSX} from 'solid-js';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {watchUiLines} from './text-layout.ts';

/** Presentation only. The startup owner supplies the active reader title/background
 * and performs persistence or task exit after an explicit button press. */
export function PrivacyPolicyConsentScreen(props:{
 width:number;height:number;title:ScrollEntry;background:JSX.Element;
 onOpenPrivacy:()=>void;onAgree:()=>void;onDisagree:()=>void;
 active?:()=>boolean;ref?:Parameters<typeof ScrollEntries>[0]['ref'];
}){
 const notice=createMemo(()=>watchUiLines('我们更新了隐私政策，请在继续使用前阅读并确认。',{
  width:Math.max(1,props.width-28),measure:text=>getOps().measureText(text,1)
 }));
 const entries=createMemo<ScrollEntry[]>(()=>[
  {height:22,render:()=> <View/>},props.title,
  {height:10,render:()=> <View/>},
  {height:notice().length*17,render:()=> <Text class="absolute inset-0 text-sm leading-[17] text-white text-center">{notice().join('\n')}</Text>},
  {height:10,render:()=> <View/>},
  {height:38,render:()=> <View class="absolute inset-0 items-center justify-center"><View focusable onPress={props.onOpenPrivacy} class="rounded-[9999] px-[12] py-[8] active:scale-96"><Text class="text-lg leading-[22] text-[#ff6026] text-center">查看《隐私政策》</Text><View class="absolute left-[12] right-[12] bottom-[8] h-[0.5] bg-[#ff6026]"/></View></View>},
  {height:82,render:()=> <View/>}
 ]);
 return <View class="absolute inset-0" accessibilityState={{disabled:props.active?.()===false}}>
  {props.background}
  <ScrollEntries height={props.height} entries={entries()} padding={14} verticalPadding={0} gap={0} inputActive={props.active} ref={props.ref}/>
  <View class="absolute bottom-[0] left-[0] right-[0] h-[64] items-center justify-center" style={{bgColor:'#000000eb'}}>
   <View class="relative w-[108] h-[48]">
    <View focusable onPress={props.onDisagree} class="absolute left-[0] top-[0] w-[48] h-[48] rounded-[9999] bg-[#23272a] items-center justify-center active:scale-96"><Text class="text-xs leading-[14] text-[#b6b6b6] text-center">不同意</Text></View>
    <View focusable onPress={props.onAgree} class="absolute right-[0] top-[0] w-[48] h-[48] rounded-[9999] bg-[#ff6026] items-center justify-center active:scale-96"><Text class="text-xs leading-[14] text-[#000000] text-center">同意</Text></View>
   </View>
  </View>
 </View>;
}
