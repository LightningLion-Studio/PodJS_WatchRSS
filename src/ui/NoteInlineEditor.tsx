import {modalInputKey} from "./modal-input.ts";
import type {ModalInput,ModalInputRecovery} from "./service.ts";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import { delay, textInput } from "@podjs/framework/services";
import { safeTopBlock } from "@podjs/framework/watch-ui";
import { getDisplayMetrics, hasCapability, onLifecycleChange } from "@podjs/framework/watch";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { NoteDraftAutosave, type NoteDraftSaveState } from "../notes/draft-autosave.ts";
import { RawTextHistory } from "../notes/raw-text-history.ts";
import { noteMetadata } from "../notes/metadata.ts";
import type { MemoNote } from "../notes/types.ts";
import type { MemoRepository } from "../notes/repository.ts";

type InputSession={close():Promise<void>;setValue(value:string):Promise<void>};
export interface NoteInlineEditorHandle { close:()=>void }
export function NoteInlineEditor(props:{width:number;height:number;repository:MemoRepository;initial:MemoNote|null;initialSelection?:number;active?:boolean;fallbackInput:ModalInput;inputRecovery?:ModalInputRecovery;onSaved:(note:MemoNote)=>void;onCloseStart?:()=>void;onClose:(note:MemoNote|null)=>void;onError:(message:string)=>void;ref?:(handle:NoteInlineEditorHandle)=>void}){
  const [status,setStatus]=createSignal<NoteDraftSaveState>(props.initial?"saved":"empty");
  const draft=new NoteDraftAutosave(props.repository,props.initial,setStatus,props.onSaved,error=>props.onError(String(error)));
  const history=new RawTextHistory(draft.markdown);
  const [historyState,setHistoryState]=createSignal({undo:false,redo:false});
  const syncHistoryState=()=>setHistoryState({undo:history.canUndo,redo:history.canRedo});
  const changeMarkdown=(value:string)=>{history.record(value);draft.setMarkdown(value);syncHistoryState();};
  const changeHistory=(direction:"undo"|"redo")=>{
    if(direction==="undo"&&!history.canUndo||direction==="redo"&&!history.canRedo)return;
    const value=direction==="undo"?history.undo():history.redo();
    draft.setMarkdown(value);syncHistoryState();
    void bodyInput?.setValue(value).catch(error=>props.onError(String(error)));
  };
  onFrame(()=>draft.tick(),()=>draft.state==="pending");
  const removeLifecycle=onLifecycleChange(state=>{
    if(state!=="active"&&!closing)void draft.flush().catch(error=>props.onError(String(error)));
  });
  let titleInput:InputSession|undefined,bodyInput:InputSession|undefined,disposed=false,closing=false;
  const closeInputs=async()=>{await bodyInput?.close();await titleInput?.close();bodyInput=undefined;titleInput=undefined;};
  const close=async()=>{
    if(closing||disposed)return;closing=true;
    props.onCloseStart?.();
    const deadline=hasCapability("runtime.timer")?delay(5000):undefined;
    try{
      const saving=draft.flush();
      const note=deadline?await Promise.race([saving,deadline.result.then(()=>{throw new Error("备忘录保存超时，请重试");})]):await saving;
      await closeInputs();
      if(!disposed)props.onClose(note);
    }catch(error){closing=false;if(!disposed)props.onError(String(error));}
    finally{deadline?.cancel();}
  };
  props.ref?.({close:()=>void close()});
  const inputKey=modalInputKey("note");
  const modalOptions=(part:string)=>inputKey&&props.inputRecovery?{restorationKey:`${inputKey}:${part}`}:undefined;
  const live=()=>!disposed&&props.active!==false;
  const fallback=async(skipTitle=false)=>{
    if(!live())return;
    if(!skipTitle){
      const title=await props.fallbackInput("备忘录标题",draft.title,modalOptions('title'));
      if(!live())return;
      if(title!==null){draft.setTitle(title);try{await draft.flush();}catch(saveError){if(live())props.onError(String(saveError));return;}}
    }
    if(!live())return;
    const markdown=await props.fallbackInput("备忘录正文",draft.markdown,modalOptions('body'));
    if(!live())return;
    if(markdown!==null)changeMarkdown(markdown);
    await close();
  };
  onMount(async()=>{
    const inset=14,fieldWidth=props.width-2*inset,bodyTop=props.initial?108:80.5;
    const round=getDisplayMetrics().shape==="round";
    const title=round?safeTopBlock(props.width,props.height,()=>29.3,{minTop:42.5,maxWidth:fieldWidth}):undefined;
    const body=round?safeTopBlock(props.width,props.height,()=>24,{minTop:bodyTop,margin:9}):undefined;
    const bodyInset=Math.max(inset,body?.x??inset);
    const documentId="note-editor";
    const viewportHeight=Math.max(56,props.height-42-56);
    try{
      if(inputKey&&props.inputRecovery){
        const [titlePending,bodyPending]=await Promise.all([props.inputRecovery.pending(`${inputKey}:title`),props.inputRecovery.pending(`${inputKey}:body`)]);
        if(!live())return;
        if(titlePending||bodyPending){await fallback(bodyPending);return;}
      }
      titleInput=await textInput.openInline(draft.title,{x:inset,y:42.5,width:fieldWidth,height:29.3},value=>draft.setTitle(value),undefined,{hint:props.initial?"未命名笔记":"新建备忘录",fontSizeSp:21.7,fontWeight:700,includeFontPadding:false,textAlign:"center",autoFocus:false,horizontalPaddingDp:title?title.x-inset:undefined,document:{id:documentId,role:"title",viewportHeight,viewportOverhangDp:1,roundSafe:round,swipeBack:true,metadata:props.initial?noteMetadata(props.initial):undefined}});
      if(disposed){await closeInputs();return;}
      bodyInput = await textInput.openInline(
        draft.markdown,
        {x:bodyInset,y:body?.y??bodyTop,width:props.width-2*bodyInset,height:Math.max(56,props.height-bodyTop-56)},
        changeMarkdown,
        undefined,
        {
          hint:"直接输入原始文本",
          fontSizeSp:17,
          fontWeight:400,
          includeFontPadding:false,
          multiline:true,
          keepExisting:true,
          selectionStart:props.initial?props.initialSelection:0,
          horizontalPaddingDp:0,
          verticalPaddingDp:0,
          autoFocus:false,
          document:{
            id:documentId,
            role:"body",
            viewportHeight,
            focusOnOpenWithoutKeyboard:true,
            focusFromTitleToast:"转动表冠调整光标，再次点击开始输入。",
            entryToast:"滚动滚轮调整光标位置，再次点击打开输入法",
          },
        },
      );
      if(disposed)await closeInputs();
    }catch(error){
      await closeInputs().catch(()=>{});
      if(!live())return;
      // Other hosts without inline fields retain a functional, serialized editor.
      await fallback();
    }
  });
  createEffect(()=>{
    if(props.active===false&&inputKey&&props.inputRecovery)for(const part of ['title','body'])void props.inputRecovery.dismiss(`${inputKey}:${part}`).catch(()=>{});
  });
  onCleanup(()=>{disposed=true;
    if(inputKey&&props.inputRecovery)for(const part of ['title','body'])void props.inputRecovery.dismiss(`${inputKey}:${part}`).catch(()=>{});removeLifecycle();draft.dispose();void closeInputs();});
  return <View class="absolute inset-0 bg-black">
    <View class="absolute top-[0] left-[0] right-[0] h-[56] bg-gradient-to-b from-[#000000] via-[#000000e6] to-transparent items-start justify-center flex-row">
      <View class="w-[48] h-[48] mr-[8] items-center justify-center"><Image src={historyState().undo?"../assets/icons/note-undo.svg":"../assets/icons/note-undo-disabled.svg"} class="w-[24] h-[24]"/><View onPress={()=>changeHistory("undo")} focusable={historyState().undo} accessibilityRole="button" accessibilityLabel="撤销" class="absolute inset-0 active:scale-96"/></View>
      <View class="w-[48] h-[48] items-center justify-center"><Image src={historyState().redo?"../assets/icons/note-redo.svg":"../assets/icons/note-redo-disabled.svg"} class="w-[24] h-[24]"/><View onPress={()=>changeHistory("redo")} focusable={historyState().redo} accessibilityRole="button" accessibilityLabel="重做" class="absolute inset-0 active:scale-96"/></View>
    </View>
    <View class="absolute bottom-[0] left-[0] right-[0] h-[56] bg-gradient-to-b from-transparent via-[#000000e6] to-[#000000] flex-col items-center justify-end">
      <View onPress={()=>void close()} focusable={!closing} accessibilityRole="button" accessibilityLabel="保存并退出" class="w-[48] h-[48] items-center justify-center active:scale-96"><Image src={status()==="error"?"../assets/icons/note-save-error.svg":"../assets/icons/note-save.svg"} class="w-[24] h-[24]"/></View>
    </View>
  </View>;
}
