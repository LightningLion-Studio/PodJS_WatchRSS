import {NovelReadingMenu} from "./NovelReadingMenu.tsx";
import {openNovelChapterAfterSave,isNovelChapter,novelBookSource,novelNavigation,type NovelChapter} from "../reader/novel.ts";
import {traceServiceWork} from "@podjs/framework/service-trace";
import {restoredSignal,booleanState} from './route-activity.tsx';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('ReaderScreen');
import { openBrowserUrl } from "../browser/open.ts";
import { OriginalWebConfirm } from "./OriginalWebConfirm.tsx";
import { createGesture } from "@pocketjs/framework/gesture";
import {managedCache} from "../cache/host.ts";
import {prefetchInlineImages} from "../cache/prefetch.ts";
import {useReaderTitle} from "./reader-title.ts";
import {useReaderFonts} from "./reader-fonts.ts";
import {SystemTextLine} from "@podjs/framework/text";
import {systemTextOptions,requiresReaderSystemText} from "../reader/system-text.ts";
import type {SpeechHighlight} from "../reader/speech-highlight.ts";
import {titleHighlightRects,highlightCenter} from "../reader/speech-highlight-layout.ts";
import { readerChrome } from "../reader/chrome.ts";
import type { ReaderPreset } from "../reader/preset.ts";
import { requestReaderLayout } from "../reader/platform-layout.ts";
import {getDisplayMetrics,getFontMetrics,hasCapability} from "@podjs/framework/watch";
import type {NativeBlockLayouts,ReaderRow} from "../reader/content-layout.ts";
import { createContentLayouter, presetContentFont, readerColor } from "../reader/content-layout.ts";
import {onFrame} from "@pocketjs/framework/lifecycle";
import {hostOperation,textLayout} from "@podjs/framework/services";
import {measuredLines} from "../reader/measured-text.ts";
import {summaryDisplayText,summaryTokenUsageText,type SummaryState} from "../llm/summary.ts";
import {createMemo,createSignal,createEffect,onCleanup,Show} from "solid-js";
import {Image,Text,View,type NodeMirror} from "@pocketjs/framework/components";
import {getOps} from "@pocketjs/framework/host";
import {ReaderBody,type ReaderBodyHandle} from "./ReaderBody.tsx";
import {ArticleSource} from "./ArticleSource.tsx";
import type {ScrollEntry} from "./ScrollEntries.tsx";
import type {Article,AppServices} from "./service.ts";
import type {ContentBlock} from "../reader/content.ts";
import {contentFont} from "../reader/content-layout.ts";
import {isImportedContentUrl} from "../core/imported-content.ts";
import type {SpeechAnchor} from "../reader/speech-segments.ts";

