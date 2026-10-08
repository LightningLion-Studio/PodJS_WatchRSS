import {traceServiceWork} from "@podjs/framework/service-trace";
import {prepareTextLayout} from "@podjs/framework/text";
import {createWindowValue} from "@podjs/framework/windowed-list";
import {readerRowKey} from "../reader/content-layout.ts";
import {updateSystemCarets} from "../reader/system-carets.ts";
import {appLogger} from '../logs/app-logger.ts';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('ReaderBody');
import {ReaderBackground,useReaderBackgrounds} from "./ReaderBackground.tsx";
import {useReaderFonts} from "./reader-fonts.ts";
import type {ReaderRow} from "../reader/content-layout.ts";
import { ImportedReaderDocument, importedByteTarget, importedCharForByte } from "../reader/imported-document.ts";
import type { ImportedTextHandle } from "../reader/imported-text.ts";
import type {SpeechHighlight} from "../reader/speech-highlight.ts";
import {contentHighlightRects,highlightCenter} from "../reader/speech-highlight-layout.ts";
import type { ReaderPreset } from "../reader/preset.ts";
import { readerColor } from "../reader/content-layout.ts";
import { requestReaderLayout, requestReaderLayoutBatched } from "../reader/platform-layout.ts";
import type { NativeBlockLayouts } from "../reader/content-layout.ts";
import { delay, textLayout } from "@podjs/framework/services";
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack, batch } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { ScrollEntries, type ScrollEntry, type PositionedScrollEntry, type IndexedScrollEntries } from "./ScrollEntries.tsx";
import { RemoteImage } from "./RemoteImage.tsx";
import { getOps } from "@pocketjs/framework/host";
import { resolveUrl } from "../core/parser.ts";
import type { ContentBlock } from "../reader/content.ts";
import { createContentLayouter } from "../reader/content-layout.ts";
import { documentAnchorAt, offsetForDocumentAnchor } from "../reader/document-layout.ts";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { kv, onLifecycleCheckpoint, __onHostEvent, getDisplayMetrics, getFontMetrics, hasCapability } from "@podjs/framework/watch";
import { AutoScrollController, ReadingProgressStore } from "../reader/index.ts";
import { pressedSpeechAnchor, type SpeechAnchor } from "../reader/speech-segments.ts";
import {readerReachedBottom} from "../reader/watch-later-completion.ts";
import {LifecycleReadingProgressStore} from "../reader/lifecycle-progress.ts";
import {normalizeReadingProgress} from "../reader/progress.ts";
import {ReadingProgressWriteQueue} from "../reader/progress-write-queue.ts";
import {ReaderTextRow,createReaderTextEnvironment} from "./ReaderTextRow.tsx";


