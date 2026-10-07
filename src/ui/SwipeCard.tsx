import {type JSX} from "solid-js";
import {SwipeActionCard} from "@podjs/framework/watch-ui";
export const SWIPE_REVEAL_WIDTH=164;
export function SwipeCard(props:{onOpen:()=>void;onActions?:()=>void;onFavorite:()=>void;onWatchLater:()=>void;open:boolean;swipeEnabled:boolean;onStartSwipe:()=>void;onOpenSwipe:()=>void;onCloseSwipe:()=>void;cardClass?:string;
  /** Pans starting in a screen-edge strip (e.g. the Bili side-menu edge) are routed here instead of moving the card. */
  edgeSwipe?:{startX:(x:number)=>boolean;onSwipe:(dx:number)=>void};children:JSX.Element}) {
 return <SwipeActionCard {...props} revealWidth={SWIPE_REVEAL_WIDTH} actions={[
  {label:"收藏",icon:"../assets/icons/star.svg",right:80,onPress:props.onFavorite,accessibilityLabel:"收藏按钮"},
  {label:"稍后再看",icon:"../assets/icons/watch-later.svg",right:4,onPress:props.onWatchLater,accessibilityLabel:"稍后再看按钮"},
 ]}/>;
}
