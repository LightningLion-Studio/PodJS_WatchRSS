import {useModalInput} from './modal-input.ts';
import type {ModalInput,ModalInputRecovery} from './service.ts';
import {restoredSignal,stringState,booleanState} from './route-activity.tsx';
import {createEffect,createMemo,createSignal,onCleanup,onMount} from "solid-js";
import {Text,View} from "@pocketjs/framework/components";
import {ScrollEntries,type ScrollEntry} from "./ScrollEntries.tsx";
import type {Scroller} from "@pocketjs/framework/kinetics";
import type {AddChannelPreview,Channel} from "./service.ts";

const SAFE=18,GAP=8;
type Inline=(value:string,bounds:{x:number;y:number;width:number;height:number},onChange:(value:string)=>void,onSubmit:()=>void,options?:{hint?:string;fontSizeSp?:number;inputType?:"text"|"uri"})=>Promise<{close():Promise<void>}>;

export function AddRssScreen(props:{width:number;height:number;active:boolean;initialUrl:string;initialPreview?:AddChannelPreview;initialError?:string;preview?:(url:string)=>Promise<AddChannelPreview>;confirm?:(token:string)=>Promise<Channel>;input:ModalInput;inputRecovery?:ModalInputRecovery;openInlineInput?:Inline;onAdded:(channel:Channel)=>void;onExisting:(channel:Channel)=>void;ref?:(value:{scroller:Scroller;onRootBack:()=>boolean})=>void}){
  const [url,setUrl]=restoredSignal('retained','add-url',props.initialUrl,stringState),[step,setStep]=createSignal<"input"|"preview"|"existing">(props.initialPreview?.kind==="ready"?"preview":props.initialPreview?.kind==="existing"?"existing":"input");
  const [preview,setPreview]=createSignal<AddChannelPreview|undefined>(props.initialPreview);
  const [loading,setLoading]=createSignal(false),[submitting,setSubmitting]=createSignal(false),[error,setError]=restoredSignal('retained','add-error',props.initialError??'',stringState);
  const [restorePreview,setRestorePreview]=restoredSignal('retained','add-preview',false,booleanState);
  const [editing,setEditing]=createSignal(false);
  let editingPadding=SAFE;
  const verticalPadding=()=>editing()?editingPadding:step()==="preview"?26:step()==="existing"?52:!url().length&&!error()?40:error()?16:SAFE;
  const rowGap=()=>step()==="input"?GAP:4;
  const inputTop=()=>verticalPadding()+30+GAP+2+GAP;
  let scroller:Scroller|undefined,session:{close():Promise<void>}|undefined,editVersion=0,previewVersion=0,disposed=false;
  const closeInput=()=>{editVersion++;setEditing(false);const old=session;session=undefined;if(old)void old.close().catch(()=>{});};
  const backToInput=()=>{setRestorePreview(false);previewVersion++;closeInput();setPreview(undefined);setStep("input");setError("");setLoading(false);setSubmitting(false);scroller?.scrollTo(0,{immediate:true});};
  const onRootBack=()=>false;
  const changeUrl=(value:string)=>{setUrl(value);setError("");};
  const clearError=()=>setError("");
  const modalInput=useModalInput({key:'add-rss',title:'添加 RSS 地址',value:url,input:props.input,recovery:props.inputRecovery,active:()=>props.active&&step()==='input',onValue:changeUrl,onError:error=>setError(String(error))});
  const openInput=async()=>{
    if(editing())return;
    if(!props.openInlineInput){await modalInput();return;}
    scroller?.scrollTo(0,{immediate:true});editingPadding=verticalPadding();setEditing(true);const current=++editVersion;
    try{
      const opened=await props.openInlineInput(url(),{x:SAFE-4,y:inputTop(),width:props.width-2*SAFE+8,height:56},
        value=>{if(!disposed&&current===editVersion)changeUrl(value);},()=>{if(!disposed&&current===editVersion)closeInput();},
        {hint:"https://example.com/feed.xml",fontSizeSp:16,inputType:"uri"});
      if(disposed||current!==editVersion){void opened.close().catch(()=>{});return;}
      session=opened;
    }catch{
      if(disposed||current!==editVersion)return;
      setEditing(false);
      await modalInput();
    }
  };
  const submit=async()=>{
    if(loading()||submitting())return;
    closeInput();
    if(!url().trim()){setError("请输入 RSS 地址");return;}
    if(!props.preview){setError("无法预览订阅");return;}
    setError("");setLoading(true);const current=++previewVersion;
    try{
      const result=await props.preview(url());
      if(disposed||current!==previewVersion)return;
      setRestorePreview(true);setPreview(result);setStep(result.kind==="ready"?"preview":"existing");scroller?.scrollTo(0,{immediate:true});
    }catch(cause){if(!disposed&&current===previewVersion)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(!disposed&&current===previewVersion)setLoading(false);}
  };
  const confirm=async()=>{
    const ready=preview();if(ready?.kind!=="ready"||submitting())return;
    if(!props.confirm){setError("无法确认订阅");return;}
    setSubmitting(true);setError("");const current=previewVersion;
    try{const channel=await props.confirm(ready.token);if(!disposed&&current===previewVersion)props.onAdded(channel);}
    catch(cause){if(!disposed&&current===previewVersion)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(!disposed&&current===previewVersion)setSubmitting(false);}
  };
  onMount(()=>{if(restorePreview()&&!props.initialPreview&&url().trim())void submit();});
  createEffect(()=>{if(!props.active&&editing())closeInput();});
  onCleanup(()=>{disposed=true;previewVersion++;closeInput();});
  const heading=(label:string):ScrollEntry=>({height:step()==="input"?30:18,render:()=> <View class="absolute inset-0 items-center justify-center" style={{translateY:step()==="input"?2:0}}><Text accessibilityRole="header" class={step()==="input"?"text-2xl leading-[26] text-[#f5f5f5]":"text-xs leading-[17] text-[#f5f5f5]"}>{label}</Text></View>});
  const button=(label:string,press:()=>void,disabled=false):ScrollEntry=>({height:48,render:()=> <View onPress={disabled?undefined:press} focusable={!disabled} accessibilityRole="button" accessibilityLabel={label} class="absolute left-[18] right-[18] top-[0] bottom-[0] rounded-[47] bg-[#23272a] items-center justify-center"><Text class="text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text></View>});
  const retryActions=():ScrollEntry=>({height:40,render:()=> <View class="absolute inset-0 flex-row items-center justify-center gap-[12]">
    <View onPress={()=>void submit()} focusable accessibilityRole="button" accessibilityLabel="重试按钮" class="w-[76] h-[40] rounded-[24] bg-[#23272a] items-center justify-center"><Text class="text-base text-[#f5f5f5]">重试</Text></View>
    <View onPress={clearError} focusable accessibilityRole="button" accessibilityLabel="取消按钮" class="w-[76] h-[40] rounded-[24] bg-[#23272a] items-center justify-center"><Text class="text-base text-[#f5f5f5]">取消</Text></View>
  </View>});
  const submitAction=():ScrollEntry=>({height:44,render:()=> <View class="absolute inset-0 items-center justify-center"><View onPress={()=>void submit()} focusable={!loading()} accessibilityRole="button" accessibilityLabel={loading()?"添加中":"添加订阅按钮"} class="h-[44] w-[44] rounded-[22] bg-[#23272a] items-center justify-center"><Text class="text-[21px] text-[#f5f5f5]">+</Text></View></View>});
  const entries=createMemo<ScrollEntry[]>(()=>{
    if(step()==="input")return [heading("添加 RSS"),{height:2,render:()=> <View/>},
      {height:error()?86:94,render:()=> <View class="absolute inset-0">
        <View onPress={()=>void openInput()} focusable={!editing()} accessibilityRole="button" accessibilityLabel={`RSS订阅地址输入框，当前内容：${url()}`} class="absolute top-[0] h-[56] rounded-[30] bg-[#1c1f21] overflow-hidden" style={{insetL:-4,insetR:-4,borderWidth:1,borderColor:"#2c3135"}}>{url()?<View class="absolute left-[16] right-[16] top-[17] h-[22] overflow-hidden"><Text class="absolute left-[0] top-[0] text-base leading-[22] text-[#f5f5f5]">{editing()?"":url()}</Text></View>:<Text class="absolute left-[16] top-[21] text-xs leading-[17] text-[#b6b6b6]">订阅地址</Text>}</View>
        {url()?<View class="absolute top-[-9] left-[5] bg-black px-[6]"><Text class="text-xs leading-[17] text-[#b6b6b6]">订阅地址</Text></View>:null}
        <Text class="absolute top-[56] text-xs leading-[17] text-center text-[#b6b6b6]" style={{insetL:-2,insetR:-2,height:36}}>支持 RSS/Atom/RDF，添加后会自动拉{"\n"}取最新内容。</Text>
      </View>},
      ...(loading()?[{height:28,render:()=> <Text class="absolute inset-0 text-[13px] text-center text-[#b6b6b6]">解析中...</Text>}]:[]),
      ...(error()?[{height:14,render:()=> <Text class="absolute inset-0 text-xs text-center text-[#e54d4d]">{error()}</Text>}]:[]),
      ...(error()&&error()!=="请输入 RSS 地址"&&error()!=="URL 不合法"?[retryActions(),{height:0,render:()=> <View/>}]:[]),
      ...(url().length>0?[submitAction()]:[]),
      {height:20,render:()=> <View/>}];
    const item=preview();
    if(step()==="existing"&&item?.kind==="existing")return [heading("添加 RSS"),
      {height:24,render:()=> <View class="absolute inset-0 items-center justify-center"><Text accessibilityRole="header" class="text-lg leading-[23] text-center text-[#f5f5f5]">已存在：{item.channel.title}</Text></View>},
      {height:18,render:()=> <Text class="absolute inset-0 text-xs text-center text-[#b6b6b6]">无需重复添加，可直接进入频道。</Text>},
      {height:6,render:()=> <View/>},button("跳转频道",()=>props.onExisting(item.channel))];
    if(item?.kind==="ready")return [heading("添加 RSS"),
      {height:24,render:()=> <View class="absolute inset-0 items-center justify-center"><Text accessibilityRole="header" class="text-lg leading-[23] text-center text-[#f5f5f5]">{item.title}</Text></View>},
      {height:18,render:()=> <Text class="absolute inset-0 text-xs leading-[17] text-center text-[#b6b6b6]">{item.description||"暂无简介"}</Text>},
      ...(error()?[{height:18,render:()=> <Text class="absolute inset-0 text-xs text-center text-[#e54d4d]">{error()}</Text>}]:[]),
      {height:2,render:()=> <View/>},button(submitting()?"添加中":"确认添加",()=>void confirm(),submitting()),{height:0,render:()=> <View/>},button("修改地址",backToInput)];
    return [heading("添加 RSS")];
  });
  return <ScrollEntries height={props.height} entries={entries()} gap={rowGap()} padding={SAFE} verticalPadding={verticalPadding()} fixed={editing()} onManualScroll={closeInput} inputActive={()=>props.active} accessibilityLabel="添加RSS订阅页面" ref={value=>{scroller=value.scroller;props.ref?.({...value,onRootBack});}}/>;
}
