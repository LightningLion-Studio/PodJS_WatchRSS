import { createEffect, createSignal, type JSX } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";

/** Native SwipeActionRow + two SwipeActionButtons (FeedScreen/BiliFeedScreen): 72dp buttons with
 * 4dp padding plus an 8dp reveal gap (164dp), surfaceVariant pills, 16dp icon over 12sp label. */
export const SWIPE_REVEAL_WIDTH=164;
export function SwipeCard(props:{onOpen:()=>void;onActions?:()=>void;onFavorite:()=>void;onWatchLater:()=>void;open:boolean;swipeEnabled:boolean;onStartSwipe:()=>void;onOpenSwipe:()=>void;onCloseSwipe:()=>void;cardClass?:string;
  /** Pans starting in a screen-edge strip (e.g. the Bili side-menu edge) are routed here instead of moving the card. */
  edgeSwipe?:{startX:(x:number)=>boolean;onSwipe:(dx:number)=>void};children:JSX.Element}) {
  let node:NodeMirror|undefined;
  const [offset,setOffset]=createSignal(props.open?-SWIPE_REVEAL_WIDTH:0);
  let dragging=false,edge=false,dragStart=0,animation:{from:number;to:number;start:number}|null=null;
  const animate=(to:number)=>{animation={from:offset(),to,start:Date.now()};};
  onFrame(()=>{if(!animation)return;const part=Math.min(1,(Date.now()-animation.start)/180),eased=1-(1-part)*(1-part);setOffset(animation.from+(animation.to-animation.from)*eased);if(part>=1)animation=null;});
  createEffect(()=>{const open=props.open,enabled=props.swipeEnabled;if(!dragging)animate(open&&enabled?-SWIPE_REVEAL_WIDTH:0);});
  createGesture({region:{node:()=>props.swipeEnabled?node:null},axis:"x",panSlop:8,onLongPress:props.onActions,
    onPanStart:c=>{edge=!props.open&&!!props.edgeSwipe?.startX(c.x-c.dx);if(edge)return;dragging=true;animation=null;dragStart=offset();props.onStartSwipe();},
    onPanMove:c=>{if(!edge)setOffset(Math.max(-SWIPE_REVEAL_WIDTH,Math.min(0,dragStart+c.dx)));},
    onPanEnd:c=>{if(edge){edge=false;props.edgeSwipe?.onSwipe(c.dx);return;}dragging=false;if(offset()<=-SWIPE_REVEAL_WIDTH/2){props.onOpenSwipe();animate(-SWIPE_REVEAL_WIDTH);}else{props.onCloseSwipe();animate(0);}},
    onCancel:()=>{if(edge){edge=false;return;}dragging=false;props.onCloseSwipe();animate(0);}
  });
  const action=(label:string,icon:string,right:number,press:()=>void)=><View onPress={press} focusable={props.open} accessibilityRole="button" accessibilityLabel={`${label}按钮`} class="absolute top-[0] bottom-[0] w-[72] rounded-[16] bg-[#23272a] flex-col items-center justify-center" style={{insetR:right}}><Image src={icon} class="w-[16] h-[16]"/><Text class="mt-[4] text-xs leading-[14] text-[#f5f5f5]">{label}</Text></View>;
  return <View class="absolute inset-0 overflow-hidden bg-black">
    {action("收藏","../assets/icons/star.svg",80,props.onFavorite)}
    {action("稍后再看","../assets/icons/watch-later.svg",4,props.onWatchLater)}
    <View ref={value=>node=value} onPress={props.onOpen} focusable class={props.cardClass??"absolute inset-0 rounded-[16] overflow-hidden bg-[#1c1f21]"} style={{translateX:offset()}}>{props.children}</View>
  </View>;
}
