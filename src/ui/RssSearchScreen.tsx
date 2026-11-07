import {createEffect,createMemo,createSignal,onCleanup} from "solid-js";
import {Image,Text,View} from "@pocketjs/framework/components";
import {getOps} from "@pocketjs/framework/host";
import {measuredLines} from "../reader/measured-text.ts";
import {searchHighlightLines} from "../rss/search-snippet.ts";
import {ScrollEntries,type ScrollEntry} from "./ScrollEntries.tsx";
import type {Article} from "./service.ts";

const SAFE=18,GAP=6,CARD_PADDING=9,TITLE_LINE=17,SUMMARY_LINE=10;
const TITLE_SLOT=1,SUMMARY_SLOT=19,INPUT_SLOT=22;

function HighlightedLine(props:{text:string;segments:{text:string;x:number;width:number}[];slot:number;top:number;color:string;lineHeight:number}){
  return <View class="absolute left-[0] right-[0]" style={{insetT:props.top,height:props.lineHeight}}>
    <Text style={{fontSlot:props.slot,lineHeight:props.lineHeight,textColor:props.color}}>{props.text}</Text>
    {props.segments.map(segment=><View class="absolute top-[0]" style={{insetL:segment.x,width:segment.width,height:props.lineHeight,bgColor:"#ff6026"}}><Text style={{fontSlot:props.slot,lineHeight:props.lineHeight,textColor:"#000000"}}>{segment.text}</Text></View>)}
  </View>;
}

export function RssSearchScreen(props:{width:number;height:number;active:boolean;keyword:string;results:Article[];loading:boolean;onInput:()=>void;onKeywordChange:(value:string)=>void;openInlineInput?:(value:string,bounds:{x:number;y:number;width:number;height:number},onChange:(value:string)=>void,onSubmit:()=>void)=>Promise<{close():Promise<void>}>;onOpen:(article:Article)=>void;ref?:(handle:{scroller:import("@pocketjs/framework/kinetics").Scroller})=>void}){
  const [editing,setEditing]=createSignal(false);
  let scroller:import("@pocketjs/framework/kinetics").Scroller|undefined;
  let session:{close():Promise<void>}|undefined,version=0,disposed=false;
  const closeInput=()=>{
    version++;setEditing(false);
    const current=session;session=undefined;
    if(current)void current.close().catch(()=>{});
  };
  const startInput=async()=>{
    if(editing())return;
    if(!props.openInlineInput){props.onInput();return;}
    scroller?.scrollTo(0,{immediate:true});
    setEditing(true);
    const current=++version;
    try{
      const opened=await props.openInlineInput(props.keyword,{x:SAFE,y:SAFE+20+GAP,width:props.width-2*SAFE,height:56},
        value=>{if(!disposed&&current===version)props.onKeywordChange(value);},
        ()=>{if(!disposed&&current===version)closeInput();});
      if(disposed||current!==version){void opened.close().catch(()=>{});return;}
      session=opened;
    }catch{
      if(disposed||current!==version)return;
      setEditing(false);props.onInput();
    }
  };
  createEffect(()=>{if(!props.active&&editing())closeInput();});
  onCleanup(()=>{disposed=true;closeInput();});
  const contentWidth=()=>Math.max(1,props.width-2*SAFE-2*CARD_PADDING);
  const titleLines=(value:string)=>measuredLines(value,contentWidth(),text=>getOps().measureText(text,TITLE_SLOT),2);
  const summaryLines=(value:string)=>measuredLines(value||"暂无摘要",contentWidth(),text=>getOps().measureText(text,SUMMARY_SLOT),2);
  const card=(item:Article):ScrollEntry=>{
    const summaryText=item.searchSnippet||"暂无摘要";
    const title=titleLines(item.title),summary=summaryLines(summaryText);
    const titleHighlights=searchHighlightLines(item.title,title,props.keyword,text=>getOps().measureText(text,TITLE_SLOT));
    const summaryHighlights=searchHighlightLines(summaryText,summary,props.keyword,text=>getOps().measureText(text,SUMMARY_SLOT));
    const summaryTop=CARD_PADDING+title.length*TITLE_LINE+2;
    return {height:summaryTop+summary.length*SUMMARY_LINE+CARD_PADDING+1,render:()=>
      <View onPress={()=>{closeInput();props.onOpen(item);}} focusable accessibilityRole="button" accessibilityLabel={`文章：${item.title}，${item.searchSnippet||"暂无摘要"}`} class="absolute inset-0 rounded-[16] bg-[#1c1f21]">
        <View class="absolute left-[9] right-[9]" style={{insetT:CARD_PADDING,height:summaryTop+summary.length*SUMMARY_LINE}}>
          {title.map((line,index)=><HighlightedLine text={line} segments={titleHighlights[index]} slot={TITLE_SLOT} top={index*TITLE_LINE} color="#f5f5f5" lineHeight={TITLE_LINE}/>)}
          {summary.map((line,index)=><HighlightedLine text={line} segments={summaryHighlights[index]} slot={SUMMARY_SLOT} top={summaryTop-CARD_PADDING+index*SUMMARY_LINE} color="#b6b6b6" lineHeight={SUMMARY_LINE}/>)}
        </View>
      </View>};
  };
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:20,render:()=> <View class="absolute inset-0"><Text accessibilityRole="header" class="absolute left-[0] right-[0] top-[1] text-[17px] leading-[20] text-center text-[#f5f5f5]">搜索</Text></View>},
    {height:56,render:()=> <View onPress={()=>void startInput()} focusable={!editing()} accessibilityRole="button" accessibilityLabel={props.keyword?`搜索关键词：${props.keyword}`:"输入关键词开始搜索"} class="absolute inset-0 rounded-[30] active:scale-96" style={{borderWidth:1,borderColor:"#747474"}}><Text class="absolute left-[16] right-[40] top-[18] text-[17px] leading-[21] text-[#f5f5f5]">{editing()?"":measuredLines(props.keyword||"搜索",Math.max(1,contentWidth()-40),text=>getOps().measureText(text,INPUT_SLOT),1).join("")}</Text><Image src="../assets/icons/search.svg" class="absolute right-[14] top-[16] w-[24] h-[24]"/></View>},
    ...(props.loading?[{height:48,render:()=> <Text class="absolute inset-0 text-[13px] text-center text-[#b6b6b6]">搜索中…</Text>}]:props.keyword.trim().length===0?[{height:48,render:()=> <Text class="absolute inset-0 text-[13px] text-center text-[#b6b6b6]">输入关键词开始搜索</Text>}]:props.results.length===0?[{height:48,render:()=> <Text class="absolute inset-0 text-[13px] text-center text-[#b6b6b6]">没有找到相关结果</Text>}]:props.results.map(card)),
    {height:32,render:()=> <View/>}
  ]);
  return <ScrollEntries height={props.height} entries={entries()} gap={GAP} padding={SAFE} fixed={editing()} onManualScroll={closeInput} inputActive={()=>props.active} accessibilityLabel="频道文章搜索结果" ref={handle=>{scroller=handle.scroller;props.ref?.(handle);}}/>;
}
