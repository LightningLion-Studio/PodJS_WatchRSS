import {getOps} from '@pocketjs/framework/host';
import {watchUiLines} from './text-layout.ts';
import {Show,createSignal,createEffect,onCleanup,onMount} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {debugPerformance} from '@podjs/framework/services';
import {kv,onLifecycleChange} from '@podjs/framework/watch';
import {debugGate} from '../debug/host.ts';
import {douyinDebug} from '../debug/douyin-host.ts';
import {DebugTts,debugTtsEngines} from '../debug/tts.ts';
import {buildLargeList,buildLargeArticle} from '../debug/perf.ts';
import type {DebugBluetoothSession} from '../debug/bluetooth.ts';
import {TtsConfigStore,type TtsEngine} from '../tts/config-store.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {douyinClient,mediaTransport} from '../media-services.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {cardSlices,chunkLines,roundRowMaxHeight} from './round-rows.tsx';
import {RssFeedScreen} from './RssScreens.tsx';
import {ReaderScreen} from './ReaderScreen.tsx';
import {defaultReaderPreset} from '../reader/preset.ts';
import {StartupGate} from './StartupGate.tsx';
import {ONBOARDING_KEY} from '../onboarding/store.ts';
import type {AppServices} from './service.ts';
import type {RouteEntry} from './routes/types.ts';

