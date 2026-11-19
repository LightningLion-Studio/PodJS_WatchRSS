import {DeleteConfirmDialog} from "./DeleteConfirmDialog.tsx";
import {isDeletableLocalContentChannel} from "../core/imported-content.ts";
import {shareActionEnabled} from "../sharing/policy.ts";
import { getOps } from "@pocketjs/framework/host";
import { RemoteImage } from "./RemoteImage.tsx";
import { measuredLines, watchTitleLines } from "../reader/measured-text.ts";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry, type IndexedScrollEntries } from "./ScrollEntries.tsx";
import { SwipeCard } from "./SwipeCard.tsx";
import {createFeedCardLayouts, type FeedCardGeometry} from "./feed-card-layout.ts";
import {createFontGeometryRevision} from "@podjs/framework/font-geometry";
import {onMemoryTrim} from "@podjs/framework/memory";
import type { Article } from "./service.ts";

const measureFor=(size:number)=>(text:string)=>getOps().measureText(text,size===21?23:size===14?1:size===9?19:size===12?0:20);
/** Native EmptyStateCard: 14dp surface card, titleLarge 21/26 + bodySmall 12/14 subtitle. */
export function feedEmptyStateEntry(title:string,subtitle:string,width:number):ScrollEntry {
  const wrapped=measuredLines(subtitle,width-36-24,measureFor(12));
  return {height:10+26+4+wrapped.length*14+10,render:()=> <View class="absolute inset-0 rounded-[14] bg-[#1c1f21]">
    <Text class="absolute left-[12] right-[12] top-[10] text-[21px] leading-[26] text-[#f5f5f5]">{title}</Text>
    <Text class="absolute left-[12] right-[12] top-[40] text-xs leading-[14] text-[#b6b6b6]">{wrapped.join("\n")}</Text>
  </View>};
}
/** Native FeedPillButton: 17sp, 9dp horizontal padding, 44dp tall surfaceVariant pill; 0.5 alpha disabled. */
export function feedPillEntry(label:string,width:number,onPress?:()=>void,prominent=false):ScrollEntry {
  return {height:52,render:()=>{
    const buttonWidth=Math.min(width-44,getOps().measureText(label,22)+18);
    return <View class="absolute inset-0"><View onPress={onPress} focusable={!!onPress} accessibilityRole="button" accessibilityLabel={label} class={prominent?"absolute top-[4] h-[44] rounded-[47] bg-[#fe2c55] items-center justify-center active:scale-96":"absolute top-[4] h-[44] rounded-[47] bg-[#23272a] items-center justify-center active:scale-96"} style={{insetL:(width-36-buttonWidth)/2,width:buttonWidth,opacity:onPress?1:.5}}>
      <Text class={prominent?"text-[17px] leading-[21] font-bold text-white":"text-[17px] leading-[21] text-[#f5f5f5]"}>{label}</Text>
    </View></View>;
  }};
}
export function RssFeedScreen(props:{width:number;height:number;title:string;active?:boolean;originalEnabled?:boolean;onOriginalPaused?:(paused:boolean)=>void;onOriginalContents?:(ids:string[])=>void;onInfo?:()=>void;items:Article[];refreshing:boolean;loadingMore:boolean;canNext:boolean;onOpen:(article:Article)=>void;onActions:(article:Article)=>void;onFavorite:(article:Article)=>void;onWatchLater:(article:Article)=>void;onRefresh:()=>void;onNext:()=>void;leading?:ScrollEntry[];empty?:ScrollEntry[];ref?:(value:{scroller:Scroller})=>void}) {
  const requested=new Set<string>();
  const [openSwipeId,setOpenSwipeId]=createSignal<string|null>(null);
  const [scrolling,setScrolling]=createSignal(false);
  createEffect(()=>{const id=openSwipeId();if(id&&!props.items.some(item=>item.id===id))setOpenSwipeId(null);});
  let lastAutoLoadCount=-1;
  function requestVisible(first:number,last:number) {
    if(!props.originalEnabled||!props.onOriginalContents)return;
    const start=entries().length;
    const ids=props.items.slice(Math.max(0,first-start),Math.max(0,last+1-start)).filter(a=>!requested.has(a.id)).map(a=>a.id);
    if(!ids.length)return;ids.forEach(id=>requested.add(id));props.onOriginalContents(ids);
  }
  // Native FeedHeader formats "$title ⓘ" when the title opens channel info.
  // Native hint: bold #BDBDBD "ⓘ" at 19sp: 16dp circle, ~2.5dp after the text (measured on OWW242).
  const INFO_ADVANCE=18.5,INFO_BOX=19.2;
  // watchTitleLines drops spaces in CJK titles, so the hint is measured as its own unit ("ⓘ" = space + icon).
  const titleMeasure=(text:string)=>text.endsWith("ⓘ")?measureFor(21)(text.slice(0,-1).trimEnd())+INFO_ADVANCE:measureFor(21)(text);
  const fontRevision=createFontGeometryRevision([1,19,23]);
  const header=createMemo(()=>{fontRevision();return watchTitleLines(props.onInfo?`${props.title}ⓘ`:props.title,props.width-36,titleMeasure,150,190,props.onInfo?"ⓘ":undefined,2);});
  const headerText=(line:string)=>line.endsWith("ⓘ")?line.slice(0,-1).trimEnd():line;
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:18+header().length*27+16,render:()=> <View onPress={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onInfo?.();}} focusable={!!props.onInfo} class="absolute inset-0 items-center"><For each={header()}>{(line,index)=>{const text=headerText(line),icon=line.endsWith("ⓘ"),width=()=>measureFor(21)(text)+(icon?INFO_ADVANCE:0),left=()=>(props.width-36-width())/2;
        return icon?<><Text class="absolute top-[0] text-[21px] leading-[27] text-[#f5f5f5]" style={{insetL:left(),insetT:9.5+index()*27}}>{text}</Text><Image src="../assets/icons/info-hint.svg" class="absolute w-[18.6] h-[18.6]" style={{insetL:left()+measureFor(21)(text)-0.6,insetT:9.5+index()*27+4.65}}/></>
          :<Text class="absolute left-[0] right-[0] text-[21px] leading-[27] text-center text-[#f5f5f5]" style={{insetT:9.5+index()*27}}>{text}</Text>;}}</For><Text class="absolute left-[0] right-[0] text-[9px] leading-[12] text-center text-[#b6b6b6]" style={{insetT:11+header().length*27}}>{props.refreshing?"正在刷新中...":"下拉刷新"}</Text></View>},
    ...(props.leading??[]),
  ]);
  type ArticleRowData = {article: Article; geometry: FeedCardGeometry; imageUrl: Article["imageUrl"]};
  const articleGeometry=createFeedCardLayouts(measureFor);
  const articleGap=8;
  const articleScope={};
  onCleanup(onMemoryTrim(4,level=>{if(level>0)articleGeometry.clear();}));
  const articles=createMemo<IndexedScrollEntries>(previous=>{
    const width=props.width-36, font=fontRevision();
    const unreadIndent=articleGeometry.unreadIndent();
    const indices=new Map<string,number>();
    let top=0;
    const rows=props.items.map((article,index)=>{
      const geometry=articleGeometry.get(article,width,font,unreadIndent);
      const previousRow=previous?.entries[index];
      const previousData=previousRow?.data as ArticleRowData|undefined;
      const sameData=previousData?.article===article && previousData.geometry===geometry && previousData.imageUrl===article.imageUrl;
      const row=sameData && previousRow?.top===top ? previousRow : {
        key:article.id, data:sameData ? previousData : {article,geometry,imageUrl:article.imageUrl},
        top, height:geometry.height, render:renderArticle,
      };
      indices.set(article.id,index);
      top+=geometry.height+articleGap;
      return row;
    });
    articleGeometry.retain(indices);
    return {entries:rows,indices,scope:articleScope,trailingGap:articleGap};
  });
  function renderArticle(current?:()=>ScrollEntry){
    const data=()=>current!().data as ArticleRowData;
    const article=()=>data().article, geometry=()=>data().geometry, id=()=>article().id;
    const image=()=>data().imageUrl;
    return <SwipeCard onOpen={()=>{if(openSwipeId())setOpenSwipeId(null);else props.onOpen(article());}} onActions={()=>props.onActions(article())} onFavorite={()=>{setOpenSwipeId(null);props.onFavorite(article());}} onWatchLater={()=>{setOpenSwipeId(null);props.onWatchLater(article());}} open={openSwipeId()===id()} swipeEnabled={(props.active??true)&&!scrolling()} onStartSwipe={()=>{if(openSwipeId()!==id())setOpenSwipeId(null);}} onOpenSwipe={()=>setOpenSwipeId(id())} onCloseSwipe={()=>{if(openSwipeId()===id())setOpenSwipeId(null);}}>
      <Show when={image()}>{url=><RemoteImage url={url()} width={props.width-36} height={geometry().height} fit="cover" class="absolute left-[0] top-[0]"/>}</Show>
      <Show when={image()}><View class="absolute inset-0 bg-gradient-to-b from-transparent to-[#0b1211b3]"/></Show>
      <Show when={!article().read}><View class="absolute w-[7] h-[7] rounded-full bg-[#ff6026]" style={{insetL:geometry().padding,insetT:geometry().top+6}}/></Show>
      <For each={geometry().title}>{(line,index)=><Text class="absolute text-sm leading-[18] text-[#f5f5f5]" style={{insetL:geometry().padding+(index()===0?geometry().firstIndent:0),insetR:geometry().padding,insetT:geometry().top+index()*18}}>{line}</Text>}</For>
      <Text class={image()?"absolute text-[9px] leading-[9.9] text-[#b6b6b6cc]":"absolute text-[9px] leading-[9.9] text-[#b6b6b6b3]"} style={{insetL:geometry().padding,insetR:geometry().padding,insetT:geometry().top+2+geometry().title.length*18}}>{geometry().summary}</Text>
    </SwipeCard>;
  }
  const footer=createMemo<ScrollEntry[]>(()=>[
    ...(!props.items.length?props.empty??[{height:48,render:()=> <Text class="text-sm text-center text-[#b6b6b6]">暂无内容</Text>}]:[]),
    ...(props.items.length?[{height:52,render:()=> {
      const label=props.loadingMore?"加载中...":props.canNext?"加载更多":"没有更多";
      const enabled=props.canNext&&!props.loadingMore;
      // Native FeedPillButton: 17sp text, 9dp horizontal padding, 44dp height, surfaceVariant, 0.5 alpha when disabled.
      const buttonWidth=Math.min(props.width-44,getOps().measureText(label,22)+18);
      return <View class="absolute inset-0">
        <View onPress={enabled?props.onNext:undefined} focusable={enabled} class="absolute top-[4] h-[44] rounded-[47] bg-[#23272a] items-center justify-center active:scale-96" style={{insetL:(props.width-36-buttonWidth)/2,width:buttonWidth,opacity:enabled?1:.5}}>
          <Text class="text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
        </View>
      </View>;
    }}]:[])
  ]);
  return <ScrollEntries height={props.height} entries={entries()} indexedEntries={articles()} footerEntries={footer()} verticalPadding={12} gap={articleGap} inputActive={()=>props.active??true} settleKey={props.originalEnabled} onSettledRange={(first,last)=>{
    requestVisible(first,last);
    if(props.canNext&&!props.loadingMore&&last>=props.items.length+(props.leading?.length??0)&&lastAutoLoadCount!==props.items.length){lastAutoLoadCount=props.items.length;props.onNext();}
  }} onScrollStateChange={value=>{setScrolling(value);if(value)setOpenSwipeId(null);props.onOriginalPaused?.(value);}} onRefresh={props.onRefresh} ref={props.ref}/>;
}
export function RssActionsScreen(props:{width:number;height:number;article:Article;channelUrl?:string;onDelete:()=>void;onMarkUnread:()=>void;systemShare?:boolean;busy:boolean;onSave:(type:"favorite"|"watchLater",saved:boolean)=>void;onShare:()=>void;onBack:()=>void;ref?:(value:{scroller:Scroller;goBack:()=>boolean})=>void}) {
  const [confirm,setConfirm]=createSignal(false);
  const goBack=()=>{if(!confirm())return false;if(props.busy)return true;setConfirm(false);return true;};
  const entries=()=>[
    {label:props.article.saved?"取消收藏":"收藏",act:()=>props.onSave("favorite",!props.article.saved),enabled:!props.busy},
    {label:props.article.watchLater?"取消稍后再看":"稍后再看",act:()=>props.onSave("watchLater",!props.article.watchLater),enabled:!props.busy},
    ...(props.article.read?[{label:"标为未读",act:props.onMarkUnread,enabled:!props.busy}]:[]),
    {label:"分享",act:props.onShare,enabled:!props.busy&&shareActionEnabled(props.article.title,props.article.link,!!props.systemShare)},
    ...(isDeletableLocalContentChannel(props.channelUrl)?[{label:"删除",act:()=>setConfirm(true),enabled:!props.busy}]:[]),
    {label:"取消",act:props.onBack,enabled:!props.busy}
  ].map(item=>({height:48,render:()=> <View onPress={item.enabled?item.act:undefined} focusable={item.enabled} class="absolute top-[0] h-[48] rounded-[47] bg-[#2a2a2a] items-center justify-center active:scale-96" style={{width:Math.min(160,props.width-44),insetL:Math.max(0,(props.width-44-160)/2)}}><Text class={item.enabled?"text-[17px] leading-[23] text-[#f5f5f5]":"text-[17px] leading-[23] text-[#939393]"}>{item.label}</Text></View>}));
  return <><ScrollEntries height={props.height} entries={entries()} padding={22} verticalPadding={22} gap={8} inputActive={()=>!confirm()&&!props.busy} ref={value=>props.ref?.({...value,goBack})}/><Show when={confirm()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除内容" message="删除后会从本机和下次同步中移除此内容" busy={props.busy} onCancel={()=>setConfirm(false)} onConfirm={props.onDelete}/></Show></>;
}
