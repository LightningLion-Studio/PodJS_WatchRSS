import {tcp,byteStreams} from '@podjs/framework/services';
import {createSignal,createMemo,createEffect,onCleanup,Show} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getOps} from '@pocketjs/framework/host';
import {RemoteInputServer} from '../remote-input/server.ts';
import {ConfigPairingSession} from '../tts/config-pairing.ts';
import {serveTtsConfigHttp} from '../tts/config-http.ts';
import {TtsConfigStore} from '../tts/config-store.ts';
import {RemoteInputQr} from './RemoteInputScreen.tsx';
import {DownloadPhoneAppDialog} from './DownloadPhoneAppDialog.tsx';
import {watchUiLines} from './text-layout.ts';

const title='配置朗读语音';
const hint='请使用手机版扫描下方二维码';
const downloadPrompt=`下载手机端App以完成${title}`;
export function TtsConfigScreen(props:{width:number;height:number;active:()=>boolean;onSaved:()=>void;onDismiss:()=>void;onError:(message:string)=>void;ref?:(value:{onRootBack:()=>boolean})=>void}){
 const [qr,setQr]=createSignal(''),[started,setStarted]=createSignal(false),[unavailable,setUnavailable]=createSignal(false),[failure,setFailure]=createSignal(false),[saved,setSaved]=createSignal(false),[download,setDownload]=createSignal(false);
 const [transition,setTransition]=createSignal(0),opened=Date.now();
 onFrame(()=>{const next=Math.max(0,Math.min(1,(Date.now()-opened-3000)/1000));if(next!==transition())setTransition(next);});
 createEffect(()=>{
  if(!props.active())return;
  let alive=true,server:RemoteInputServer|undefined,pairing:ConfigPairingSession|undefined;
  setQr('');setStarted(false);setUnavailable(false);setFailure(false);setSaved(false);
  void (async()=>{
   pairing=await ConfigPairingSession.create();
   if(!alive){pairing.invalidate();return;}
   const session=pairing;
   server=new RemoteInputServer(()=>{},error=>{if(alive){setFailure(true);props.onError(String(error));}},{tcp,streams:byteStreams},'0.0.0.0',
    (stream,active)=>serveTtsConfigHttp(stream,active,session,new TtsConfigStore(),()=>{if(alive){setSaved(true);props.onSaved();}}));
   const endpoint=await server.ready;
   if(!alive)return;
   setStarted(true);
   if(!endpoint.addresses.length){setUnavailable(true);return;}
   setQr(session.qrContent(endpoint.addresses[0],endpoint.port));
  })().catch(error=>{if(alive){setFailure(true);props.onError(String(error));}});
  onCleanup(()=>{alive=false;pairing?.invalidate();void server?.dispose();});
 });
 const closeDownload=()=>{if(!download())return false;setDownload(false);return true;};props.ref?.({onRootBack:closeDownload});
 const foreground=()=>{const v=Math.round(255*(1-transition())).toString(16).padStart(2,'0');return '#'+v+v+v;};
 const background=()=>{const v=Math.round(255*transition()).toString(16).padStart(2,'0');return '#'+v+v+v;};
 const wrap=(value:string)=>watchUiLines(value,{width:props.width-28,measure:text=>getOps().measureText(text,0)});
 const hintLines=()=>wrap(hint),downloadLines=()=>wrap(downloadPrompt);
 const state=()=>failure()?'服务器启动失败':!started()?'正在启动服务器...':unavailable()?'请连接WiFi网络':'';
 const completed=()=>saved()&&!!qr();
 const height=createMemo(()=>26+12+(state()?17+(started()?8+hintLines().length*14+12+48:0):120+8+hintLines().length*14+(completed()?12+17+12+48:0))+8+downloadLines().length*14);
 const top=()=>Math.max(10,(props.height-height())/2),contentTop=()=>top()+38,linkTop=()=>top()+height()-downloadLines().length*14;
 const buttonTop=()=>contentTop()+(state()?25+hintLines().length*14+12:128+17+12);
 return <View class="absolute inset-0" style={{bgColor:background()}}>
  <Text class="absolute left-[14] right-[14] text-[21px] leading-[26] text-center" style={{insetT:top(),textColor:foreground()}}>{title}</Text>
  <Show when={qr()&&!state()} fallback={<Text class="absolute left-[14] right-[14] text-sm leading-[17] text-center" style={{insetT:contentTop(),textColor:unavailable()?'#b00020':foreground(),opacity:unavailable()?1:.7}}>{state()}</Text>}>
   <View class="absolute" style={{insetL:(props.width-120)/2,insetT:contentTop(),width:120,height:120,bgColor:'#000000'}}><RemoteInputQr value={qr()} onError={message=>{setFailure(true);props.onError(message);}}/></View>
  </Show>
  <Show when={started()}>
   <Text class="absolute left-[14] right-[14] text-xs leading-[14] text-center" style={{insetT:contentTop()+(state()?25:128),textColor:completed()?transition()>.5?'#1976d2':'#64b5f6':foreground(),opacity:completed()?1:.7}}>{completed()?'已同步至手机端':hintLines().join('\n')}</Text>
   <Show when={state()||completed()}><View onPress={props.onDismiss} focusable class="absolute w-[200] h-[48] rounded-[47] items-center justify-center active:scale-96" style={{insetL:(props.width-200)/2,insetT:buttonTop(),bgColor:transition()>.5?'#e0e0e0':'#2c2c2c'}}><Text class="text-[17px]" style={{textColor:foreground()}}>关闭</Text></View></Show>
  </Show>
  <View onPress={()=>setDownload(true)} focusable class="absolute left-[14] right-[14] items-center justify-center" style={{insetT:linkTop(),height:downloadLines().length*14}}><Text class="text-xs leading-[14] text-center" style={{textColor:foreground(),opacity:.8}}>{downloadLines().join('\n')}</Text></View>
  <Show when={download()}><DownloadPhoneAppDialog width={props.width} height={props.height} operation={title} onDismiss={()=>setDownload(false)} onError={props.onError}/></Show>
 </View>;
}
