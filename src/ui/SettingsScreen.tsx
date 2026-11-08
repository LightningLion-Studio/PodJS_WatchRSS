import {debugGate} from '../debug/host.ts';
import {DebugTts,debugTtsEngines} from '../debug/tts.ts';
import {TtsConfigStore,type TtsEngine} from '../tts/config-store.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {mediaTransport} from '../media-services.ts';
import {managedCache} from "../cache/host.ts";
import {advancedCacheRows} from "./advanced-cache-settings.tsx";
import { mediaVolumeSettingsRows } from "./media-volume-settings.tsx";
import {getOps} from "@pocketjs/framework/host";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {watchUiLines} from "./text-layout.ts";
import { WatchSwitch } from "./AutoScrollSettingsScreen.tsx";
import { SUMMARY_PRESETS } from "../llm/summary.ts";
import { Text, View } from "@pocketjs/framework/components";
import { createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { chunkLines, describedRows } from "./round-rows.tsx";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { FONT_OPTIONS, type SettingsState } from "../settings/store.ts";
export type SettingsRoute = "debug-tools" | "llm-preset" | "llm-usage" | "reader-presets" | "tts" | "tts-config" | "auto-scroll" | "remote-input" | "advanced" | "beian";
export interface SettingsScreenProps { systemShareSupported?:boolean; hasSummaryAccount?:()=>Promise<boolean>; active?:()=>boolean; width: number; height: number; state: SettingsState; onChange: (patch: Partial<SettingsState>) => void; onNavigate: (route: SettingsRoute) => void; onUnsupported?: (label: string) => void; ref?: (value: { scroller: Scroller }) => void }
type Props = SettingsScreenProps;
function wrap(text:string,width:number):string[] {
 const lines:string[]=[];let line="",size=0;
 for(const c of text){const advance=c.codePointAt(0)!>255?12:6;if(size+advance>width&&line){lines.push(line);line="";size=0;}line+=c;size+=advance;}if(line)lines.push(line);return lines;
}
const row = (label:string,detail:string,width:number,value?:string,onPress?:()=>void,disabled=false):ScrollEntry[] => {
 const lines=wrap(detail,width-10);
 return describedRows(width,{height:52,render:()=> <View onPress={disabled?undefined:onPress} focusable={!disabled&&!!onPress} class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a] active:scale-96">
 <Text class="absolute left-[10] right-[44] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
 <Text class={disabled?"absolute right-[10] top-[15.5] text-xs leading-[21] text-[#b6b6b6]":"absolute right-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]"}>{value??""}</Text>
 </View>},[lines]);
};
const stepper = (label:string,value:string,detail:string,width:number,dec:()=>void,inc:()=>void):ScrollEntry[] => [{height:70,render:()=> <View class="absolute inset-0"><View class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a]">
 <Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>
 <View onPress={dec} focusable class="absolute right-[69] top-[14] h-[24] w-[24] rounded-full bg-[#45454a] items-center justify-center active:scale-96"><Text class="text-lg text-white">−</Text></View>
 <Text class="absolute right-[38] top-[18] w-[30] text-center text-xs text-white">{value}</Text>
 <View onPress={inc} focusable class="absolute right-[10] top-[14] h-[24] w-[24] rounded-full bg-[#45454a] items-center justify-center active:scale-96"><Text class="text-lg text-white">＋</Text></View>
 </View><Text class="absolute left-[10] top-[56] text-xs leading-[14] text-[#b6b6b6]">{detail}</Text></View>}];
