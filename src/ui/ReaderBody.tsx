import {readerMediaRatio} from '../reader/media-geometry.ts';
import {AutoPageClock} from "../reader/auto-page.ts";
import {ReaderBookPage} from "./ReaderBookPage.tsx";
import {createBookPaginator,bookPageForAnchor,type PageAnchor} from "../reader/pagination.ts";
import {rowAtOffset} from "../reader/content-layout.ts";
import {AutoScrollAwakeLease} from "../reader/keep-awake.ts";
import {displayPower} from "@podjs/framework/services";
import {lifecycle} from "@podjs/framework/watch";
import {traceServiceWork} from "@podjs/framework/service-trace";
import {createWindowValue} from "@podjs/framework/windowed-list";
import {createSystemTextCache} from "@podjs/framework/text";
import {prepareTextLayout} from "@podjs/framework/text";
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
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack, batch, Show } from "solid-js";
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
  ready?:()=>boolean;
  scroller:Scroller;
  playing:()=>boolean;
  setPlaying:(value:boolean)=>void;
  pause:()=>void;
  manualScroll:()=>void;
  reachedBottom:()=>boolean;
  flushProgress:()=>Promise<void>;
}
function ReaderBodyImpl(props:{
  pageMode?:boolean;
  touchOrigin?:{left:number;top:number};
  onMoving?:(moving:boolean)=>void;
  progressStore?:Pick<ReadingProgressStore,"load"|"save">;
  imported?:{handle:ImportedTextHandle;read:(index:number)=>Promise<string|null>};
  onImportedError?:()=>void;
  preset?:ReaderPreset;
  highlight?:SpeechHighlight; speechPlaying?:boolean; speechTitleCenter?:number; highlightColor?:string;
  header?:ScrollEntry[]; footer?:ScrollEntry[];
  articleId:string; top?:number; text:string; blocks:ContentBlock[]; baseUrl?:string; width:number; height:number; lineHeight:number;
  offlineMedia?:Record<string,string>;
  fontSize:number; onMedia:(block:Exclude<ContentBlock,{type:"text"}>)=>void; active:boolean; autoStart:boolean; keepAwake?:boolean; speed:number; pageSeconds?:number;
  onControls:(handle:ReaderBodyHandle)=>void; onError:(message:string)=>void;
  onSpeechControls?:(anchor?:SpeechAnchor)=>void;
  ref:(handle:ReaderBodyHandle)=>void;
}) {
  const textCache=createSystemTextCache();
  const textEnvironment=createMemo(()=>{
    // Re-read host facts when the reader configuration changes.
    props.width;props.fontSize;props.preset;
    return createReaderTextEnvironment();
  });
  const normalizedTextLength=createMemo(()=>props.text.replace(/\r\n?/g,"\n").length);
  const fonts=useReaderFonts();const backgrounds=useReaderBackgrounds();
  const [ratios,setRatios]=createSignal<Record<number,number>>({});
  const layoutContent=createContentLayouter((text,slot)=>getOps().measureText(text,slot),(text,slot,width)=>getOps().wrapText?.(text,slot,width),getFontMetrics);
  const [nativeLayouts,setNativeLayouts]=createSignal<NativeBlockLayouts>(new Map());
  const [nativeReady,setNativeReady]=createSignal(false);
  const [progressLoaded,setProgressLoaded]=createSignal(false);
  let latestNativeLayouts:NativeBlockLayouts=new Map(),prefixPreparing=false,preparationRevision=0;
  const [importedRevision,setImportedRevision]=createSignal(0);
  const importedTasks=new Set<{cancel():void}>();
  let importedReadFailed=false;
  const reportImportedError=(error:unknown)=>{
    if(importedReadFailed&&props.onImportedError)props.onImportedError();
    else props.onError(String(error));
  };
  const imported=props.imported?new ImportedReaderDocument(props.imported.handle,async index=>{
    try{const text=await props.imported!.read(index);if(text===null)throw new Error("加载失败可重试");return text;}
    catch{importedReadFailed=true;throw new Error("加载失败可重试");}
  },async block=>{
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
    latestNativeLayouts=new Map();
    batch(()=>{setNativeReady(false);setNativeLayouts(new Map());});
    if(!hasCapability("text.layout")){setNativeReady(true);return;}
    const metrics=getDisplayMetrics(),pixelScale=metrics.physicalWidth/metrics.logicalWidth;
    let cancelled=false,first=true,complete:NativeBlockLayouts=new Map();
    const task=requestReaderLayoutBatched(blocks,width,size,pixelScale,preset,args=>textLayout.layoutBatch(args),value=>{
      complete=value;latestNativeLayouts=value;
      if(first){first=false;setNativeLayouts(value);}
    },error=>logConsole.warn("Reader paragraph layout",String(error)),fonts());
    void task.done.then(()=>{if(!cancelled)batch(()=>{setNativeLayouts(complete);setNativeReady(true);});});
    onCleanup(()=>{cancelled=true;task.cancel();});
  });
  const [prepared,setPrepared]=createSignal<{layout:ReturnType<typeof layoutContent>;entries:PositionedScrollEntry[];indices:ReadonlyMap<string,number>;complete:boolean;scope:ContentBlock[]}|undefined>();
  createEffect(()=>{
    if(imported)return;
    if(!progressLoaded())return;
    const native=nativeLayouts(),source=props.blocks,width=props.width-28,size=props.fontSize,preset=props.preset,ratio=ratios(),complete=nativeReady(),viewportHeight=props.height;
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
    const publishPrefix=(snapshot:{entries:PositionedScrollEntry[];indices:ReadonlyMap<string,number>;layout?:ReturnType<typeof layoutContent>})=>{
      if(pendingProgress&&(pendingProgress.textAnchor||pendingProgress.progress>0))return;
      const rows=snapshot.entries.map(entry=>entry.data as ReaderRow),last=rows.at(-1);
      const geometry=snapshot.layout??{rows,height:last?last.top+last.height:0,textLength:0};
      // A replacement preparation can start at row zero while the reader is
      // already farther down. Never shrink the published window to that prefix.
      if(geometry.height<(untrack(prepared)?.layout.height??0))return;
      setPrepared({...snapshot,layout:geometry,complete:false,scope:source});
    };
    const first=!untrack(prepared),revision=++preparationRevision;prefixPreparing=true;
    const task=prepareTextLayout(layoutContent.steps(input,width,size,ratio,preset,native,viewportHeight),{key:readerRowKey,entry:makeEntry,
      preview:first?{rows:16,publish:publishPrefix}:undefined,
      progress:!props.pageMode?{rows:64,publish:publishPrefix}:undefined,
      publish:snapshot=>{
        const progress=pendingProgress;
        if(complete&&progress&&(progress.textAnchor||progress.progress>0)){
          pendingProgress=undefined;
          const anchor=progress.textAnchor??{character:progress.progress*normalizedTextLength(),fraction:0};
          const maximum=Math.max(0,headerHeight()+snapshot.layout.height+footerHeight()-props.height);
          const offset=offsetForDocumentAnchor(snapshot.layout,anchor,headerHeight(),maximum);
          // Commit geometry and saved position together, so the window mounts
          // only the saved viewport. Later native/image reflows retain its keys.
          batch(()=>{setPrepared({...snapshot,complete,scope:source});scroller.scrollTo(offset,{immediate:true});});
          lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);
        }else if(complete)setPrepared({...snapshot,complete,scope:source});else publishPrefix(snapshot);
      }});
    void task.done.then(()=>{if(revision===preparationRevision)prefixPreparing=false;},error=>{if(revision===preparationRevision)prefixPreparing=false;logConsole.warn("Reader layout preparation",String(error));});
    onCleanup(()=>task.cancel());
  });
  const layout=createMemo(()=>{importedRevision();return imported?.layout()??prepared()?.layout??{rows:[],height:0,textLength:0};});

  const [pageAnchor,setPageAnchor]=createSignal<PageAnchor>();
  const round=()=>getDisplayMetrics().shape==='round';
  const paginateCached=createBookPaginator((text,slot)=>getOps().measureText(text,slot));
  const bookPages=createMemo(()=>props.pageMode?paginateCached(blocks(),{width:props.width,height:props.height,ratios:ratios(),round:round(),fontSize:props.fontSize,preset:props.preset,header:props.header?.map(entry=>entry.height),footer:props.footer?.map(entry=>entry.height),unloaded:imported?index=>imported.text(index)===undefined:undefined}):[]);
  const bookPageIndex=createMemo(()=>bookPageForAnchor(bookPages(),pageAnchor()??{section:'header',character:0,blockIndex:0,sourceStart:0,sectionOffset:0}));
  const bookPage=()=>bookPages()[bookPageIndex()];
  let lastBookAnchor:PageAnchor|undefined;
  createEffect(()=>{if(props.pageMode&&bookPage())lastBookAnchor=bookPage()!.anchor;});
  const [systemCarets,setSystemCarets]=createSignal<ReadonlyMap<ReaderRow,readonly number[]>>(new Map());
  const highlightRects=createMemo(()=>{
    const highlight=props.highlight;
    // Caret delivery must not invalidate every mounted row when speech is absent.
    if(!highlight)return new Map<ReaderRow,{left:number;top:number;width:number;height:number}>();
    return contentHighlightRects(layout(),imported&&highlight.importedChunkIndex!==undefined?{...highlight,contentBlockIndex:highlight.importedChunkIndex}:highlight,props.width-28,(text,slot)=>getOps().measureText(text,slot),systemCarets());
  });
  const headerHeight=()=>props.header?.reduce((sum,row)=>sum+row.height,0)??0;
  const footerReady=()=>!!imported||!!props.pageMode||prepared()?.complete===true;
  const footerHeight=()=>footerReady()?(props.footer?.reduce((sum,row)=>sum+row.height,0)??0):0;
  const max=()=>Math.max(0,headerHeight()+layout().height+footerHeight()-props.height);
  const scroller=createScroller({max});
  const controller=new AutoScrollController(0,offset=>scroller.scrollTo(offset,{immediate:true}));
  const [playing,setPlayingState]=createSignal(false),[restored,setRestored]=createSignal(false),[feedback,setFeedback]=createSignal("");
  const store=new LifecycleReadingProgressStore(props.progressStore??new ReadingProgressStore({get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);}}),kv);
  const writes=new ReadingProgressWriteQueue();
  let initialBookProgress:Awaited<ReturnType<typeof store.load>>|undefined;
  const [lastManualScroll,setLastManualScroll]=createSignal(-Infinity);
  const [scrolling,setScrolling]=createSignal(false);
  let followingSpeech=false;
  const manualScroll=()=>{followingSpeech=false;setLastManualScroll(Date.now());handle.pause();};
  let disposed=false,foreground=lifecycle()==="active",lastFrame=0,lastSave=0,lastOffset=-1,pageTurnAt=0;
  const autoPages=new AutoPageClock();
  const awake=new AutoScrollAwakeLease((owner,active)=>hasCapability("display.power")?displayPower.keepAwake(owner,active):Promise.resolve(),()=>appLogger.w("ReaderAutoScroll","Display lease update failed"));
  const syncAwake=()=>awake.update({enabled:props.keepAwake===true,scrolling:playing()&&restored(),active:props.active,foreground});
  createEffect(()=>{void syncAwake();});
  let tapTimer:(()=>void)|undefined,feedbackTimer:(()=>void)|undefined;
  const schedule=(milliseconds:number,callback:()=>void)=>{const timer=delay(Math.max(1,milliseconds));void timer.result.then(callback,()=>{});return ()=>timer.cancel();};
  const currentProgress=()=>{
    if(importedReadFailed)return;
    if(!restored()||disposed)return;
    const offset=scroller.offset();
    if(props.pageMode&&bookPage()){
      const start=bookPage()!.anchor;
      const section=start.section==='body'?{}:{section:start.section,sectionOffset:start.sectionOffset};
      if(imported){
        const importedAnchor={marker:imported.handle.marker,chunkIndex:start.blockIndex,charOffset:start.sourceStart,fraction:0,...section};
        return normalizeReadingProgress({offset,progress:imported.progress(importedAnchor),updatedAt:Date.now(),importedAnchor});
      }
      const textAnchor={character:start.character,fraction:0,...section};
      return normalizeReadingProgress({offset,progress:start.section==='footer'?1:start.character/Math.max(1,normalizedTextLength()),updatedAt:Date.now(),textAnchor});
    }
    if(imported){
      const importedAnchor=imported.anchor(offset,headerHeight());if(!importedAnchor)return;
      return normalizeReadingProgress({offset,progress:imported.progress(importedAnchor),updatedAt:Date.now(),importedAnchor});
    }
    const textAnchor=documentAnchorAt(layout(),offset,headerHeight());
    return normalizeReadingProgress({offset,progress:Math.min(1,textAnchor.character/Math.max(1,normalizedTextLength())),updatedAt:Date.now(),textAnchor});
  };
  let lastPageKey='';
  const save=():Promise<void>=>{
    const pageKey=props.pageMode?JSON.stringify(bookPage()?.anchor):'';
    if(!restored()||disposed||scroller.offset()===lastOffset&&pageKey===lastPageKey)return writes.flush();
    lastPageKey=pageKey;
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
    autoPages.reset();
    if(props.pageMode){controller.pause();setPlayingState(value&&bookPageIndex()<bookPages().length-1);}
    else {
      if(value){const offset=scroller.offset();controller.setBounds(max());controller.setOffset(offset);controller.start();}
      else controller.pause();
      setPlayingState(controller.isRequested());
    }
    lastFrame=0;
    if(notify){
      setFeedback(`${props.pageMode?"自动翻页":"自动滚动"}${playing()?"已开始":"已暂停"}`);
      if(feedbackTimer)feedbackTimer();
      feedbackTimer=schedule(1500,()=>setFeedback(""));
    }
  };
  const handle:ReaderBodyHandle={ready:restored,manualScroll,tap:()=>tap(),scroller,playing,setPlaying:value=>setPlaying(value),pause:()=>{if(playing())setPlaying(false);},reachedBottom:()=>restored()&&(props.pageMode?bookPageIndex()===bookPages().length-1:!!(imported||prepared()?.complete)&&readerReachedBottom(headerHeight()+layout().height+footerHeight(),props.height,scroller.offset())),flushProgress:save};
  props.ref(handle);
  let tapOrigin:PageAnchor|undefined;
  const tap=(direction=0)=>{
    if(!props.active||!restored())return;
    if(tapTimer){
      tapTimer();tapTimer=undefined;
      if(props.pageMode&&tapOrigin)setPageAnchor(tapOrigin);
      tapOrigin=undefined;props.onControls(handle);return;
    }
    if(props.pageMode){
      handle.pause();tapOrigin=bookPage()?.anchor;
      if(direction)turnBookPage(direction,true,false);
    }
    tapTimer=schedule(300,()=>{tapTimer=undefined;tapOrigin=undefined;if(!props.active)return;if(props.pageMode)void save();else setPlaying(!playing());});
  };
  const turnBookPage=(direction:number,manual=true,persist=true):boolean=>{
    const next=Math.max(0,Math.min(bookPages().length-1,bookPageIndex()+direction));
    if(next===bookPageIndex())return false;
    if(manual)manualScroll();
    pageTurnAt=Date.now();setPageAnchor(bookPages()[next]!.anchor);
    // Persist source anchors after paint, without walking/positioning the continuous document on input.
    if(persist)lastSave=0;
    return true;
  };
  const restoreContinuousAnchor=(start:PageAnchor)=>{
    const section=start.section==='body'?{}:{section:start.section,sectionOffset:start.sectionOffset};
    const target=imported?imported.offset({marker:imported.handle.marker,chunkIndex:start.blockIndex,charOffset:start.sourceStart,fraction:0,...section},headerHeight(),max()):offsetForDocumentAnchor(layout(),{character:start.character,fraction:0,...section},headerHeight(),max());
    scroller.scrollTo(target,{immediate:true});
  };
  let previousPageMode=props.pageMode;
  createEffect(()=>{
    const enabled=props.pageMode,ready=restored();
    untrack(()=>{
      if(previousPageMode!==enabled){setPlaying(false,false);if(!enabled&&lastBookAnchor)restoreContinuousAnchor(lastBookAnchor);}
      previousPageMode=enabled;
      if(!enabled){setPageAnchor(undefined);initialBookProgress=undefined;return;}
      if(!ready)return;
      if(pageAnchor())return;
      const saved=initialBookProgress?.importedAnchor??imported?.anchor(scroller.offset(),headerHeight());
      const document=initialBookProgress?.textAnchor??documentAnchorAt(layout(),scroller.offset(),headerHeight());
      let blockIndex=0,base=0;
      if(!imported&&!document.section){for(let i=0;i<blocks().length;i++){const block=blocks()[i]!;if(document.mediaIndex===i||block.type==='text'&&document.character<base+block.text.replace(/\r\n?/g,'\n').length+1){blockIndex=i;break;}if(block.type==='text')base+=block.text.replace(/\r\n?/g,'\n').length+1;}}
      let sourceStart=0,normalized=0;const block=blocks()[blockIndex];
      if(block?.type==='text')while(normalized<document.character-base&&sourceStart<block.text.length){if(block.text[sourceStart]==='\r'&&block.text[sourceStart+1]==='\n')sourceStart++;sourceStart++;normalized++;}
      setPageAnchor({section:saved?.section??document.section??'body',character:document.character,blockIndex:saved?.chunkIndex??blockIndex,sourceStart:saved?.charOffset??sourceStart,sectionOffset:saved?.sectionOffset??document.sectionOffset??0});
      initialBookProgress=undefined;
    });
  });
  let loadingBookChunk:Promise<void>|undefined,failedBookChunk:number|undefined;
  const [bookLoadRevision,setBookLoadRevision]=createSignal(0);
  createEffect(()=>{
    bookLoadRevision();
    const page=props.pageMode&&restored()&&props.active?bookPage():undefined;
    if(page?.loading===undefined||!imported||loadingBookChunk||failedBookChunk===page.loading)return;
    const index=page.loading;let failed=false;
    loadingBookChunk=imported.ensure(index).catch(error=>{failed=true;failedBookChunk=index;if(!disposed)reportImportedError(error);}).finally(()=>{loadingBookChunk=undefined;if(!disposed&&!failed)setBookLoadRevision(value=>value+1);});
  });
  createEffect(()=>{
    const highlight=props.highlight,enabled=props.active&&props.speechPlaying&&restored()&&!props.pageMode,manualAt=lastManualScroll();
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
        batch(()=>{controller.setBounds(maximum);controller.setOffset(offset);});lastFrame=0;
      }
      previousLayout=nextLayout;previousHeaderHeight=nextHeaderHeight;
    });
  });
  createEffect(()=>{
    const active=props.active;
    untrack(()=>{lastFrame=0;autoPages.reset();controller.setBackground(!active||!foreground);if(!active){save();if(tapTimer){tapTimer();tapTimer=undefined;}}});
  });
  createEffect(()=>{
    const ready=restored(),active=props.active,moving=scrolling(),automatic=playing(),source=blocks(),width=props.width,height=props.height,size=props.fontSize,preset=props.preset;
    lastManualScroll(); // A new input cancels speculative preparation.
    if(!ready||!active||moving||automatic||props.pageMode||source.reduce((sum,block)=>sum+(block.type==='text'?block.text.length:0),0)>128*1024)return;
    const task=delay(1500);let preparation:ReturnType<typeof paginateCached.prepare>|undefined;
    void task.result.then(()=>{if(!disposed){
      preparation=paginateCached.prepare(source,{width,height,round:round(),fontSize:size,preset,unloaded:imported?index=>imported.text(index)===undefined:undefined});
      void preparation.done.catch(error=>logConsole.warn("Reader page preparation",String(error)));
    }},()=>{});
    onCleanup(()=>{task.cancel();preparation?.cancel();});
  });
  let pendingProgress:Awaited<ReturnType<typeof store.load>>|undefined;
  let restoreTimer:ReturnType<typeof delay>|undefined;
  const canRestore=()=>!!prepared()&&(!(pendingProgress?.textAnchor||pendingProgress&&pendingProgress.progress>0)||prepared()!.complete);
  const restoreProgress=()=>{
    if(!pendingProgress||disposed||imported||!canRestore()||restoreTimer)return;
    if(!pendingProgress.textAnchor&&pendingProgress.progress<=0){
      pendingProgress=undefined;lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);return;
    }
    // A fresh document accepts touch with its first prefix. Saved source anchors
    // still wait for complete geometry before mounting their window.
    restoreTimer=delay(1);
    void restoreTimer.result.then(()=>{
      restoreTimer=undefined;
      if(!pendingProgress||disposed||!canRestore())return;
      const progress=pendingProgress;pendingProgress=undefined;
      const anchor=progress.textAnchor??{character:progress.progress*normalizedTextLength(),fraction:0};
      scroller.scrollTo(!progress.textAnchor&&progress.progress<=0?0:offsetForDocumentAnchor(layout(),anchor,headerHeight(),max()),{immediate:true});
      lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);
    },()=>{restoreTimer=undefined;});
  };
  createEffect(()=>{prepared();untrack(restoreProgress);});
  onMount(()=>{
    void store.load(Number(props.articleId)).then(async progress=>{
      if(disposed)return;
      initialBookProgress=props.pageMode?progress:undefined;
      if(imported){
        const saved=progress.importedAnchor?.marker===imported.handle.marker?progress.importedAnchor:undefined;
        const target=importedByteTarget(imported.handle,progress.progress),index=Math.min(imported.handle.chunkCount-1,saved?.chunkIndex??target.chunkIndex);
        await imported.ensure(index);if(disposed)return;
        const anchor=saved?{...saved,chunkIndex:index}:{marker:imported.handle.marker,chunkIndex:index,charOffset:importedCharForByte(imported.text(index)??"",target.byteOffset),fraction:0};
        scroller.scrollTo(!saved&&progress.progress<=0?0:imported.offset(anchor,headerHeight(),max()),{immediate:true});
        lastOffset=scroller.offset();setRestored(true);setPlaying(props.autoStart,false);return;
      }
      pendingProgress=progress;setProgressLoaded(true);restoreProgress();
    }).catch(error=>{if(!disposed){if(!importedReadFailed){setProgressLoaded(true);setRestored(true);}reportImportedError(error);}});
  });
  onFrame(()=>{
    const now=Date.now();
    if(!restored()||!props.active||!foreground){lastFrame=0;autoPages.reset();return;}
    // Publish another shaped prefix before the drag reaches its current end.
    // Only one prefix preparation runs; later native replies remain available.
    if(!imported&&!props.pageMode&&!nativeReady()&&!prefixPreparing&&latestNativeLayouts.size>nativeLayouts().size&&scroller.offset()+props.height+80>=headerHeight()+layout().height)setNativeLayouts(latestNativeLayouts);
    if(props.pageMode){
      if(autoPages.tick(now,playing()&&bookPage()?.loading===undefined,props.pageSeconds??5)){if(!turnBookPage(1,false)||bookPageIndex()===bookPages().length-1)setPlaying(false);}
      if(!tapTimer&&now-pageTurnAt>=100&&now-lastSave>=1000)void save();
      return;
    }
    if(imported&&!props.pageMode){
      const target=props.speechPlaying&&Date.now()-lastManualScroll()>=3000?props.highlight?.importedChunkIndex:undefined;
      const load=target!==undefined&&imported.text(target)===undefined?imported.ensure(target):imported.visible(scroller.offset()-headerHeight(),props.height);
      void load.catch(error=>{if(!disposed)reportImportedError(error);});
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
    foreground=event.state==="active";lastFrame=0;autoPages.reset();controller.setBackground(!foreground||!props.active);
    void syncAwake();
    if(!foreground)void save();
  });
  onCleanup(()=>{textCache.close();void awake.close();void save();disposed=true;restoreTimer?.cancel();imported?.close();for(const task of importedTasks)task.cancel();removeLifecycle();removeCheckpoint();controller.pause();scroller.stop();if(tapTimer)tapTimer();if(feedbackTimer)feedbackTimer();});
  function makeEntry(initial:ReaderRow):PositionedScrollEntry {return {top:initial.top,key:readerRowKey(initial),data:initial,height:initial.height,retain:initial.kind==="text",onPress:initial.kind==="text"?tap:undefined,render:(current?:()=>ScrollEntry)=>{const raw=()=>current?.().data as ReaderRow??initial;const row=createMemo(raw);const textRow=()=>row() as Extract<ReaderRow,{kind:"text"}>;return initial.kind==="text"?<>{(()=>{const rect=highlightRects().get(raw());return rect?<View debugName="SpeechBodyHighlight" class="absolute" style={{insetL:rect.left,insetT:rect.top,width:rect.width,height:rect.height,bgColor:props.highlightColor??"#ff651557"}}/>:null;})()}<ReaderTextRow cache={textCache} top={textRow().gap} environment={textEnvironment()} row={textRow()} style={blocks()[textRow().blockIndex]?.type==="text"?(blocks()[textRow().blockIndex] as ContentBlock & {type:"text"}).style:"body"} fontSize={props.fontSize} width={props.width-28} preset={props.preset} fonts={fonts()} onCarets={(positions,owner)=>setSystemCarets(previous=>updateSystemCarets(previous,owner,positions))}/></>:(()=>{const row=createWindowValue(()=>raw() as Exclude<ReaderRow,{kind:"text"}>);return <View onPress={()=>{if(props.active){handle.pause();props.onMedia(row.block);}}} focusable class="absolute left-[0] right-[0] bg-[#161616]" style={{insetT:row.gap,height:row.height-row.gap}}>
      {row.kind==="image"?<RemoteImage inline url={resolveUrl(row.block.url,props.baseUrl)??""} filePath={props.offlineMedia?.[row.block.url]} width={props.width-28} height={row.height-row.gap} fit="contain" onSize={(width,height)=>untrack(()=>{const ratio=width/height;if(Number.isFinite(ratio)&&ratio>0&&readerMediaRatio(row.block,ratios()[row.blockIndex])!==ratio)setRatios({...ratios(),[row.blockIndex]:ratio});})}/>:<>{row.block.type==="video"&&row.block.poster?<RemoteImage url={resolveUrl(row.block.poster,props.baseUrl)??""} filePath={props.offlineMedia?.[row.block.poster]} width={props.width-28} height={row.height-row.gap} fit="contain" onSize={(width,height)=>untrack(()=>{const ratio=width/height;if(Number.isFinite(ratio)&&ratio>0&&readerMediaRatio(row.block,ratios()[row.blockIndex])!==ratio)setRatios({...ratios(),[row.blockIndex]:ratio});})}/>:null}<Image src="../assets/icons/play-circle.svg" class="absolute w-[24] h-[24]" style={{insetL:(props.width-28-24)/2,insetT:(row.height-row.gap-24)/2}}/></>}
    </View>;})();}};}
  const indexedEntries=createMemo<IndexedScrollEntries>(()=>{
    const snapshot=prepared();
    if(snapshot&&!imported)return snapshot;
    const entries=layout().rows.map(makeEntry),indices=new Map<string,number>();
    entries.forEach((entry,index)=>indices.set(entry.key as string,index));
    return {entries,indices,scope:blocks()};
  });
  return <View debugName="ReaderViewport" class="absolute left-[0] right-[0]" style={{insetT:props.top??40,height:props.height,bgColor:props.preset?readerColor(props.preset.background.colorArgb):"#000000"}}>
    {props.preset&&<ReaderBackground background={props.preset.background} snapshot={backgrounds()} width={props.width} height={props.height} active={props.active}/>}
    <Show when={props.pageMode} fallback={<>
    <ScrollEntries retainRows={0} minRows={Math.ceil((props.height+160)/Math.max(1,props.fontSize*(props.preset?.body.lineHeightEm??1.35)))+4} recycleKey={entry=>(entry.data as ReaderRow|undefined)?.kind==="text"?"reader-text":undefined} entryEquals={(a,b)=>!!a.data&&!!b.data&&a.key===b.key&&a.top===b.top&&a.height===b.height&&a.data===b.data&&a.onPress===b.onPress} onManualScroll={manualScroll} onScrollStateChange={moving=>{setScrolling(moving);props.onMoving?.(moving);if(moving&&!followingSpeech)manualScroll();}} controller={scroller} height={props.height} padding={14} verticalPadding={0} gap={0} inputActive={()=>props.active&&restored()} onLongPress={props.onSpeechControls?contact=>{if(tapTimer){tapTimer();tapTimer=undefined;}handle.pause();const anchor=pressedSpeechAnchor(layout(),blocks(),contact.startX-(props.touchOrigin?.left??0),contact.startY-(props.touchOrigin?.top??0)-(props.top??40),scroller.offset(),headerHeight(),props.width,(text,slot)=>getOps().measureText(text,slot),14,systemCarets());if(anchor?.contentBlockIndex!==undefined)appLogger.d("ReadAloudTouch",`${imported?"imported chunk":"content block"}=${anchor.contentBlockIndex} position=Offset(${contact.startX}, ${contact.startY-(props.top??40)}) offset=${anchor.contentCharOffset??null} text=<redacted>`);props.onSpeechControls?.(imported&&anchor?.contentBlockIndex!==undefined?{importedChunkIndex:anchor.contentBlockIndex,importedCharOffset:anchor.contentCharOffset??0}:anchor);}:undefined} entries={props.header??[]} footerEntries={footerReady()?props.footer??[]:[]} indexedEntries={indexedEntries()}/>
    </>}><Show when={restored()?bookPage():undefined}>{page=><ReaderBookPage page={page()} width={props.width} height={props.height} round={round()} active={props.active&&restored()} touchOrigin={props.touchOrigin} header={props.header??[]} footer={props.footer??[]} blocks={blocks()} preset={props.preset} fontSize={props.fontSize} fonts={fonts()} environment={textEnvironment()} offlineMedia={props.offlineMedia} baseUrl={props.baseUrl} onImageSize={(index,width,height)=>untrack(()=>{const block=blocks()[index];if(!block||block.type==="text")return;const ratio=width/height;if(Number.isFinite(ratio)&&ratio>0&&readerMediaRatio(block,ratios()[index])!==ratio)setRatios({...ratios(),[index]:ratio});})} onTap={direction=>tap(direction)} onMedia={props.onMedia} onLongPress={props.onSpeechControls?line=>{if(tapTimer){tapTimer();tapTimer=undefined;}handle.pause();const start=line?{blockIndex:line.row.blockIndex,sourceStart:line.row.sourceStart??0}:bookPage()!.anchor;props.onSpeechControls?.(imported?{importedChunkIndex:start.blockIndex,importedCharOffset:start.sourceStart}:{contentBlockIndex:start.blockIndex,contentCharOffset:start.sourceStart});}:undefined}/>}</Show></Show>

    <View class="absolute h-[18] items-center justify-center" style={{insetL:(props.width-Math.min(160,props.width-24))/2,width:Math.min(160,props.width-24),...(props.pageMode?{insetT:props.height/2-9}:{insetB:0}),opacity:feedback()?1:0}}><Text class="text-xs text-[#45d6a7]">{feedback()}</Text></View>
  </View>;
}

export function ReaderBody(props:Parameters<typeof ReaderBodyImpl>[0]) {return traceServiceWork("reader.ReaderBody",()=>ReaderBodyImpl(props));}
