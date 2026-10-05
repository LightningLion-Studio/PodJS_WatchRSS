import {DeleteConfirmDialog} from "./DeleteConfirmDialog.tsx";
import {isDeletableLocalContentChannel} from "../core/imported-content.ts";
import {shareActionEnabled} from "../sharing/policy.ts";
import { getOps } from "@pocketjs/framework/host";
import { RemoteImage } from "./RemoteImage.tsx";
import { measuredLines, watchTitleLines } from "../reader/measured-text.ts";
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { SwipeCard } from "./SwipeCard.tsx";
import type { Article } from "./service.ts";

const measureFor=(size:number)=>(text:string)=>getOps().measureText(text,size===21?23:size===14?1:size===9?19:20);
function lines(text:string,width:number,size:number,max:number) {return measuredLines(text,width,measureFor(size),max);}
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
  // Native FeedHeader formats "$title ⓘ" when the title opens channel info.
  // Native hint: bold #BDBDBD "ⓘ" at 19sp: 16dp circle, ~2.5dp after the text (measured on OWW242).
  const INFO_ADVANCE=18.5,INFO_BOX=19.2;
  // watchTitleLines drops spaces in CJK titles, so the hint is measured as its own unit ("ⓘ" = space + icon).
  const titleMeasure=(text:string)=>text.endsWith("ⓘ")?measureFor(21)(text.slice(0,-1).trimEnd())+INFO_ADVANCE:measureFor(21)(text);
  const header=()=>watchTitleLines(props.onInfo?`${props.title}ⓘ`:props.title,props.width-36,titleMeasure,150,190,props.onInfo?"ⓘ":undefined,2);
  const headerText=(line:string)=>line.endsWith("ⓘ")?line.slice(0,-1).trimEnd():line;
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:18+header().length*27+16,render:()=> <View onPress={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onInfo?.();}} focusable={!!props.onInfo} class="absolute inset-0 items-center"><For each={header()}>{(line,index)=>{const text=headerText(line),icon=line.endsWith("ⓘ"),width=()=>measureFor(21)(text)+(icon?INFO_ADVANCE:0),left=()=>(props.width-36-width())/2;
        return icon?<><Text class="absolute top-[0] text-[21px] leading-[27] text-[#f5f5f5]" style={{insetL:left(),insetT:9.5+index()*27}}>{text}</Text><Image src="../assets/icons/info-hint.svg" class="absolute w-[18.6] h-[18.6]" style={{insetL:left()+measureFor(21)(text)-0.6,insetT:9.5+index()*27+4.65}}/></>
          :<Text class="absolute left-[0] right-[0] text-[21px] leading-[27] text-center text-[#f5f5f5]" style={{insetT:9.5+index()*27}}>{text}</Text>;}}</For><Text class="absolute left-[0] right-[0] text-[9px] leading-[12] text-center text-[#b6b6b6]" style={{insetT:11+header().length*27}}>{props.refreshing?"正在刷新中...":"下拉刷新"}</Text></View>},
    ...props.items.map(a=>{
      const image=!!a.imageUrl;
      const padding=image?8:9;
      // Reserve the 0.5em unread glyph and one measured space on the first line.
      const firstIndent=a.read?0:7+measureFor(14)(" ");
      const title=measuredLines(a.title,props.width-36-padding*2,measureFor(14),2,firstIndent);
      // Native feed_card_summary_text_size = hey_caption 9sp, lineHeight 1.1x.
      const summary=lines(a.excerpt||"暂无摘要",props.width-36-padding*2,9,2);
      const textHeight=title.length*18+2+summary.length*9.9;
      const cardHeight=image?Math.max(100,textHeight+padding*2):textHeight+padding*2;
      const top=image?cardHeight-padding-textHeight:padding;
      return {height:cardHeight,render:()=> <SwipeCard onOpen={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onOpen(a);}} onActions={()=>props.onActions(a)} onFavorite={()=>{setOpenSwipeId(null);props.onFavorite(a);}} onWatchLater={()=>{setOpenSwipeId(null);props.onWatchLater(a);}} open={openSwipeId()===a.id} swipeEnabled={(props.active??true)&&!scrolling()} onStartSwipe={()=>{if(openSwipeId()!==a.id)setOpenSwipeId(null);}} onOpenSwipe={()=>setOpenSwipeId(a.id)} onCloseSwipe={()=>{if(openSwipeId()===a.id)setOpenSwipeId(null);}}>
        {image && <RemoteImage url={a.imageUrl!} width={props.width-36} height={cardHeight} fit="cover" class="absolute left-[0] top-[0]"/>}
        {image && <View class="absolute inset-0 bg-gradient-to-b from-transparent to-[#0b1211b3]"/>}
        {!a.read && <View class="absolute w-[7] h-[7] rounded-full bg-[#ff6026]" style={{insetL:padding,insetT:top+6}}/>}
        <For each={title}>{(line,index)=><Text class="absolute text-sm leading-[18] text-[#f5f5f5]" style={{insetL:padding+(index()===0?firstIndent:0),insetR:padding,insetT:top+index()*18}}>{line}</Text>}</For>
        <Text class={image?"absolute text-[9px] leading-[9.9] text-[#b6b6b6cc]":"absolute text-[9px] leading-[9.9] text-[#b6b6b6b3]"} style={{insetL:padding,insetR:padding,insetT:top+2+title.length*18}}>{summary.join("\n")}</Text>
      </SwipeCard>};
    }),
    ...(!props.items.length?[{height:48,render:()=> <Text class="text-sm text-center text-[#b6b6b6]">暂无内容</Text>}]:[]),
    ...(props.items.length?[{height:52,render:()=> {
      const label=props.loadingMore?"加载中...":props.canNext?"加载更多":"没有更多";
      const enabled=props.canNext&&!props.loadingMore;
      // Native FeedPillButton: 17sp text, 9dp horizontal padding, 44dp height, surfaceVariant, 0.5 alpha when disabled.
      const buttonWidth=Math.min(props.width-44,getOps().measureText(label,22)+18);
      return <View class="absolute inset-0">
        <View onPress={enabled?props.onNext:undefined} focusable={enabled} class="absolute top-[4] h-[44] rounded-[47] bg-[#23272a] items-center justify-center" style={{insetL:(props.width-36-buttonWidth)/2,width:buttonWidth,opacity:enabled?1:.5}}>
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
