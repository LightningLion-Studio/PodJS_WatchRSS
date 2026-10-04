import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {createEffect,createMemo,createSignal,untrack,type JSX} from 'solid-js';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {initialCustomizationDraft,type CustomizationDraft} from '../onboarding/restoration.ts';
import {adjacentPlaybackStartVolumeLimit,formatPlaybackStartVolumeLimit} from '../media/start-volume.ts';
import {WatchSwitch} from './AutoScrollSettingsScreen.tsx';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {OnboardingPrimaryButton} from './OnboardingNetworkScreen.tsx';
import {watchUiLines} from './text-layout.ts';

/** Native OobeCustomizationStep keeps these controls as local demonstrations.
 * Only the theme action belongs to the persistent reader-preset owner. */
export function OnboardingCustomizationScreen(props:{width:number;height:number;readerDark:boolean;onToggleReaderTheme:()=>void;onNext:()=>void;restoreDraft?:()=>CustomizationDraft;onDraftChange?:(draft:CustomizationDraft)=>void;active?:()=>boolean;ref?:Parameters<typeof ScrollEntries>[0]['ref']}){
 const initial=untrack(()=>props.restoreDraft?.()??initialCustomizationDraft());
 const [font,setFont]=createSignal(initial.font);
 const [volume,setVolume]=createSignal(initial.volume);
 const [guard,setGuard]=createSignal(initial.guard);
 const [limit,setLimit]=createSignal<number|null>(initial.limit);
 const [scroller,setScroller]=createSignal<Scroller>();
 createEffect(()=>{
  const scroll=scroller();if(!scroll)return;
  const draft={font:font(),volume:volume(),guard:guard(),limit:limit(),scrollOffset:Math.max(0,Math.round(scroll.offset()*density))};
  untrack(()=>props.onDraftChange?.(draft));
 });
 const density=getDisplayMetrics().density;
 const wrap=(text:string,width:number,slot=0)=>watchUiLines(text,{width:Math.max(1,width),measure:t=>getOps().measureText(t,slot)});
 const spacer=(height:number):ScrollEntry=>({height,render:()=> <View/>});
 const setting=(label:string,description:string,controlWidth:number,render:()=>JSX.Element,end=10):ScrollEntry=>{
  const labels=wrap(label,props.width-10-end-controlWidth,22);
  const height=Math.max(52,16+labels.length*21);
  const details=wrap(description,props.width-10);
  return {height:height+4+details.length*14,render:()=> <View class="absolute inset-0">
   <View class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{height}}>
    <Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{insetT:(height-labels.length*21)/2,width:props.width-10-end-controlWidth,height:labels.length*21}}>{labels.join('\n')}</Text>
    <View class="absolute top-[0] bottom-[0] flex-col justify-center" style={{insetR:end,width:controlWidth}}>{render()}</View>
   </View>
   <Text class="absolute left-[10] right-[0] text-xs leading-[14] text-[#b6b6b6]" style={{insetT:height+4,height:details.length*14}}>{details.join('\n')}</Text>
  </View>};
 };
 const stepButton=(label:string,plus:boolean,enabled:boolean,onPress:()=>void)=> <View accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:!enabled}} focusable={enabled} onPress={()=>{if(enabled)onPress();}} class="absolute top-[0.5] w-[20] h-[20] rounded-[9999] bg-[#444444]" style={plus?{insetR:0}:{insetL:0}}>
  <View class="absolute left-[5] top-[9.5] w-[10] h-[1] bg-[#f5f5f5]" style={{opacity:enabled?1:.38}}/>
  {plus&&<View class="absolute left-[9.5] top-[5] w-[1] h-[10] bg-[#f5f5f5]" style={{opacity:enabled?1:.38}}/>}
 </View>;
 const stepper=(text:string,compact:boolean,lower:boolean,higher:boolean,previous:()=>void,next:()=>void)=> <View class="relative w-[100] h-[21]">
  {stepButton(compact?"降低静音开播上限":"减小字体",false,lower,previous)}
  <Text class="absolute top-[0] text-[17px] leading-[21] text-center text-[#f5f5f5]" style={{insetL:compact?24:26,width:compact?52:48}}>{text}</Text>
  {stepButton(compact?"提高静音开播上限":"增大字体",true,higher,next)}
 </View>;
 const hint=()=>wrap('这些项目都能在设置中随时调整',Math.min(props.width,208));
 const entries=createMemo<ScrollEntry[]>(()=>[
  spacer(10),{height:29,render:()=> <Text class="absolute inset-0 text-2xl leading-[29] text-[#f5f5f5] text-center">自定义</Text>},spacer(8),
  {height:hint().length*14,render:()=> <Text class="absolute text-xs leading-[14] text-[#b6b6b6] text-center" style={{insetL:(props.width-Math.min(props.width,208))/2,width:Math.min(props.width,208),height:hint().length*14}}>{hint().join('\n')}</Text>},spacer(12),
  setting('阅读主题','切换浅色或深色阅读界面',20,()=> <View focusable accessibilityLabel="切换阅读主题" onPress={props.onToggleReaderTheme} class="relative w-[20] h-[20] rounded-[9999] bg-[#ff6026]"><View class="absolute left-[2] top-[2] w-[16] h-[16] rounded-[9999]" style={{bgColor:props.readerDark?'#000000':'#ffffff'}}/></View>,15),spacer(8),
  setting('字体大小','调整正文阅读字号',100,()=>stepper(`${font()}sp`,false,font()>12,font()<32,()=>setFont(v=>Math.max(12,v-2)),()=>setFont(v=>Math.min(32,v+2)))),spacer(8),
  setting('使用滚轮调节音量','播放器内可用滚轮调节媒体音量',60/density,()=> <WatchSwitch accessibilityLabel="使用滚轮调节音量" checked={volume()} onChange={()=>setVolume(v=>!v)}/>,15),
  ...(volume()?[spacer(8),setting('音量调节防干扰','滚轮连续上调时先停一下，减少误触后突然过响',60/density,()=> <WatchSwitch accessibilityLabel="音量调节防干扰" checked={guard()} onChange={()=>setGuard(v=>!v)}/>,15)]:[]),spacer(8),
  setting('静音开播','开始播放时仅在当前音量高于上限时压低音量',100,()=>stepper(formatPlaybackStartVolumeLimit(limit()),true,true,true,()=>setLimit(v=>adjacentPlaybackStartVolumeLimit(v,-1)),()=>setLimit(v=>adjacentPlaybackStartVolumeLimit(v,1)))),spacer(8),
  {height:45,render:()=> <View class="absolute inset-0 flex-col items-center"><OnboardingPrimaryButton text="下一页" enabled onPress={props.onNext}/></View>},spacer(52)
 ]);
 return <ScrollEntries accessibilityLabel="自定义设置" height={props.height} entries={entries()} gap={0} padding={0} verticalPadding={0} inputActive={props.active} ref={value=>{value.scroller.scrollTo(initial.scrollOffset/density,{immediate:true});setScroller(value.scroller);props.ref?.(value);}}/>;
}