type Tool='menu'|'bluetooth'|'tts'|'douyin'|'list'|'article'|'onboarding';
export function DebugToolsScreen(props:{width:number;height:number;active:()=>boolean;services:AppServices;entry:RouteEntry;createBluetooth?:()=>DebugBluetoothSession}){
 if(!debugGate.allowed)return null;
 const [tool,setTool]=createSignal<Tool>('menu'),[status,setStatus]=createSignal(''),[timeout,setTimeout]=createSignal(120000),[busy,setBusy]=createSignal(false);
 const [auto,setAuto]=createSignal(douyinDebug.interval);
 const tts=new DebugTts(debugGate,new TtsConfigStore(),mediaTransport,()=>summaryAccountStore.read());
 let bluetooth:DebugBluetoothSession|undefined,alive=true,version=0;
 const closeBluetooth=()=>{const session=bluetooth;bluetooth=undefined;return session?.close()??Promise.resolve();};
 onCleanup(onLifecycleChange(state=>{if(state!=="active"){version++;void closeBluetooth();setBusy(false);}}));
 onCleanup(()=>{alive=false;version++;closeBluetooth();});
 createEffect(()=>{if(!props.active()){version++;closeBluetooth();setBusy(false);}});
 const open=(next:Tool)=>{debugGate.require();version++;closeBluetooth();setBusy(false);setStatus('');setTool(next);};
 props.entry.internalBack=()=>{if(tool()==='menu')return false;open('menu');return true;};
 const run=async(action:(current:()=>boolean)=>Promise<string>)=>{if(busy()||!props.active())return;debugGate.require();const generation=++version;setBusy(true);try{const message=await action(()=>alive&&generation===version&&props.active()&&debugGate.allowed);if(alive&&generation===version)setStatus(message);}catch(error){if(alive&&generation===version)setStatus(String(error));}finally{if(alive&&generation===version)setBusy(false);}};
 const input=async(label:string,value:string)=>{debugGate.require();const generation=version;const result=await props.services.input(label,value);if(!alive||!props.active()||generation!==version)return null;debugGate.require();return result;};
 const row=(label:string,action?:()=>void):ScrollEntry=>{const lines=watchUiLines(label,{width:props.width-60,measure:text=>getOps().measureText(text,1)});return {height:Math.max(62,lines.length*20+24),render:()=> <View onPress={()=>{if(!props.active()||busy()||!action)return;debugGate.require();action();}} focusable={!!action} class="absolute inset-0 rounded-[16] bg-[#1c1f21] justify-center px-[12]"><Text class="text-sm leading-[20] text-[#ffffff]">{lines.join("\n")}</Text></View>};};
 // A long status line (e.g. a JSON snapshot) continues as slices of the same card so all of it can
 // scroll into view on a round screen; short lines keep the ordinary row.
 const statusRows=(label:string):ScrollEntry[]=>{
  const width=props.width-36,lines=watchUiLines(label,{width:props.width-60,measure:text=>getOps().measureText(text,1)});
  if(Math.max(62,lines.length*20+24)<=roundRowMaxHeight(width))return [row(label)];
  return cardSlices(chunkLines(lines,20,width-24,24).map(chunk=>({height:chunk.length*20+24,bounds:{x:12,y:12,width:width-24,height:chunk.length*20},render:()=>
   <Text class="absolute left-[12] right-[12] top-[12] text-sm leading-[20] text-[#ffffff]">{chunk.join("\n")}</Text>})),6,"#1c1f21",16);
 };
 const entries=():ScrollEntry[]=>{
  const list:ScrollEntry[]=[row('调试工具 · '+tool())];
  if(tool()==='menu')list.push(...([
   ['bluetooth','蓝牙单次同步'],['onboarding','重新进入新手引导'],['list','性能测试：超大列表'],['article','性能测试：超大文章'],['tts','详细 TTS 配置'],['douyin','抖音调试'],
  ] as [Tool,string][]).map(([target,label])=>row(label,()=>open(target))));
  if(tool()==='bluetooth')list.push(row(`超时 ${timeout()} ms`,()=>void run(async()=>{const raw=await input('蓝牙超时（毫秒）',String(timeout()));if(raw===null)return '';const value=Number(raw);if(!Number.isSafeInteger(value)||value<=0)throw Error('超时必须为正整数毫秒');setTimeout(value);return '超时已设置';})),row('等待手机蓝牙连接',()=>void run(async current=>{if(!props.createBluetooth)throw Error('调试蓝牙监听不可用');await closeBluetooth();if(!current())return '';bluetooth=props.createBluetooth();return bluetooth.run(timeout());})));
  if(tool()==='tts')list.push(...Object.entries(debugTtsEngines).map(([engine,label])=>row('选择 '+label,()=>void run(async()=>{await tts.select(engine as TtsEngine);return tts.status();}))),...(['model','voiceId','baseUrl','apiKey'] as const).map(field=>row('编辑 '+({model:'模型',voiceId:'音色 ID',baseUrl:'服务地址',apiKey:'API Key'}[field]),()=>void run(async()=>{const raw=await input(field,field==='apiKey'?'':tts.fields()[field]);if(raw===null)return '';if(field==='apiKey')await tts.setApiKey(raw);else tts.update(field,raw);return tts.status();}))),row('语速设置',()=>void run(async()=>{const store=new TtsConfigStore(),raw=await input('语速（0.5–2.0）',String(store.read().speed));if(raw===null)return '';store.setSpeed(Number(raw));return `语速 ${store.read().speed}x`;})),row('刷新配置状态',()=>void run(()=>tts.status())),row('测试连接',()=>void run(()=>tts.test())));
  if(tool()==='douyin')list.push(row('播放上下文',()=>setStatus(JSON.stringify(douyinDebug.snapshot()))),row('请求下一片',()=>{douyinDebug.requestAdvance();setStatus('下一次进入播放页时换片');}),row('下一条视频故障注入',()=>{douyinDebug.armNext();setStatus('下一条视频将失败；使用播放页正常恢复逻辑');}),row('指定视频故障注入',()=>void run(async()=>{const id=await input('awemeId','');if(id===null)return '';douyinDebug.poison(id);return '已标记故障';})),row('导入 Cookie',()=>void run(async()=>{const cookie=await input('抖音 Cookie','');if(cookie===null)return '';return douyinDebug.importCookie(cookie,value=>douyinClient.applyCookie(value));})),row(`自动换片 ${auto()?`${auto()} ms`:'关闭'}`,()=>void run(async()=>{const raw=await input('换片间隔毫秒（0 关闭）',String(auto()||5000));if(raw===null)return '';douyinDebug.setAuto(Number(raw));setAuto(douyinDebug.interval);return '返回抖音播放页后生效';})),row('清除故障 / 停止自动换片',()=>{douyinDebug.reset();setAuto(0);setStatus('已清除');}));
  if(busy())list.push(row('正在执行…'));
  if(status())for(const line of status().split('\n'))list.push(...statusRows(line));
  return list;
 };
 return <Show when={debugGate.allowed}><Show when={tool()!=='list'&&tool()!=='article'&&tool()!=='onboarding'} fallback={<Show when={tool()==='onboarding'} fallback={<DebugPerfScreen kind={tool()==='list'?'list':'article'} {...props} onStats={setStatus}/>}><DebugOnboarding onFinish={()=>open('menu')}/></Show>}><ScrollEntries height={props.height} entries={entries()} inputActive={props.active} ref={value=>{props.entry.list=value;}}/></Show></Show>;
}
function DebugOnboarding(props:{onFinish:()=>void}){
 debugGate.require();let completed=false;
 const storage={get:(key:string)=>{const value=kv.get<Record<string,unknown>>(key);return key===ONBOARDING_KEY&&!completed?{...value,oobeSeenVersion:0}:value;},set:(key:string,value:unknown)=>{debugGate.require();completed=true;kv.set(key,value);}};
 function Finish(){onMount(props.onFinish);return null;}
 return <StartupGate onExit={props.onFinish} storage={storage} content={()=><Finish/>}/>;
}
function DebugPerfScreen(props:{kind:'list'|'article';width:number;height:number;active:()=>boolean;services:AppServices;entry:RouteEntry;onStats:(text:string)=>void}){
 debugGate.require();
 const ready=debugPerformance.start(`perf_large_${props.kind}`);
 void ready.catch(error=>props.onStats(`原生帧指标不可用：${String(error)}`));
 onCleanup(()=>{void ready.then(value=>debugPerformance.stop(value.sessionId)).then(value=>props.onStats(`场景 ${value.scenario}\n来源 ${value.source}\nframes=${value.frames} jank=${value.jank}\njankPct=${value.jankPct.toFixed(2)}%\navgMs=${value.avgMs.toFixed(2)} maxMs=${value.maxMs.toFixed(2)}\ndrop=${value.drop}\n${Object.entries(value.lastFrame).map(([key,ms])=>`${key}=${ms.toFixed(2)}`).join("\n")}`)).catch(()=>{});});
 const noop=()=>{};
 const items=props.kind==='list'?buildLargeList():[];
 const article=props.kind==='article'?buildLargeArticle():undefined;
 if(props.kind==='list')return <RssFeedScreen width={props.width} height={props.height} title="性能测试：超大列表" items={items} active={props.active()} refreshing={false} loadingMore={false} canNext={false} onOpen={noop} onActions={noop} onFavorite={noop} onWatchLater={noop} onRefresh={noop} onNext={noop} ref={value=>{props.entry.list=value;}}/>;
 return <ReaderScreen width={props.width} height={props.height} article={article!} services={props.services} preset={defaultReaderPreset()} fontSize={18} lineHeight={1.5} llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0} active={props.active()} autoStart={false} speed={20} favorite={false} speaking={false} busy={false} onFavorite={noop} onShare={noop} onSpeak={noop} onSpeechControls={noop} onMedia={noop} onControls={noop} onError={props.onStats} ref={value=>{props.entry.list=value;}}/>;
}