const heading=(text:string):ScrollEntry=>({height:34,render:()=> <View class="absolute inset-0 items-center justify-center"><Text class="text-[21px] leading-[26] text-[#f5f5f5]">{text}</Text></View>});
function aiRows(props:Props,width:number):ScrollEntry[] {
 const entry=(label:string,detail:string,value:string,route:"llm-preset"|"llm-usage"):ScrollEntry[]=>{
  const lines=watchUiLines(detail,{width:width-10,measure:t=>getOps().measureText(t,0)}),open=()=>props.onNavigate(route);
  return describedRows(width,{height:52,render:()=> <View onPress={open} focusable class="absolute left-[0] right-[0] top-[0] h-[52] rounded-[47] bg-[#2a2a2a] active:scale-96"><Text class="absolute left-[10] top-[15.5] text-[17px] leading-[21] text-[#f5f5f5]">{label}</Text>{route==="llm-preset"?<Text class="absolute right-[10] top-[19] text-xs leading-[14] text-[#b6b6b6]">{value}</Text>:<View onPress={open} focusable class="absolute right-[10] top-[16] w-[20] h-[20] rounded-full overflow-hidden bg-[#444444] active:scale-96"><Text class="absolute left-[0] top-[-11] w-[20] text-[17px] leading-[21] text-center text-[#f5f5f5]">{"进\n入"}</Text></View>}</View>},[lines]);
 };
 const toggle=(label:string,detail:string,key:"llmEnabled"|"llmAutoSummarize"|"llmShowTokenUsage"):ScrollEntry[]=>{
  const density=getDisplayMetrics().density,lines=watchUiLines(detail,{width:width-10,measure:t=>getOps().measureText(t,0)}),labelLines=watchUiLines(label,{width:width-25-60/density,measure:t=>getOps().measureText(t,22)}),pillHeight=Math.max(52,16+labelLines.length*21);
  return describedRows(width,{height:pillHeight,render:()=> <View class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{height:pillHeight}}><Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{insetT:(pillHeight-labelLines.length*21)/2,width:width-25-60/density}}>{labelLines.join("\n")}</Text><View class="absolute right-[15]" style={{insetT:(pillHeight-35/density)/2}}><WatchSwitch checked={props.state[key]} onChange={()=>props.onChange({[key]:!props.state[key]})}/></View></View>},[lines]);
 };
 return [...toggle("AI 总结功能","在 RSS 文章详情页显示 AI 总结按钮","llmEnabled"),...(props.state.llmEnabled?[
 {height:0,render:()=> <View/>},...toggle("进入详情自动开始总结",props.state.llmAutoSummarize?"进入文章时自动在顶部显示总结":"详情页顶部显示总结按钮，手动触发","llmAutoSummarize"),
 ...entry("提示词预设","选择 AI 总结时使用的提示词",SUMMARY_PRESETS[props.state.llmPromptPreset-1]??SUMMARY_PRESETS[0],"llm-preset"),
 ...toggle("显示 Token 用量","在总结页面显示本次请求消耗的 token 数量","llmShowTokenUsage"),
 ...entry("Token 消耗统计","查看 LLM 调用历史与累计 token 消耗","进入","llm-usage")]:[])];
}
function Top(props: Props) { const [account,setAccount]=createSignal(false);let alive=true,version=0;onCleanup(()=>{alive=false;});createEffect(()=>{if(props.active?.()===false)return;const current=++version;void props.hasSummaryAccount?.().then(value=>{if(alive&&version===current)setAccount(value);}).catch(()=>{if(alive&&version===current)setAccount(false);});}); const width = props.width - 36, fi = () => FONT_OPTIONS.indexOf(props.state.fontSizeSp); const entries = createMemo<ScrollEntry[]>(() => [heading("设置"), ...row("阅读器与预设", "字体、排版、纯色与图片背景；视频背景在手表端只读", width, "管理", () => props.onNavigate("reader-presets")), ...row("朗读语速", "调节朗读语速", width, "配置", () => props.onNavigate("tts")), ...row("滚动控制", "设置翻页模式、自动开始和滚动速度", width, "配置", () => props.onNavigate("auto-scroll")), ...row("从手机输入", "用手机版输入 RSS 地址并同步到手表", width, "扫码", () => props.onNavigate("remote-input")), ...stepper("字体大小", `${props.state.fontSizeSp}sp`, "调整正文阅读字号", width, () => { const i = fi(); if (i > 0) props.onChange({ fontSizeSp: FONT_OPTIONS[i - 1] }); }, () => { const i = fi(); if (i < FONT_OPTIONS.length - 1) props.onChange({ fontSizeSp: FONT_OPTIONS[i + 1] }); }), ...mediaVolumeSettingsRows(props, width), ...row("高级", "管理高级选项", width, "进入", () => props.onNavigate("advanced")), ...(account()?aiRows(props,width):[]),...(debugGate.allowed?row("调试工具", "仅调试构建可用", width, "进入",()=>props.onNavigate("debug-tools")):[]),settingsFooterEntry(()=>props.onNavigate("beian"))]); return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref} />; }
export function settingsFooterEntry(onPress:()=>void):ScrollEntry {
 return {height:66,render:()=> <View class="absolute inset-0"><View onPress={onPress} focusable class="absolute left-[0] right-[0] top-[0] h-[14] items-center justify-center"><Text class="text-xs leading-[14] text-[#b6b6b6]">浙ICP备2024111886号-5A</Text></View></View>};
}
export function systemShareRows(props:Props,width:number):ScrollEntry[] {
 if(!props.systemShareSupported)return [];
 const density=getDisplayMetrics().density,labelWidth=width-25-60/density;
 const lines=watchUiLines("使用系统分享方式",{width:labelWidth,measure:t=>getOps().measureText(t,22)}),height=Math.max(52,16+lines.length*21);
 const descriptions=[props.state.shareUseSystem?"当前：系统分享":"当前：二维码分享","开启后直接调用系统分享面板；关闭后显示二维码供扫码分享","便于配合其他第三方应用使用"].map(text=>watchUiLines(text,{width:width-10,measure:t=>getOps().measureText(t,0)}));
 return describedRows(width,{height,render:()=> <View class="absolute left-[0] right-[0] top-[0] rounded-[47] bg-[#2a2a2a]" style={{height}}><Text class="absolute left-[10] text-[17px] leading-[21] text-[#f5f5f5]" style={{width:labelWidth,insetT:(height-lines.length*21)/2}}>{lines.join("\n")}</Text><View class="absolute right-[15]" style={{insetT:(height-35/density)/2}}><WatchSwitch checked={props.state.shareUseSystem} onChange={()=>props.onChange({shareUseSystem:!props.state.shareUseSystem})}/></View></View>},descriptions);
}
export function AdvancedSettingsScreen(props: Props) {
 const width=props.width-36,[usage,setUsage]=createSignal<number>();
 onCleanup(managedCache.subscribe(setUsage));
 createEffect(()=>{if(props.active?.()===false)return;void managedCache.inspect().catch(error=>props.onUnsupported?.(String(error)));});
 const entries=createMemo<ScrollEntry[]>(()=>[heading("高级"),...advancedCacheRows(props,width,usage()),...systemShareRows(props,width)]);
 return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref}/>;
}
export function SettingsScreen(props: Props) { return <Top {...props} />; }
export default SettingsScreen;

