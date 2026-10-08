import {traceServiceWork} from '@podjs/framework/service-trace';
import {prepareTextLayout} from '@podjs/framework/text-layout';
import {prepareNotePreviewSteps,noteBlockSourceOffsets,type NotePreviewBlock} from '../notes/preview.ts';
import {modalInputKey} from './modal-input.ts';
import {restoredSignal,booleanState} from './route-activity.tsx';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('NotesScreen');
import {notePreviewEntrySteps,type NotePreviewEntry} from './NotePreview.tsx';
import {createKeyedMemo} from '@podjs/framework/keyed-memo';
import {noteImageDisplayHeight,noteTextRows} from '../notes/presentation.ts';
import type {ModalInput,ModalInputRecovery} from './service.ts';
import {noteBodyLayoutSteps} from '../notes/native-layout-input.ts';
import { For, Show, createEffect, createMemo, createSignal, untrack, onMount, onCleanup, on } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { centredBounds, textWidthBound } from "./round-bounds.ts";
import { DownloadPhoneAppDialog } from "./DownloadPhoneAppDialog.tsx";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { NOTE_LIST_LAYOUT, noteAtLongPress } from "./note-list-hit.ts";
import { measuredLines, watchTitleLines } from "../reader/measured-text.ts";
import { getOps } from "@pocketjs/framework/host";
import { NoteInlineEditor, type NoteInlineEditorHandle } from "./NoteInlineEditor.tsx";
import type { MemoFolder, MemoNote } from "../notes/types.ts";
import type { MemoRepository } from "../notes/repository.ts";
import { noteMetadata } from "../notes/metadata.ts";
import { noteEditorAnchor } from "../notes/editor-anchor.ts";
import { ReaderBackground } from "./ReaderBackground.tsx";
import { presetContentFont, readerColor } from "../reader/content-layout.ts";
import { getDisplayMetrics, hasCapability } from "@podjs/framework/watch";
import { textLayout } from "@podjs/framework/services";
import { requestReaderLayoutBatched } from "../reader/platform-layout.ts";
import type { NativeBlockLayouts, ParagraphLine } from "../reader/content-layout.ts";
import { useReaderFonts } from "./reader-fonts.ts";
import { SystemTextLine } from "@podjs/framework/text";
import { resolvedReaderStyle, type ReaderPreset } from "../reader/preset.ts";
import type { ReaderBackgroundSnapshot } from "../reader/background-assets.ts";

export type NotesInput = ModalInput;
interface BaseProps { repository: MemoRepository; height:number; width:number; onError?:(message:string)=>void }
const fail = (props: BaseProps, error: unknown) => props.onError?.(error instanceof Error ? error.message : String(error));
function preview(note: MemoNote): string { const lines=note.plainText.split("\n").map(v=>v.trim()).filter(Boolean); if(lines[0]===note.title.trim()) lines.shift(); return lines.join(" ").slice(0,120)||"暂无摘要"; }

