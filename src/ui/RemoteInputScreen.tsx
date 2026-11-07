import type {HttpExportMode} from '../remote-input/exports.ts';
import {httpExportSource} from '../remote-input/export-runtime.ts';
import {tcp,byteStreams} from '@podjs/framework/services';
import {createSignal,createMemo,createEffect,onCleanup,Show} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getOps} from '@pocketjs/framework/host';
import {RemoteInputServer} from '../remote-input/server.ts';
import {remoteInputQrContent} from '../remote-input/http.ts';
import {QRCode} from './QRCode.tsx';
import {DownloadPhoneAppDialog} from './DownloadPhoneAppDialog.tsx';
import {watchUiLines} from './text-layout.ts';

export function RemoteInputQr(props:{value:string;onError?:(message:string)=>void}){
 return <View class="relative w-[120] h-[120] bg-black"><View class="absolute left-[6] top-[6] w-[108] h-[108]"><QRCode value={props.value} size={108} nativeWatch onError={props.onError}/></View></View>;
}
export function RemoteInputScreen(props:{exportMode?:HttpExportMode;width:number;height:number;active:()=>boolean;onUrl:(url:string)=>void;onDismiss:()=>void;onError:(message:string)=>void;ref?:(value:{onRootBack:()=>boolean})=>void}){
 const [endpoint,setEndpoint]=createSignal<{port:number;addresses:string[]}>();
 const [synced,setSynced]=createSignal(false);
 const title=()=>props.exportMode==='favorite'?'同步收藏':props.exportMode==='watchLater'?'同步稍后再看':props.exportMode==='bili'?'同步B站观看记录':'从手机输入';
 const [failure,setFailure]=createSignal('');const [download,setDownload]=createSignal(false);
 const [transition,setTransition]=createSignal(0);const opened=Date.now();
 onFrame(()=>{const next=Math.max(0,Math.min(1,(Date.now()-opened-3000)/1000));if(next!==transition())setTransition(next);});
 // The listener belongs to this visible page, including its pending reads and accept.
 createEffect(()=>{if(!props.active())return;let alive=true;setEndpoint(undefined);setFailure('');setSynced(false);const server=new RemoteInputServer(url=>{if(alive)props.onUrl(url);},error=>{if(alive)setFailure(String(error));},{tcp,streams:byteStreams},'0.0.0.0',undefined,props.exportMode?{mode:props.exportMode,source:httpExportSource,onComplete:()=>{if(alive)setSynced(true);}}:undefined);void server.ready.then(value=>{if(alive)setEndpoint(value);},error=>{if(alive)setFailure(String(error));});onCleanup(()=>{alive=false;void server.dispose();});});
 const closeDownload=()=>{if(!download())return false;setDownload(false);return true;};props.ref?.({onRootBack:closeDownload});
 const foreground=()=>{const v=Math.round(255*(1-transition())).toString(16).padStart(2,'0');return '#'+v+v+v;};
 const background=()=>{const v=Math.round(255*transition()).toString(16).padStart(2,'0');return '#'+v+v+v;};
 const unavailable=()=>!!endpoint()&&!endpoint()!.addresses.length;
 const qr=()=>endpoint()?.addresses[0]?remoteInputQrContent(endpoint()!.addresses[0],endpoint()!.port):'';
 const wrap=(text:string,slot=0)=>watchUiLines(text,{width:props.width-28,measure:t=>getOps().measureText(t,slot)});
 const hint=()=>wrap('请使用手机版扫描下方二维码');
 const downloadHint=()=>wrap('下载手机端App以完成'+title());
 const state=()=>failure()?'服务器启动失败':!endpoint()?'正在启动服务器...':unavailable()?'请连接WiFi网络':'';
 const height=createMemo(()=>26+12+(state()?17+(endpoint()?8+hint().length*14+12+48:0):120+8+(synced()?17+12+48:hint().length*14))+8+downloadHint().length*14);
 const top=()=>Math.max(10,(props.height-height())/2);
 const contentTop=()=>top()+38;
 const linkTop=()=>top()+height()-downloadHint().length*14;
 return <View class="absolute inset-0" style={{bgColor:background()}}>
  <Text class="absolute left-[14] right-[14] text-[21px] leading-[26] text-center" style={{insetT:top(),textColor:foreground()}}>{title()}</Text>
  <Show when={state()} fallback={<View class="absolute" style={{insetL:(props.width-120)/2,insetT:contentTop(),width:120,height:120,bgColor:'#000000'}}><RemoteInputQr value={qr()} onError={setFailure}/></View>}>
   <Text class="absolute left-[14] right-[14] text-sm leading-[17] text-center" style={{insetT:contentTop(),textColor:unavailable()?'#b00020':foreground(),opacity:unavailable()?1:.7}}>{state()}</Text>
  </Show>
  <Show when={endpoint()}>
   <Show when={!synced()||state()}>
   <Text class="absolute left-[14] right-[14] text-xs leading-[14] text-center" style={{insetT:contentTop()+(state()?25:128),textColor:foreground(),opacity:.7}}>{hint().join('\n')}</Text>
   </Show>
   <Show when={synced()&&!state()}><Text class="absolute left-[14] right-[14] text-sm leading-[17] text-center" style={{insetT:contentTop()+128,textColor:transition()>.5?'#1976d2':'#64b5f6'}}>已同步至手机端</Text></Show>
   <Show when={state()||synced()}><View onPress={props.onDismiss} focusable class="absolute w-[200] h-[48] rounded-[47] items-center justify-center active:scale-96" style={{insetL:(props.width-200)/2,insetT:contentTop()+(state()?25+hint().length*14+12:128+17+12),bgColor:transition()>.5?'#e0e0e0':'#2c2c2c'}}><Text class="text-[17px]" style={{textColor:foreground()}}>关闭</Text></View></Show>
  </Show>
  <View onPress={()=>setDownload(true)} focusable class="absolute left-[14] right-[14] items-center justify-center" style={{insetT:linkTop(),height:downloadHint().length*14}}><Text class="text-xs leading-[14] text-center" style={{textColor:foreground(),opacity:.8}}>{downloadHint().join("\n")}</Text></View>
  <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation={title()} onDismiss={()=>setDownload(false)} onError={props.onError}/></Show>
 </View>;
}