/** Native TtsSettingsScreen. Release: "朗读语速" (speed + phone QR). Debug builds: "朗读语音源" with the
 * engine picker (✓ on the selected engine), account/voice/model/key status, per-field editing (the
 * explicitly requested wrist editor; stored keys are never shown or prefilled), speed, 测试连接 with
 * success #4CAF50 + latency / failure #FF6B6B, and the phone QR entry. Section gap 8dp, detail 10dp/4dp. */
export function SpeechSettingsScreen(props: Props & {input?:(title:string,value:string)=>Promise<string|null>}) {
  const debug=debugGate.allowed&&!!props.input;
  const tts=debug?new DebugTts(debugGate,new TtsConfigStore(),mediaTransport,()=>summaryAccountStore.read()):undefined;
  const [config,setConfig]=createSignal(tts?.fields());
  const [keySet,setKeySet]=createSignal(false),[logged,setLogged]=createSignal(false);
  const [picker,setPicker]=createSignal(false),[testing,setTesting]=createSignal(false),[result,setResult]=createSignal<{ok:boolean;text:string}>();
  let alive=true;onCleanup(()=>{alive=false;});
  const refresh=async()=>{if(!tts)return;setConfig(tts.fields());try{const pub=await new TtsConfigStore().publicConfig(),account=await summaryAccountStore.read();if(alive){setKeySet(!!pub.apiKey);setLogged(!!account?.watchDeviceToken);}}catch{}};
  if(tts)void refresh();
  const width=props.width-36;
  const edit=(field:"model"|"voiceId"|"baseUrl",title:string)=>()=>{if(!tts||!props.input)return;void props.input(title,tts.fields()[field]).then(value=>{if(!alive||value===null)return;tts.update(field,value);void refresh();});};
  const setKey=()=>{if(!tts||!props.input)return;void props.input("API Key","").then(async value=>{if(!alive||value===null)return;await tts.setApiKey(value);void refresh();});};
  const select=(engine:TtsEngine)=>{if(!tts)return;setPicker(false);setResult(undefined);void tts.select(engine).then(()=>refresh(),error=>{if(alive)setResult({ok:false,text:error instanceof Error?error.message:String(error)});});};
  const test=()=>{if(!tts||testing())return;setTesting(true);setResult(undefined);void tts.test().then(text=>{if(alive)setResult({ok:true,text});},error=>{if(alive)setResult({ok:false,text:error instanceof Error?error.message:String(error)});}).finally(()=>{if(alive)setTesting(false);});};
  const detail=(text:string,color="#b6b6b6"):ScrollEntry[]=>chunkLines(wrap(text,width-10),14,width,4).map(lines=>({height:4+lines.length*14,bounds:{x:10,y:4,width:width-10,height:lines.length*14},render:()=> <Text class="absolute left-[10] right-[0] top-[4] text-xs leading-[14]" style={{textColor:color}}>{lines.join("\n")}</Text>}));
  const speed=()=>stepper("语速", `${props.state.speechRate.toFixed(1)}x`, "调节朗读语速", width, () => props.onChange({speechRate:Math.max(0.5,Math.round((props.state.speechRate-0.1)*10)/10)}), () => props.onChange({speechRate:Math.min(2,Math.round((props.state.speechRate+0.1)*10)/10)}));
  const qrRow=()=>row("手机扫码配置语音","在手机端选择音色、输入 API Key 并同步到手表",width,undefined,()=>props.onNavigate('tts-config'));
  const entries = createMemo<ScrollEntry[]>(() => {
    if(!tts)return [heading("朗读语速"), ...speed(), ...qrRow()];
    const c=config(),engine=c?.engine??"local";
    if(picker())return [heading("选择引擎"),...(Object.keys(debugTtsEngines) as TtsEngine[]).map(id=>row(debugTtsEngines[id],"",width,id===engine?"✓":undefined,()=>select(id))).flat()];
    const keyed=engine!=="local"&&engine!=="backend_default";
    return [heading("朗读语音源"),
      ...row("当前引擎","",width,debugTtsEngines[engine],()=>setPicker(true)),
      ...(engine==="backend_default"?[...detail(logged()?"账号已登录，使用 WatchRSS 提供的默认语音":"使用默认语音前请先登录")]:[]),
      ...(keyed?[
        ...row("音色",c?.voiceId?"":"默认",width,c?.voiceId||"默认",edit("voiceId","音色 ID")),
        ...row("模型","",width,c?.model||"默认",edit("model","模型")),
        ...row("服务地址",c?.baseUrl||"默认",width,"编辑",edit("baseUrl","服务地址")),
        ...row("API Key","",width,keySet()?"已配置":"未配置",setKey),
        ...detail("也可以在手机端编辑音色、模型和 API Key 后同步到手表"),
      ]:[]),
      ...speed(),
      ...row(testing()?"正在测试...":"测试连接","",width,undefined,testing()?undefined:test),
      ...(result()?[...detail(result()!.text,result()!.ok?"#4caf50":"#ff6b6b")]:[]),
      ...qrRow()];
  });
  return <ScrollEntries height={props.height} entries={entries()} gap={8} ref={props.ref}/>;
}