function ReaderScreenImpl(props:{
 pageMode?:boolean;onPageMode?:(value:boolean)=>void;touchOrigin?:{left:number;top:number};onOpenChapter?:(article:Article)=>Promise<void>;onBackHandler?:(handler:(()=>boolean)|undefined)=>void;
 highlight?:SpeechHighlight;mediaCacheMode?:string;
 preset:ReaderPreset;article:Article;services:AppServices;width:number;height:number;fontSize:number;lineHeight:number;
 llmEnabled:boolean;llmAutoSummarize:boolean;llmPromptPreset:number;llmShowTokenUsage?:boolean;
 active:boolean;autoStart:boolean;keepAwake?:boolean;speed:number;pageSeconds?:number;favorite:boolean;speaking:boolean;busy:boolean;
 onFavorite:()=>void;onShare:()=>void;onSpeak:(article:Article)=>void;
 onSpeechControls:(article:Article,anchor?:SpeechAnchor)=>void;
 onMedia:(article:Article,block:Exclude<ContentBlock,{type:"text"}>)=>void;
 onControls:(handle:ReaderBodyHandle)=>void;onError:(message:string)=>void;ref:(handle:ReaderBodyHandle)=>void;
}){
 const chromeWidth=()=>props.pageMode&&getDisplayMetrics().shape==='round'?Math.floor((Math.min(props.width,props.height)-16)/Math.SQRT2)+28:props.width;
 const fonts=useReaderFonts();
 const novel=()=>isNovelChapter(props.article.link);
 const pageMode=()=>props.pageMode===true;
 const setPageMode=(value:boolean)=>props.onPageMode?.(value);
 const [novelMenu,setNovelMenu]=restoredSignal('saved','novel-menu-expanded',false,booleanState);
 const [moving,setMoving]=createSignal(false),[chapters,setChapters]=createSignal<NovelChapter[]>([]),[switching,setSwitching]=createSignal(false);
 props.onBackHandler?.(()=>{if(!novelMenu())return false;setNovelMenu(false);return true;});
 onCleanup(()=>props.onBackHandler?.(undefined));
 createEffect(()=>{
  const source=novelBookSource(props.article.link);let cancelled=false;setChapters([]);
  if(novel()&&source&&props.services.listNovelChapters)void props.services.listNovelChapters(source).then(value=>{if(!cancelled)setChapters(value);}).catch(error=>{if(!cancelled)props.onError(String(error));});
  onCleanup(()=>{cancelled=true;});
 });
 const navigation=()=>novelNavigation(chapters(),props.article.id);
 const openChapter=async(chapter:NovelChapter|undefined)=>{
  const reader=handle();if(!chapter||!reader||reader.ready?.()===false||switching()||!props.onOpenChapter)return;
  setSwitching(true);
  try{await openNovelChapterAfterSave(reader,chapter,value=>props.onOpenChapter!(value),()=>props.active);}catch(error){props.onError(String(error));}finally{setSwitching(false);}
 };

 const [webWarning,setWebWarning]=createSignal(false);
 const chrome=()=>readerChrome(props.preset);
 const [handle,setHandle]=createSignal<ReaderBodyHandle>();
 const [summary,setSummary]=createSignal<SummaryState>({status:"idle",text:""});
 const [offlineMedia,setOfflineMedia]=createSignal<Record<string,string>>(props.article.offlineMedia??{});
 const [offlineFailures,setOfflineFailures]=createSignal(props.article.offlineMediaFailures??0);
 const [retryingOffline,setRetryingOffline]=createSignal(false);
 const retryOffline=async()=>{
  if(retryingOffline()||!props.services.retryOfflineMedia)return;
  setRetryingOffline(true);
  try{const result=await props.services.retryOfflineMedia(props.article.id);setOfflineMedia(result.available);setOfflineFailures(result.failed);}
  catch(error){props.onError(String(error));}
  finally{setRetryingOffline(false);}
 };
 const [expanded,setExpanded]=restoredSignal('saved','reader-summary-expanded',false,booleanState),[rotation,setRotation]=createSignal(0);
 const loading=()=>summary().status==="waiting"||summary().status==="generating";
 const session=props.services.createSummary(props.article.id,()=>props.llmPromptPreset,state=>{setSummary(state);if(state.status==="error"&&state.error)void hostOperation("ui.toast",{message:state.error}).result.catch(()=>props.onError(state.error!));});
 let disposed=false,autoRequested=false;
 createEffect(()=>{if(novel()||!props.llmEnabled||!props.llmAutoSummarize||autoRequested)return;void props.services.hasSummaryAccount().then(ready=>{if(!disposed&&ready&&props.llmEnabled&&props.llmAutoSummarize&&!autoRequested){autoRequested=true;setExpanded(true);void session.start();}}).catch(props.onError);});
 onCleanup(()=>{disposed=true;session.dispose();});
 onFrame(()=>{if(loading()&&props.active)setRotation((Date.now()%1200)/1200*360);});
 const toggleSummary=()=>{setExpanded(value=>!value);if(expanded()&&(summary().status==="idle"||summary().status==="error"))void session.start();};
 const summaryText=()=>summaryDisplayText(summary());
 const summaryLines=createMemo(()=>measuredLines(summaryText(),chromeWidth()-36,text=>getOps().measureText(text,1)));
 const tokenUsageLines=createMemo(()=>{const text=summaryTokenUsageText(summary(),props.llmShowTokenUsage??false);return text?measuredLines(text,chromeWidth()-60,value=>getOps().measureText(value,0)):[];});
 const summaryIcon=(size:number)=>loading()?<Image src={chrome().dark?"../assets/icons/ai-loading.svg":"../assets/icons/ai-loading-light.svg"} style={{width:size,height:size,rotate:rotation()}}/>:<Image src={chrome().dark?"../assets/icons/ai-summary.svg":"../assets/icons/ai-summary-light.svg"} style={{width:size,height:size}}/>;
 const spacer=(height:number):ScrollEntry=>({height,render:()=>null});
 const titleFont=()=>presetContentFont(props.preset,"title");
 const bodyFont=()=>presetContentFont(props.preset,"body");
 const imported=()=>isImportedContentUrl(props.article.link);
 return <ArticleSource article={props.article} services={props.services}>{(article,source)=>{
  let originalButton:NodeMirror|undefined;
  let originalGesture:ReturnType<typeof createGesture>|undefined;
  const bindOriginalButton=(node:NodeMirror)=>{
   originalButton=node;
   originalGesture?.dispose();
   // Register after the enclosing ScrollEntries so this button owns its long press.
   originalGesture=createGesture({region:{node:()=>props.active&&!webWarning()?originalButton:undefined},onTap:()=>source.toggle(),onLongPress:()=>{handle()?.pause();setWebWarning(true);}});
  };
  onCleanup(()=>originalGesture?.dispose());
  createEffect(()=>{
   if(!props.active||article().importedText)return;
   const task=prefetchInlineImages(managedCache,article().contentBlocks??[],article().link,props.mediaCacheMode??'前 4 项');
   onCleanup(()=>task.cancel());
  });
  const title=useReaderTitle(()=>props.article.title,()=>chromeWidth()-28,()=>props.preset,fonts);
  const titleBlock=createMemo<ContentBlock>(()=>({type:"text",text:title().join("\n"),style:"title"}));
  const [nativeTitle,setNativeTitle]=createSignal<NativeBlockLayouts>(new Map());
  const layOutTitle=createContentLayouter((text,slot)=>getOps().measureText(text,slot),undefined,getFontMetrics);
  createEffect(()=>{
    const block=titleBlock(),width=Math.min(chromeWidth()-28,190),size=props.fontSize,preset=props.preset;
    setNativeTitle(new Map());
    if(!hasCapability("text.layout"))return;
    const metrics=getDisplayMetrics();
    const task=requestReaderLayout([block],width,size,metrics.physicalWidth/metrics.logicalWidth,preset,args=>textLayout.layout(args),setNativeTitle,error=>logConsole.warn("Reader title layout",String(error)),fonts());
    onCleanup(()=>task.cancel());
  });
  const titleLayout=createMemo(()=>layOutTitle([titleBlock()],chromeWidth()-28,props.fontSize,{},props.preset,nativeTitle()));
  const [titleCarets,setTitleCarets]=createSignal<ReadonlyMap<ReaderRow,readonly number[]>>(new Map());
  const titleRows=()=>titleLayout().rows.filter(row=>row.kind==="text");
  const speechArticle=()=>({...article(),useOriginalContent:source.enabled()});
  const activeHighlight=()=>props.highlight?.articleId===props.article.id&&(imported()||props.highlight.useOriginalContent===source.enabled())?props.highlight:undefined;
  const titleRects=createMemo(()=>titleHighlightRects(props.article.title,titleRows().map(row=>row.text),activeHighlight(),chromeWidth()-28,titleFont(),(text,slot)=>getOps().measureText(text,slot),titleRows(),titleRows().map(row=>titleCarets().get(row))));
  const highlightColor=()=>readerColor(props.preset.accentColorArgb).slice(0,7)+(chrome().dark?"57":"38");
  const actionLineHeight=()=>props.fontSize*17/14;
  const actionsHeight=()=>Math.max(38,actionLineHeight()+12);
  const pill=(label:()=>string,right:boolean,press:()=>void)=> <View ref={node=>{if(!right)bindOriginalButton(node);}} onPress={press} focusable class="absolute rounded-[20] items-center justify-center" style={{...(right?{insetR:0}:{insetL:0}),bgColor:right?chrome().activeAction:chrome().action,borderWidth:chrome().dark?0:1,borderColor:right?chrome().activeBorder:chrome().border,insetT:(actionsHeight()-(actionLineHeight()+12))/2,width:Math.min((chromeWidth()-28-38)/2,getOps().measureText(label(),bodyFont().fontSlot)*bodyFont().scale+18),height:actionLineHeight()+12}}><Text style={{fontSlot:bodyFont().fontSlot,scale:bodyFont().scale,lineHeight:actionLineHeight()/bodyFont().scale,textColor:right?readerColor(props.preset.accentColorArgb):readerColor(props.preset.body.colorArgb)}}>{label()}</Text></View>;
  const titleHeader=createMemo<ScrollEntry[]>(()=>{
    const entry:ScrollEntry={height:titleLayout().height,render:()=> <View onPress={()=>handle()?.tap()} class="absolute inset-0">{titleRects().map(rect=><View debugName="SpeechTitleHighlight" class="absolute" style={{insetL:rect.left,insetT:rect.top,width:rect.width,height:rect.height,bgColor:highlightColor()}}/>)}{titleRows().map(row=><View class="absolute left-[0] right-[0]" style={{insetT:row.top,height:row.lineHeight}}>{requiresReaderSystemText(row.text,props.preset,"title")&&hasCapability("text.raster")?<SystemTextLine pixelScale={getDisplayMetrics().physicalWidth/getDisplayMetrics().logicalWidth} options={systemTextOptions({...row,textAlign:1},"title",props.fontSize,chromeWidth()-28,getDisplayMetrics().physicalWidth/getDisplayMetrics().logicalWidth,props.preset,getFontMetrics(row.fontSlot),fonts())} onCarets={positions=>setTitleCarets(previous=>{const next=new Map(previous);if(positions)next.set(row,positions);else next.delete(row);return next;})} fallback={<Text class="absolute text-center text-lg font-bold" style={{insetL:0,insetT:row.textOffsetY??0,width:(chromeWidth()-28)/row.scale,fontSlot:row.fontSlot,scale:row.scale,originX:-.5,originY:-.5,lineHeight:row.lineHeight/row.scale,textColor:row.color}}>{row.text}</Text>}/>:<Text class="absolute text-center text-lg font-bold" style={{insetL:0,insetT:row.textOffsetY??0,width:(chromeWidth()-28)/row.scale,fontSlot:row.fontSlot,scale:row.scale,originX:-.5,originY:-.5,lineHeight:row.lineHeight/row.scale,textColor:row.color}}>{row.text}</Text>}</View>)}</View>};
    return props.pageMode?titleRows().map(row=>({height:row.height,render:()=> <View class="absolute inset-0 overflow-hidden"><View class="absolute left-[0] right-[0]" style={{insetT:-row.top,height:entry.height}}>{entry.render()}</View></View>})):[entry];
  });
  const header=createMemo<ScrollEntry[]>(()=>[
   spacer(22),
   ...titleHeader(),
   ...(!novel()&&(!imported()||props.llmEnabled)?[spacer(6),{height:actionsHeight(),render:()=> <View class="absolute inset-0">{!imported()&&source.canRead()?pill(()=>source.enabled()?"阅读RSS":"阅读原文",false,source.toggle):null}{props.llmEnabled?<View onPress={toggleSummary} focusable class="absolute top-[0] w-[38] h-[38] rounded-[19] items-center justify-center" style={{insetL:(chromeWidth()-28-38)/2,insetT:(actionsHeight()-38)/2,bgColor:expanded()?chrome().summaryAction:chrome().action,borderWidth:chrome().dark?0:1,borderColor:chrome().border}}>{summaryIcon(loading()?18:26)}</View>:null}{!imported()?pill(()=>"大声朗读",true,()=>{handle()?.pause();props.onSpeak(speechArticle());}):null}</View>}]:[]),
   ...(!novel()&&props.llmEnabled&&expanded()?[spacer(6),{height:20+summaryLines().length*17,render:()=> <View onPress={()=>{if(summary().status==="error")void session.start();}} focusable={summary().status==="error"} class="absolute inset-0"><View class="absolute left-[4] top-[0] h-[14] w-[14] items-center justify-center">{summaryIcon(14)}</View><Text class="absolute left-[24] top-[0] text-xs leading-[14]" style={{textColor:chrome().active}}>AI 总结</Text><Text class="absolute left-[4] right-[4] top-[20] text-sm leading-[17]" style={{textColor:summary().status==="error"?"#ff8a80":`${chrome().content.slice(0,7)}eb`}}>{summaryLines().join("\n")}</Text></View>},...(tokenUsageLines().length?[spacer(6),{height:36+tokenUsageLines().length*14,render:()=> <View class="absolute inset-0 rounded-[10]" style={{bgColor:chrome().action}}><Text class="absolute left-[12] right-[12] top-[8] text-xs leading-[14]" style={{textColor:`${chrome().content.slice(0,7)}b8`}}>Token 用量</Text><Text class="absolute left-[12] right-[12] top-[26] text-xs leading-[14]" style={{textColor:`${chrome().content.slice(0,7)}b8`}}>{tokenUsageLines().join("\n")}</Text></View>}]:[])]:[]),
   ...(source.notice()?[{height:40,render:()=> <Text class="absolute inset-0 text-xs leading-[16] text-[#aaa]">{source.notice()}</Text>}]:[]),
   ...(offlineFailures()||retryingOffline()?[{height:34,render:()=> <View onPress={()=>void retryOffline()} focusable={!retryingOffline()} class="absolute inset-0 items-center justify-center"><Text class="text-xs text-[#ffb88c]">{retryingOffline()?"重试中...":"离线媒体下载失败，点此重试"}</Text></View>}]:[]),spacer(6)
  ]);
  const footer=createMemo<ScrollEntry[]>(()=>[
   ...(novel()&&navigation()?[spacer(8),{height:42,render:()=> <View class="absolute inset-0">{[{chapter:navigation()?.previous,label:navigation()?.previous?'上一章':'已是首章'},{chapter:navigation()?.next,label:navigation()?.next?'下一章':'已是末章'}].map((item,index)=><View focusable={!!item.chapter&&!switching()} accessibilityRole="button" accessibilityLabel={item.label} onPress={()=>void openChapter(item.chapter)} class="absolute top-[0] h-[40] rounded-[20] items-center justify-center" style={{insetL:index*(chromeWidth()-28)/2,width:(chromeWidth()-28)/2-3,bgColor:chrome().action,opacity:item.chapter&&!switching()?1:.45}}><Text class="text-sm" style={{textColor:chrome().content}}>{item.label}</Text></View>)}</View>}]:[]),
   spacer(15),{height:32,render:()=> <View class="absolute top-[0] h-[32]" style={{insetL:(chromeWidth()-28-120)/2,width:120}}>
    <View onPress={()=>{if(!props.busy)props.onFavorite();}} focusable class="absolute left-[0] top-[0] w-[32] h-[32] rounded-[16] items-center justify-center" style={{bgColor:props.favorite?chrome().activeAction:chrome().action,borderWidth:chrome().dark?0:1,borderColor:props.favorite?chrome().activeBorder:chrome().border}}><Image src={props.favorite?(chrome().dark?"../assets/icons/star-active.svg":"../assets/icons/star-active-light.svg"):(chrome().dark?"../assets/icons/star.svg":"../assets/icons/star-light.svg")} class="w-[20] h-[20]"/></View>
    <View onPress={()=>{handle()?.pause();props.onShare();}} focusable class="absolute left-[44] top-[0] w-[32] h-[32] rounded-[16] items-center justify-center" style={{bgColor:chrome().action,borderWidth:chrome().dark?0:1,borderColor:chrome().border}}><Image src={chrome().dark?"../assets/icons/share.svg":"../assets/icons/share-light.svg"} class="w-[20] h-[20]"/></View>
    <View onPress={()=>{const value=handle();if(value)value.setPlaying(!value.playing());}} focusable class="absolute left-[88] top-[0] w-[32] h-[32] rounded-[16] items-center justify-center" style={{bgColor:chrome().action,borderWidth:chrome().dark?0:1,borderColor:chrome().border}}><Image src={handle()?.playing()?(chrome().dark?"../assets/icons/reader-pause.svg":"../assets/icons/reader-pause-light.svg"):(chrome().dark?"../assets/icons/reader-play.svg":"../assets/icons/reader-play-light.svg")} class="w-[20] h-[20]"/></View>
   </View>},spacer(15)
  ]);
  return <><ReaderBody pageMode={pageMode()} touchOrigin={props.touchOrigin} onMoving={setMoving} progressStore={props.services.readingProgress} imported={article().importedText&&props.services.loadImportedTextChunk?{handle:article().importedText!,read:index=>props.services.loadImportedTextChunk!(article().importedText!,index)}:undefined} highlight={activeHighlight()} speechPlaying={props.speaking} speechTitleCenter={titleRects().length?22+highlightCenter(titleRects())!:undefined} highlightColor={highlightColor()} onSpeechControls={anchor=>props.onSpeechControls(speechArticle(),anchor)} preset={props.preset} articleId={props.article.id} text={article().content} blocks={article().contentBlocks??[{type:"text",text:article().content,style:"body"}]} offlineMedia={offlineMedia()} baseUrl={article().link} width={props.width} height={props.height} top={0} fontSize={props.fontSize} lineHeight={props.lineHeight} active={props.active&&!webWarning()&&!novelMenu()} autoStart={props.autoStart} keepAwake={props.keepAwake} speed={props.speed} pageSeconds={props.pageSeconds} header={header()} footer={footer()} onMedia={block=>props.onMedia({...article(),offlineMedia:offlineMedia()},block)} onControls={props.onControls} onError={props.onError} ref={value=>{setHandle(value);props.ref(value);}}/><Show when={novel()}><NovelReadingMenu width={props.width} height={props.height} active={props.active} expanded={novelMenu()} moving={moving()} pageMode={pageMode()} preset={props.preset} onExpanded={value=>{handle()?.pause();setNovelMenu(value);}} onMode={value=>{setPageMode(value);if(value)void hostOperation("ui.toast",{message:"轻点左侧上一页，轻点右侧下一页"}).result.catch(()=>{});}} onSpeak={()=>props.onSpeechControls(speechArticle())}/></Show><Show when={webWarning()}><OriginalWebConfirm width={props.width} height={props.height} onCancel={()=>setWebWarning(false)} onConfirm={()=>{setWebWarning(false);void openBrowserUrl(props.article.link??"","article",props.preset).catch(error=>props.onError(String(error)));}}/></Show></>;
 }}</ArticleSource>;
}

export function ReaderScreen(props:Parameters<typeof ReaderScreenImpl>[0]) {return traceServiceWork("reader.ReaderScreen",()=>ReaderScreenImpl(props));}