export interface NotesListScreenProps extends BaseProps {
  onOpenNote:(noteId:string)=>void; onCreateNote:()=>void; onOpenActions:(noteId:string)=>void;
  refreshKey?:number;
  ref?:(value:{scroller:Scroller})=>void;
}
export function NotesListScreen(props: NotesListScreenProps) {
  const [notes,setNotes]=createSignal<MemoNote[]>([]), [loaded,setLoaded]=createSignal(false);
  const [download,setDownload]=createSignal(false);
  let scroller:Scroller|undefined;let roundStart=()=>0;
  const {padding, verticalPadding, gap, headerHeight, promptHeight}=NOTE_LIST_LAYOUT;
  const phonePrompt=()=>measuredLines("下载手机端app以在手机上编辑和同步内容",props.width-2*padding-20,text=>getOps().measureText(text,22),2).join("\n");
  let readVersion=0,disposed=false;
  onCleanup(()=>{disposed=true;readVersion++;});
  const load=async()=>{const version=++readVersion;try{const value=await props.repository.list();if(!disposed&&version===readVersion)setNotes(value);}catch(e){if(!disposed&&version===readVersion)fail(props,e);}finally{if(!disposed&&version===readVersion)setLoaded(true);}};
  onMount(()=>void load());
  createEffect(on(()=>props.refreshKey,()=>void load(),{defer:true}));
  const cardLayouts=createMemo(()=>notes().map(note=>{
    const textWidth=props.width-2*padding-24;
    const title=measuredLines(note.title||"未命名笔记",textWidth,text=>getOps().measureText(text,22),2);
    const summary=measuredLines(preview(note),textWidth,text=>getOps().measureText(text,1),2);
    return {note,title,summary,height:13+title.length*21+2+summary.length*19+14};
  }));
  const card=(layout:ReturnType<typeof cardLayouts>[number]):ScrollEntry=>({height:layout.height,render:()=> <View onPress={()=>props.onOpenNote(layout.note.noteId)} focusable accessibilityRole="button" accessibilityLabel={`备忘录：${layout.note.title||"未命名笔记"}`} accessibilityHint="长按打开操作" class={layout.note.pinned?"absolute inset-0 rounded-[16] bg-[#333333]":"absolute inset-0 rounded-[16] bg-[#1c1f21]"}>
    <Text class="absolute left-[14] right-[10] top-[13] overflow-hidden text-[17px] leading-[21] text-[#f5f5f5]" style={{height:layout.title.length*21}}>{layout.title.join("\n")}</Text>
    <Text class="absolute left-[14] right-[10] overflow-hidden text-sm leading-[19] text-[#b6b6b6]" style={{insetT:15+layout.title.length*21,height:layout.summary.length*19}}>{layout.summary.join("\n")}</Text>
  </View>});
  const entries=createMemo<ScrollEntry[]>(()=>[
    {height:headerHeight,bounds:centredBounds(props.width-2*padding,Math.max(textWidthBound("备忘录",21),textWidthBound(`${notes().length} 条备忘录`,9)),9,45),render:()=> <View class="absolute inset-0"><Text class="absolute top-[9] text-[21px] leading-[26] text-center text-[#f5f5f5]" style={{width:props.width-2*padding}}>备忘录</Text><Text class="absolute top-[37] text-[9px] leading-[17] text-center text-[#b6b6b6]" style={{width:props.width-2*padding}}>{notes().length} 条备忘录</Text></View>},
    {height:promptHeight,render:()=> <View onPress={()=>setDownload(true)} focusable accessibilityRole="button" accessibilityLabel="下载手机端app以在手机上编辑和同步内容" style={{insetT:-0.5,height:57}} class="absolute left-[0] right-[0] rounded-[16] bg-[#2a2a2a]"><Text class="absolute left-[10] right-[10] top-[10] text-[17px] leading-[20] text-[#f5f5f5]">{phonePrompt()}</Text></View>},
    ...(!notes().length?[{height:30,render:()=> <Text class="absolute left-[0] right-[0] top-[20] text-sm text-center text-[#b6b6b6]">暂无内容</Text>}]:[]),
    ...cardLayouts().map(card),
    {height:56,bounds:centredBounds(props.width-2*padding,44,4.5,44),render:()=> <View class="absolute inset-0 items-center"><View onPress={props.onCreateNote} focusable accessibilityRole="button" accessibilityLabel="新建备忘录" style={{insetL:(props.width-36-44)/2-0.5,insetT:4.5}} class="absolute w-[44] h-[44] rounded-[47] bg-[#23272a] items-center justify-center"><Image src="../assets/icons/speech-plus.svg" class="w-[24] h-[24]"/></View></View>}
  ]);
  const onLongPress=(screenX:number,screenY:number)=>{
    const note=noteAtLongPress(notes(),screenX,screenY-roundStart(),props.width,scroller?.offset()??0,cardLayouts().map(card=>card.height));
    if(note)props.onOpenActions(note.noteId);
  };
  const onTap=(screenX:number,screenY:number)=>{
    const contentY=screenY-roundStart()+(scroller?.offset()??0);
    const promptTop=verticalPadding+headerHeight+gap;
    if(screenX>=padding&&screenX<props.width-padding&&contentY>=promptTop&&contentY<promptTop+promptHeight-gap){
      queueMicrotask(()=>setDownload(true));
      return true;
    }
    const note=noteAtLongPress(notes(),screenX,screenY-roundStart(),props.width,scroller?.offset()??0,cardLayouts().map(card=>card.height));
    if(!note)return false;
    queueMicrotask(()=>props.onOpenNote(note.noteId));
    return true;
  };
  return <Show when={loaded()} fallback={<View class="absolute inset-0 items-center justify-center"><Text class="text-sm text-[#b6b6b6]">加载中…</Text></View>}><View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} gap={gap} padding={padding} verticalPadding={verticalPadding} inputActive={()=>!download()} onTap={contact=>onTap(contact.x,contact.y)} onLongPress={contact=>onLongPress(contact.x,contact.y)} ref={handle=>{scroller=handle.scroller;roundStart=()=>handle.roundInsets?.().start??0;props.ref?.(handle);}}/>
    <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="同步备忘录" onDismiss={()=>setDownload(false)} onError={message=>props.onError?.(message)}/></Show>
  </View></Show>;
}

