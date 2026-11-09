import {createEffect,createSignal,Show,untrack} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {novelMenuAppearance} from '../reader/novel.ts';
import {readerColor} from '../reader/content-layout.ts';
import {readerChrome} from '../reader/chrome.ts';
import type {ReaderPreset} from '../reader/preset.ts';
import {
 NOVEL_MENU_CLOSE_MS,
 NOVEL_MENU_CONTROLS_FADE_START,
 NOVEL_MENU_OPEN_MS,
 novelMenuAnimatedProgress,
 novelMenuControlsAlpha,
 novelMenuRevealGeometry,
 novelMenuRevealRadius,
 novelMenuScrimAlpha,
} from './novel-menu-animation.ts';

/** Novel-only controls stay in the app and leave the scroll/back gestures intact. */
export function NovelReadingMenu(props:{width:number;height:number;active:boolean;expanded:boolean;moving:boolean;pageMode:boolean;preset:ReaderPreset;onExpanded:(value:boolean)=>void;onMode:(value:boolean)=>void;onSpeak:()=>void}){
 const chrome=()=>readerChrome(props.preset);
 const [idleFor,setIdleFor]=createSignal(0);
 const [progress,setProgress]=createSignal(0);
 let idleSince=Date.now();
 let lastExpanded=false;
 let animating=false;
 let from=0,to=0,startedAt=0,duration=0;
 let lastIdleUpdate=0;
 let pendingAction:(()=>void)|undefined;
 createEffect(()=>{props.moving;props.expanded;props.active;idleSince=Date.now();setIdleFor(0);});
 createEffect(()=>{
  const expanded=props.expanded;
  if(expanded===lastExpanded)return;
  lastExpanded=expanded;
  from=untrack(progress);to=expanded?1:0;startedAt=Date.now();duration=expanded?NOVEL_MENU_OPEN_MS:NOVEL_MENU_CLOSE_MS;animating=true;
  if(expanded)pendingAction=undefined;
 });
 onFrame(()=>{
  const now=Date.now();
  if(animating){
   const elapsed=now-startedAt;
   const next=novelMenuAnimatedProgress(from,to,elapsed,duration);
   setProgress(next);
   if(elapsed>=duration){
    setProgress(to);animating=false;
    if(to===0){const action=pendingAction;pendingAction=undefined;action?.();}
   }
  }
  if(props.active&&!props.moving&&!props.expanded&&progress()===0&&now-lastIdleUpdate>=40){lastIdleUpdate=now;setIdleFor(now-idleSince);}
 });
 const appearance=()=>novelMenuAppearance(idleFor(),props.moving);
 const choose=(mode:boolean)=>{
  if(!props.expanded||pendingAction)return;
  pendingAction=()=>props.onMode(mode);
  props.onExpanded(false);
 };
 const speak=()=>{
  if(!props.expanded||pendingAction)return;
  pendingAction=props.onSpeak;
  props.onExpanded(false);
 };
 const close=()=>{if(props.expanded)props.onExpanded(false);};
 const bubbleSize=()=>props.pageMode?20:32;
 const bubbleRadius=()=>bubbleSize()/2;
 const bubbleTop=()=>props.height-(props.pageMode?30:52)+(props.pageMode?2:6);
 const centerX=()=>props.width/2;
 const centerY=()=>bubbleTop()+bubbleRadius();
 const geometry=()=>novelMenuRevealGeometry(props.width,props.height,centerX(),centerY(),bubbleRadius());
 const radius=()=>novelMenuRevealRadius(progress(),geometry());
 const scrim=()=>`#000000${Math.round(novelMenuScrimAlpha(progress())*255).toString(16).padStart(2,'0')}`;
 const controlsAlpha=()=>novelMenuControlsAlpha(progress());
 const controlsVisible=()=>progress()>NOVEL_MENU_CONTROLS_FADE_START;
 return <>
  <Show when={props.expanded||progress()>0}>
   <View class="absolute inset-0" style={{bgColor:scrim()}} onPress={close} accessibilityLabel="关闭阅读方式菜单"/>
   <View class="absolute rounded-[9999]" style={{insetL:centerX()-radius(),insetT:centerY()-radius(),width:radius()*2,height:radius()*2,bgColor:readerColor(props.preset.background.colorArgb)}} onPress={close}/>
   <Show when={controlsVisible()}>
    <View class="absolute" style={{insetL:props.width*.12,insetT:props.height/2-65,width:props.width*.76,height:130,opacity:controlsAlpha()}}>
     <Text class="absolute left-[0] right-[0] top-[0] text-center text-base" style={{textColor:chrome().content}}>阅读方式</Text>
     <View class="absolute top-[30] left-[0] right-[0] h-[40] rounded-[20]" style={{bgColor:chrome().action}}>
      {[{mode:false,label:'纵向滚动'},{mode:true,label:'点击翻页'}].map((item,index)=><View focusable={props.expanded} accessibilityRole="button" accessibilityLabel={item.label} onPress={()=>choose(item.mode)} class="absolute top-[2] h-[36] rounded-[18] items-center justify-center active:scale-96" style={{insetL:2+index*(props.width*.76-4)/2,width:(props.width*.76-4)/2,bgColor:item.mode===props.pageMode?chrome().activeAction:chrome().action,borderWidth:item.mode===props.pageMode?1:0,borderColor:chrome().active}}><Text class="text-xs" style={{textColor:item.mode===props.pageMode?chrome().active:chrome().content}}>{item.label}</Text></View>)}
     </View>
     <View focusable={props.expanded} accessibilityRole="button" accessibilityLabel="大声朗读" onPress={speak} class="absolute top-[80] left-[0] right-[0] h-[40] rounded-[20] items-center justify-center active:scale-96" style={{bgColor:chrome().action}}><Text class="text-sm" style={{textColor:chrome().content}}>大声朗读</Text></View>
    </View>
   </Show>
  </Show>
  <Show when={!props.expanded&&progress()===0&&appearance().visible}>
   <View focusable accessibilityRole="button" accessibilityLabel="阅读方式菜单" onPress={()=>props.onExpanded(true)} class="absolute items-center justify-center active:scale-96" style={{width:props.pageMode?24:44,height:props.pageMode?24:44,insetL:(props.width-(props.pageMode?24:44))/2,insetT:props.height-(props.pageMode?30:52)}}>
    <View class="absolute rounded-[16] items-center justify-center" style={{insetL:props.pageMode?2:6,insetT:props.pageMode?2:6,width:bubbleSize(),height:bubbleSize(),bgColor:chrome().action,borderWidth:1,borderColor:chrome().border,opacity:appearance().opacity}}><Text class={props.pageMode?"text-sm":"text-xl"} style={{textColor:chrome().content}}>≡</Text></View>
   </View>
  </Show>
 </>;
}
