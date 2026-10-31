import {createEffect,createSignal,Show} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {novelMenuAppearance} from '../reader/novel.ts';
import {readerColor} from '../reader/content-layout.ts';
import {readerChrome} from '../reader/chrome.ts';
import type {ReaderPreset} from '../reader/preset.ts';

/** Novel-only controls stay in the app and leave the scroll/back gestures intact. */
export function NovelReadingMenu(props:{width:number;height:number;active:boolean;expanded:boolean;moving:boolean;pageMode:boolean;preset:ReaderPreset;onExpanded:(value:boolean)=>void;onMode:(value:boolean)=>void;onSpeak:()=>void}){
 const chrome=()=>readerChrome(props.preset);
 const [idleFor,setIdleFor]=createSignal(0);
 let idleSince=Date.now();
 createEffect(()=>{props.moving;props.expanded;props.active;idleSince=Date.now();setIdleFor(0);});
 onFrame(()=>{if(props.active&&!props.moving&&!props.expanded)setIdleFor(Date.now()-idleSince);});
 const appearance=()=>novelMenuAppearance(idleFor(),props.moving);
 const choose=(mode:boolean)=>{props.onExpanded(false);props.onMode(mode);};
 return <>
  <Show when={props.expanded}>
   <View class="absolute inset-0" style={{bgColor:readerColor(props.preset.background.colorArgb)}} onPress={()=>props.onExpanded(false)} accessibilityLabel="关闭阅读方式菜单"/>
   <View class="absolute" style={{insetL:props.width*.12,insetT:props.height/2-65,width:props.width*.76,height:130}}>
    <Text class="absolute left-[0] right-[0] top-[0] text-center text-base" style={{textColor:chrome().content}}>阅读方式</Text>
    <View class="absolute top-[30] left-[0] right-[0] h-[40] rounded-[20]" style={{bgColor:chrome().action}}>
     {[{mode:false,label:'纵向滚动'},{mode:true,label:'点击翻页'}].map((item,index)=><View focusable accessibilityRole="button" accessibilityLabel={item.label} onPress={()=>choose(item.mode)} class="absolute top-[2] h-[36] rounded-[18] items-center justify-center" style={{insetL:2+index*(props.width*.76-4)/2,width:(props.width*.76-4)/2,bgColor:item.mode===props.pageMode?chrome().activeAction:chrome().action,borderWidth:item.mode===props.pageMode?1:0,borderColor:chrome().active}}><Text class="text-xs" style={{textColor:item.mode===props.pageMode?chrome().active:chrome().content}}>{item.label}</Text></View>)}
    </View>
    <View focusable accessibilityRole="button" accessibilityLabel="大声朗读" onPress={()=>{props.onExpanded(false);props.onSpeak();}} class="absolute top-[80] left-[0] right-[0] h-[40] rounded-[20] items-center justify-center" style={{bgColor:chrome().action}}><Text class="text-sm" style={{textColor:chrome().content}}>大声朗读</Text></View>
   </View>
  </Show>
  <Show when={!props.expanded&&appearance().visible}>
   <View focusable accessibilityRole="button" accessibilityLabel="阅读方式菜单" onPress={()=>props.onExpanded(true)} class="absolute items-center justify-center" style={{width:props.pageMode?24:44,height:props.pageMode?24:44,insetL:(props.width-(props.pageMode?24:44))/2,insetT:props.height-(props.pageMode?30:52)}}>
    <View class="absolute rounded-[16] items-center justify-center" style={{insetL:props.pageMode?2:6,insetT:props.pageMode?2:6,width:props.pageMode?20:32,height:props.pageMode?20:32,bgColor:chrome().action,borderWidth:1,borderColor:chrome().border,opacity:appearance().opacity}}><Text class={props.pageMode?"text-sm":"text-xl"} style={{textColor:chrome().content}}>≡</Text></View>
   </View>
  </Show>
 </>;
}
