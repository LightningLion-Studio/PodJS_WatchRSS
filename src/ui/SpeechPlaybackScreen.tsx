import {playbackWork} from '../core/playback-work';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('SpeechPlaybackScreen');
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { onRawScrollInput, onLifecycleChange, lifecycle, getDisplayMetrics } from "@podjs/framework/watch";
import { mediaVolume, delay, hostOperation } from "@podjs/framework/services";
import { CrownVolumeController } from "../media/crown-volume.ts";
import { VolumeArcCapsule, volumeArcLeftEdge } from "./VolumeArcCapsule.tsx";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import { measuredLines } from "../reader/measured-text.ts";
import type {QrRect} from '@podjs/framework/round-layout';
import {speechControlsLayout} from './speech-controls-layout.ts';
import { speechPlaybackStatus, type SpeechPlaybackState } from "../reader/speech-playback.ts";

export function SpeechPlaybackScreen(props: {
  width: number; height: number; active: boolean; state: SpeechPlaybackState;
  volumeEnabled:boolean; volumeGuard:boolean;
  onToggle: () => void; onPrevious: () => void; onNext: () => void; onStop: () => void;
  onAutoAdvance: () => void; onRate: (step: -1 | 1) => void;
  currentArticleActionText: "返回文章" | "查看当前文章"; onOpenCurrentArticle: () => void;
}) {
  const [workForeground,setWorkForeground]=createSignal(lifecycle()==='active');
  createEffect(()=>{if(props.active&&workForeground()&&!props.state.error){const release=playbackWork.hold();onCleanup(release);}});
  const [volume,setVolume]=createSignal({visible:false,percent:0});
  const volumeController=new CrownVolumeController(mediaVolume,{after:(ms,callback)=>{const timer=delay(ms);void timer.result.then(callback,()=>{});return()=>timer.cancel();}},setVolume,
    ()=>{void hostOperation("ui.toast",{message:"音量调节防干扰触发，先停下以继续调整音量"}).result.catch(()=>{});},
    error=>logConsole.warn("朗读音量调节失败",error));
  const removeRaw=onRawScrollInput(event=>{if(props.active&&props.volumeEnabled&&lifecycle()==="active")volumeController.adjust(event.vertical,event.uptimeMs,props.volumeGuard);});
  const removeLifecycle=onLifecycleChange(state=>{setWorkForeground(state==='active');if(state!=="active")volumeController.reset();});
  createEffect(()=>{props.active;props.volumeEnabled;props.volumeGuard;volumeController.reset();});
  onCleanup(()=>{removeRaw();removeLifecycle();volumeController.reset();});
  const volumeText=()=>`：${volume().percent}%`;
  const volumeWidth=()=>38+getOps().measureText(volumeText(),3);
  const round = getDisplayMetrics().shape === "round", volumeShown = createMemo(() => volume().visible);
  // While the round capsule shows, the article row (left 18+33) yields to it; re-clipped on show/hide only.
  const rowWidth = (y0: number, y1: number) => { const full = inner() - 33; if (!round || !volumeShown()) return full; const edge = volumeArcLeftEdge(props.width, props.height, y0, y1); return edge === undefined ? full : Math.max(0, Math.min(full, edge - 4 - 51)); };
  let surface: NodeMirror | undefined;
  createGesture({ region: { node: () => surface }, onTap: contact => { if (props.active) { const node = hitNode(contact.x, contact.y, contact.surface); if (node) pressNode(node); } } });
  const inner = () => props.width - 36;
  const clipped = (text: string, width: number, slot = 3) => measuredLines(text, width, s => getOps().measureText(s, slot), 1).join("");
  const errors = () => props.state.error ? measuredLines(props.state.error, inner(), s => getOps().measureText(s, 0), 2) : [];
  const layout=createMemo(()=>speechControlsLayout(props.width,props.height,errors().length,round));
  const headerY=(y:number)=>layout().headerTop+y*layout().headerScale;
  const bounds=(box:QrRect)=>({insetL:box.x,insetT:box.y,width:box.width,height:box.height});
  const button=(name:string,src:string,box:QrRect,press:()=>void,selected=false,iconSize=box.width/2)=>
    <View debugName={name} onPress={press} focusable class="absolute rounded-[9999] items-center justify-center active:scale-96"
      style={{...bounds(box),bgColor:selected?"#ff6026":"#00000000"}}><Image src={src} style={{width:iconSize,height:iconSize}} /></View>;
  return <View ref={value => surface = value} debugName="SpeechPlayback" class="absolute inset-0 bg-black">
    <Text class="absolute left-[18] right-[18] text-lg leading-[22] text-white text-center" style={{insetT:headerY(12)}}>朗读播控</Text>
    <View class="absolute left-[18] right-[18] h-[36]" style={{insetT:headerY(40)}}>
      <Image src="../assets/icons/speech-volume.svg" class="absolute left-[0] top-[6] w-[24] h-[24]" />
      <Text class="absolute left-[33] right-[0] top-[0] text-lg leading-[22] text-white">{clipped(props.state.article?.title || "尚未开始朗读", rowWidth(headerY(40),headerY(62)))}</Text>
      <Text class="absolute left-[33] right-[0] text-xs leading-[14] text-[#bdbdbd]" style={{insetT:22*layout().headerScale}}>{clipped(speechPlaybackStatus(props.state), rowWidth(headerY(62),headerY(76)), 0)}</Text>
    </View>
    <Text class="absolute left-[18] right-[18] text-xs leading-[14] text-[#e54d4d] text-center"
      style={{insetT:headerY(81),lineHeight:14*layout().headerScale,scale:layout().headerScale}}>{errors().join("\n")}</Text>
    <Show when={layout().buttons}>{controls=><>
      {button("SpeechPrevious","../assets/icons/speech-previous.svg",controls().previous,props.onPrevious)}
      {button("SpeechToggle",props.state.playing?"../assets/icons/speech-pause.svg":"../assets/icons/speech-play.svg",controls().toggle,props.onToggle,true)}
      {button("SpeechNext","../assets/icons/speech-next.svg",controls().next,props.onNext)}
      {button("SpeechStop","../assets/icons/speech-stop.svg",controls().stop,props.onStop)}
      {button("SpeechAutoAdvance",props.state.autoAdvance?"../assets/icons/speech-auto.svg":"../assets/icons/speech-auto-off.svg",
        controls().auto,props.onAutoAdvance,false,24*layout().headerScale)}
      {button("SpeechSlower","../assets/icons/speech-minus.svg",controls().slower,()=>props.onRate(-1))}
      <Text class="absolute text-lg leading-[22] text-white text-center"
        style={{...bounds(controls().rate),scale:layout().headerScale,lineHeight:22*layout().headerScale}}>{`${props.state.rate}x`}</Text>
      {button("SpeechFaster","../assets/icons/speech-plus.svg",controls().faster,()=>props.onRate(1))}
      <View debugName="SpeechReturn" onPress={props.onOpenCurrentArticle} focusable class="absolute items-center justify-center"
        style={bounds(controls().return)}><Text class="text-sm leading-[17] text-[#ff6026]"
          style={{translateY:round?0:-4.5,scale:layout().headerScale}}>{props.currentArticleActionText}</Text></View>
    </>}</Show>
    <Show when={round && volume().visible}><VolumeArcCapsule width={props.width} height={props.height} percent={volume().percent} /></Show>
    <Show when={!round && volume().visible}><View debugName="SpeechVolumeOverlay" class="absolute rounded-[9999]" style={{insetL:(props.width-volumeWidth())/2,insetT:(props.height-33)/2,width:volumeWidth(),height:33,bgColor:"#1c1f21db"}}>
      <Image src="../assets/icons/speech-volume-overlay.svg" class="absolute left-[8] w-[18] h-[18]" style={{insetT:7.5}} />
      <Text class="absolute left-[30] top-[6] text-lg leading-[22] text-[#f5f5f5]" style={{width:volumeWidth()-38}}>{volumeText()}</Text>
    </View></Show>
  </View>;
}