export interface ReaderBodyHandle {
  tap:()=>void;
  scroller:Scroller;
  playing:()=>boolean;
  setPlaying:(value:boolean)=>void;
  pause:()=>void;
  manualScroll:()=>void;
  reachedBottom:()=>boolean;
  flushProgress:()=>Promise<void>;
}
function ReaderBodyImpl(props:{
  progressStore?:Pick<ReadingProgressStore,"load"|"save">;
  imported?:{handle:ImportedTextHandle;read:(index:number)=>Promise<string|null>};
  preset?:ReaderPreset;
  highlight?:SpeechHighlight; speechPlaying?:boolean; speechTitleCenter?:number; highlightColor?:string;
  header?:ScrollEntry[]; footer?:ScrollEntry[];
  articleId:string; top?:number; text:string; blocks:ContentBlock[]; baseUrl?:string; width:number; height:number; lineHeight:number;
  offlineMedia?:Record<string,string>;
  fontSize:number; onMedia:(block:Exclude<ContentBlock,{type:"text"}>)=>void; active:boolean; autoStart:boolean; speed:number;
  onControls:(handle:ReaderBodyHandle)=>void; onError:(message:string)=>void;
  onSpeechControls?:(anchor?:SpeechAnchor)=>void;
  ref:(handle:ReaderBodyHandle)=>void;
}) {
  const textEnvironment=createMemo(()=>{
    // Re-read host facts when the reader configuration changes.
    props.width;props.fontSize;props.preset;
    return createReaderTextEnvironment();
  });
  const fonts=useReaderFonts();const backgrounds=useReaderBackgrounds();
  const [ratios,setRatios]=createSignal<Record<number,number>>({});
  const layoutContent=createContentLayouter((text,slot)=>getOps().measureText(text,slot),(text,slot,width)=>getOps().wrapText?.(text,slot,width),getFontMetrics);
  const [nativeLayouts,setNativeLayouts]=createSignal<NativeBlockLayouts>(new Map());
  const [nativeReady,setNativeReady]=createSignal(false);
  const [importedRevision,setImportedRevision]=createSignal(0);
  const importedTasks=new Set<{cancel():void}>();
  const imported=props.imported?new ImportedReaderDocument(props.imported.handle,props.imported.read,async block=>{
    const width=props.width-28,size=props.fontSize,preset=props.preset;
    let lines:NativeBlockLayouts= new Map();
    if(hasCapability("text.layout")){
      const metrics=getDisplayMetrics();
      const task=requestReaderLayout([block],width,size,metrics.physicalWidth/metrics.logicalWidth,preset,args=>textLayout.layout(args),value=>{lines=value;},error=>logConsole.warn("Imported paragraph layout",String(error)),fonts());
      importedTasks.add(task);try{await task.done;}finally{importedTasks.delete(task);}
    }
    return layoutContent([block],width,size,{},preset,lines);
  },()=>setImportedRevision(value=>value+1)):undefined;
  const blocks=createMemo(()=>{importedRevision();return imported?.blocks()??props.blocks;});
  let initialImportedLayout=true;
  createEffect(()=>{
    const configuration=[props.width,props.fontSize,props.preset,fonts()];
    if(initialImportedLayout){initialImportedLayout=false;return;}
    if(imported)void imported.relayout().catch(error=>props.onError(String(error)));
  });
  createEffect(()=>{
    if(imported)return;
    const blocks=props.blocks,width=props.width-28,size=props.fontSize,preset=props.preset;
    batch(()=>{setNativeReady(false);setNativeLayouts(new Map());});
    if(!hasCapability("text.layout")){setNativeReady(true);return;}
    const metrics=getDisplayMetrics(),pixelScale=metrics.physicalWidth/metrics.logicalWidth;
    let cancelled=false,first=true,complete:NativeBlockLayouts=new Map();
    const task=requestReaderLayoutBatched(blocks,width,size,pixelScale,preset,args=>textLayout.layoutBatch(args),value=>{
      complete=value;
      if(first){first=false;setNativeLayouts(value);}
    },error=>logConsole.warn("Reader paragraph layout",String(error)),fonts());
    void task.done.then(()=>{if(!cancelled)batch(()=>{setNativeLayouts(complete);setNativeReady(true);});});
    onCleanup(()=>{cancelled=true;task.cancel();});
  });
  const [prepared,setPrepared]=createSignal<{layout:ReturnType<typeof layoutContent>;entries:PositionedScrollEntry[];indices:ReadonlyMap<string,number>;complete:boolean;scope:ContentBlock[]}|undefined>();
  createEffect(()=>{
    if(imported)return;
    const native=nativeLayouts(),source=props.blocks,width=props.width-28,size=props.fontSize,preset=props.preset,ratio=ratios(),complete=nativeReady();
    // Native-capable hosts can show their first shaped paragraphs without
    // wrapping the unseen tail in the atlas first. Saved anchors wait for the
    // complete document; portable hosts and failed paragraphs use Rust wrap.
    let input=source;
    if(!complete){
      if(!native.size||pendingProgress&&(pendingProgress.textAnchor||pendingProgress.progress>0))return;
      const end=source.findIndex(block=>block.type==='text'&&!native.has(block));
      input=end<0?source:source.slice(0,end);
      if(!input.length)return;
    }
    const first=!untrack(prepared);
    const task=prepareTextLayout(layoutContent.steps(input,width,size,ratio,preset,native),{key:readerRowKey,entry:makeEntry,
      preview:first?{rows:16,publish:snapshot=>{
        // A saved position must not mount an unrelated start window first.
        if(pendingProgress&&(pendingProgress.textAnchor||pendingProgress.progress>0))return;
        const rows=snapshot.entries.map(entry=>entry.data as ReaderRow),last=rows.at(-1);
        setPrepared({...snapshot,layout:{rows,height:last?last.top+last.height:0,textLength:0},complete:false,scope:source});
      }}:undefined,
      publish:snapshot=>{
        const progress=pendingProgress;
        if(complete&&progress&&(progress.textAnchor||progress.progress>0)){
          pendingProgress=undefined;
          const anchor=progress.textAnchor??{character:progress.progress*props.text.replace(/\r\n?/g,"\n").length,fraction:0};
          const maximum=Math.max(0,headerHeight()+snapshot.layout.height+footerHeight()-props.height);
          const offset=offsetForDocumentAnchor(snapshot.layout,anchor,headerHeight(),maximum);
          // Commit geometry and saved position together, so the window mounts
          // only the saved viewport. Later native/image reflows retain its keys.
          batch(()=>{setPrepared({...snapshot,complete,scope:source});scroller.scrollTo(offset,{immediate:true});});
          lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);
        }else setPrepared({...snapshot,complete,scope:source});
      }});
    void task.done.catch(error=>logConsole.warn("Reader layout preparation",String(error)));
    onCleanup(()=>task.cancel());
  });
  const layout=createMemo(()=>{importedRevision();return imported?.layout()??prepared()?.layout??{rows:[],height:0,textLength:0};});

  const [systemCarets,setSystemCarets]=createSignal<ReadonlyMap<ReaderRow,readonly number[]>>(new Map());
  const highlightRects=createMemo(()=>contentHighlightRects(layout(),imported&&props.highlight?.importedChunkIndex!==undefined?{...props.highlight,contentBlockIndex:props.highlight.importedChunkIndex}:props.highlight,props.width-28,(text,slot)=>getOps().measureText(text,slot),systemCarets()));
  const headerHeight=()=>props.header?.reduce((sum,row)=>sum+row.height,0)??0;
  const footerHeight=()=>props.footer?.reduce((sum,row)=>sum+row.height,0)??0;
  const max=()=>Math.max(0,headerHeight()+layout().height+footerHeight()-props.height);
  const scroller=createScroller({max});
  const controller=new AutoScrollController(0,offset=>scroller.scrollTo(offset,{immediate:true}));
  const [playing,setPlayingState]=createSignal(false),[restored,setRestored]=createSignal(false),[feedback,setFeedback]=createSignal("");
  const store=new LifecycleReadingProgressStore(props.progressStore??new ReadingProgressStore({get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);}}),kv);
  const writes=new ReadingProgressWriteQueue();
  const [lastManualScroll,setLastManualScroll]=createSignal(-Infinity);
  let followingSpeech=false;
  const manualScroll=()=>{followingSpeech=false;setLastManualScroll(Date.now());handle.pause();};
  let disposed=false,foreground=true,lastFrame=0,lastSave=0,lastOffset=-1;
  let tapTimer:(()=>void)|undefined,feedbackTimer:(()=>void)|undefined;
  const schedule=(milliseconds:number,callback:()=>void)=>{const timer=delay(Math.max(1,milliseconds));void timer.result.then(callback,()=>{});return ()=>timer.cancel();};
  const currentProgress=()=>{
    if(!restored()||disposed)return;
    const offset=scroller.offset();
    if(imported){
      const importedAnchor=imported.anchor(offset,headerHeight());if(!importedAnchor)return;
      return normalizeReadingProgress({offset,progress:imported.progress(importedAnchor),updatedAt:Date.now(),importedAnchor});
    }
    const textAnchor=documentAnchorAt(layout(),offset,headerHeight());
    return normalizeReadingProgress({offset,progress:Math.min(1,textAnchor.character/Math.max(1,props.text.replace(/\r\n?/g,"\n").length)),updatedAt:Date.now(),textAnchor});
  };
  const save=():Promise<void>=>{
    if(!restored()||disposed||scroller.offset()===lastOffset)return writes.flush();
    const value=currentProgress();if(!value)return writes.flush();
    const {offset}=value;
    lastOffset=offset;lastSave=value.updatedAt;
    const task=writes.enqueue(store.prepareSave(Number(props.articleId),value));
    void task.catch(error=>{if(lastOffset===offset)lastOffset=-1;if(!disposed)props.onError(String(error));});return task;
  };
  const removeCheckpoint=onLifecycleCheckpoint(()=>{
    const value=currentProgress();
    if(value)store.checkpoint(Number(props.articleId),value);
  });
  const setPlaying=(value:boolean,notify=true)=>{
    if(value){const offset=scroller.offset();controller.setBounds(max());controller.setOffset(offset);controller.start();}
    else controller.pause();
    setPlayingState(controller.isRequested());lastFrame=0;
    if(notify){
      setFeedback(controller.isRequested()?"自动滚动已开始":"自动滚动已暂停");
      if(feedbackTimer)feedbackTimer();
      feedbackTimer=schedule(1500,()=>setFeedback(""));
    }
  };
  const handle:ReaderBodyHandle={manualScroll,tap:()=>tap(),scroller,playing,setPlaying:value=>setPlaying(value),pause:()=>{if(playing())setPlaying(false);},reachedBottom:()=>restored()&&readerReachedBottom(headerHeight()+layout().height+footerHeight(),props.height,scroller.offset()),flushProgress:save};
  props.ref(handle);
  const tap=()=>{
    if(!props.active||!restored())return;
    if(tapTimer){tapTimer();tapTimer=undefined;props.onControls(handle);}
    else tapTimer=schedule(300,()=>{tapTimer=undefined;if(props.active)setPlaying(!playing());});
  };
  createEffect(()=>{
    const highlight=props.highlight,enabled=props.active&&props.speechPlaying&&restored(),manualAt=lastManualScroll();
    const rectangles=highlightRects();
    const center=highlight?.isTitle?props.speechTitleCenter:highlightCenter(Array.from(rectangles,([row,rect])=>({top:headerHeight()+row.top+rect.top,height:rect.height})));
    const maximum=max();
    let cancelWait:(()=>void)|undefined,cancelSettle:(()=>void)|undefined;
    if(enabled&&highlight&&center!==undefined){
      cancelWait=schedule(Math.max(0,3000-(Date.now()-manualAt)),()=>{
        followingSpeech=true;
        scroller.scrollTo(Math.max(0,Math.min(maximum,center-props.height/2)));
        cancelSettle=schedule(320,()=>{followingSpeech=false;});
      });
    }
    onCleanup(()=>{cancelWait?.();cancelSettle?.();if(followingSpeech){followingSpeech=false;scroller.stop();}});
  });
  let previousLayout=layout(),previousHeaderHeight=headerHeight();
  createEffect(()=>{
    const nextLayout=layout(),nextHeaderHeight=headerHeight(),maximum=max();
    untrack(()=>{
      if(restored()){
        const importedAnchor=imported?.anchor(scroller.offset(),previousHeaderHeight,previousLayout);
        const anchor=documentAnchorAt(previousLayout,scroller.offset(),previousHeaderHeight);
        const offset=importedAnchor?imported!.offset(importedAnchor,nextHeaderHeight,maximum):imported?scroller.offset():offsetForDocumentAnchor(nextLayout,anchor,nextHeaderHeight,maximum);
        controller.setBounds(maximum);controller.setOffset(offset);lastFrame=0;
      }
      previousLayout=nextLayout;previousHeaderHeight=nextHeaderHeight;
    });
  });
  createEffect(()=>{
    const active=props.active;
    untrack(()=>{lastFrame=0;controller.setBackground(!active||!foreground);if(!active){save();if(tapTimer){tapTimer();tapTimer=undefined;}}});
  });
  let pendingProgress:Awaited<ReturnType<typeof store.load>>|undefined;
  let restoreTimer:ReturnType<typeof delay>|undefined;
  const restoreProgress=()=>{
    if(!pendingProgress||disposed||imported||!prepared()?.complete||restoreTimer)return;
    // Publishing the first window and mounting the saved window are separate
    // host turns. The source anchor stays pending until complete geometry exists.
    restoreTimer=delay(1);
    void restoreTimer.result.then(()=>{
      restoreTimer=undefined;
      if(!pendingProgress||disposed||!prepared()?.complete)return;
      const progress=pendingProgress;pendingProgress=undefined;
      const anchor=progress.textAnchor??{character:progress.progress*props.text.replace(/\r\n?/g,"\n").length,fraction:0};
      scroller.scrollTo(!progress.textAnchor&&progress.progress<=0?0:offsetForDocumentAnchor(layout(),anchor,headerHeight(),max()),{immediate:true});
      lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);
    },()=>{restoreTimer=undefined;});
  };
  createEffect(()=>{prepared();untrack(restoreProgress);});
  onMount(()=>{
    void store.load(Number(props.articleId)).then(async progress=>{
      if(disposed)return;
      if(imported){
        const saved=progress.importedAnchor?.marker===imported.handle.marker?progress.importedAnchor:undefined;
        const target=importedByteTarget(imported.handle,progress.progress),index=Math.min(imported.handle.chunkCount-1,saved?.chunkIndex??target.chunkIndex);
        await imported.ensure(index);if(disposed)return;
        const anchor=saved?{...saved,chunkIndex:index}:{marker:imported.handle.marker,chunkIndex:index,charOffset:importedCharForByte(imported.text(index)??"",target.byteOffset),fraction:0};
        scroller.scrollTo(!saved&&progress.progress<=0?0:imported.offset(anchor,headerHeight(),max()),{immediate:true});
        lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);return;
      }
      pendingProgress=progress;restoreProgress();
    }).catch(error=>{if(!disposed){setRestored(true);props.onError(String(error));}});
  });
  onFrame(()=>{
    const now=Date.now();
    if(!restored()||!props.active||!foreground){lastFrame=0;return;}
    if(imported){
      const target=props.speechPlaying&&Date.now()-lastManualScroll()>=3000?props.highlight?.importedChunkIndex:undefined;
      const load=target!==undefined&&imported.text(target)===undefined?imported.ensure(target):imported.visible(scroller.offset()-headerHeight(),props.height);
      void load.catch(error=>{if(!disposed)props.onError(String(error));});
    }
    // A user drag, fling, d-pad chase or crown tween cancels automatic movement.
    if(scroller.state()!=="idle")handle.pause();
    if(followingSpeech&&["tracking","chase","fling"].includes(scroller.state()))manualScroll();
    controller.setBackground(false);
    if(playing()){
      controller.setSpeed(props.speed*props.lineHeight);
      if(lastFrame)controller.tick(Math.max(0,now-lastFrame));
      if(!controller.isRequested())setPlayingState(false);
    }
    lastFrame=now;
    if(now-lastSave>=1000)void save();
  });
  const removeLifecycle=__onHostEvent(event=>{
    if(event.t!=="lifecycle")return;
    foreground=event.state==="active";lastFrame=0;controller.setBackground(!foreground||!props.active);
    if(!foreground)void save();
  });
  onCleanup(()=>{void save();disposed=true;restoreTimer?.cancel();imported?.close();for(const task of importedTasks)task.cancel();removeLifecycle();removeCheckpoint();controller.pause();scroller.stop();if(tapTimer)tapTimer();if(feedbackTimer)feedbackTimer();});
  function makeEntry(initial:ReaderRow):PositionedScrollEntry {return {top:initial.top,key:readerRowKey(initial),data:initial,height:initial.height,retain:initial.kind==="text",render:(current?:()=>ScrollEntry)=>{const raw=()=>current?.().data as ReaderRow??initial;const row=createWindowValue(raw);return row.kind==="text"?<View onPress={tap} class="absolute inset-0">{(()=>{const rect=highlightRects().get(raw());return rect?<View debugName="SpeechBodyHighlight" class="absolute" style={{insetL:rect.left,insetT:rect.top,width:rect.width,height:rect.height,bgColor:props.highlightColor??"#ff651557"}}/>:null;})()}<View class="absolute left-[0] right-[0]" style={{insetT:row.gap,height:row.lineHeight}}><ReaderTextRow environment={textEnvironment()} row={row} style={blocks()[row.blockIndex]?.type==="text"?(blocks()[row.blockIndex] as ContentBlock & {type:"text"}).style:"body"} fontSize={props.fontSize} width={props.width-28} preset={props.preset} fonts={fonts()} onCarets={positions=>setSystemCarets(previous=>updateSystemCarets(previous,raw(),positions))}/></View></View>:<View onPress={()=>{if(props.active){handle.pause();props.onMedia(row.block);}}} focusable class="absolute left-[0] right-[0] bg-[#161616]" style={{insetT:row.gap,height:row.height-row.gap}}>
      {row.kind==="image"?<RemoteImage inline url={resolveUrl(row.block.url,props.baseUrl)??""} filePath={props.offlineMedia?.[row.block.url]} width={props.width-28} height={row.height-row.gap} fit="contain" onSize={(width,height)=>untrack(()=>{const ratio=width/height;if(Number.isFinite(ratio)&&ratio>0&&ratios()[row.blockIndex]!==ratio)setRatios({...ratios(),[row.blockIndex]:ratio});})}/>:<>{row.block.type==="video"&&row.block.poster?<RemoteImage url={resolveUrl(row.block.poster,props.baseUrl)??""} filePath={props.offlineMedia?.[row.block.poster]} width={props.width-28} height={row.height-row.gap} fit="contain" onSize={(width,height)=>untrack(()=>{const ratio=width/height;if(Number.isFinite(ratio)&&ratio>0&&ratios()[row.blockIndex]!==ratio)setRatios({...ratios(),[row.blockIndex]:ratio});})}/>:null}<Image src="../assets/icons/play-circle.svg" class="absolute w-[24] h-[24]" style={{insetL:(props.width-28-24)/2,insetT:(row.height-row.gap-24)/2}}/></>}
    </View>;}};}
  const indexedEntries=createMemo<IndexedScrollEntries>(()=>{
    const snapshot=prepared();
    if(snapshot&&!imported)return snapshot;
    const entries=layout().rows.map(makeEntry),indices=new Map<string,number>();
    entries.forEach((entry,index)=>indices.set(entry.key as string,index));
    return {entries,indices,scope:blocks()};
  });
  return <View debugName="ReaderViewport" class="absolute left-[0] right-[0]" style={{insetT:props.top??40,height:props.height,bgColor:props.preset?readerColor(props.preset.background.colorArgb):"#000000"}}>
    {props.preset&&<ReaderBackground background={props.preset.background} snapshot={backgrounds()} width={props.width} height={props.height} active={props.active}/>}
    <ScrollEntries retainRows={24} onManualScroll={manualScroll} onScrollStateChange={scrolling=>{if(scrolling&&!followingSpeech)manualScroll();}} controller={scroller} height={props.height} padding={14} verticalPadding={0} gap={0} inputActive={()=>props.active&&restored()} onLongPress={props.onSpeechControls?contact=>{if(tapTimer){tapTimer();tapTimer=undefined;}handle.pause();const anchor=pressedSpeechAnchor(layout(),blocks(),contact.startX,contact.startY-(props.top??40),scroller.offset(),headerHeight(),props.width,(text,slot)=>getOps().measureText(text,slot),14,systemCarets());if(anchor?.contentBlockIndex!==undefined)appLogger.d("ReadAloudTouch",`${imported?"imported chunk":"content block"}=${anchor.contentBlockIndex} position=Offset(${contact.startX}, ${contact.startY-(props.top??40)}) offset=${anchor.contentCharOffset??null} text=<redacted>`);props.onSpeechControls?.(imported&&anchor?.contentBlockIndex!==undefined?{importedChunkIndex:anchor.contentBlockIndex,importedCharOffset:anchor.contentCharOffset??0}:anchor);}:undefined} entries={props.header??[]} footerEntries={props.footer??[]} indexedEntries={indexedEntries()}/>

    <View class="absolute left-[12] right-[12] bottom-[0] h-[18] items-center justify-center" style={{opacity:feedback()?1:0}}><Text class="text-xs text-[#45d6a7]">{feedback()}</Text></View>
  </View>;
}

export function ReaderBody(props:Parameters<typeof ReaderBodyImpl>[0]) {return traceServiceWork("reader.ReaderBody",()=>ReaderBodyImpl(props));}