export interface NoteDetailHandle { scroller?:Scroller; goBack:()=>boolean }
export interface NoteDetailScreenProps extends BaseProps { onNoteIdentity?:(id:string)=>void; noteId?:string; refreshKey?:number; input:NotesInput; inputRecovery?:ModalInputRecovery; onImage?:(path:string)=>void; onBack:()=>void; preset?:ReaderPreset; backgroundSnapshot?:ReaderBackgroundSnapshot; active?:boolean; ref?:(value:NoteDetailHandle)=>void }
interface NoteHeaderLayout {title:number;subtitle:number;titleLines:readonly ParagraphLine[];subtitleLines:readonly ParagraphLine[]}
export function NoteDetailScreen(props: NoteDetailScreenProps) {
  const [createMode,setCreateMode]=restoredSignal('retained','note-create-mode',!props.noteId,booleanState);
  const createdHere=createMode(),inputKey=modalInputKey("note");
  const [note,setNote]=createSignal<MemoNote|null>(null), [loaded,setLoaded]=createSignal(!props.noteId), [editing,setEditing]=createSignal(!props.noteId),[editorSeed,setEditorSeed]=createSignal<MemoNote|null>(null);
  const [download,setDownload]=createSignal(false);
  const [imageHeights,setImageHeights]=createSignal<ReadonlyMap<string,number>>(new Map());
  const fonts=useReaderFonts();
  const [nativeBody,setNativeBody]=createSignal<ReadonlyMap<string,readonly ParagraphLine[]>>(new Map());
  const [nativeHeader,setNativeHeader]=createSignal<NoteHeaderLayout|undefined>();
  const previewCache=createKeyedMemo<string>();
  const [previewRows,setPreviewRows]=createSignal<NotePreviewEntry[]>([]);
  const previewIndexed=createMemo(()=>{let top=0;const indices=new Map<unknown,number>();const entries=previewRows().map((entry,index)=>{const key=entry.key??entry;indices.set(key,index);const row={...entry,key,top};top+=entry.height;return row;});return {entries,indices,scope:previewCache};});
  const [preparedSource,setPreparedSource]=createSignal<string>();
  const [sourcePrefix,setSourcePrefix]=createSignal<{source:string;blocks:NotePreviewBlock[];offsets:(number|null)[]}>();
  let previewSource:string|undefined,previewReady=false;
  const openDownload=()=>setDownload(true);
  const imageSize=(path:string,width:number,height:number)=>{const next=noteImageDisplayHeight(props.width-28,width,height);if(imageHeights().get(path)!==next)setImageHeights(previous=>new Map(previous).set(path,next));};
  onCleanup(()=>previewCache.clear());
  createEffect(()=>{
    const current=note(),active=props.active!==false&&!editing();
    if(previewSource!==current?.markdown){previewSource=current?.markdown;previewReady=false;previewCache.clear();setPreviewRows([]);setPreparedSource(undefined);setSourcePrefix(undefined);}
    if(!current||!active||previewReady)return;
    let work=0;
    const task=prepareTextLayout(prepareNotePreviewSteps(current.markdown,1200,blocks=>traceServiceWork('note.sourcePrefix',()=>setSourcePrefix({source:current.markdown,blocks,offsets:noteBlockSourceOffsets(current.markdown,blocks)}),blocks.length)),{key:()=>work++,entry:()=>undefined,publish:snapshot=>{
      previewReady=true;const blocks=snapshot.layout;previewCache.get('parse',[current.markdown],()=>({blocks,offsets:noteBlockSourceOffsets(current.markdown,blocks)}));setPreparedSource(current.markdown);
    }},{traceLabel:'note.sourceSlice',budgetMs:2});
    void task.done.catch(error=>logConsole.warn('Note parse',String(error)));onCleanup(()=>task.cancel());
  });
  createEffect(()=>{
    const current=note(),prepared=preparedSource(),prefix=sourcePrefix(),native=nativeBody(),heights=imageHeights(),preset=props.preset;
    if(!current||(prepared!==current.markdown&&prefix?.source!==current.markdown)||props.active===false||editing())return;
    const task=prepareTextLayout(notePreviewEntrySteps(current.markdown,props.width-28,props.onImage,preset,native,openDownload,heights,imageSize,previewCache,prepared===current.markdown?undefined:prefix),{key:entry=>entry,entry:entry=>entry,preview:{rows:16,publish:snapshot=>{if(!untrack(previewRows).length)traceServiceWork('note.previewPrefix',()=>setPreviewRows(snapshot.entries),snapshot.entries.length);}},
      publish:snapshot=>traceServiceWork('note.previewComplete',()=>setPreviewRows(snapshot.entries),snapshot.entries.length)},{traceLabel:'note.previewSlice'});
    void task.done.catch(error=>logConsole.warn('Note preview layout',String(error)));
    onCleanup(()=>task.cancel());
  });
  createEffect(()=>{
    const current=note(),prepared=preparedSource(),preset=props.preset,width=props.width-28,resolveFont=fonts();
    setNativeBody(new Map());
    if(!current||prepared!==current.markdown||!preset||props.active===false||editing()||!hasCapability('text.layout'))return;
    const metrics=getDisplayMetrics(),scale=metrics.physicalWidth/metrics.logicalWidth;
    let bodyTask:ReturnType<typeof requestReaderLayoutBatched>|undefined,cancelled=false;
    let completeLayouts:NativeBlockLayouts|undefined;
    const steps=(function*(){
      const prepared=previewCache.peek<{blocks:NotePreviewBlock[]}>('parse',[current.markdown])!;
      yield* noteBodyLayoutSteps(current.markdown,prepared.blocks,(block,index)=>previewCache.get('text:'+index,[block],()=>noteTextRows(block.markup,block.html)));
    })();
    const bodyPrepare=prepareTextLayout(steps,{key:block=>block.text,entry:block=>block,publish:({entries:bodyBlocks})=>{
      if(!bodyBlocks.length)return;
      bodyTask=requestReaderLayoutBatched(bodyBlocks,width,preset.body.fontSizeSp,scale,preset,args=>textLayout.layoutBatch(args),layouts=>{
        completeLayouts=layouts;
      },error=>logConsole.warn('Note body layout',String(error)),resolveFont,{firstBlocks:4,batchBlocks:16});
      // Keep the first fallback preview running while host batches arrive.
      // Reflow once at completion, including valid neighbors of failed inputs.
      void bodyTask.done.then(()=>{
        if(cancelled||!completeLayouts)return;
        const byText=new Map<string,readonly ParagraphLine[]>();
        for(const block of bodyBlocks){const lines=completeLayouts.get(block);if(lines?.length)byText.set(block.text,lines);}
        setNativeBody(byText);
      });
    }},{traceLabel:'note.bodyInputSlice'});
    void bodyPrepare.done.catch(error=>logConsole.warn('Note body prepare',String(error)));
    onCleanup(()=>{cancelled=true;bodyPrepare.cancel();bodyTask?.cancel();});
  });
  createEffect(()=>{
    const current=note(),preset=props.preset,width=props.width-28,resolveFont=fonts();
    setNativeHeader(undefined);
    if(!current||!preset||props.active===false||editing()||!hasCapability('text.layout'))return;
    const titleStyle=presetContentFont(preset,'title');
    const titleLines=watchTitleLines(current.title||'未命名笔记',width,value=>getOps().measureText(value,titleStyle.fontSlot)*titleStyle.scale);
    const titleBlock={type:'text' as const,style:'title' as const,text:titleLines.join('\n')};
    const subtitleBlock={type:'text' as const,style:'subtitle' as const,text:noteMetadata(current)};
    const metrics=getDisplayMetrics(),scale=metrics.physicalWidth/metrics.logicalWidth;
    const headerTask=requestReaderLayoutBatched([titleBlock,subtitleBlock],width,preset.body.fontSizeSp,scale,preset,args=>{args[0]!.widthPx=Math.ceil(Math.min(190,width)*scale);args[0]!.align='center';return textLayout.layoutBatch(args);},layouts=>{
      const title=layouts.get(titleBlock),subtitle=layouts.get(subtitleBlock);
      if(title?.every(line=>line.height!==undefined)&&subtitle?.every(line=>line.height!==undefined))setNativeHeader({title:title.reduce((sum,line)=>sum+line.height!,0),subtitle:subtitle.reduce((sum,line)=>sum+line.height!,0),titleLines:title,subtitleLines:subtitle});
    },error=>logConsole.warn('Note header layout',String(error)),resolveFont,{firstBlocks:2,batchBlocks:2});
    onCleanup(()=>headerTask.cancel());
  });
  const [editButtonVisible,setEditButtonVisible]=createSignal(true);
  const [editorAnchor,setEditorAnchor]=createSignal<number|undefined>();
  const titleColor=()=>props.preset?readerColor(resolvedReaderStyle(props.preset,"title").colorArgb):"#f5f5f5";
  const subtitleColor=()=>props.preset?readerColor(resolvedReaderStyle(props.preset,"subtitle").colorArgb):"#b6b6b6";
  const bodyColor=()=>props.preset?readerColor(props.preset.body.colorArgb):"#ffffff";
  const editBackground=()=>bodyColor().slice(0,7)+"24";
  const titleFont=()=>props.preset?presetContentFont(props.preset,"title"):{fontSlot:23,scale:1,lineHeight:25};
  const subtitleFont=()=>props.preset?presetContentFont(props.preset,"subtitle"):{fontSlot:0,scale:1,lineHeight:22};
  let editorClose=()=>{};
  let readVersion=0,disposed=false;
  onCleanup(()=>{disposed=true;readVersion++;});
  async function reload(id:string){const version=++readVersion;try{const value=await traceServiceWork('note.readRequest',()=>props.repository.get(id));if(!disposed&&version===readVersion)traceServiceWork('note.setNote',()=>setNote(value));}catch(e){if(!disposed&&version===readVersion)fail(props,e);}}
  const edit=()=>{const current=note();setEditorSeed(current);setEditorAnchor(current?noteEditorAnchor(entries(),current.markdown,readerScroller.offset(),props.width,props.height,(text,slot)=>getOps().measureText(text,slot),{top:22,gap:0,horizontalInset:14}):undefined);setEditing(true);};
  const goBack=()=>{if(!editing())return false;editorClose();return true;};
  onMount(async()=>{setCreateMode(createdHere);try{if(props.noteId)await reload(props.noteId);}catch(e){if(!disposed)fail(props,e);}finally{if(!disposed)setLoaded(true);}});
  let modalRecoveryChecked=false;
  createEffect(()=>{
    if(!loaded()||editing()||props.active===false||!note()||!inputKey||!props.inputRecovery||modalRecoveryChecked)return;
    modalRecoveryChecked=true;
    void Promise.all(['title','body'].map(part=>props.inputRecovery!.pending(`${inputKey}:${part}`))).then(pending=>{
      if(!disposed&&props.active!==false&&!editing()&&note()&&pending.some(Boolean)){setEditorSeed(note());setEditing(true);}
    }).catch(()=>{});
  });
  createEffect(on(()=>props.refreshKey,()=>{if(!editing()&&props.noteId)void reload(props.noteId);},{defer:true}));
  const entries=createMemo<ScrollEntry[]>(()=>{ const n=note(); if(!n)return[]; const titleStyle=titleFont(),subtitleStyle=subtitleFont(),contentWidth=props.width-28,titleWidth=Math.min(190,contentWidth);const titleLines=watchTitleLines(n.title||"未命名笔记",contentWidth,value=>getOps().measureText(value,titleStyle.fontSlot)*titleStyle.scale);const measured=nativeHeader(),titleHeight=Math.max(32,measured?.title??titleLines.length*titleStyle.lineHeight),subtitleHeight=Math.max(22,measured?.subtitle??subtitleStyle.lineHeight),pixelScale=getDisplayMetrics().physicalWidth/getDisplayMetrics().logicalWidth;return [
    {height:titleHeight,render:()=>measured?.titleLines.length&&hasCapability('text.raster')?<View class="absolute top-[0] bottom-[0]" style={{insetL:(contentWidth-titleWidth)/2,width:titleWidth}}>{measured.titleLines.map((line,index)=>{const text=titleLines.join('\n').slice(line.start,line.visibleEnd),top=measured.titleLines.slice(0,index).reduce((sum,value)=>sum+(value.height??0),0),height=line.height??titleStyle.lineHeight;return <View class="absolute left-[0] right-[0]" style={{insetT:top,height}}><SystemTextLine pixelScale={pixelScale} options={{...line.paragraph,text,widthPx:Math.ceil(titleWidth*pixelScale),heightPx:Math.ceil(height*pixelScale),baselinePx:Math.ceil((line.baseline??height*.8)*pixelScale),fontSizePx:line.paragraph?.fontSizePx??titleStyle.scale*21.7*pixelScale,align:'center',paragraph:line.paragraph}} fallback={<Text class="absolute text-center" style={{width:titleWidth/titleStyle.scale,height:height/titleStyle.scale,fontSlot:titleStyle.fontSlot,scale:titleStyle.scale,originX:-.5,originY:-.5,lineHeight:height/titleStyle.scale,textColor:titleColor()}}>{text}</Text>}/></View>;})}</View>:<Text class={getDisplayMetrics().shape==="round"?"absolute text-center":"absolute"} style={{insetL:(contentWidth-titleWidth)/2,width:titleWidth/titleStyle.scale,height:titleHeight/titleStyle.scale,fontSlot:titleStyle.fontSlot,scale:titleStyle.scale,originX:-.5,originY:-.5,lineHeight:titleStyle.lineHeight/titleStyle.scale,textColor:titleColor()}}>{titleLines.join("\n")}</Text>},
    {height:10,render:()=>null},
    {height:subtitleHeight,render:()=>measured?.subtitleLines.length&&hasCapability('text.raster')?<View class="absolute inset-0">{measured.subtitleLines.map((line,index)=>{const text=noteMetadata(n).slice(line.start,line.visibleEnd),top=measured.subtitleLines.slice(0,index).reduce((sum,value)=>sum+(value.height??0),0),height=line.height??subtitleStyle.lineHeight;return <View class="absolute left-[0] right-[0]" style={{insetT:top,height}}><SystemTextLine pixelScale={pixelScale} options={{...line.paragraph,text,widthPx:Math.ceil(contentWidth*pixelScale),heightPx:Math.ceil(height*pixelScale),baselinePx:Math.ceil((line.baseline??height*.8)*pixelScale),fontSizePx:line.paragraph?.fontSizePx??subtitleStyle.scale*18*pixelScale,paragraph:line.paragraph}} fallback={<Text class="absolute" style={{width:contentWidth/subtitleStyle.scale,height:height/subtitleStyle.scale,fontSlot:subtitleStyle.fontSlot,scale:subtitleStyle.scale,originX:-.5,originY:-.5,lineHeight:height/subtitleStyle.scale,textColor:subtitleColor()}}>{text}</Text>}/></View>;})}</View>:<Text class="absolute" style={{width:contentWidth/subtitleStyle.scale,height:subtitleHeight/subtitleStyle.scale,fontSlot:subtitleStyle.fontSlot,scale:subtitleStyle.scale,originX:-.5,originY:-.5,lineHeight:subtitleStyle.lineHeight/subtitleStyle.scale,textColor:subtitleColor()}}>{noteMetadata(n)}</Text>},
    {height:10,render:()=>null},
    ...previewRows(),
    {height:42,render:()=>null}
  ]; });
  const readerScroller=createScroller({max:()=>Math.max(0,44+entries().reduce((sum,row)=>sum+row.height,0)-props.height)});
  return <Show when={loaded()} fallback={<View class="absolute inset-0 items-center justify-center"><Text class="text-sm text-[#b6b6b6]">加载中…</Text></View>}><Show when={editing()} fallback={<Show when={note()} fallback={<View class="absolute inset-0 items-center justify-center"><Text class="text-sm text-[#b6b6b6]">备忘录不存在</Text></View>}><View class="absolute inset-0">{props.preset&&props.backgroundSnapshot&&<ReaderBackground background={props.preset.background} snapshot={props.backgroundSnapshot} width={props.width} height={props.height} active={props.active??true}/>}<ScrollEntries controller={readerScroller} height={props.height} entries={entries().slice(0,4)} indexedEntries={previewIndexed()} footerEntries={entries().slice(-1)} padding={14} verticalPadding={22} gap={0} inputActive={()=>!download()} onOffsetChange={(previous,current)=>setEditButtonVisible(current<=0||current<previous)} ref={value=>props.ref?.({...value,goBack})}/><Show when={editButtonVisible()}><View class="absolute left-[0] right-[0] bottom-[0] h-[56] items-center justify-center"><View onPress={edit} focusable accessibilityRole="button" accessibilityLabel="编辑备忘录" class="h-[32] w-[44] rounded-[47] items-center justify-center" style={{bgColor:editBackground()}}><Text class="text-sm" style={{textColor:bodyColor()}}>编辑</Text></View></View></Show><Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation="同步备忘录" onDismiss={()=>setDownload(false)} onError={message=>props.onError?.(message)}/></Show></View></Show>}>
    <NoteInlineEditor width={props.width} height={props.height} repository={props.repository} initial={editorSeed()} initialSelection={editorAnchor()} active={props.active} fallbackInput={props.input} inputRecovery={props.inputRecovery} onSaved={saved=>{setNote(saved);props.onNoteIdentity?.(saved.noteId);}} onClose={saved=>{if(saved)setNote(saved);readerScroller.scrollTo(readerScroller.offset(),{immediate:true});setEditorAnchor(undefined);if(!createdHere){setEditButtonVisible(true);setEditing(false);}else props.onBack();}} onError={message=>props.onError?.(message)} ref={(value:NoteInlineEditorHandle)=>{editorClose=value.close;props.ref?.({goBack});}}/>
  </Show></Show>;
}

