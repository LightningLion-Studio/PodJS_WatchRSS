import {playbackWork} from '../core/playback-work';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('SpeechPlaybackScreen');
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { onRawScrollInput, onLifecycleChange, lifecycle, getDisplayMetrics } from "@podjs/framework/watch";
import { mediaVolume, delay, hostOperation } from "@podjs/framework/services";
import { CrownVolumeController } from "../media/crown-volume.ts";
import { VolumeArcCapsule, volumeArcLeftEdge } from "./VolumeArcCapsule.tsx";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Scroller } from "@pocketjs/framework/kinetics";
import { ScrollEntries, type ScrollEntry } from "./ScrollEntries.tsx";
import { roundRowRange } from "@podjs/framework/round-list";
import { safeTopBlock } from "@podjs/framework/watch-ui";
import type { VariableListHandle } from "@podjs/framework/variable-list";
import { getOps } from "@pocketjs/framework/host";
import { measuredLines } from "../reader/measured-text.ts";
import { speechPlaybackStatus, type SpeechPlaybackState } from "../reader/speech-playback.ts";

export function SpeechPlaybackScreen(props: {
  width: number; height: number; active: boolean; state: SpeechPlaybackState;
  volumeEnabled:boolean; volumeGuard:boolean;
  pendingArticle?: string;
  ref?: (value: { scroller: Scroller }) => void;
  onToggle: () => void; onPrevious: () => void; onNext: () => void; onStop: () => void;
  onAutoAdvance: () => void; onRate: (step: -1 | 1) => void;
  currentArticleActionText: "返回文章" | "查看当前文章"; onOpenCurrentArticle: () => void;
}) {
  const pending = () => props.pendingArticle !== undefined;
  const [list, setList] = createSignal<VariableListHandle>();
  const hasScrollRange = () => {
    const scroller = list()?.scroller;
    return !!scroller && (scroller.intent() > 0 || !scroller.isAtEnd(0));
  };
  const [workForeground,setWorkForeground]=createSignal(lifecycle()==='active');
  createEffect(()=>{if(props.active&&workForeground()&&!pending()&&!props.state.error){const release=playbackWork.hold();onCleanup(release);}});
  const [volume,setVolume]=createSignal({visible:false,percent:0});
  const volumeController=new CrownVolumeController(mediaVolume,{after:(ms,callback)=>{const timer=delay(ms);void timer.result.then(callback,()=>{});return()=>timer.cancel();}},setVolume,
    ()=>{void hostOperation("ui.toast",{message:"音量调节防干扰触发，先停下以继续调整音量"}).result.catch(()=>{});},
    error=>logConsole.warn("朗读音量调节失败",error));
  const removeRaw=onRawScrollInput(event=>{if(props.active&&props.volumeEnabled&&!hasScrollRange()&&lifecycle()==="active")volumeController.adjust(event.vertical,event.uptimeMs,props.volumeGuard);});
  const removeLifecycle=onLifecycleChange(state=>{setWorkForeground(state==='active');if(state!=="active")volumeController.reset();});
  createEffect(()=>{props.active;props.volumeEnabled;props.volumeGuard;volumeController.reset();});
  onCleanup(()=>{removeRaw();removeLifecycle();volumeController.reset();});
  const volumeText=()=>`：${volume().percent}%`;
  const volumeWidth=()=>38+getOps().measureText(volumeText(),3);
  const round = getDisplayMetrics().shape === "round", volumeShown = createMemo(() => volume().visible);
  const padding = 18, verticalPadding = 7, gap = 6, titleHeight = 22;
  const title = createMemo(() => round
    ? safeTopBlock(props.width, props.height, () => titleHeight, { minTop: 12, maxWidth: 110 })!
    : { x: 0, y: verticalPadding, width: props.width, height: titleHeight });
  const listTop = () => title().y + title().height + gap;
  const listHeight = () => props.height - listTop();
  const roundList = () => ({ width: props.width, height: props.height,
    viewport: { x: 0, y: listTop(), width: props.width } });
  const inner = () => props.width - 2 * padding;
  const bounds = (width: number, height: number, y = 0) => {
    const w = Math.min(inner(), width);
    return { x: (inner() - w) / 2, y, width: w, height };
  };
  const articleBounds = () => bounds(164, 36);
  const shift = () => (list()?.roundInsets().start ?? 0) - (list()?.scroller.offset() ?? 0);
  const rowWidth = (y0: number, y1: number) => {
    const row = articleBounds(), full = row.width - 33;
    if (!round || !volumeShown()) return full;
    const top = listTop() + verticalPadding + shift();
    const edge = volumeArcLeftEdge(props.width, props.height, top + y0, top + y1);
    return edge === undefined ? full : Math.max(0, Math.min(full, edge - 4 - 51 - row.x));
  };
  const clipped = (text: string, width: number, slot = 3) =>
    measuredLines(text, width, s => getOps().measureText(s, slot), 1).join("");
  const errors = () => !pending() && props.state.error
    ? measuredLines(props.state.error, bounds(164, 14).width - 4, s => getOps().measureText(s, 0), 2)
    : [];
  const controls = () => bounds(188, 58);
  const controlScale = () => controls().width / 188;
  const rate = () => bounds(164, 36);
  const rateScale = () => rate().width / 164;
  const button = (name: string, label: () => string, src: () => string, x: () => number,
    y: () => number, size: () => number, press: () => void, enabled = () => true, selected = false) =>
    <View debugName={name} accessibilityRole="button" accessibilityLabel={label()} accessibilityState={{disabled:!enabled()}}
      onPress={enabled() ? press : undefined} focusable={enabled()} class="absolute rounded-[9999] items-center justify-center active:scale-96"
      style={{ insetL: x(), insetT: y(), width: size(), height: size(), opacity:enabled() ? 1 : 0.36, bgColor: selected ? "#ff6026" : "#00000000" }}>
      <Image src={src()} style={{ width: size() / 2, height: size() / 2 }} />
    </View>;
  const playing = () => !pending() && props.state.playing;
  const entries = createMemo<ScrollEntry[]>(() => {
    const rows: ScrollEntry[] = [
      { key:"article", height:36, visibleBounds:articleBounds(), render:() =>
        <View class="absolute" style={{insetL:articleBounds().x,width:articleBounds().width,height:36}}>
          <Image src="../assets/icons/speech-volume.svg" class="absolute left-[0] top-[6] w-[24] h-[24]" />
          <Text class="absolute left-[33] right-[0] top-[0] text-lg leading-[22] text-white">{clipped(props.pendingArticle || props.state.article?.title || "尚未开始朗读", rowWidth(0, 22))}</Text>
          <Text class="absolute left-[33] right-[0] top-[22] text-xs leading-[14] text-[#bdbdbd]">{clipped(pending() ? "点击播放开始朗读" : speechPlaybackStatus(props.state), rowWidth(22, 36), 0)}</Text>
        </View> },
    ];
    const errorHeight = errors().length * 14;
    if (errorHeight) rows.push({ key:"error", height:errorHeight, visibleBounds:bounds(164, errorHeight), render:() =>
      <Text class="absolute text-xs leading-[14] text-[#e54d4d] text-center"
        style={{ insetL: bounds(164, errorHeight).x, width: bounds(164, errorHeight).width, height: errorHeight }}>{errors().join("\n")}</Text> });
    rows.push(
      { key:"controls", height:58, visibleBounds:controls(), render:() =>
        <View class="absolute" style={{insetL:controls().x,width:controls().width,height:58}}>
          {button("SpeechPrevious", () => "上一篇", () => "../assets/icons/speech-previous.svg", () => 0, () => 8, () => 42 * controlScale(), props.onPrevious, () => !pending())}
          {button("SpeechToggle", () => playing() ? "暂停" : "播放", () => playing() ? "../assets/icons/speech-pause.svg" : "../assets/icons/speech-play.svg", () => 44 * controlScale(), () => 0, () => 58 * controlScale(), props.onToggle, () => true, true)}
          {button("SpeechNext", () => "下一篇", () => "../assets/icons/speech-next.svg", () => 103 * controlScale(), () => 8, () => 42 * controlScale(), props.onNext, () => !pending())}
          {button("SpeechStop", () => "停止", () => "../assets/icons/speech-stop.svg", () => 146 * controlScale(), () => 8, () => 42 * controlScale(), props.onStop, () => !pending())}
        </View> },
      { key:"rate", height:36, visibleBounds:rate(), render:() =>
        <View class="absolute" style={{insetL:rate().x,width:rate().width,height:36}}>
          <View debugName="SpeechAutoAdvance" accessibilityRole="button" accessibilityLabel="自动连播" onPress={props.onAutoAdvance} focusable class="absolute left-[0] top-[0] h-[36] items-center justify-center active:scale-96" style={{ width: 54 * rateScale() }}><Image src={props.state.autoAdvance ? "../assets/icons/speech-auto.svg" : "../assets/icons/speech-auto-off.svg"} class="w-[24] h-[24]" /></View>
          {button("SpeechSlower", () => "降低语速", () => "../assets/icons/speech-minus.svg", () => 58 * rateScale(), () => 2, () => 32 * rateScale(), props.onRate.bind(undefined, -1), () => !pending())}
          <Text class="absolute top-[7] text-lg leading-[22] text-white text-center" style={{ insetL: 90 * rateScale(), width: 42 * rateScale() }}>{`${props.state.rate}x`}</Text>
          {button("SpeechFaster", () => "提高语速", () => "../assets/icons/speech-plus.svg", () => 132 * rateScale(), () => 2, () => 32 * rateScale(), props.onRate.bind(undefined, 1), () => !pending())}
        </View> },
      { key:"return", height:30, visibleBounds:bounds(106, 17, 6), render:() =>
        <View debugName="SpeechReturn" onPress={props.onOpenCurrentArticle} focusable accessibilityRole="button" accessibilityLabel={props.currentArticleActionText} class="absolute inset-0">
          <Text class="absolute top-[6] left-[0] right-[0] text-sm leading-[17] text-[#ff6026] text-center">{props.currentArticleActionText}</Text>
        </View> },
    );
    if (!round) return rows;
    let top = verticalPadding;
    return rows.map(row => {
      const rowTop = top;
      top += row.height + gap;
      const range = roundRowRange(row, roundList(), listHeight(), padding);
      return { ...row, render: () => {
        const fits = () => !!range && rowTop + shift() >= range.min - 1e-6 && rowTop + shift() <= range.max + 1e-6;
        return <Show when={fits()}>{row.render()}</Show>;
      } };
    });
  });
  return <View debugName="SpeechPlayback" class="absolute inset-0 bg-black">
    <Text class="absolute text-lg leading-[22] text-white text-center"
      style={{ insetL:title().x, insetT:title().y, width:title().width, height:title().height }}>朗读播控</Text>
    <View class="absolute left-[0] right-[0]" style={{ insetT:listTop(), height:listHeight() }}>
      <ScrollEntries height={listHeight()} round={round ? roundList() : null} entries={entries()}
        padding={padding} verticalPadding={verticalPadding} gap={gap}
        inputActive={() => props.active} accessibilityLabel="朗读播控"
        ref={value => { setList(value); props.ref?.(value); }} />
    </View>
    <Show when={round && volume().visible}><VolumeArcCapsule width={props.width} height={props.height} percent={volume().percent} /></Show>
    <Show when={!round && volume().visible}><View debugName="SpeechVolumeOverlay" class="absolute rounded-[9999]" style={{insetL:(props.width-volumeWidth())/2,insetT:(props.height-33)/2,width:volumeWidth(),height:33,bgColor:"#1c1f21db"}}>
      <Image src="../assets/icons/speech-volume-overlay.svg" class="absolute left-[8] w-[18] h-[18]" style={{insetT:7.5}} />
      <Text class="absolute left-[30] top-[6] text-lg leading-[22] text-[#f5f5f5]" style={{width:volumeWidth()-38}}>{volumeText()}</Text>
    </View></Show>
  </View>;
}
