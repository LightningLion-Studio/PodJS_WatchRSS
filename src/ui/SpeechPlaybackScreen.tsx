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
import { speechPlaybackStatus, type SpeechPlaybackState } from "../reader/speech-playback.ts";

export function SpeechPlaybackScreen(props: {
  width: number; height: number; active: boolean; state: SpeechPlaybackState;
  volumeEnabled:boolean; volumeGuard:boolean;
  onToggle: () => void; onPrevious: () => void; onNext: () => void; onStop: () => void;
  onAutoAdvance: () => void; onRate: (step: -1 | 1) => void;
  currentArticleActionText: "返回文章" | "查看当前文章"; onOpenCurrentArticle: () => void;
}) {
  createEffect(()=>{if(props.active){const release=playbackWork.hold();onCleanup(release);}});
  const [volume,setVolume]=createSignal({visible:false,percent:0});
  const volumeController=new CrownVolumeController(mediaVolume,{after:(ms,callback)=>{const timer=delay(ms);void timer.result.then(callback,()=>{});return()=>timer.cancel();}},setVolume,
    ()=>{void hostOperation("ui.toast",{message:"音量调节防干扰触发，先停下以继续调整音量"}).result.catch(()=>{});},
    error=>logConsole.warn("朗读音量调节失败",error));
  const removeRaw=onRawScrollInput(event=>{if(props.active&&props.volumeEnabled&&lifecycle()==="active")volumeController.adjust(event.vertical,event.uptimeMs,props.volumeGuard);});
  const removeLifecycle=onLifecycleChange(state=>{if(state!=="active")volumeController.reset();});
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
  const controlsTop = () => 85 + (errors().length ? 5 + errors().length * 14 : 0);
  const gap = () => Math.max(0, (inner() - 184) / 5);
  const button = (name: string, src: () => string, x: () => number, y: () => number, size: number, press: () => void, selected = false) =>
    <View debugName={name} onPress={press} focusable class="absolute rounded-[9999] items-center justify-center active:scale-96" style={{ insetL: x(), insetT: y(), width: size, height: size, bgColor: selected ? "#ff6026" : "#00000000" }}><Image src={src()} style={{ width: size / 2, height: size / 2 }} /></View>;
  return <View ref={value => surface = value} debugName="SpeechPlayback" class="absolute inset-0 bg-black">
    <Text class="absolute top-[12] left-[18] right-[18] text-lg leading-[22] text-white text-center">朗读播控</Text>
    <View class="absolute left-[18] top-[40] right-[18] h-[36]">
      <Image src="../assets/icons/speech-volume.svg" class="absolute left-[0] top-[6] w-[24] h-[24]" />
      <Text class="absolute left-[33] right-[0] top-[0] text-lg leading-[22] text-white">{clipped(props.state.article?.title || "尚未开始朗读", rowWidth(40, 62))}</Text>
      <Text class="absolute left-[33] right-[0] top-[22] text-xs leading-[14] text-[#bdbdbd]">{clipped(speechPlaybackStatus(props.state), rowWidth(62, 76), 0)}</Text>
    </View>
    <Text class="absolute left-[18] right-[18] top-[81] text-xs leading-[14] text-[#e54d4d] text-center">{errors().join("\n")}</Text>
    <View class="absolute left-[18] right-[18]" style={{ insetT: controlsTop(), height: 58 }}>
      {button("SpeechPrevious", () => "../assets/icons/speech-previous.svg", gap, () => 8, 42, props.onPrevious)}
      {button("SpeechToggle", () => props.state.playing ? "../assets/icons/speech-pause.svg" : "../assets/icons/speech-play.svg", () => 42 + gap() * 2, () => 0, 58, props.onToggle, true)}
      {button("SpeechNext", () => "../assets/icons/speech-next.svg", () => 100 + gap() * 3, () => 8, 42, props.onNext)}
      {button("SpeechStop", () => "../assets/icons/speech-stop.svg", () => 142 + gap() * 4, () => 8, 42, props.onStop)}
    </View>
    <View class="absolute left-[18] right-[18] h-[36]" style={{ insetT: controlsTop() + 67 }}>
      <View debugName="SpeechAutoAdvance" onPress={props.onAutoAdvance} focusable class="absolute left-[0] top-[0] h-[36] items-center justify-center active:scale-96" style={{ width: Math.max(36, inner() - 116) }}><Image src={props.state.autoAdvance ? "../assets/icons/speech-auto.svg" : "../assets/icons/speech-auto-off.svg"} class="w-[24] h-[24]" /></View>
      {button("SpeechSlower", () => "../assets/icons/speech-minus.svg", () => inner() - 106, () => 2, 32, () => props.onRate(-1))}
      <Text class="absolute top-[7] w-[42] text-lg leading-[22] text-white text-center" style={{ insetL: inner() - 74 }}>{`${props.state.rate}x`}</Text>
      {button("SpeechFaster", () => "../assets/icons/speech-plus.svg", () => inner() - 32, () => 2, 32, () => props.onRate(1))}
    </View>
    <View debugName="SpeechReturn" onPress={props.onOpenCurrentArticle} focusable class="absolute left-[18] right-[18] h-[34] items-center justify-center" style={{ insetT: controlsTop() + 111 }}><Text class="text-sm leading-[17] text-[#ff6026]" style={{translateY:-4.5}}>{props.currentArticleActionText}</Text></View>
    <Show when={round && volume().visible}><VolumeArcCapsule width={props.width} height={props.height} percent={volume().percent} /></Show>
    <Show when={!round && volume().visible}><View debugName="SpeechVolumeOverlay" class="absolute rounded-[9999]" style={{insetL:(props.width-volumeWidth())/2,insetT:(props.height-33)/2,width:volumeWidth(),height:33,bgColor:"#1c1f21db"}}>
      <Image src="../assets/icons/speech-volume-overlay.svg" class="absolute left-[8] w-[18] h-[18]" style={{insetT:7.5}} />
      <Text class="absolute left-[30] top-[6] text-lg leading-[22] text-[#f5f5f5]" style={{width:volumeWidth()-38}}>{volumeText()}</Text>
    </View></Show>
  </View>;
}