export interface NoteActionsHandle { scroller:Scroller; goBack:()=>boolean }
export interface NoteActionsScreenProps extends BaseProps { noteId:string; refreshKey?:number; onDone:()=>void; ref?:(value:NoteActionsHandle)=>void }
export function NoteActionsScreen(props: NoteActionsScreenProps) {
  const [note,setNote]=createSignal<MemoNote|null>(null), [folders,setFolders]=createSignal<MemoFolder[]>([]), [selectingFolder,setSelectingFolder]=createSignal(false), [confirmDelete,setConfirmDelete]=createSignal(false), [busy,setBusy]=createSignal(false);
  let readVersion=0,disposed=false;
  onCleanup(()=>{disposed=true;readVersion++;});
  const reload=async()=>{const version=++readVersion;try{const [value,groups]=await Promise.all([props.repository.get(props.noteId),props.repository.listFolders()]);if(disposed||version!==readVersion)return;setNote(value);setFolders(groups);if(!value){setSelectingFolder(false);setConfirmDelete(false);}}catch(e){if(!disposed&&version===readVersion)fail(props,e);}};
  onMount(()=>void reload());
  createEffect(on(()=>props.refreshKey,()=>void reload(),{defer:true}));
  const act=async(operation:()=>Promise<unknown>)=>{if(busy())return;setBusy(true);try{await operation();props.onDone();}catch(e){fail(props,e);}finally{if(!disposed)setBusy(false);}};
  const button=(label:string,onPress:()=>void,danger=false,enabled=true)=><View onPress={enabled&&!busy()?onPress:undefined} focusable={enabled&&!busy()} accessibilityRole="button" accessibilityLabel={label} style={{insetL:(props.width-160)/2-9}} class="absolute top-[0] w-[160] h-[48] rounded-[47] bg-[#2a2a2a] items-center justify-center"><Text class={danger?"text-[17px] leading-[23px] text-[#e54d4d]":enabled?"text-[17px] leading-[23px] text-[#f5f5f5]":"text-[17px] leading-[23px] text-[#999999]"}>{label}</Text></View>;
  // Visible content is the centred 160-wide pill, not the full 215-wide row.
  const pill={x:(props.width-160)/2-9,y:0,width:160,height:48};
  const entries=createMemo<ScrollEntry[]>(()=>{
    if(selectingFolder()) return [{height:48,bounds:pill,render:()=>button(note()?.folderId==null?"未分类（当前位置）":"未分类",()=>void act(()=>props.repository.move(props.noteId,null)),false,note()?.folderId!=null)},...folders().map(f=>({height:48,bounds:pill,render:()=>button(f.folderId===note()?.folderId?`${f.name}（当前位置）`:f.name,()=>void act(()=>props.repository.move(props.noteId,f.folderId)),false,f.folderId!==note()?.folderId)})),{height:48,bounds:pill,render:()=>button("返回",()=>setSelectingFolder(false))}];
    return [{height:48,bounds:pill,render:()=>button(note()?.pinned?"取消置顶":"置顶",()=>void act(()=>props.repository.setPinned(props.noteId,!note()?.pinned)),false,!!note())},{height:48,bounds:pill,render:()=>button("移动到…",()=>setSelectingFolder(true),false,!!note())},{height:48,bounds:pill,render:()=>button("删除",()=>setConfirmDelete(true),true,!!note())},{height:48,bounds:pill,render:()=>button("取消",props.onDone)}];
  });
  const goBack=()=>{if(confirmDelete()){setConfirmDelete(false);return true;}if(selectingFolder()){setSelectingFolder(false);return true;}return false;};
  return <View class="absolute inset-0 bg-black"><ScrollEntries height={props.height} entries={entries()} gap={8} padding={9} verticalPadding={22} inputActive={()=>!confirmDelete()&&!busy()} ref={value=>props.ref?.({...value,goBack})}/><Show when={confirmDelete()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除备忘录" message="删除后会从本机和下次同步中移除此备忘录" busy={busy()} onCancel={()=>setConfirmDelete(false)} onConfirm={()=>void act(()=>props.repository.delete(props.noteId))}/></Show></View>;
}

export const NotesScreen = NotesListScreen;
export default NotesListScreen;
