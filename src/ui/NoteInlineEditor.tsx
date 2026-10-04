import { createSignal, onCleanup, onMount } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import { textInput } from "@podjs/framework/services";
import { onLifecycleChange } from "@podjs/framework/watch";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { NoteDraftAutosave, type NoteDraftSaveState } from "../notes/draft-autosave.ts";
import { RawTextHistory } from "../notes/raw-text-history.ts";
import { noteMetadata } from "../notes/metadata.ts";
import type { MemoNote } from "../notes/types.ts";
import type { MemoRepository } from "../notes/repository.ts";

type InputSession={close():Promise<void>;setValue(value:string):Promise<void>};
export interface NoteInlineEditorHandle { close:()=>void }
export function NoteInlineEditor(props:{width:number;height:number;repository:MemoRepository;initial:MemoNote|null;initialSelection?:number;fallbackInput:(title:string,value?:string)=>Promise<string|null>;onSaved:(note:MemoNote)=>void;onClose:(note:MemoNote|null)=>void;onError:(message:string)=>void;ref?:(handle:NoteInlineEditorHandle)=>void}){
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
  onFrame(()=>draft.tick());
  const removeLifecycle=onLifecycleChange(state=>{
    if(state!=="active"&&!closing)void draft.flush().catch(error=>props.onError(String(error)));
  });
  let titleInput:InputSession|undefined,bodyInput:InputSession|undefined,disposed=false,closing=false;
  const closeInputs=async()=>{await bodyInput?.close();await titleInput?.close();bodyInput=undefined;titleInput=undefined;};
  const close=async()=>{
    if(closing)return;closing=true;
    try{const note=await draft.flush();await closeInputs();if(!disposed)props.onClose(note);}
    catch(error){closing=false;if(!disposed)props.onError(String(error));}
  };
  props.ref?.({close:()=>void close()});
  onMount(async()=>{
    const inset=14,fieldWidth=props.width-2*inset,bodyTop=props.initial?108:80.5;
    const documentId="note-editor";
    const viewportHeight=Math.max(56,props.height-42-56);
    try{
      titleInput=await textInput.openInline(draft.title,{x:inset,y:42.5,width:fieldWidth,height:29.3},value=>draft.setTitle(value),undefined,{hint:props.initial?"未命名笔记":"新建备忘录",fontSizeSp:21.7,fontWeight:700,includeFontPadding:false,textAlign:"center",autoFocus:false,document:{id:documentId,role:"title",viewportHeight,viewportOverhangDp:1,metadata:props.initial?noteMetadata(props.initial):undefined}});
      if(disposed){await closeInputs();return;}
      bodyInput=await textInput.openInline(draft.markdown,{x:inset,y:bodyTop,width:fieldWidth,height:Math.max(56,props.height-bodyTop-56)},changeMarkdown,undefined,{hint:"直接输入原始文本",fontSizeSp:17,fontAsset:"fonts/watch-sans.ttf",fontWeight:400,includeFontPadding:false,multiline:true,keepExisting:true,selectionStart:props.initialSelection,horizontalPaddingDp:0,verticalPaddingDp:0,autoFocus:false,document:{id:documentId,role:"body",viewportHeight,unfocusedCaretColor:"#ff6026"}});
      if(disposed)await closeInputs();
    }catch(error){
      await closeInputs().catch(()=>{});
      if(disposed)return;
      // Other hosts without inline fields retain a functional, serialized editor.
      const title=await props.fallbackInput("备忘录标题",draft.title);
      if(title!==null){draft.setTitle(title);try{await draft.flush();}catch(saveError){props.onError(String(saveError));return;}}
      const markdown=await props.fallbackInput("备忘录正文",draft.markdown);
      if(markdown!==null)changeMarkdown(markdown);
      await close();
    }
  });
  onCleanup(()=>{disposed=true;removeLifecycle();draft.dispose();void closeInputs();});
  const statusText=()=>({empty:"未填写",pending:"待保存",saving:"保存中…",saved:"已保存",error:"保存失败，请重试"}[status()]);
  return <View class="absolute inset-0 bg-black">
    <View class="absolute top-[0] left-[0] right-[0] h-[56] bg-gradient-to-b from-[#000000] via-[#000000e6] to-transparent items-start justify-center flex-row">
      <View class="w-[48] h-[48] mr-[8] items-center justify-center"><Image src={historyState().undo?"../assets/icons/note-undo.svg":"../assets/icons/note-undo-disabled.svg"} class="w-[24] h-[24]"/><View onPress={()=>changeHistory("undo")} focusable={historyState().undo} accessibilityRole="button" accessibilityLabel="撤销" class="absolute inset-0"/></View>
      <View class="w-[48] h-[48] items-center justify-center"><Image src={historyState().redo?"../assets/icons/note-redo.svg":"../assets/icons/note-redo-disabled.svg"} class="w-[24] h-[24]"/><View onPress={()=>changeHistory("redo")} focusable={historyState().redo} accessibilityRole="button" accessibilityLabel="重做" class="absolute inset-0"/></View>
    </View>
    <View class="absolute bottom-[0] left-[0] right-[0] h-[56] bg-gradient-to-b from-transparent via-[#000000e6] to-[#000000] flex-col items-center justify-end">
      <View onPress={()=>void close()} focusable={!closing} accessibilityRole="button" accessibilityLabel={`关闭编辑，${statusText()}`} class="w-[48] h-[48] items-center justify-center"><Image src={status()==="error"?"../assets/icons/note-close-error.svg":"../assets/icons/close.svg"} class="w-[24] h-[24]"/></View>
    </View>
  </View>;
}
