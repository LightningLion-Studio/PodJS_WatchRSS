import {DeleteConfirmDialog} from "./DeleteConfirmDialog.tsx";
import {isDeletableLocalContentChannel} from "../core/imported-content.ts";
import {shareActionEnabled} from "../sharing/policy.ts";
import { getOps } from "@pocketjs/framework/host";
import { RemoteImage } from "./RemoteImage.tsx";
import { measuredLines, watchTitleLines } from "../reader/measured-text.ts";
import { createGesture } from "@pocketjs/framework/gesture";
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import {onFrame} from "@pocketjs/framework/lifecycle";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import type { Article } from "./service.ts";

const measureFor=(size:number)=>(text:string)=>getOps().measureText(text,size===21?23:size===14?1:20);
function lines(text:string,width:number,size:number,max:number) {return measuredLines(text,width,measureFor(size),max);}
const REVEAL_WIDTH=164;
function RssCard(props:{onOpen:()=>void;onActions:()=>void;onFavorite:()=>void;onWatchLater:()=>void;open:boolean;swipeEnabled:boolean;onStartSwipe:()=>void;onOpenSwipe:()=>void;onCloseSwipe:()=>void;children:JSX.Element}) {
  let node:NodeMirror|undefined;
  const [offset,setOffset]=createSignal(props.open?-REVEAL_WIDTH:0);
  let dragging=false,dragStart=0,animation:{from:number;to:number;start:number}|null=null;
  const animate=(to:number)=>{animation={from:offset(),to,start:Date.now()};};
  onFrame(()=>{if(!animation)return;const part=Math.min(1,(Date.now()-animation.start)/180),eased=1-(1-part)*(1-part);setOffset(animation.from+(animation.to-animation.from)*eased);if(part>=1)animation=null;});
  createEffect(()=>{const open=props.open,enabled=props.swipeEnabled;if(!dragging)animate(open&&enabled?-REVEAL_WIDTH:0);});
  createGesture({region:{node:()=>props.swipeEnabled?node:null},axis:"x",panSlop:8,onLongPress:props.onActions,
    onPanStart:()=>{dragging=true;animation=null;dragStart=offset();props.onStartSwipe();},
    onPanMove:c=>setOffset(Math.max(-REVEAL_WIDTH,Math.min(0,dragStart+c.dx))),
    onPanEnd:()=>{dragging=false;if(offset()<=-REVEAL_WIDTH/2){props.onOpenSwipe();animate(-REVEAL_WIDTH);}else{props.onCloseSwipe();animate(0);}},
    onCancel:()=>{dragging=false;props.onCloseSwipe();animate(0);}
  });
  const action=(label:string,icon:string,right:number,press:()=>void)=><View onPress={press} focusable={props.open} class="absolute top-[0] bottom-[0] w-[72] rounded-[16] bg-[#2a2a2a] flex-col items-center justify-center" style={{insetR:right}}><Image src={icon} class="w-[16] h-[16]"/><Text class="mt-[4] text-xs leading-[14] text-[#f5f5f5]">{label}</Text></View>;
  return <View class="absolute inset-0 overflow-hidden bg-black">
    {action("收藏","../assets/icons/star.svg",80,props.onFavorite)}
    {action("稍后再看","../assets/icons/watch-later.svg",4,props.onWatchLater)}
    <View ref={value=>node=value} onPress={props.onOpen} focusable class="absolute inset-0 rounded-[16] overflow-hidden bg-[#1c1f21]" style={{translateX:offset()}}>{props.children}</View>
  </View>;
}
export function RssFeedScreen(props:{width:number;height:number;title:string;active?:boolean;originalEnabled?:boolean;onOriginalPaused?:(paused:boolean)=>void;onOriginalContents?:(ids:string[])=>void;onInfo?:()=>void;items:Article[];refreshing:boolean;loadingMore:boolean;canNext:boolean;onOpen:(article:Article)=>void;onActions:(article:Article)=>void;onFavorite:(article:Article)=>void;onWatchLater:(article:Article)=>void;onRefresh:()=>void;onNext:()=>void;ref?:(value:{scroller:Scroller})=>void}) {
  const requested=new Set<string>();
  const [openSwipeId,setOpenSwipeId]=createSignal<string|null>(null);
  const [scrolling,setScrolling]=createSignal(false);
  createEffect(()=>{const id=openSwipeId();if(id&&!props.items.some(item=>item.id===id))setOpenSwipeId(null);});
  let lastAutoLoadCount=-1;
  function requestVisible(first:number,last:number) {
    if(!props.originalEnabled||!props.onOriginalContents)return;
    const ids=props.items.slice(Math.max(0,first-1),Math.max(0,last)).filter(a=>!requested.has(a.id)).map(a=>a.id);
    if(!ids.length)return;ids.forEach(id=>requested.add(id));props.onOriginalContents(ids);
  }
  const header=()=>watchTitleLines(props.title,props.width-36,measureFor(21));
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:18+header().length*26+14,render:()=> <View onPress={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onInfo?.();}} focusable={!!props.onInfo} class="absolute inset-0 items-center"><Text class="absolute left-[0] right-[0] top-[9] text-[21px] leading-[26] text-center text-[#f5f5f5]">{header().join("\n")}</Text><Text class="absolute left-[0] right-[0] text-[11px] leading-[14] text-center text-[#b6b6b6]" style={{insetT:9+header().length*26}}>{props.refreshing?"正在刷新中...":"下拉刷新"}</Text></View>},
    ...props.items.map(a=>{
      const image=!!a.imageUrl;
      const padding=image?8:9;
      // Reserve the 0.5em unread glyph and one measured space on the first line.
      const firstIndent=a.read?0:7+measureFor(14)(" ");
      const title=measuredLines(a.title,props.width-36-padding*2,measureFor(14),2,firstIndent);
      const summary=lines(a.excerpt||"暂无摘要",props.width-36-padding*2,11,2);
      const textHeight=title.length*18+2+summary.length*12.1;
      const cardHeight=image?Math.max(100,textHeight+padding*2):textHeight+padding*2;
      const top=image?cardHeight-padding-textHeight:padding;
      return {height:cardHeight,render:()=> <RssCard onOpen={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onOpen(a);}} onActions={()=>props.onActions(a)} onFavorite={()=>{setOpenSwipeId(null);props.onFavorite(a);}} onWatchLater={()=>{setOpenSwipeId(null);props.onWatchLater(a);}} open={openSwipeId()===a.id} swipeEnabled={(props.active??true)&&!scrolling()} onStartSwipe={()=>{if(openSwipeId()!==a.id)setOpenSwipeId(null);}} onOpenSwipe={()=>setOpenSwipeId(a.id)} onCloseSwipe={()=>{if(openSwipeId()===a.id)setOpenSwipeId(null);}}>
        {image && <RemoteImage url={a.imageUrl!} width={props.width-36} height={cardHeight} fit="cover" class="absolute left-[0] top-[0]"/>}
        {image && <View class="absolute inset-0 bg-gradient-to-b from-transparent to-[#0b1211b3]"/>}
        {!a.read && <View class="absolute w-[7] h-[7] rounded-full bg-[#ff6026]" style={{insetL:padding,insetT:top+6}}/>}
        <For each={title}>{(line,index)=><Text class="absolute text-sm leading-[18] text-[#f5f5f5]" style={{insetL:padding+(index()===0?firstIndent:0),insetR:padding,insetT:top+index()*18}}>{line}</Text>}</For>
        <Text class={image?"absolute text-[11px] leading-[12.1] text-[#b6b6b6cc]":"absolute text-[11px] leading-[12.1] text-[#b6b6b6b3]"} style={{insetL:padding,insetR:padding,insetT:top+2+title.length*18}}>{summary.join("\n")}</Text>
      </RssCard>};
    }),
    ...(!props.items.length?[{height:48,render:()=> <Text class="text-sm text-center text-[#b6b6b6]">暂无内容</Text>}]:[]),
    ...(props.items.length?[{height:52,render:()=> {
      const label=props.loadingMore?"加载中...":props.canNext?"加载更多":"没有更多";
      const enabled=props.canNext&&!props.loadingMore;
      const buttonWidth=Math.min(props.width-44,measureFor(17)(label)+18);
      return <View class="absolute inset-0 items-center">
        <View onPress={enabled?props.onNext:undefined} focusable={enabled} class="absolute top-[4] h-[44] rounded-[47] bg-[#2a2a2a] items-center justify-center" style={{width:buttonWidth,opacity:enabled?1:.5}}>
          <Text class="text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
        </View>
      </View>;
    }}]:[])
  ]);
  return <ScrollEntries height={props.height} entries={entries()} verticalPadding={12} gap={8} inputActive={()=>props.active??true} settleKey={props.originalEnabled} onSettledRange={(first,last)=>{
    requestVisible(first,last);
    if(props.canNext&&!props.loadingMore&&last>=props.items.length&&lastAutoLoadCount!==props.items.length){lastAutoLoadCount=props.items.length;props.onNext();}
  }} onScrollStateChange={value=>{setScrolling(value);if(value)setOpenSwipeId(null);props.onOriginalPaused?.(value);}} onRefresh={props.onRefresh} ref={props.ref}/>;
}
export function RssActionsScreen(props:{width:number;height:number;article:Article;channelUrl?:string;onDelete:()=>void;systemShare?:boolean;busy:boolean;onSave:(type:"favorite"|"watchLater",saved:boolean)=>void;onShare:()=>void;onBack:()=>void;ref?:(value:{scroller:Scroller;goBack:()=>boolean})=>void}) {
  const [confirm,setConfirm]=createSignal(false);
  const goBack=()=>{if(!confirm())return false;if(props.busy)return true;setConfirm(false);return true;};
  const entries=()=>[
    {label:props.article.saved?"取消收藏":"收藏",act:()=>props.onSave("favorite",!props.article.saved),enabled:!props.busy},
    {label:props.article.watchLater?"取消稍后再看":"稍后再看",act:()=>props.onSave("watchLater",!props.article.watchLater),enabled:!props.busy},
    {label:"分享",act:props.onShare,enabled:!props.busy&&shareActionEnabled(props.article.title,props.article.link,!!props.systemShare)},
    ...(isDeletableLocalContentChannel(props.channelUrl)?[{label:"删除",act:()=>setConfirm(true),enabled:!props.busy}]:[]),
    {label:"取消",act:props.onBack,enabled:!props.busy}
  ].map(item=>({height:48,render:()=> <View onPress={item.enabled?item.act:undefined} focusable={item.enabled} class="absolute top-[0] h-[48] rounded-[47] bg-[#2a2a2a] items-center justify-center" style={{width:Math.min(160,props.width-44),insetL:Math.max(0,(props.width-44-160)/2)}}><Text class={item.enabled?"text-[17px] leading-[23] text-[#f5f5f5]":"text-[17px] leading-[23] text-[#939393]"}>{item.label}</Text></View>}));
  return <><ScrollEntries height={props.height} entries={entries()} padding={22} verticalPadding={22} gap={8} inputActive={()=>!confirm()&&!props.busy} ref={value=>props.ref?.({...value,goBack})}/><Show when={confirm()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除内容" message="删除后会从本机和下次同步中移除此内容" busy={props.busy} onCancel={()=>setConfirm(false)} onConfirm={props.onDelete}/></Show></>;
}
