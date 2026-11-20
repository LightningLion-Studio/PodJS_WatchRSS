import {useNetworkRecovery} from '../network/context.ts';
import {retryableDouyinSourceFailure,type DouyinReloadMode} from '../douyin/reload-playback.ts';
import {isTransportFailure} from '../network/recovery.ts';
import {ShellCommandError} from '@podjs/framework/shell-error';
import {measuredLines} from '../reader/measured-text.ts';
import {VideoReloadPolicy,VideoBufferedStallWait,videoSourceExpired} from './video-reload.ts';
import {PlayerLoadingIndicator,PlayerSpinner} from './PlayerLoadingIndicator.tsx';
import {playbackWork} from '../core/playback-work';
import {PlayerAnimationDiagnostics} from './player-animation-diagnostics.ts';
import {playerFailureCode,playerFailureFields,formatPlayerFailure,closedPlayerState,videoResourceUnavailable} from '../media/player-errors.ts';
import type {FailureStage} from '@podjs/framework/benchmark';
import {benchmark,type VideoBenchmarkAction} from '@podjs/framework/benchmark';
import {VideoFirstFrameWait} from '@podjs/framework/video-paging';
import {DOUYIN_MAX_SHORT_EDGE,DOUYIN_RESOLUTION_LIMIT,douyinCodecRuntimePolicy} from '../douyin/playback-selector.ts';
import {PlaybackPrepareDeadline} from '@podjs/framework/media-policy';
import {onMemoryTrim} from '@podjs/framework/memory';
import {playbackFailure} from '../media/playback-failure.ts';
import {takeVideoResolution,videoOptEnabled,type VideoPlaybackTrace} from '../media/video-opt.ts';
import {framePreviewPath,frameSource,type DouyinFramePreview} from '../douyin/frame-preview.ts';
import {kv} from "@podjs/framework/watch";
import {availableLoopModes, nextLoopMode, VideoLoopPreferences, VideoViewingProgress, VideoAutoAdvance, type VideoLoopMode} from "../media/loop-mode.ts";
import {afterPaint} from '@podjs/framework/render';
import {renderCheckpoint} from '@podjs/framework/render-checkpoint';
import {douyinDebug} from '../debug/douyin-host.ts';
import {restoredSignal,booleanState} from './route-activity.tsx';
import {appLogger} from '../logs/app-logger.ts';
import { douyinSourceNeedsInternet, douyinNetworkFailure } from "./douyin/player-network.ts";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import {normalizeRotation,playerGesture,rotateVector} from "./player-gestures.ts";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { hasCapability, lifecycle, onLifecycleChange, normalizedRelativeAxisStep } from "@podjs/framework/watch";
import * as videoServices from '@podjs/framework/services';
import { video, onVideoStateChanged, onVideoAudioChanged, onVideoFirstFrame, delay, type HostOperation, type VideoPrepare, type VideoBounds, type VideoState } from "@podjs/framework/services";
import { formatPlayerTime, systemVolumePercent, holdStepCount, guardedCrownVolume, nextScaleMode, playerPanRange, progressWidth, seekHoldStep, type CrownVolumeGuardState, type PlayerScaleMode } from "./video-player.ts";
import { DouyinVideoSessionPool, douyinPagerDelta, douyinPagerReleaseVelocity, douyinPagerProgress, douyinPagerSettleDuration, douyinPagerSettleProgress, shouldFallbackFromVideoSessions, shouldSettleDouyinPager, shouldUseDouyinVideoSessions, type DouyinPagerDirection, type DouyinPreparedSource } from "./douyin/video-sessions.ts";
import { RemoteImage } from "./RemoteImage.tsx";
import { createHoldPress } from "./hold-press.ts";
import { createDetailSlide, PlayerDetailArrow, PlayerDetailPanel, type PlayerDetailHandle } from "./PlayerDetailPanel.tsx";
import { VOLUME_ARC, VolumeArcCapsule } from "./VolumeArcCapsule.tsx";
import { avoidVolumeArc, type RowIcon } from "./volume-arc.ts";

// The host exposes one session, even when navigation retains several screens.
let videoSessionOwner:symbol|undefined;
const recoveredSources=new WeakSet<object>();
const MAX_AUTOMATIC_RESOURCE_RETRIES=2;

type ExtendedVideoState = VideoState & { sessionId?:string; volume?: number; buffered?: boolean; isBuffering?: boolean };
const liveFrame = (state:VideoState|null|undefined) => state?.hasRenderedFirstFrame===true&&state.hasCachedFirstFrame!==true;

export interface PlaybackSource { bypassCache?:boolean; expiresAtMs?:number; preparationError?:unknown; releaseStartupPreview?:()=>void; startupSeq?:number; biliApiSource?:'watch'|'web'; recoveryDeadlineMs?:number; previewOnly?:boolean;previewFrame?:DouyinFramePreview; detailPlayback?:boolean; immersive?:boolean; awemeId?:string; posterUrl?:string; backgroundPlayback?: boolean; url?: string; videoUrl?: string; audioUrl?: string; webUrl?: string; headers?: Record<string, string>; type?: string; maxVideoShortEdge?:number; videoMime?:string; videoWidth?:number; videoHeight?:number; title: string; /** Detail panel metadata already held by the source; omitted fields are not shown. */ author?: string; description?: string; resumePositionMs?: number; volumeGuard?: boolean; startVolumeLimit?: number | null; digitalCrownVolume?: boolean; platform?: "bili" | "douyin" | "rss" }
export interface VideoPlayerHandle { reloadAttempts?():number; shellState():Promise<VideoState>; shellPlaying(playing:boolean):Promise<void>; invalidatePrefetch(id:string):void; previewKind():"actual_frame"|"cover"|undefined; loopMode():VideoLoopMode; availableLoopModes():readonly VideoLoopMode[]; setLoopMode(mode:VideoLoopMode):void; cycleLoopMode():void; onCrown(delta: number): boolean; gestureRotation():number; canSwipeBack(): boolean; /** Right-to-left drag that opens the detail panel; begin() returns false when it cannot open. */ sideSwipe: { begin(): boolean; move(dx: number): void; end(vx: number): void; cancel(): void } }

const LOOP_LABELS: Record<VideoLoopMode, string> = { off: "不循环", single: "单视频循环", next: "自动下一个" };
function PlayerButton(props: { hidden?: boolean; left: number; top: number; size: number; icon: "fullscreen" | "panorama" | "fullscreen-exit" | "rotate" | "rewind" | "forward" | "play" | "pause" | "loop-off" | "loop-single" | "loop-next"; accessibilityLabel?: string; iconSize: number; enabled?: boolean; onPress: () => void; onHold?: (elapsedMs: number) => void }) {
  let node: NodeMirror | undefined;
  createHoldPress(() => node, { enabled: () => !props.hidden && props.enabled !== false, onPress: () => props.onPress(), onHold: props.onHold && (elapsed => props.onHold?.(elapsed)) });
  return <Show when={!props.hidden}><View ref={value => node = value} debugName={props.icon === "rotate" ? "VideoPlayerRotate" : undefined} onPress={() => { if (props.enabled !== false) props.onPress(); }} focusable={props.enabled !== false} accessibilityLabel={props.accessibilityLabel} accessibilityRole={props.accessibilityLabel ? "button" : undefined} style={{ insetL: props.left, insetT: props.top, width: props.size, height: props.size, opacity: props.enabled === false ? .5 : 1 }} class="absolute items-center justify-center active:scale-96">
    <Show when={props.icon === "fullscreen"}><Image src="../assets/icons/player-fullscreen.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "panorama"}><Image src="../assets/icons/player-panorama.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "fullscreen-exit"}><Image src="../assets/icons/player-fullscreen-exit.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rotate"}><Image src="../assets/icons/player-rotate.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rewind"}><Image src="../assets/icons/player-rewind.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "forward"}><Image src="../assets/icons/player-forward.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "play"}><Image src="../assets/icons/player-play.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "pause"}><Image src="../assets/icons/player-pause.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-off"}><Image src="../assets/icons/player-loop-off.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-single"}><Image src="../assets/icons/player-loop-single.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-next"}><Image src="../assets/icons/player-loop-next.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show>
  </View></Show>;
}

function PlayerTimeline(props: {positionMs: number; durationMs: number}) {
  const elapsed = createMemo(() => formatPlayerTime(props.positionMs));
  const duration = createMemo(() => formatPlayerTime(props.durationMs));
  const measure = (text: string) => Math.max(16, Math.ceil(getOps().measureText(text, 19)));
  const startWidth = createMemo(() => measure(elapsed()));
  const endWidth = createMemo(() => measure(duration()));
  const barWidth = () => Math.max(20, 181 - startWidth() - endWidth() - 11);
  const timelineProgress = createMemo(() => progressWidth(props.positionMs, props.durationMs, barWidth()));
  return <>
    <Text style={{ width: startWidth() }} class="absolute left-[26] top-[181] text-[9px] leading-[13] text-white text-right">{elapsed()}</Text>
    <View style={{ insetL: 31.5 + startWidth(), width: barWidth() }} class="absolute top-[183] h-[4] rounded-[2] bg-[#b6b6b659]">
      <Show when={timelineProgress()>0}><View class="absolute left-[0] top-[0] h-[4] rounded-[2] bg-[#ff6700]" style={{width:timelineProgress()}} /></Show>
      <View class="absolute top-[0] w-[4] h-[4] rounded-[2] bg-[#ff6700]" style={{insetL:Math.max(0,Math.min(barWidth()-4,timelineProgress()-2))}} />
    </View>
    <Text style={{ width: endWidth() }} class="absolute right-[26] top-[181] text-[9px] leading-[13] text-[#b6b6b6]">{duration()}</Text>
  </>;
}

export function VideoPlayerScreen(props: { initialPool?:DouyinVideoSessionPool; source: PlaybackSource; width: number; height: number; /** Screen y of the player area; height is the area below it. */ top?: number; active: boolean; offset: number; offsetVector?: {x:number;y:number}; round: boolean; onBluetoothAllowed?:(value:boolean)=>void; onPlaybackActiveChanged?:(source:string|undefined,active:boolean)=>void; onFirstFrame?:()=>void; onError?: (message: string) => void; onProgress?: (positionMs: number, durationMs: number) => void; onCheckpoint?: (kind: "ready" | "pause_or_exit" | "error" | "ended", positionMs: number, durationMs: number) => void; onNext?: () => void | Promise<void>; onPrevious?: () => void | Promise<void>; onAdjacentPoster?:(direction:"next"|"previous")=>string|undefined; onRejectAdjacent?:(source:DouyinPreparedSource,mirrorIndex?:number)=>void; onAdjacentKey?:(direction:"next"|"previous",distance?:1|2|3|4|5)=>string|undefined; onPrepareAdjacent?:(direction:"next"|"previous",distance?:1|2|3|4|5)=>Promise<DouyinPreparedSource|undefined>; onBoundaryRelease?:(direction:"next"|"previous")=>void; canSelectTarget?:(direction:"next"|"previous")=>boolean; onSelectTarget?:(direction:"next"|"previous",distance:1|2,prepared?:DouyinPreparedSource)=>void; onPromoteAdjacent?:(prepared:DouyinPreparedSource)=>Promise<boolean>; onActions?:()=>void; onReload?:(positionMs:number,current:()=>boolean,mode?:DouyinReloadMode)=>void|Promise<void>; onRetry?:(positionMs:number)=>void|Promise<void>; onPlaybackFailure?:(positionMs:number,error?:unknown)=>void|Promise<void>; onPanStateChange?: (offset: number, range: number) => void; ref?: (handle: VideoPlayerHandle) => void }) {
  const network=useNetworkRecovery();
  const renderDiagnostics=videoOptEnabled('metrics');
  const [networkWaiting,setNetworkWaiting]=createSignal(false);
  const [workForeground,setWorkForeground]=createSignal(lifecycle()==='active');
  benchmark.mark('startup_stage',props.source.startupSeq??0,{startup_stage:'player_mounted'});
  onCleanup(()=>props.onPlaybackActiveChanged?.(undefined,false));
  const loopPreferences=new VideoLoopPreferences(kv);
  const loopModes=()=>availableLoopModes(props.source.platform,!!props.onNext&&!!props.onPrepareAdjacent);
  const [loopMode,setLoopModeState]=createSignal(loopPreferences.load(props.source.platform,loopModes()));
  const autoAdvance=new VideoAutoAdvance(),viewing=new VideoViewingProgress();
  let viewingKey:string|undefined;
  const resetViewing=(source:PlaybackSource)=>{const key=source.awemeId??source.webUrl??source.url??source.videoUrl;if(key!==viewingKey){viewingKey=key;viewing.reset();autoAdvance.reset();}};
  const setLoopMode=(mode:VideoLoopMode)=>{if(!loopModes().includes(mode))return;loopPreferences.save(props.source.platform,mode);autoAdvance.cancel();setLoopModeState(mode);};
  const cycleLoopMode=()=>setLoopMode(nextLoopMode(loopMode(),loopModes()));
  const [loopHint,setLoopHint]=createSignal<string>();let loopHintTimer:HostOperation<void>|undefined;
  const tapLoopMode=()=>{cycleLoopMode();setLoopHint(LOOP_LABELS[loopMode()]);loopHintTimer?.cancel();loopHintTimer=delay(1200);void loopHintTimer.result.then(()=>setLoopHint()).catch(()=>{});};
  onCleanup(()=>loopHintTimer?.cancel());
  createEffect(()=>{const platform=props.source.platform;if(props.active)setLoopModeState(loopPreferences.load(platform,loopModes()));});
  const emitCheckpoint=(kind:"ready"|"pause_or_exit"|"error"|"ended",positionMs:number,durationMs:number)=>{const value=viewing.checkpoint(positionMs,durationMs);props.onCheckpoint?.(kind,value.positionMs,value.durationMs);};
  const douyinPlayer = () => props.source.platform === 'douyin';
  const immersiveDouyin=douyinPlayer()&&props.source.immersive===true;
  const [state, setState] = createSignal<ExtendedVideoState | null>(null), [error, setError] = createSignal("");
  createEffect(()=>{if(props.active&&workForeground()&&!error()){const release=playbackWork.hold();onCleanup(release);}});
  const playbackActive=createMemo(()=>props.active&&state()?.state==='playing'&&!state()?.isBuffering&&!error());
  createEffect(()=>{
    const source=props.source.platform==='bili'?'bilibili':props.source.platform==='douyin'?'douyin':undefined;
    props.onPlaybackActiveChanged?.(source,!!source&&playbackActive());
  });
  const [ready, setReady] = createSignal(false), [controlsVisible, setControlsVisible] = restoredSignal('saved','player-controls',true,booleanState,immersiveDouyin);
  const [mode, setMode] = restoredSignal<PlayerScaleMode>('saved','player-scale',"standard",(v):v is PlayerScaleMode=>v==='standard'||v==='expanded'||v==='shrunk',immersiveDouyin);
  // Rotation belongs to the mounted Douyin player, including queue changes.
  const [rotation, setRotation] = createSignal(0);
  const [displayRotation, setDisplayRotation] = createSignal(0), [pan, setPan] = createSignal(0), [volumeVisible, setVolumeVisible] = createSignal(false);
  const animationDiagnostics=new PlayerAnimationDiagnostics(line=>{if(props.source.platform==='douyin')appLogger.i('DouyinAnimation',line);},()=>Date.now());
  onCleanup(()=>animationDiagnostics.close());
  // Retain the saved preference for activity snapshot compatibility; it no longer gates playback.
  const [allowBluetooth] = restoredSignal('saved','player-bluetooth',false,booleanState,immersiveDouyin);
  const [networkFailure, setNetworkFailure] = createSignal(false);
  const [sessionsDisabled,setSessionsDisabled]=createSignal(false),[dragProgress,setDragProgress]=createSignal(0),[dragPoster,setDragPoster]=createSignal<{url:string;filePath?:string;direction:DouyinPagerDirection}|null>(null),[dragAxis,setDragAxis]=createSignal<DouyinPagerDirection|undefined>(),[handoff,setHandoff]=createSignal(false),[firstFrame,setFirstFrame]=createSignal(false),[nativeDrag,setNativeDrag]=createSignal(false),[spinnerDue,setSpinnerDue]=createSignal(false);
  let benchmarkSeq=0,benchmarkGeneration=1,lastBenchmarkHeartbeat=0;
  let pendingBenchmark:VideoBenchmarkAction|undefined,pendingBenchmarkSource:PlaybackSource|undefined;
  const frameWait=new VideoFirstFrameWait(Date.now,1000);frameWait.reset();
  const [startLimitConsumed,setStartLimitConsumed]=restoredSignal('saved','player-start-limit-consumed',false,booleanState,immersiveDouyin);
  const sessionCapable=shouldUseDouyinVideoSessions(props.source,hasCapability("media.video.sessions"));
  const sessionPool=sessionCapable?(props.initialPool??new DouyinVideoSessionPool()):undefined;
  const usingSessions=()=>!!sessionPool&&!sessionsDisabled();
  const sessionSource=(source:PlaybackSource):DouyinPreparedSource=>({key:source.awemeId??source.url??source.videoUrl??"current",source});
  createEffect(()=>{props.onBluetoothAllowed?.(allowBluetooth());});
  const networkPrompt=()=>networkWaiting();
  const sessionOwner=Symbol("video-screen");
  createEffect(()=>{if(props.active&&props.source.platform==='douyin'&&props.source.immersive&&douyinDebug.allowed)
    onCleanup(douyinDebug.bindSessions(async()=>usingSessions()&&videoSessionOwner===sessionOwner?sessionPool!.diagnostics():undefined));});
  const [badFrame,setBadFrame]=createSignal<string>();
  const previewPath=()=>{const path=framePreviewPath(props.source.previewFrame,props.source.awemeId);return path!==badFrame()?path:undefined;};
  const recoveryDeadline=new PlaybackPrepareDeadline();
  const reloadPolicy=new VideoReloadPolicy();
  const bufferedStall=new VideoBufferedStallWait();
  let reloadCount=0;
  const [reconnecting,setReconnecting]=createSignal(false);
  let reloadWait:HostOperation<void>|undefined;
  let reloadTimeout:HostOperation<void>|undefined;
  let reloadResume:number|undefined;
  let freshPrepare=false,needsFreshResolution=false;
  let resumeAutoplay:boolean|undefined;
  type ResourceRetry={source:PlaybackSource;positionMs:number;autoplay:boolean;attempt:number;manualOnly?:boolean;timer?:HostOperation<void>};
  let resourceRetry:ResourceRetry|undefined;
  let resourcePrepareGeneration:number|undefined;
  let detailReload:{source:PlaybackSource;manual:boolean}|undefined;
  const isManualDetailSource=()=>detailReload?.source===props.source&&detailReload.manual;
  const stopResourceTimer=()=>{if(resourceRetry){resourceRetry.timer?.cancel();resourceRetry.timer=undefined;}};
  const cancelResourceRetry=()=>{stopResourceTimer();resourceRetry=undefined;};
  const douyinPlayback=()=>props.source.platform==='douyin'||props.source.awemeId!==undefined;
  const isResourceFailure=(value:unknown)=>douyinPlayback()&&videoResourceUnavailable(value);
  const retryCacheMiss=(value:unknown)=>(value as {code?:string}|undefined)?.code==='video_retry_cache_miss';
  createEffect(()=>{
    const source=props.source;
    if(!props.active||resourceRetry?.source!==source)cancelResourceRetry();
  });
  onCleanup(cancelResourceRetry);
  createEffect(()=>{if(reloadPolicy.select(props.source)){reloadCount=0;bufferedStall.cancel();reloadWait?.cancel();reloadTimeout?.cancel();setReconnecting(false);reloadResume=undefined;needsFreshResolution=false;}});
  const cancelReload=()=>{reloadPolicy.cancel();reloadWait?.cancel();reloadWait=undefined;reloadTimeout?.cancel();reloadTimeout=undefined;setReconnecting(false);};
  onCleanup(cancelReload);
  let retiredNativeGeneration=-1;
  let preparedSource:PlaybackSource|undefined;
  let networkRetriedSource:PlaybackSource|undefined;
  let firstFrameSource:PlaybackSource|undefined;
  let frameTrace:{source:PlaybackSource;generation:number;seq:number;live:boolean}|undefined;
  const tracePreparedSource=(source:PlaybackSource,action?:VideoBenchmarkAction)=>{
    const previous=frameTrace?.source===props.source?frameTrace.seq:0;
    const seq=action?.seq??source.startupSeq??previous;
    frameTrace={source:props.source,generation,seq,live:false};
    benchmark.mark('startup_stage',seq,{startup_stage:'candidate_ready',generation});
    return seq;
  };
  createEffect(()=>{if(firstFrame()&&(state()?.hasRenderedFirstFrame||state()?.hasCachedFirstFrame)&&preparedSource===props.source){
    const frame=state();
    if(frame&&liveFrame(frame)){
      recoveryDeadline.cancel();recoveredSources.add(props.source);
      if(resourceRetry?.source===props.source){
        cancelResourceRetry();setError('');props.onError?.('');
      }
      if(detailReload?.source===props.source)detailReload=undefined;
      if(frameTrace?.generation===generation&&!frameTrace.live&&frame.sourceGeneration!==undefined){
        frameTrace.live=true;
        benchmark.mark('startup_stage',frameTrace.seq,{startup_stage:'playback_frame_adopted',generation,source_generation:frame.sourceGeneration});
      }
    }
    if(firstFrameSource!==props.source){firstFrameSource=props.source;props.onFirstFrame?.();}
    if(pendingBenchmark&&props.source!==pendingBenchmarkSource){benchmark.confirmVideoFrame(pendingBenchmark.seq,pendingBenchmark.generation);pendingBenchmark=undefined;}
  }});
  onCleanup(onVideoFirstFrame(value=>{
    if(disposed||videoSessionOwner!==sessionOwner||!props.active||reconnecting()||handoff()||props.source.previewOnly||preparedSource!==props.source)return;
    if(usingSessions()?!value.sessionId||!sessionPool!.ownsActiveSession(value.sessionId)||value.presented===false:!!value.sessionId)return;
    if(props.onReload&&!usingSessions()&&(value.sourceGeneration??-1)<=retiredNativeGeneration)return;
    if(state()?.sourceGeneration!==undefined&&state()!.sourceGeneration!==value.sourceGeneration)return;
    if(!value.hasRenderedFirstFrame&&!value.hasCachedFirstFrame)return;
    batch(()=>{setFirstFrame(true);setState(previous=>({...previous,...value}));setSpinnerDue(false);});
    captureFrame();
    if(resourcePrepareGeneration!==generation&&resourceRetry?.source!==props.source&&(detailReload?.source!==props.source||liveFrame(value)))void warmForward().catch(()=>{});
  }));
  let playbackTrace:VideoPlaybackTrace|undefined;
  createEffect(()=>{const value=state();if(value)playbackTrace?.sample(value,props.active&&(!usingSessions()||(value as {presented?:boolean}).presented===true));});
  let sessionCapacity:"unchecked"|"checking"|"available"|"unavailable"=sessionCapable?"unchecked":"unavailable";
  let autoplayAllowed=false;
  let preparingState:{generation:number;value:ExtendedVideoState}|undefined;
  let prepareStarted=0;
  let disposed = false, generation = 0, lastPlaybackState = "", checkpointPosition = 0, checkpointDuration = 0, pollTimer: HostOperation<void> | undefined, tapTimer: HostOperation<void> | undefined, volumeTimer: HostOperation<void> | undefined, prepareOp: HostOperation<VideoState> | undefined;
  const [motion,setMotion]=createSignal(false);
  let surface: NodeMirror | undefined, panningStart = 0, panVelocity = 0, panFrameAt = Date.now();
  // Only the tween keeps an unwrapped angle. Every consumer sees the same turn.
  let rotationFrom = 0, rotationTo = 0, rotationFrameAngle = 0, rotationStarted = 0;
  let transformRunning = false, transformDirty = false, seekRunning = false, desiredSeek = 0, volumeRunning = false, volumeDirty = false, virtualVolume: number | undefined, observedVolume: number | undefined, crownGuard: CrownVolumeGuardState = { lastEventMs: Number.NEGATIVE_INFINITY };
  const top = () => props.top ?? 0, screenHeight = () => props.height + top();
  const pagerRotation = () => rotation();
  const pagerLength = () => pagerRotation() % 180 === 0 ? props.height : props.width;
  const dragOffset = createMemo(() => {
    const direction = dragAxis();
    if (!direction || usingSessions() && nativeDrag()) return {x:0,y:0};
    const distance = dragProgress() * pagerLength();
    return rotateVector(0, direction === "up" ? -distance : distance, pagerRotation());
  });
  const restingBounds = () => ({ x: 0, y: top(), width: props.width, height: props.height, translateX: props.offsetVector?.x ?? props.offset, translateY: props.offsetVector?.y ?? 0, pagerOffset: { x: 0, y: 0 }, visible: props.active && !handoff(), roundClip: props.round ? { cx: props.width / 2, cy: screenHeight() / 2 - top(), radius: Math.min(props.width, screenHeight()) / 2 } : undefined });
  const bounds = () => {
    const base = restingBounds(), offset = dragOffset();
    return {...base, translateX:base.translateX+offset.x, translateY:base.translateY+offset.y, pagerOffset:offset};
  };
  const prepareTransform = () => ({scaleMode:mode(),rotationDeg:displayRotation(),scaleRotationDeg:rotation(),panX:0,panY:0});
  const finishRotation = (reason = "complete") => {
    if (!rotationStarted) return;
    rotationStarted = 0;
    setDisplayRotation(rotation());
    animationDiagnostics.end('rotation',reason);
  };
  let crownDirection: -1|1 = 1;
  const media={
    prepare:(options:VideoPrepare)=>{options={...options,respectSilentMode:true,compactProgress:true};return usingSessions()?sessionPool!.prepare(sessionSource(props.source),{...options,transform:prepareTransform()}):video.prepare(douyinPlayer()?{...options,transform:prepareTransform()}:options);},
    retire:(handoff=false)=>usingSessions()?sessionPool!.retire(handoff):video.retire(handoff),
    play:()=>usingSessions()?sessionPool!.play():video.play(),pause:(action?:VideoBenchmarkAction,handoff=false)=>usingSessions()?sessionPool!.pause(action,handoff):video.pause(handoff),
    seek:(positionMs:number)=>usingSessions()?sessionPool!.seek(positionMs):video.seek(positionMs),
    stop:()=>usingSessions()?sessionPool!.stop():video.stop(),state:()=>usingSessions()?sessionPool!.state():video.state(),
    setBounds:(value:VideoBounds)=>usingSessions()?sessionPool!.setBounds(value):video.setBounds(value),
    setTransform:(value:{rotationDeg?:number;scaleRotationDeg?:number;scaleMode?:"standard"|"expanded"|"shrunk";panX?:number;panY?:number},updateNeighbours:boolean)=>usingSessions()?sessionPool!.setTransform(value,updateNeighbours):video.setTransform(value),
    setVolume:(value:number)=>usingSessions()?sessionPool!.setVolume(value,crownDirection):video.setVolume(value,crownDirection),
    setMuted:(muted:boolean)=>usingSessions()?sessionPool!.setMuted(muted):video.setMuted(muted),
    setLoop:(value:boolean)=>usingSessions()?sessionPool!.setLoop(value):video.setLoop(value),
    setSpeed:(value:number)=>usingSessions()?sessionPool!.setSpeed(value):video.setSpeed(value),
  };
  onCleanup(onVideoAudioChanged(value=>{
    if(disposed||!props.active||videoSessionOwner!==sessionOwner)return;
    if(usingSessions()?!value.sessionId||!sessionPool!.ownsActiveSession(value.sessionId):!!value.sessionId)return;
    if(state()?.sourceGeneration!==undefined&&state()!.sourceGeneration!==value.sourceGeneration)return;
    const previous=state();
    if(previous&&(value.volumeIndex!==previous.volumeIndex||value.volumeMax!==previous.volumeMax||value.muted!==previous.muted))showVolumeOverlay();
    setState(previous=>({...previous,...value}));
    if(value.volume!==observedVolume){if(!volumeRunning){virtualVolume=value.volume;crownGuard={lastEventMs:Number.NEGATIVE_INFINITY};}observedVolume=value.volume;}
  }));
  let captured:{source:PlaybackSource;native:number;session?:string;position:number}|undefined;
  function captureFrame(leaving=false) {
    const source=preparedSource,current=state();
    if(source?.platform!=='douyin'||!source.awemeId||videoSessionOwner!==sessionOwner||!liveFrame(current)||current?.sourceGeneration===undefined)return;
    const native=current.sourceGeneration,session=current.sessionId,position=current.positionMs;
    if(captured?.source===source&&captured.native===native&&captured.session===session&&(!leaving||captured.position===position))return;
    const ticket={source,native,session,position};captured=ticket;
    const failedCapture=()=>{if(captured===ticket)captured=undefined;};
    const options={key:`douyin:${source.awemeId}`,source:frameSource({...source,maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE}),sourceGeneration:native};
    try{void (usingSessions()?sessionPool!.captureFrame(options):video.captureFrame(options)).catch(failedCapture);}catch{failedCapture();}
  }
  createEffect(()=>{const loop=loopMode()==="single";if(ready()&&videoSessionOwner===sessionOwner)void media.setLoop(loop).catch(value=>{if(usingSessions())void degradeSessions(value);else failed(value);});});
  createEffect(()=>{const release=props.source.releaseStartupPreview;onCleanup(()=>release?.());});
  const failed = (value: unknown,terminal=false,stage:FailureStage='unknown',checkedNetwork=false) => {
    if(disposed||!props.active||lifecycle()!=='active'||videoSessionOwner!==sessionOwner)return;
    const resourceFailure=isResourceFailure(value);
    const cacheMiss=douyinPlayback()&&retryCacheMiss(value);
    if(cacheMiss||resourceRetry?.source===props.source&&!resourceFailure){
      const fault=playerFailureCode(value);
      if(fault==='cancelled'||fault==='stale')return;
      if(resourceRetry?.source!==props.source)resourceRetry={source:props.source,positionMs:checkpointPosition,autoplay:autoplayAllowed,attempt:0};
      stopResourceTimer();resourceRetry.manualOnly=true;recoveryDeadline.cancel();
      const message=cacheMiss?'当前视频缓存不足，请稍后重试':formatPlayerFailure(fault);
      setReady(false);setError(message);props.onError?.(message);
      return;
    }
    const fromManualDetail=isManualDetailSource();
    if(fromManualDetail||networkRetriedSource===props.source&&isTransportFailure(value))terminal=true;
    if(!fromManualDetail&&!checkedNetwork&&networkRetriedSource!==props.source&&isTransportFailure(value)&&douyinSourceNeedsInternet(props.source.url??props.source.videoUrl)){
      if(networkWaiting())return;
      recoveryDeadline.cancel();const source=props.source,own=generation;setNetworkWaiting(true);
      setState(previous=>previous?{...previous,state:'error'}:previous);
      const usable=()=>state()?.state==='playing'&&state()?.isBuffering!==true&&state()?.hasRenderedFirstFrame===true;
      void network.recover(value,()=>{setNetworkWaiting(false);if(!disposed&&props.active&&source===props.source&&own===generation)return retry(true);},usable).then(()=>setNetworkWaiting(false)).catch(error=>{
        setNetworkWaiting(false);if(!disposed&&props.active&&source===props.source&&own===generation){failed(error,terminal,stage,true);recoverPlaybackFailure(error);}
      });return;
    }
    const detail=playerFailureFields(value,stage),fault=playerFailureCode(value);
    if(fault==='cancelled'||fault==='stale')return;
    recoveryDeadline.cancel();
    if(resourceFailure&&resourceRetry?.source===props.source){armResourceRetry();return;}
    if(!resourceFailure)cancelResourceRetry();
    if(props.onReload&&!resourceFailure&&!terminal&&!resolutionRejected(value)&&fault!=='restricted'&&fault!=='permission_denied'){void reload(false,value);return;}
    props.source.releaseStartupPreview?.();
    if(!terminal&&props.source.platform==='douyin'&&props.source.immersive&&props.onPlaybackFailure&&['network','expired'].includes(playbackFailure(value))){benchmark.begin('error_page',{reason:'candidate_retry',...detail});return;}
    benchmark.begin('error_page',{reason:'exhausted',...detail}); if(benchmarkSeq)benchmark.mark("error",benchmarkSeq,{generation:pendingBenchmark?.generation??benchmarkGeneration,...detail}); appLogger.e('VideoPlayer','Playback failed'); setHandoff(false); if (!disposed) { const message = resolutionRejected(value)?'视频清晰度超过 720P':formatPlayerFailure(fault); setNetworkFailure(douyinNetworkFailure(value)); setError(message); emitCheckpoint("error", checkpointPosition, checkpointDuration); props.onError?.(message); }
    if(resourceFailure){
      if(resourceRetry?.source!==props.source)resourceRetry={source:props.source,positionMs:checkpointPosition,autoplay:autoplayAllowed,attempt:0};
      setReady(false);
      armResourceRetry();
    }
  };
  const resolutionRejected=(value:unknown)=>(props.source.platform==='douyin'||props.source.maxVideoShortEdge!==undefined)&&(value as {code?:string}|undefined)?.code===DOUYIN_RESOLUTION_LIMIT;
  const recoverPlaybackFailure = (value: unknown) => {
    if(isResourceFailure(value)||retryCacheMiss(value)||resourceRetry?.source===props.source||isManualDetailSource())return;
    if(networkWaiting()||networkRetriedSource===props.source&&isTransportFailure(value))return;
    if(disposed||!props.active||lifecycle()!=='active'||videoSessionOwner!==sessionOwner)return;
    if(resolutionRejected(value)){
      void props.onPlaybackFailure?.(checkpointPosition,value);
      return;
    }
    const failure=playbackFailure(value);
    // A rejected watch CDN source still gets its one Web resolution. API login
    // and risk responses are handled by the resolver, never by this player.
    const watchFallback=props.source.platform==='bili'&&props.source.biliApiSource==='watch';
    const immersiveDouyin=props.source.platform==='douyin'&&props.source.immersive;
    if(immersiveDouyin&&playbackFailure(value)==='other')return;
    if(props.source.platform==='douyin'&&props.source.videoMime==='video/hevc'&&failure==='decode')douyinCodecRuntimePolicy.recordAutoHevcFailure();
    if(props.onReload)return;
    if((failure==='decode'||failure==='restricted'&&!watchFallback)&&!immersiveDouyin)return;
    if(props.source.platform==='douyin'&&douyinNetworkFailure(value)&&!immersiveDouyin)return;
    // Network loss does not invalidate a Bili URL or consume its automatic backups.
    if (props.source.platform === "bili" && douyinNetworkFailure(value)) return;
    if (!networkPrompt() && (props.source.platform !== "douyin" || props.source.immersive || props.source.detailPlayback)) {
      const source=props.source,own=generation;
      const recovery=props.onPlaybackFailure?.(checkpointPosition,value);
      if(immersiveDouyin&&recovery&&typeof recovery.then==='function')void recovery.then(()=>{if(!disposed&&own===generation&&source===props.source)failed(value,true,'recovery');},error=>{if(!disposed&&own===generation&&source===props.source)failed(error,true,'recovery');});
    }
  };
  const nativeRange = () => playerPanRange(mode(), props.width, props.height, state()?.width ?? 0, state()?.height ?? 0, rotation());
  const range = () => { const r=nativeRange(),v=rotateVector(r.axis==='x'?1:0,r.axis==='y'?1:0,-rotation());return {axis:Math.abs(v.x)>Math.abs(v.y)?'x' as const:'y' as const,range:r.range}; };
  const playerViewport=()=>({x:0,y:top(),w:props.width,h:props.height});
  let lastTransform:{generation:number;angle:number;rotation:number;mode:PlayerScaleMode;x:number;y:number;range:number;neighbours:boolean}|undefined;
  const requestTransform = async () => {
    if (videoSessionOwner !== sessionOwner) return;
    if (transformRunning) { transformDirty = true; return; }
    transformRunning = true;
    try {
      do {
        transformDirty = false;
        const ownGeneration = generation;
        try {
          const r = range();
          const value = Math.max(-r.range, Math.min(r.range, pan()));
          if (value !== pan()) setPan(value);
          const angle = displayRotation();
          const screenPan = rotateVector(r.axis === "x" ? value : 0, r.axis === "y" ? value : 0, angle);
          const targetRotation=rotation(),scaleMode=mode(),x=screenPan.x,y=screenPan.y,last=lastTransform;
          // Hidden sessions need the settled geometry before a swipe, not intermediate animation angles.
          const neighbours=!rotationStarted;
          if(last?.generation===ownGeneration&&last.angle===angle&&last.rotation===targetRotation&&last.mode===scaleMode&&last.x===x&&last.y===y&&last.range===r.range&&(!neighbours||last.neighbours))continue;
          await media.setTransform({rotationDeg:angle,scaleRotationDeg:targetRotation,scaleMode,panX:x,panY:y},neighbours);
          lastTransform={generation:ownGeneration,angle,rotation:targetRotation,mode:scaleMode,x,y,range:r.range,neighbours};
          if (ownGeneration !== generation) transformDirty = true;
          else if (!disposed && videoSessionOwner === sessionOwner) props.onPanStateChange?.(value, r.range);
        } catch (error) {
          if (disposed || videoSessionOwner !== sessionOwner) return;
          if (ownGeneration === generation) {
            if (props.active) {
              if (usingSessions()) void degradeSessions(error, 'transform');
              else failed(error, false, 'transform');
            }
            return;
          }
          // A replaced video can cancel its transform. A newer video still
          // needs the latest angle, even after its rotation tween has settled.
          transformDirty = true;
        }
      } while (transformDirty && !disposed && videoSessionOwner === sessionOwner);
    } finally {
      transformRunning = false;
    }
  };
  // Video volume is owned by STREAM_MUSIC. Old saved start limits/private
  // zero-gain values must never re-mute a system-unmuted installation.
  const enforceStartVolume = async (next: ExtendedVideoState, _limit: number | null | undefined) => next;

  // Native calls run in order, so the surface stays transparent from prepare until its first frame; only the JS poster needs telling.
  const observeState=(next:ExtendedVideoState)=>{
    if(next.state==='error'){
      if(lastPlaybackState!=='error'){failed({code:next.errorCode});recoverPlaybackFailure({code:next.errorCode,mirrorIndex:next.mirrorIndex});}
      lastPlaybackState='error';return;
    }
    const previous=state(),firstObserved=liveFrame(next)&&!liveFrame(previous);
    setState(next);
    if(next.state==='playing'&&next.hasRenderedFirstFrame)networkRetriedSource=undefined;
    if(!previous||firstObserved||next.state!==previous.state||next.isBuffering!==previous.isBuffering||next.hasCachedFirstFrame!==previous.hasCachedFirstFrame)network.refreshUsable();
    if(next.hasRenderedFirstFrame||next.hasCachedFirstFrame){setFirstFrame(true);if(firstObserved)captureFrame();}
    if(!volumeRunning&&next.volume!==observedVolume){virtualVolume=next.volume;observedVolume=next.volume;}
    if(props.onReload)reloadPolicy.observe(generation,next.positionMs,next.state==='playing');
    const progress=viewing.observe(next);
    checkpointPosition=progress.positionMs;checkpointDuration=progress.durationMs;
    if(progress.completed)emitCheckpoint('ended',progress.positionMs,progress.durationMs);
    else if(progress.reportProgress)props.onProgress?.(progress.positionMs,progress.durationMs);
    lastPlaybackState=next.state;
    if(progress.firstEnd)void advanceAfterEnd().catch(failed);
  };
  // Coalesce prepare events without publishing transient READY/volume/size
  // snapshots into the UI. Only a due network-stall indicator needs a redraw.
  const publishPreparationBuffer=()=>{const pending=preparingState;if(!disposed&&props.active&&!ready()&&videoSessionOwner===sessionOwner&&pending?.generation===generation&&frameWait.visible()&&pending.value.bufferedMs===0&&pending.value.networkStalled===true)setState(pending.value);};
  onCleanup(onVideoStateChanged(value=>{
   if(disposed||!props.active||reconnecting()||handoff()||videoSessionOwner!==sessionOwner||preparedSource!==props.source)return;
   if(usingSessions()?!value.sessionId||!sessionPool!.ownsActiveSession(value.sessionId):!!value.sessionId)return;
   if(props.onReload&&!usingSessions()&&(value.sourceGeneration??-1)<=retiredNativeGeneration)return;
   if(state()?.sourceGeneration!==undefined&&state()!.sourceGeneration!==value.sourceGeneration)return;
   if(!ready()){if(value.state!=='error'){preparingState={generation,value};publishPreparationBuffer();}return;}
   observeState(value);
  }));
  if(videoServices.onVideoProgress)onCleanup(videoServices.onVideoProgress(progress=>{
    if(disposed||!props.active||!ready()||handoff()||reconnecting()||preparedSource!==props.source||videoSessionOwner!==sessionOwner)return;
    if(usingSessions()?!progress.sessionId||!sessionPool!.ownsActiveSession(progress.sessionId):!!progress.sessionId)return;
    const previous=state();
    if(!previous||previous.sourceGeneration!==progress.sourceGeneration)return;
    observeState({...previous,...progress,metrics:progress.metrics??previous.metrics});
  }));
  const poll=async(ownGeneration:number)=>{
    const current=()=>!disposed&&ownGeneration===generation&&props.active&&videoSessionOwner===sessionOwner;
    if(!current())return;
    try{const next=await media.state();if(current())observeState(next);}
    catch(value){
      if(!current())return;
      if(usingSessions()&&!douyinNetworkFailure(value))void degradeSessions(value,'state');
      else{failed(value,false,'state');if(props.source.platform==='bili'){lastPlaybackState='error';recoverPlaybackFailure(value);}}
    }
  };
  function armResourceRetry(){
    const retry=resourceRetry;
    if(!retry||retry.timer||retry.manualOnly||disposed||!props.active||lifecycle()!=="active")return;
    if(retry.attempt>=MAX_AUTOMATIC_RESOURCE_RETRIES){retry.manualOnly=true;return;}
    const own=generation;
    const timer=delay(1000*2**retry.attempt);
    retry.timer=timer;
    void timer.result.then(()=>{
      if(retry.timer!==timer||resourceRetry!==retry)return;
      retry.timer=undefined;
      if(disposed||!props.active||lifecycle()!=="active"||own!==generation||retry.source!==props.source||videoSessionOwner!==sessionOwner)return;
      retry.attempt++;
      prepare(true,retry);
    }).catch(()=>{});
  }
  const armLiveFrameDeadline=(source:PlaybackSource,ownGeneration:number,resourceAttempt?:ResourceRetry)=>{
    const windowMs=resourceAttempt||props.onReload||!Number.isFinite(source.recoveryDeadlineMs)?20_000:source.recoveryDeadlineMs!-Date.now();
    recoveryDeadline.arm(windowMs,delay,
      ()=>!disposed&&ownGeneration===generation&&videoSessionOwner===sessionOwner&&!liveFrame(state()),
      ()=>{
        const admissionPending=preparingState?.generation===ownGeneration&&preparingState.value.decoderAdmissionDeferred===true;
        generation++;prepareOp?.cancel();pollTimer?.cancel();autoAdvance.cancel();
        void (usingSessions()?sessionPool!.releaseAll():media.stop()).catch(()=>{});
        failed({code:admissionPending||resourceAttempt?'decoder_admission_deferred':'timeout'},false,'prepare');
      },!resourceAttempt&&source.platform==='douyin'&&props.onReload?{maxMs:120_000,read:()=>Math.max(state()?.metrics?.bytesLoaded??0,preparingState?.generation===ownGeneration?preparingState.value.metrics?.bytesLoaded??0:0)}:undefined);
  };
  const prepare = (retryNetwork = false, resourceAttempt?:ResourceRetry) => {
    if(disposed||!props.active||lifecycle()!=="active"||props.source.previewOnly)return;
    if(!resourceAttempt)cancelResourceRetry();
    appLogger.d('VideoPlayer',`prepare platform=${props.source.platform??'rss'} source=${props.source.url?.startsWith('podjs-media-cache:')?'proxy':douyinSourceNeedsInternet(props.source.url??props.source.videoUrl)?'network':'local'}`);if(networkPrompt()&&!retryNetwork)return;
    if(sessionPool&&sessionCapacity==="unchecked"){
      sessionCapacity="checking";
      void sessionPool.supportsPrewarm(props.source).then(supported=>{
        if(disposed)return;sessionCapacity=supported?"available":"unavailable";
        if(!supported){appLogger.i("VideoPlayer","decoderLimit<2; using legacy single-player path");setSessionsDisabled(true);}
        if(props.active&&!networkPrompt())untrack(prepare);
      }).catch(value=>{
        if(disposed)return;sessionCapacity="unavailable";setSessionsDisabled(true);
        appLogger.w("VideoPlayer","videoSessions capabilities failed; using legacy single-player path");
        if(props.active&&!networkPrompt())untrack(prepare);
      });
      return;
    }
    if(sessionPool&&sessionCapacity==="checking")return;
    if(props.onReload&&!usingSessions())retiredNativeGeneration=Math.max(retiredNativeGeneration,state()?.sourceGeneration??-1);
    resetViewing(props.source);
    const previous=state(),sameSource=preparedSource===props.source,fromDetail=detailReload?.source===props.source;
    const source=resourceAttempt?{...props.source,resumePositionMs:resourceAttempt.positionMs}
      :props.onReload&&reloadResume!==undefined?{...props.source,resumePositionMs:reloadResume,bypassCache:fromDetail?props.source.bypassCache:true}
      :sameSource&&videoSessionOwner!==sessionOwner&&previous?{...props.source,resumePositionMs:previous.positionMs}
      :props.source;
    reloadResume=undefined;
    if(!sameSource){neighborRevision++;forwardTarget=undefined;backwardTarget=undefined;backwardWarm=undefined;forwardResolved=false;forwardWarm=undefined;}preparedSource=props.source;videoSessionOwner=sessionOwner;autoplayAllowed=props.active&&(resourceAttempt?.autoplay??(resumeAutoplay!==false))&&(source.backgroundPlayback===true||lifecycle()==="active");resumeAutoplay=undefined;if(!resourceAttempt)props.onError?.("");if(ready()&&previous)emitCheckpoint("pause_or_exit",previous.positionMs,previous.durationMs);const ownGeneration=++generation;const startupSeq=tracePreparedSource(source,pendingBenchmark);resourcePrepareGeneration=resourceAttempt?ownGeneration:undefined;preparingState=undefined;prepareStarted=Date.now();recoveryDeadline.cancel();playbackTrace?.event('exit');playbackTrace=takeVideoResolution(source.url??source.videoUrl??'',source.platform??'rss');playbackTrace.event('prepare');failedMove=undefined;prepareOp?.cancel();pollTimer?.cancel();if(!immersiveDouyin)setMode("standard");if(!douyinPlayer())setRotation(0);finishRotation('source-change');setDisplayRotation(rotation());setPan(0);panVelocity=0;crownGuard={lastEventMs:Number.NEGATIVE_INFINITY};virtualVolume=undefined;observedVolume=undefined;if(!resourceAttempt)setError("");setReady(false);setFirstFrame(false);if(!handoff())frameWait.reset();setSpinnerDue(frameWait.visible());setState(null);lastPlaybackState="";checkpointPosition=source.resumePositionMs??0;checkpointDuration=0;if(source.platform==='douyin'&&source.videoMime==='video/hevc')douyinCodecRuntimePolicy.recordAutoHevcAttempt();const prepareAutoplay=usingSessions()&&autoplayAllowed&&!networkPrompt()&&(source.resumePositionMs??0)===0;if(!resourceAttempt&&douyinSourceNeedsInternet(source.url??source.videoUrl))network.requestStarted();const op=media.prepare({...source,startupSeq,clientGeneration:ownGeneration,...(source.platform==='douyin'?{maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE}:{}),...(!usingSessions()&&douyinPlayback()?{cacheOnlyAdmissionRetry:true}:{}),...(resourceAttempt?{cacheOnlyPrepare:true,bypassCache:false}:freshPrepare&&!fromDetail?{bypassCache:true}:{}),...(pendingBenchmark?{benchmark:pendingBenchmark}:{}),loop:loopMode()==="single",bounds:{...restingBounds(),visible:props.active},autoplay:prepareAutoplay} as VideoPrepare);freshPrepare=false;prepareOp=op;void Promise.resolve().then(()=>{if(!disposed&&ownGeneration===generation&&!resourceAttempt&&!fromDetail)warmEarly();});
    if(resourceAttempt||props.onReload||Number.isFinite(source.recoveryDeadlineMs)&&!recoveredSources.has(props.source))
      armLiveFrameDeadline(source,ownGeneration,resourceAttempt);
    if(handoff())setHandoff(false);void op.result.then(async next=>{if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;let prepared:ExtendedVideoState=next;if((source.resumePositionMs??0)>0&&(!resourceAttempt||prepared.positionMs!==source.resumePositionMs)){prepared=await media.seek(source.resumePositionMs!) as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;}if(!immersiveDouyin||!startLimitConsumed()){prepared=await enforceStartVolume(prepared,source.startVolumeLimit);if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(immersiveDouyin)setStartLimitConsumed(true);}if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(autoplayAllowed&&!networkPrompt()&&!prepareAutoplay)prepared=await media.play() as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;appLogger.i('VideoPlayer',`ready durationMs=${prepared.durationMs}`);resumeAfterLifecycle=false;setReady(true);if(prepared.hasRenderedFirstFrame||prepared.hasCachedFirstFrame){setFirstFrame(true);}setState(prepared);if(prepared.state==='playing'&&prepared.hasRenderedFirstFrame)networkRetriedSource=undefined;if(!resourceAttempt&&(!fromDetail||prepared.hasRenderedFirstFrame))void warmForward().catch(()=>{});captureFrame();virtualVolume=prepared.volume;observedVolume=prepared.volume;checkpointPosition=prepared.positionMs;checkpointDuration=prepared.durationMs;emitCheckpoint("ready",prepared.positionMs,prepared.durationMs);await requestTransform();if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;void poll(ownGeneration);}).catch(value=>{if(!disposed&&props.active&&ownGeneration===generation&&videoSessionOwner===sessionOwner){if(!resourceAttempt&&usingSessions()&&!douyinNetworkFailure(value))void degradeSessions(value,'prepare');else{failed(value,false,'prepare');recoverPlaybackFailure(value);}}});
  };
  const reload=async(manual:boolean,cause:unknown={code:'source_expired'},userInitiated=manual)=>{
    if(disposed||!props.active||lifecycle()!=='active')return;
    if(props.source.previewOnly)videoSessionOwner=sessionOwner;
    if(videoSessionOwner!==sessionOwner)return;
    if(!userInitiated&&isManualDetailSource()){
      if(!error())failed(cause,true,'recovery');
      return;
    }
    const ticket=reloadPolicy.begin(manual);
    if(!ticket){if(!reloadPolicy.busy)failed(cause,true,'recovery');return;}
    needsFreshResolution=true;
    if(manual)resumeAutoplay=true;
    const position=checkpointPosition,from=props.source;
    const immersive=from.platform==='douyin'&&from.immersive===true;
    const beforeLiveFrame=!recoveredSources.has(from);
    const retryCurrent=!userInitiated&&immersive&&!from.previewOnly&&(cause as {code?:string})?.code==='timeout'&&
      !videoSourceExpired(from)&&(!beforeLiveFrame||reloadCount===0);
    // The recommendation feed need not contain the already selected item.
    const requestDetail=(douyinPlayback()&&userInitiated)||(immersive&&beforeLiveFrame&&retryableDouyinSourceFailure(cause));
    const mode:DouyinReloadMode=retryCurrent?'current':requestDetail?'detail':'feed';
    if(mode==='detail'&&userInitiated)detailReload={source:from,manual:true};
    generation++;const own=generation;prepareOp?.cancel();pollTimer?.cancel();recoveryDeadline.cancel();autoAdvance.cancel();
    neighborRevision++;dragRevision++;forwardTarget=undefined;backwardTarget=undefined;forwardWarm=undefined;backwardWarm=undefined;clearDrag();
    setReconnecting(true);setError('');setNetworkFailure(false);setReady(false);setFirstFrame(false);
    let resolutionTimeout:HostOperation<void>|undefined;
    const current=()=>!disposed&&props.active&&lifecycle()==='active'&&videoSessionOwner===sessionOwner&&reloadPolicy.current(ticket)&&generation===own;
    try{
      await (usingSessions()?sessionPool!.releaseAll():media.stop());
      if(!current())return;
      if(ticket.waitMs){reloadWait=delay(ticket.waitMs);await reloadWait.result;reloadWait=undefined;}
      if(!current())return;
      reloadPolicy.markRequest(ticket);
      reloadCount++;
      resolutionTimeout=delay(20_000);reloadTimeout=resolutionTimeout;
      await Promise.race([Promise.resolve(props.onReload?.(position,current,mode)),resolutionTimeout.result.then(()=>{throw Object.assign(new Error('Video resolution timed out'),{code:'timeout'});})]);
      resolutionTimeout.cancel();if(reloadTimeout===resolutionTimeout)reloadTimeout=undefined;
      if(!current())return;
      if(props.source===from)throw Object.assign(new Error('Video resolution did not publish a source'),{code:'prepare_failed'});
      if(networkRetriedSource===from)networkRetriedSource=props.source;
      if(mode==='detail')detailReload={source:props.source,manual:userInitiated};
      needsFreshResolution=false;reloadResume=position;freshPrepare=mode!=='detail';preparedSource=props.source;
      // End the policy before preparing: another native failure consumes the
      // next budget slot even when resolution published a new source object.
      reloadPolicy.finish(ticket);setReconnecting(false);prepare(true);
    }catch(value){if(current()){reloadPolicy.finish(ticket);setReconnecting(false);const fault=playerFailureCode(value);const retryTimeout=!manual&&props.source.platform==='douyin'&&props.source.immersive&&fault==='timeout';failed(fault==='cancelled'||fault==='stale'?{code:'prepare_failed'}:value,!retryTimeout,'recovery');}}
    finally{resolutionTimeout?.cancel();if(reloadTimeout===resolutionTimeout)reloadTimeout=undefined;if(reloadPolicy.current(ticket)){reloadPolicy.finish(ticket);setReconnecting(false);}}
  };
  let retrying = false, failedMove:(()=>void|Promise<void>)|undefined;
  const retry = async (automaticNetworkRetry=false) => {
    // Native prepare settles after retry() returns. Keep its one-shot budget
    // until a frame plays, or the user explicitly retries a new operation.
    if (retrying||disposed||!props.active) return;
    if(resourceRetry?.source===props.source){
      if(resourceRetry.timer||resourceRetry.manualOnly){
        stopResourceTimer();resourceRetry.manualOnly=false;resourceRetry.attempt=0;
        prepare(true,resourceRetry);
      }
      return;
    }
    networkRetriedSource=automaticNetworkRetry?props.source:undefined;
    if(failedMove&&(!props.onReload||!douyinPlayback())){
      retrying=true;const move=failedMove,from=props.source;setError("");
      try{await move();failedMove=undefined;if(!disposed&&props.source===from)prepare(true);}
      catch(value){if(!disposed)failed(value);}finally{retrying=false;}
      return;
    }
    if(props.onReload){await reload(true,undefined,!automaticNetworkRetry);return;}
    // Native onRetry recreates this source; do not resolve/discard a queue item on network retry.
    const retryNetwork = !!networkPrompt();
    setNetworkFailure(false);
    if (!props.source.previewOnly&&(retryNetwork || !props.onRetry || props.source.platform === "douyin" && !props.source.immersive && !props.source.detailPlayback)) { prepare(true); return; }
    appLogger.w('VideoPlayer','Retry playback');
    retrying = true;
    const source=props.source,own=generation;setError("");
    try { await props.onRetry?.(checkpointPosition);if(!disposed&&props.active&&source===props.source&&own===generation)prepare(true); } catch (value) { if (!disposed) failed(value); } finally { retrying = false; }
  };
  // Android emits inactive and background for the same suspension.
  let resumeAfterLifecycle=false,lifecycleSuspended=false;
  const removeLifecycle=onLifecycleChange(next=>{
    setWorkForeground(next==='active');
    if(next==="active"){
      lifecycleSuspended=false;
      if(!props.active)return;
      if(props.onReload&&videoSessionOwner!==sessionOwner){videoSessionOwner=sessionOwner;resumeAfterLifecycle=true;}
      if(videoSessionOwner!==sessionOwner)return;
      if(resourceRetry?.source===props.source){armResourceRetry();return;}
      if(props.onReload){
        generation++;pollTimer?.cancel();
        const desiredResume=resumeAfterLifecycle||['playing','buffering'].includes(state()?.state??'');
        if(!ready()){
          resumeAutoplay=desiredResume;
          if(needsFreshResolution||videoSourceExpired(props.source)){void reload(false,{code:'source_expired'});return;}
          if(!error()){reloadResume=checkpointPosition;freshPrepare=true;prepare(true);return;}
        }
        const own=generation;
        void media.state().then(value=>{
          if(disposed||own!==generation||!props.active||videoSessionOwner!==sessionOwner)return;
          if(['playing','paused','ready','buffering'].includes(value.state)&&Number.isFinite(value.positionMs)&&value.durationMs>0){checkpointPosition=value.positionMs;checkpointDuration=value.durationMs;}
          if(['error','stopped','idle'].includes(value.state)||videoSourceExpired(props.source)){resumeAutoplay=desiredResume;void reload(false,{code:value.errorCode??'source_expired'});return;}
          reloadResume=checkpointPosition;
          if(!ready()){freshPrepare=true;prepare(true);return;}
          setState(value);
          if(resumeAfterLifecycle){autoplayAllowed=true;void media.play().then(next=>{if(!disposed&&own===generation){resumeAfterLifecycle=false;setState(next);void poll(own);}}).catch(value=>failed(value,false,'play'));}
          else void poll(own);
        }).catch(value=>{if(!disposed&&own===generation)void reload(false,value);});
        return;
      }
      if(ready()){const own=generation;void media.state().then(value=>{if(!disposed&&own===generation&&props.active&&videoSessionOwner===sessionOwner)setState(value);}).catch(()=>{});}
      if(usingSessions()&&!ready())untrack(prepare);
      else if(resumeAfterLifecycle&&ready()){
        resumeAfterLifecycle=false;autoplayAllowed=true;const own=generation;
        void media.play().then(value=>{if(disposed||own!==generation||videoSessionOwner!==sessionOwner)return;setState(value);void poll(own);}).catch(value=>{if(!disposed&&own===generation&&lifecycle()==='active')failed(value,false,'play');});
      }
      return;
    }
    if(lifecycleSuspended)return;lifecycleSuspended=true;
    stopResourceTimer();
    if(props.source.backgroundPlayback||videoSessionOwner!==sessionOwner){if(usingSessions()&&videoSessionOwner===sessionOwner)sessionPool!.retainNeighbours([]);return;}
    if(props.onReload){cancelReload();reloadResume=checkpointPosition;}
    captureFrame(true);resumeAfterLifecycle=resumeAutoplay??(resumeAfterLifecycle||autoplayAllowed&&(!ready()||['playing','buffering','preparing'].includes(state()?.state??'')));autoplayAllowed=false;autoAdvance.cancel();
    // A lifecycle release invalidates control replies just like route exit.
    generation++;prepareOp?.cancel();pollTimer?.cancel();recoveryDeadline.cancel();
    if(usingSessions()){
      const value=state();if(value){checkpointPosition=value.positionMs;checkpointDuration=value.durationMs;emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);}
      preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});
    }else if(ready()){const pausedGeneration=generation;void media.pause().then(value=>{if(disposed||pausedGeneration!==generation)return;setState(value);checkpointPosition=value.positionMs;checkpointDuration=value.durationMs;emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);}).catch(failed);}
  });
  createEffect(() => { const source=props.source;
    if(props.active&&source.previewOnly&&source!==preparedSource&&!reconnecting()){
      preparedSource=source;generation++;prepareOp?.cancel();pollTimer?.cancel();setReady(false);setFirstFrame(false);setState(null);
      checkpointPosition=source.resumePositionMs??0;checkpointDuration=0;
      if(props.onReload&&source.platform==='douyin'&&source.immersive&&source.preparationError&&retryableDouyinSourceFailure(source.preparationError)){
        if(lifecycle()==='active')untrack(()=>void reload(false,source.preparationError));
        else needsFreshResolution=true;
        return;
      }
      setError(source.preparationError?formatPlayerFailure(playerFailureCode(source.preparationError)):"");
      if(source.preparationError){benchmark.begin('error_page',{reason:'exhausted',...playerFailureFields(source.preparationError,'source')});source.releaseStartupPreview?.();}
    }
    if(props.active&&!reconnecting()&&!networkPrompt()&&source!==preparedSource)untrack(prepare);
  });
  let updating = false, dirty = false;
  const stripOwnsBounds=()=>usingSessions()&&nativeDrag()&&props.active&&props.offset===0&&!handoff();
  const syncBounds = async () => { if(stripOwnsBounds())return; if (updating) { dirty = true; return; } updating = true; const requestGeneration=generation; try { do { dirty = false; if(stripOwnsBounds())break; await media.setBounds(bounds()); } while (dirty && !disposed); } catch (value) { if(!disposed&&props.active&&requestGeneration===generation&&videoSessionOwner===sessionOwner){if(usingSessions())void degradeSessions(value,'bounds');else failed(value,false,'bounds');} } finally { updating = false; } };
  createEffect(() => { props.offset; props.active; dragOffset(); handoff(); if (props.offset !== 0 || !props.active) panVelocity = 0; if (ready()&&videoSessionOwner===sessionOwner&&!stripOwnsBounds()) void syncBounds(); });
  const toggle = async () => { try { const pausing = state()?.state === "playing",own=generation;if(props.onReload){autoplayAllowed=!pausing;resumeAfterLifecycle=false;}const next = await (pausing ? media.pause() : media.play());if(disposed||own!==generation||videoSessionOwner!==sessionOwner)return;setState(next); checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; if (pausing) emitCheckpoint("pause_or_exit", next.positionMs, next.durationMs); } catch (value) { failed(value); } };
  let seekSource: PlaybackSource | undefined, seekGeneration = -1;
  const seekTo = async (delta: number) => {
    const current = state();
    if (!props.active || !current || videoSessionOwner !== sessionOwner) return;
    if (!seekRunning || seekSource !== props.source || seekGeneration !== generation) {
      desiredSeek = current.positionMs; seekSource = props.source; seekGeneration = generation;
    }
    desiredSeek = Math.max(0, Math.min(current.durationMs || Number.MAX_SAFE_INTEGER, desiredSeek + delta));
    if (seekRunning) return;
    seekRunning = true;
    let requestSource: PlaybackSource | undefined, requestGeneration = -1;
    try {
      do {
        const source: PlaybackSource | undefined = seekSource;
        const ownGeneration = seekGeneration, target = desiredSeek;
        if (disposed || !props.active || source !== props.source || ownGeneration !== generation || videoSessionOwner !== sessionOwner) return;
        requestSource = source; requestGeneration = ownGeneration;
        const next = await media.seek(target);
        if (disposed || !props.active || videoSessionOwner !== sessionOwner) return;
        if (source !== props.source || ownGeneration !== generation) {
          if (source !== seekSource || ownGeneration !== seekGeneration) continue;
          return;
        }
        setState(previous => previous ? { ...previous, positionMs: next.positionMs, durationMs: next.durationMs } : previous);
        checkpointPosition = next.positionMs; checkpointDuration = next.durationMs;
        if (target === desiredSeek) break;
      } while (!disposed);
    } catch (value) { if (!disposed && props.active && requestSource === props.source && requestGeneration === generation) failed(value); }
    finally { seekRunning = false; }
  };
  const rotateBy = (step: 90 | -90) => {
    if (douyinPlayer() && (dragDirection || dragSettling)) return;
    rotationFrom = rotationStarted ? rotationFrameAngle : displayRotation();
    rotationTo = (rotationStarted ? rotationTo : rotation()) + step;
    rotationFrameAngle = rotationFrom;
    const target = normalizeRotation(rotationTo);
    animationDiagnostics.begin('rotation', mode(), target);
    setRotation(target);
    rotationStarted = Date.now();
    setMotion(true);
    void requestTransform();
  };
  const changeMode = () => { animationDiagnostics.begin('scale',nextScaleMode(mode()),rotation()); panVelocity = 0; setMode(nextScaleMode(mode())); setPan(0);setMotion(true); void requestTransform(); };
  const backgroundTap = () => { if (tapTimer) { tapTimer.cancel(); tapTimer = undefined; void toggle(); return; } tapTimer = delay(280); void tapTimer.result.then(() => { tapTimer = undefined; setControlsVisible(value => !value); }).catch(() => {}); };
  let backwardTarget:DouyinPreparedSource|undefined,backwardWarm:Promise<DouyinPreparedSource|undefined>|undefined;
  let degradingSessions=false,neighborRevision=0,forwardResolved=false,forwardWarm:Promise<DouyinPreparedSource|undefined>|undefined,forwardTarget:DouyinPreparedSource|undefined;
  const cancelledSessionError=(value:unknown)=>/cancel|stale|abort/i.test(String((value as {code?:unknown}|null)?.code??'')+' '+String(value));
  const fallbackSessions=async()=>{
    if(disposed||!props.active||videoSessionOwner!==sessionOwner||!usingSessions()||degradingSessions)return;
    degradingSessions=true;appLogger.w("VideoPlayer","videoSessions failed; falling back to legacy video");
    generation++;prepareOp?.cancel();pollTimer?.cancel();neighborRevision++;
    try{await sessionPool!.releaseAll();}catch(releaseError){appLogger.w("VideoPlayer","videoSessions cleanup failed");}
    if(disposed){degradingSessions=false;return;}
    batch(()=>{sessionCapacity="unavailable";setSessionsDisabled(true);preparedSource=undefined;forwardTarget=undefined;setReady(false);setState(null);degradingSessions=false;});
    if(props.active&&!networkPrompt()&&preparedSource!==props.source)untrack(prepare);
  };
  const degradeSessions=async(value:unknown,stage:FailureStage='unknown')=>{
    if(disposed||!props.active||videoSessionOwner!==sessionOwner)return;
    if(isResourceFailure(value)||retryCacheMiss(value)||resourceRetry?.source===props.source||isManualDetailSource()){failed(value,false,stage);return;}
    if(!shouldFallbackFromVideoSessions(value)){if(!cancelledSessionError(value)){failed(value,false,stage);recoverPlaybackFailure(value);}return;}
    await fallbackSessions();
  };
  const adjacentResolutions=new Map<string,{revision:number;key:string|undefined;pending:Promise<DouyinPreparedSource|undefined>}>();
  const showDragPreview=(target:DouyinPreparedSource|undefined,direction:DouyinPagerDirection,poster?:string)=>{
    const source=target?.source;
    const filePath=framePreviewPath(source?.previewFrame,target?.key);
    const url=props.source.immersive?'':source?.posterUrl??poster??'';
    setDragPoster(filePath||url?{filePath,url,direction}:null);
  };
  const previewAdjacent=(direction:"next"|"previous",revision:number,revealPoster=false,distance:1|2|3|4|5=1):Promise<DouyinPreparedSource|undefined>=>{
    if(!props.onPrepareAdjacent)return Promise.resolve(undefined);
    const id=direction+distance,key=props.onAdjacentKey?.(direction,distance),known=adjacentResolutions.get(id);
    const resolve=known&&known.revision===revision&&known.key===key?known.pending:props.onPrepareAdjacent(direction,distance).then(target=>{
      if(!target||revision!==neighborRevision||disposed||(props.onAdjacentKey&&props.onAdjacentKey(direction,distance)!==target.key))return;
      return target;
    });
    adjacentResolutions.set(id,{revision,key,pending:resolve});
    const forget=()=>{if(adjacentResolutions.get(id)?.pending===resolve)adjacentResolutions.delete(id);};
    return resolve.then(target=>{
      if(!target)forget();
      const pagerDirection=direction==="next"?"up":"down";
      if(target&&revealPoster&&!nativeDrag()&&dragDirection===pagerDirection)showDragPreview(target,pagerDirection);
      return target;
    },error=>{forget();throw error;});
  };
  const warmEarly=()=>{
    if(usingSessions())void warmForward().catch(()=>{});
  };
  const prepareAdjacent=async(direction:"next"|"previous",revision:number,revealPoster=false,distance:1|2=1,retainKeyframe=false):Promise<DouyinPreparedSource|undefined>=>{
    if(!usingSessions()||!props.onPrepareAdjacent)return;
    const target=await previewAdjacent(direction,revision,revealPoster,distance);
    if(!target||revision!==neighborRevision||disposed||!usingSessions())return;
    if(retainKeyframe&&(!props.active||lifecycle()!=="active"||!sessionPool!.canPrewarmPreviousFrame))return;
    try{
      if(target.queueIndex!==undefined&&target.anchorIndex!==undefined)sessionPool!.traceNeighbour(target.key,target.queueIndex,target.anchorIndex);
      await sessionPool!.prewarm(target,{...target.source,respectSilentMode:true,compactProgress:true,bounds:bounds(),loop:loopMode()==="single",autoplay:false,muted:true,retainKeyframe},direction==="next"?"next":"prev");
      return revision===neighborRevision&&usingSessions()&&sessionPool!.hasStandby(target.key)?target:undefined;
    }catch(value){if(retainKeyframe)return;if(revision===neighborRevision&&resolutionRejected(value)){props.onRejectAdjacent?.(target,(value as {mirrorIndex?:number})?.mirrorIndex);return;}if(revision===neighborRevision&&!cancelledSessionError(value)&&shouldFallbackFromVideoSessions(value)){if(await sessionPool!.supportsPrewarm())return;await fallbackSessions();return revision===neighborRevision&&!disposed?target:undefined;}return;}
  };
  const warmBackward=()=>{
    if(!usingSessions()||!sessionPool!.canPrewarmPreviousFrame||!props.onPrevious||!props.onPrepareAdjacent||
       !props.active||lifecycle()!=="active"||backwardWarm||disposed)return;
    const key=props.onAdjacentKey?.("previous",1);
    if((props.onAdjacentKey&&!key) || sessionPool!.hasStandby(key??backwardTarget?.key??""))return;
    const revision=neighborRevision;
    const pending=prepareAdjacent("previous",revision,false,1,true).then(target=>{
      if(revision!==neighborRevision||backwardWarm!==pending)return;
      if(target)backwardTarget=target;
      return target;
    }).finally(()=>{if(backwardWarm===pending)backwardWarm=undefined;});
    backwardWarm=pending;
    void pending.catch(()=>{});
  };
  const warmForward=():Promise<DouyinPreparedSource|undefined>=>{
    if(usingSessions()&&props.onAdjacentKey){
      const keys=[props.onAdjacentKey("next",1),sessionPool!.canPrewarmPreviousFrame?props.onAdjacentKey("previous",1):undefined];
      sessionPool!.retainNeighbours(keys.filter((key):key is string=>!!key));
    }
    warmBackward();
    if(!props.onPrepareAdjacent)return Promise.resolve(undefined);
    if(forwardTarget&&(!usingSessions()||sessionPool!.hasStandby(forwardTarget.key)))return Promise.resolve(forwardTarget);
    if(!usingSessions()&&forwardResolved&&!forwardTarget)return Promise.resolve(undefined);
    if(forwardWarm)return forwardWarm;
    const revision=neighborRevision;
    const pending=(usingSessions()?prepareAdjacent("next",revision):previewAdjacent("next",revision)).then(target=>{if(revision!==neighborRevision)return;forwardResolved=true;if(target)forwardTarget=target;return target;}).finally(()=>{if(forwardWarm===pending)forwardWarm=undefined;});
    forwardWarm=pending;return pending;
  };
  let dragRevision=0,dragDirection:DouyinPagerDirection|undefined,dragTarget:DouyinPreparedSource|undefined,dragTargetPromise:Promise<DouyinPreparedSource|undefined>|undefined,dragSettling=false;
  onCleanup(onMemoryTrim(35,level=>{
    if(!usingSessions()||!props.active||lifecycle()!=="active"||videoSessionOwner!==sessionOwner||dragDirection||dragSettling)return;
    if(level>=2){
      const previous=props.onAdjacentKey?.("previous",1)??backwardTarget?.key;
      if(previous)sessionPool!.invalidateStandby(previous);
      backwardTarget=undefined;
      backwardWarm=undefined;
    }else if(ready())warmBackward();
  }));
  type DeferredDrag={distanceY:number;velocityY:number;cancel:boolean;seq:number;action?:VideoBenchmarkAction};
  let deferredPan:DeferredDrag|undefined,drainingDeferred=false,replayingDeferred=false;
  const deferredDrags:DeferredDrag[]=[];
  let pagerPointerRotation: number | undefined;
  const clearDrag=()=>{pagerPointerRotation=undefined;animationDiagnostics.end('swipe');setNativeDrag(false);dragDirection=undefined;setDragAxis(undefined);dragTarget=undefined;dragTargetPromise=undefined;dragSettling=false;setDragPoster(null);setDragProgress(0);};
  const transitionPages = (progress: number, direction: DouyinPagerDirection, action?: VideoBenchmarkAction) =>
    sessionPool!.transition(progress,direction,restingBounds(),action,pagerRotation());
  const ensureDragTarget=(direction:DouyinPagerDirection,revision:number)=>{
    const queueDirection:"next"|"previous"=direction==="up"?"next":"previous";
    const candidate=direction==="up"?forwardTarget:backwardTarget;
    const showColdPreview=()=>showDragPreview(candidate,direction,props.onAdjacentPoster?.(queueDirection));
    if(!usingSessions()){
      showColdPreview();
      if(direction==='up'&&forwardTarget){dragTarget=forwardTarget;return Promise.resolve(forwardTarget);}
      return Promise.resolve(undefined);
    }
    const existing=sessionPool?.sourceFor(props.onAdjacentKey?.(queueDirection))??sessionPool?.preparingSourceFor(props.onAdjacentKey?.(queueDirection))??(candidate&&sessionPool?.hasStandby(candidate.key)?candidate:undefined);
    if(existing&&sessionPool!.selectStandby(existing.key,true)){dragTarget=existing;setNativeDrag(true);setDragPoster(null);return Promise.resolve(existing);}
    showColdPreview();
    const ownNeighbor=neighborRevision;
    const pending=(direction==="up"?forwardWarm:backwardWarm)??prepareAdjacent(queueDirection,ownNeighbor,true);
    return pending.then(target=>{
      if(revision!==dragRevision||direction!==dragDirection||ownNeighbor!==neighborRevision)return;
      dragTarget=target;if(target&&usingSessions()){sessionPool!.selectStandby(target.key);setNativeDrag(true);setDragPoster(null);void transitionPages(dragProgress(),direction).catch(value=>{if(!cancelledSessionError(value))void degradeSessions(value);});}return target;
    });
  };
  const beginDouyinDrag=(distanceY=0,measured=false)=>{
    if(props.source.platform!=="douyin")return;
    if(!props.onSelectTarget&&!replayingDeferred&&(dragSettling||deferredDrags.length||drainingDeferred)){
      deferredPan={distanceY,velocityY:0,cancel:false,seq:measured?benchmark.begin("gesture_down",{direction:distanceY<0?"next":"prev"}):0};return;
    }
    // The recognizer retains the displayed angle sampled at touch-down. If it
    // differs from the destination, use its already-mapped progress for this drag.
    const pointerTracksPager = (pagerPointerRotation ?? displayRotation()) === pagerRotation();
    if(rotationStarted){
      finishRotation('swipe');
      void requestTransform();
    }
    if(measured && pointerTracksPager)sessionPool?.beginDrag();else sessionPool?.endDrag();
    if(props.onSelectTarget)clearDrag();
    benchmarkSeq=measured?benchmark.begin("gesture_down",{direction:distanceY<0?"next":"prev"}):0;
    animationDiagnostics.begin('swipe',mode(),rotation());
    dragRevision++;setNativeDrag(false);dragDirection=undefined;dragTarget=undefined;dragTargetPromise=undefined;setDragProgress(0);setDragPoster(null);
    // Pan-start already carries the slop-crossing displacement. Predict, select
    // and place the neighbour now, even if the finger then holds still.
    if(distanceY!==0)moveDouyinDrag(distanceY);
  };
  const moveDouyinDrag=(distanceY:number)=>{
    if(deferredPan&&!replayingDeferred){deferredPan.distanceY=distanceY;return;}
    if(props.source.platform!=="douyin"||dragSettling||distanceY===0)return;
    const direction:DouyinPagerDirection=distanceY<0?"up":"down",progress=douyinPagerProgress(distanceY,pagerLength()),revision=dragRevision;
    setDragProgress(progress);
    if(direction!==dragDirection){setNativeDrag(false);dragDirection=direction;setDragAxis(direction);dragTarget=undefined;dragTargetPromise=ensureDragTarget(direction,revision);}
    if(usingSessions()&&dragTarget&&sessionPool!.selectStandby(dragTarget.key,true)){setNativeDrag(true);setDragPoster(null);
      void transitionPages(progress,direction).catch(value=>{if(revision===dragRevision&&!cancelledSessionError(value))void degradeSessions(value);});
    }
  };
  const animateDouyinTransition=async(revision:number,direction:DouyinPagerDirection,to:0|1)=>{
    const from=dragProgress(),started=Date.now(),duration=douyinPagerSettleDuration(to);
    if(from===to){if(usingSessions()&&nativeDrag()&&to===0)await transitionPages(to,direction,pendingBenchmark);return revision===dragRevision&&!disposed;}
    while(true){
      const elapsed=Date.now()-started,next=douyinPagerSettleProgress(from,to,elapsed);setDragProgress(next);
      const step=usingSessions()&&nativeDrag()&&!(to===1&&elapsed>=duration)
        ?transitionPages(next,direction,to===0&&elapsed>=duration?pendingBenchmark:undefined):undefined;
      if(elapsed>=duration){await step;return revision===dragRevision&&!disposed;}
      const tick=delay(16);
      try{await Promise.all([step,tick.result]);}finally{tick.cancel();}
      if(revision!==dragRevision||disposed)return false;
    }
    return true;
  };
  const finishDouyinDrag=async(velocityY:number,forceCancel=false,replayed?:DeferredDrag,cancelReason:"cancelled"|"network_prompt"="cancelled")=>{
    if(deferredPan&&!replayed){
      const queued=deferredPan;deferredPan=undefined;queued.velocityY=velocityY;queued.cancel=forceCancel;
      const direction=queued.distanceY<0?'up':'down',progress=douyinPagerProgress(queued.distanceY,pagerLength());
      const boundary=props.canSelectTarget?.(direction==='up'?'next':'previous')===false;
      const settles=!forceCancel&&!boundary&&!!(direction==='up'?props.onNext:props.onPrevious)&&shouldSettleDouyinPager(progress,velocityY,direction);
      const delta=settles?douyinPagerDelta(progress,velocityY,direction):0;
      if(queued.seq){queued.action={seq:queued.seq,generation:settles?++benchmarkGeneration:benchmarkGeneration,source_generation:state()?.sourceGeneration??0,delta:delta===2?2:1};benchmark.mark('gesture_release',queued.seq,{direction:settles?(delta===2?'fling':direction==='up'?'next':'prev'):'cancel',delta,reason:forceCancel?cancelReason:boundary?'boundary':settles?'release':'threshold',prewarmed:false,generation:queued.action.generation,source_generation:queued.action.source_generation});}
      // Bound retained intent. Never let a slow publication allocate indefinitely.
      if(deferredDrags.length<16)deferredDrags.push(queued);
      else if(queued.seq)benchmark.mark('error',queued.seq,{reason:'capacity'});
      void drainDeferred();return;
    }
    if(disposed||!props.active||videoSessionOwner!==sessionOwner||props.source.platform!=="douyin"||dragSettling)return;
    const revision=dragRevision,direction=dragDirection,progress=dragProgress();if(!direction){clearDrag();return;}
    sessionPool?.endDrag();
    dragSettling=true;const move=direction==="up"?props.onNext:props.onPrevious;
    const boundary=props.canSelectTarget?.(direction==='up'?'next':'previous')===false;
    const committed=!forceCancel&&!!move&&shouldSettleDouyinPager(progress,velocityY,direction);
    if(committed&&boundary)props.onBoundaryRelease?.(direction==='up'?'next':'previous');
    const wantsSettle=committed&&!boundary;
    if(usingSessions()&&wantsSettle){const key=props.onAdjacentKey?.(direction==='up'?'next':'previous');const late=sessionPool!.sourceFor(key);if(late)dragTarget=late;}
    const releaseReason=forceCancel?cancelReason:boundary?'boundary':wantsSettle?'release':'threshold';
    // Stop outgoing playback at release, including a cold two-item fling.
    // Keep its decoded surface for the strip; cancellation never enters here.
    let delta:1|2=1;
    const requestedDelta=wantsSettle?douyinPagerDelta(progress,velocityY,direction):0;
    if(replayed){pendingBenchmarkSource=props.source;pendingBenchmark=replayed.action;}
    else if(benchmarkSeq){pendingBenchmarkSource=props.source;pendingBenchmark={seq:benchmarkSeq,generation:wantsSettle?++benchmarkGeneration:benchmarkGeneration,source_generation:state()?.sourceGeneration??0,delta};benchmark.mark("gesture_release",benchmarkSeq,{direction:wantsSettle?(requestedDelta===2?'fling':direction==='up'?'next':'prev'):'cancel',delta:requestedDelta,reason:releaseReason,prewarmed:requestedDelta===1&&!!(usingSessions()&&dragTarget&&sessionPool!.hasStandby(dragTarget.key)),generation:pendingBenchmark.generation,source_generation:pendingBenchmark.source_generation});}

    if(wantsSettle){const stoppedGeneration=generation;void media.pause(pendingBenchmark,true).catch(value=>{if(!disposed&&revision===dragRevision&&stoppedGeneration===generation&&videoSessionOwner===sessionOwner)failed(value);});}

    if(wantsSettle&&props.onSelectTarget){
      // Input commits selection before any native/URL/persistence await. There
      // is no retained queue: every new gesture replaces the pending target.
      const selectedDelta=requestedDelta===2?2:1;
      if(pendingBenchmark)pendingBenchmark.delta=selectedDelta;
      const from=props.source;
      const selectedKey=props.onAdjacentKey?.(direction==='up'?'next':'previous',selectedDelta);
      const authorized=selectedDelta===1?(sessionPool?.preparingSourceFor(selectedKey)??(direction==='up'?forwardTarget:backwardTarget)):undefined;
      const decoded=selectedDelta===1&&usingSessions()?sessionPool!.sourceFor(selectedKey)??(dragTarget&&sessionPool!.hasStandby(dragTarget.key)?dragTarget:undefined):undefined;
      const ownGeneration=++generation;neighborRevision++;dragRevision++;
      if(pendingBenchmark)benchmark.mark('startup_stage',pendingBenchmark.seq,{startup_stage:'candidate_start',generation:ownGeneration});
      prepareOp?.cancel();pollTimer?.cancel();recoveryDeadline.cancel();
      forwardTarget=undefined;backwardTarget=undefined;forwardWarm=undefined;backwardWarm=undefined;forwardResolved=false;
      batch(()=>{
        // Publication must retain this exact source to use its decoded surface.
        // The route rejects changed authorization and stale neighbour identity.
        if(decoded)preparedSource=decoded.source;
        props.onSelectTarget!(direction==='up'?'next':'previous',selectedDelta,decoded??(authorized?.key===selectedKey?authorized:undefined));
        if(decoded&&props.source===decoded.source){
          const action=pendingBenchmark;pendingBenchmark=undefined;
          const startupSeq=tracePreparedSource(decoded.source,action);
          autoplayAllowed=props.active&&lifecycle()==='active';
          const op=sessionPool!.prepare(decoded,{...decoded.source,startupSeq,clientGeneration:ownGeneration,respectSilentMode:true,compactProgress:true,loop:loopMode()==='single',bounds:{...restingBounds(),visible:props.active},transform:prepareTransform(),autoplay:autoplayAllowed,...(action?{benchmark:action}:{})} as VideoPrepare);
          prepareOp=op;setState(null);setHandoff(false);setFirstFrame(true);setReady(true);setError('');setSpinnerDue(false);clearDrag();
          armLiveFrameDeadline(decoded.source,ownGeneration);
          // The cover stays absent. Native independently requires the decoded,
          // latched target and a real commit; this acknowledgement is not proof.
          if(action)benchmark.confirmVideoFrame(action.seq,action.generation);
          // Give the incoming pixels their first commit, then prepare neighbours
          // while native admits the foreground player. Waiting for that player
          // and a second commit leaves too little lead at a one-second cadence.
          let neighbourPaint:HostOperation<unknown>;
          try{neighbourPaint=afterPaint();}catch{neighbourPaint=delay(100);}
          void neighbourPaint.result.then(()=>{
            if(!disposed&&ownGeneration===generation&&videoSessionOwner===sessionOwner)void warmForward().catch(()=>{});
          }).catch(()=>{});
          void op.result.then(next=>{
            if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;
            resetViewing(decoded.source);lastPlaybackState="";
            playbackTrace?.event('exit');playbackTrace=takeVideoResolution(decoded.source.url??decoded.source.videoUrl??'',decoded.source.platform??'rss');playbackTrace.event('prepare');
            // A native frame event can beat the cached promotion reply.
            const observed=state();
            const frame=observed?.sourceGeneration===next.sourceGeneration&&observed?.hasRenderedFirstFrame?observed:next;
            setState(frame);setFirstFrame(frame.hasRenderedFirstFrame===true||frame.hasCachedFirstFrame===true);setReady(true);
            let painted:HostOperation<unknown>;
            try{painted=afterPaint();}catch{painted=delay(100);}
            void painted.result.then(()=>{
              if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;
              virtualVolume=next.volume;observedVolume=next.volume;checkpointPosition=next.positionMs;checkpointDuration=next.durationMs;
              void warmForward().catch(()=>{});emitCheckpoint('ready',next.positionMs,next.durationMs);captureFrame();void requestTransform();void poll(ownGeneration);
            }).catch(()=>{});
          }).catch(value=>{if(!disposed&&ownGeneration===generation&&!cancelledSessionError(value))void degradeSessions(value,'promote');});
        }else{
          if(decoded)preparedSource=from;
          void media.retire(true).catch(()=>{});
          setHandoff(true);setFirstFrame(false);setReady(false);setState(null);setError('');frameWait.reset();setSpinnerDue(false);clearDrag();
          sessionPool?.retainNeighbours([sessionSource(props.source).key]);setHandoff(false);
        }
      });
      // Read reactive props after the batch publishes the new selection.
      sessionPool?.traceSelection(props.source===from?undefined:sessionSource(props.source).key,pendingBenchmark);
      if(props.source===from)setHandoff(false);
      return;
    }

    if(wantsSettle&&douyinPagerDelta(progress,velocityY,direction)===2&&props.onPrepareAdjacent){
      // Resolve the two-item target without publishing the intermediate item.
      // Keep the old foreground until the target is ready or the bounded wait ends.
      const deadline=delay(2500);
      try{
        const candidate=await Promise.race([props.onPrepareAdjacent(direction==='up'?'next':'previous',2),deadline.result.then(()=>undefined)]);
        if(revision!==dragRevision||disposed)return;
        if(candidate){
          delta=2;if(pendingBenchmark)pendingBenchmark.delta=2;dragTarget=candidate;setNativeDrag(false);neighborRevision++;forwardTarget=undefined;backwardTarget=undefined;forwardWarm=undefined;backwardWarm=undefined;forwardResolved=false;
          if(usingSessions()){
            sessionPool!.retainNeighbours([]);
            await Promise.race([sessionPool!.prewarm(candidate,{...candidate.source,respectSilentMode:true,compactProgress:true,bounds:bounds(),autoplay:false,muted:true},direction==='up'?'next':'prev'),deadline.result]);
          }
          if(revision!==dragRevision||disposed)return;
          dragTarget=candidate;
          if(usingSessions()&&sessionPool!.hasStandby(candidate.key)){sessionPool!.selectStandby(candidate.key);setNativeDrag(true);}
        }
      }catch{ /* Cold publication still targets the selected two-item source. */ }
      finally{deadline.cancel();}
    }
    if(revision!==dragRevision||disposed)return;
    const followingKeys:string[]=[];
    const followingKey=props.onAdjacentKey?.(direction==='up'?'next':'previous',2);
    if(followingKey)followingKeys.push(followingKey);
    try{
      if(!await animateDouyinTransition(revision,direction,wantsSettle?1:0))return;
      if(!wantsSettle){if(pendingBenchmark)await media.setBounds({...bounds(),benchmark:pendingBenchmark});pendingBenchmark=undefined;clearDrag();neighborRevision++;if(usingSessions())void warmForward().catch(()=>{});return;}
      const target=dragTarget;
      if(usingSessions()&&target&&sessionPool!.hasStandby(target.key)){
        const ownGeneration=++generation;pollTimer?.cancel();
        sessionPool!.selectStandby(target.key);
        const promoted=await sessionPool!.promote(direction,restingBounds(),props.active&&lifecycle()==="active",pendingBenchmark,followingKeys,prepareTransform());
        if(disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;
        // Install ownership BEFORE publishing the reactive source. Publication
        // must not schedule another prepare/release of the surface on screen.
        let publication:Promise<boolean>|undefined;
        batch(()=>{preparedSource=promoted.source.source;publication=props.onPromoteAdjacent?.(promoted.source);setState(promoted.state);setReady(true);setFirstFrame(promoted.state.hasRenderedFirstFrame===true||promoted.state.hasCachedFirstFrame===true);setError("");setSpinnerDue(false);clearDrag();});
        forwardTarget=undefined;backwardTarget=undefined;forwardWarm=undefined;backwardWarm=undefined;forwardResolved=false;
        playbackTrace?.event('exit');playbackTrace=takeVideoResolution(promoted.source.source.url??promoted.source.source.videoUrl??'',promoted.source.source.platform??'rss');playbackTrace.event('prepare');resetViewing(promoted.source.source);lastPlaybackState="";preparedSource=promoted.source.source;setState(promoted.state);setReady(true);setError("");checkpointPosition=promoted.state.positionMs;checkpointDuration=promoted.state.durationMs;virtualVolume=promoted.state.volume;observedVolume=promoted.state.volume;
        emitCheckpoint("ready",promoted.state.positionMs,promoted.state.durationMs);clearDrag();neighborRevision++;if(delta===2)sessionPool!.retainNeighbours([]);void requestTransform();void warmForward().catch(()=>{});void poll(ownGeneration);
        if(!await publication)throw new Error("video session queue promotion was cancelled");
        if(disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;
      }else{
        // Dispatch pause+mute+hide in one foreground command before any source
        // resolution or persistence await. Its reply never gates the new page.
        const from=preparedSource;setHandoff(true);frameWait.reset();setSpinnerDue(false);
        generation++;autoplayAllowed=false;prepareOp?.cancel();pollTimer?.cancel();
        void media.retire(true).catch(value=>{if(!disposed&&revision===dragRevision)failed(value);});
        await (target&&props.onPromoteAdjacent?props.onPromoteAdjacent(target).then(ok=>{if(!ok)throw new Error("video queue promotion was cancelled");}):Promise.resolve(move!()));if(disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;clearDrag();if(preparedSource===from)setHandoff(false);
      }
    }catch(value){if(disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;if(!usingSessions()){
      // Resolution failed before a new source was published. Stop motion/audio first, then show the selected old frame with Retry.
      failedMove=move;setHandoff(true);
      try{const paused=await media.pause();if(!disposed&&revision===dragRevision&&videoSessionOwner===sessionOwner)setState(paused);}catch{if(!disposed&&revision===dragRevision&&videoSessionOwner===sessionOwner)await media.stop().catch(()=>{});}
      if(disposed||revision!==dragRevision)return;
      clearDrag();failed(value);
    }else if(revision===dragRevision&&!cancelledSessionError(value))void degradeSessions(value);}
    finally{void drainDeferred();}
  };
  const drainDeferred=async()=>{
    if(disposed||!props.active||videoSessionOwner!==sessionOwner||props.source.platform!=='douyin'){deferredDrags.length=0;deferredPan=undefined;return;}
    if(dragSettling||drainingDeferred||!deferredDrags.length)return;
    const queued=deferredDrags.shift()!;drainingDeferred=true;
    try{
      replayingDeferred=true;beginDouyinDrag(queued.distanceY);benchmarkSeq=queued.seq;moveDouyinDrag(queued.distanceY);replayingDeferred=false;
      await finishDouyinDrag(queued.velocityY,queued.cancel,queued);
    }finally{replayingDeferred=false;drainingDeferred=false;void drainDeferred();}
  };
  const advanceAfterEnd=()=>autoAdvance.ended(loopMode(),async()=>{
    if(!props.active||lifecycle()!=="active"||!props.onNext||!props.onPrepareAdjacent)return false;
    const target=await warmForward();
    return !!target||!!props.onAdjacentKey?.('next');
  },async current=>{
    if(!current()||disposed||!props.active||lifecycle()!=="active"||videoSessionOwner!==sessionOwner||dragSettling||dragDirection)return;
    beginDouyinDrag();moveDouyinDrag(-pagerLength());await finishDouyinDrag(-125);
  });
  // The capability probe can leave a pool object behind while playback uses
  // the legacy host. Release the backend that actually owns playback.
  const releaseOwnedPlayback=()=>{
    captureFrame(true);const owns=videoSessionOwner===sessionOwner,legacy=!usingSessions();
    if(owns)videoSessionOwner=undefined;
    if(sessionPool)void sessionPool.releaseAll().catch(()=>{});
    if(owns&&legacy)void video.stop().catch(()=>{});
  };
  let resumeAfterOverlay=false,wasRouteActive=props.active;
  createEffect(()=>{const active=props.active,resumed=active&&!wasRouteActive;wasRouteActive=active;
    if(resumed&&props.onReload&&resourceRetry?.source!==props.source&&!isManualDetailSource()&&untrack(()=>videoSourceExpired(props.source))){videoSessionOwner=sessionOwner;void reload(false,{code:'source_expired'});return;}
    if(!active){if(props.onReload){cancelReload();reloadResume=checkpointPosition;}if(props.source.platform==='douyin'){
    if(props.source.previewOnly&&needsFreshResolution&&!untrack(error))preparedSource=undefined;
    deferredDrags.length=0;deferredPan=undefined;resumeAfterOverlay=false;autoplayAllowed=false;autoAdvance.cancel();generation++;neighborRevision++;dragRevision++;
    prepareOp?.cancel();pollTimer?.cancel();tapTimer?.cancel();volumeTimer?.cancel();
    const current=untrack(state);if(videoSessionOwner===sessionOwner&&current)emitCheckpoint("pause_or_exit",current.positionMs,current.durationMs);
    forwardTarget=undefined;clearDrag();setReady(false);setFirstFrame(false);
    untrack(releaseOwnedPlayback);return;
  }resumeAfterOverlay=autoplayAllowed&&untrack(()=>!ready()||state()?.state==="playing");autoplayAllowed=false;if(usingSessions()){const value=untrack(state);if(value)emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});}else if(untrack(ready)&&videoSessionOwner===sessionOwner)void media.pause().catch(()=>{});}else if(videoSessionOwner!==sessionOwner||usingSessions()&&!untrack(ready)){untrack(prepare);}else if(resumeAfterOverlay){resumeAfterOverlay=false;autoplayAllowed=lifecycle()==="active"||props.source.backgroundPlayback===true;if(autoplayAllowed&&untrack(ready))void media.play().then(setState).catch(failed);}});
  // Native video is composed outside the guest ink tree. Its fullscreen pager
  // owns the active viewport even when the host hit fact names a backdrop node.
  const surfaceGesture = createGesture(playerGesture({ region: { node: () => detailShown() || props.source.platform==='douyin'&&props.source.immersive ? undefined : surface, rect: () => props.active && props.offset === 0 && !detailShown() ? { x: 0, y: top(), w: props.width, h: props.height } : null }, axis: "y", panSlop: 8,
    onTap: contact => { const hit = hitNode(contact.x, contact.y, contact.surface); let pressable = hit; while (pressable && !pressable.onPress) pressable = pressable.parent; if (hit && pressable) pressNode(hit); else backgroundTap(); },
    onLongPress: contact => {
      if (!props.active || networkPrompt()) return;
      if (douyinPlayer()) {
        let target = hitNode(contact.x, contact.y, contact.surface);
        while (target && !target.onPress) target = target.parent;
        if (target?.debugName === "VideoPlayerRotate") { rotateBy(-90); return; }
      }
      props.onActions?.();
    },
    onDown: () => { panVelocity = 0; pagerPointerRotation=displayRotation(); }, onPanStart: contact => { panningStart = pan();if(props.source.platform==="douyin")beginDouyinDrag(contact.dy,true); }, onPanMove: contact => { if(props.source.platform==="douyin"){moveDouyinDrag(contact.dy);return;}const r = range(); if(r.axis !== "y" || r.range <= 0) return; setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dy))); void requestTransform(); },
    onPanEnd: contact => { if(props.source.platform==="douyin"){void finishDouyinDrag(douyinPagerReleaseVelocity(contact),!!networkPrompt(),undefined,"network_prompt");return;} if (networkPrompt()) return; if(range().axis === "y") { panVelocity = contact.vy; panFrameAt = Date.now();setMotion(true); } props.onPanStateChange?.(pan(), range().range); },
    onCancel:()=>{if(props.source.platform==="douyin")void finishDouyinDrag(0,true);}
  },displayRotation,playerViewport));
  const horizontalPanGesture = createGesture(playerGesture({ region: { rect: () => { const r = range(); return props.active && !detailShown() && props.source.platform !== "douyin" && r.axis === "x" && r.range > 0 && pan() < r.range - 1 ? { x: 0, y: top(), w: props.width, h: props.height } : null; } }, axis: "x", panSlop: 8,
    onDown: () => { panVelocity = 0; }, onPanStart: () => { panningStart = pan(); }, onPanMove: contact => { const r = range(); setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dx))); void requestTransform(); }, onPanEnd: contact => { panVelocity = contact.vx; panFrameAt = Date.now();setMotion(true); props.onPanStateChange?.(pan(), range().range); }
  },displayRotation,playerViewport));
  const spinnerVisible=()=>props.active&&workForeground()&&!props.onReload&&!error()&&!networkPrompt()&&(props.source.platform==='douyin'&&props.source.immersive?spinnerDue()&&state()?.bufferedMs===0&&state()?.networkStalled===true&&(!firstFrame()||handoff())&&(!dragAxis()||handoff()):!state()||state()?.state==='buffering'||state()?.buffered===false||state()?.isBuffering===true);
  createEffect(()=>{if(!renderDiagnostics)return;state();props.active;props.offset;error();networkPrompt();const now=Date.now();if(props.source.platform==='douyin'&&props.source.immersive&&props.active&&now-lastBenchmarkHeartbeat>=1000){lastBenchmarkHeartbeat=now;benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true,ringer_mode:state()!.ringerMode??'unknown',silenced:state()!.silenced===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:props.active&&props.offset===0&&lifecycle()==='active'&&!error()&&!networkPrompt()?'present':'absent',visibility_reason:!props.active?'inactive':props.offset!==0?'route_offset':lifecycle()!=='active'?'lifecycle':error()?'player_error':networkPrompt()?'network_prompt':'ready',player_state:closedPlayerState(state()?.state),has_frame:state()?.hasRenderedFirstFrame===true,offset_abs_milli:Math.min(1000000000,Math.round(Math.abs(props.offset)*1000))});} });
  createEffect(()=>{const observed=firstFrame()&&!handoff(),value=state();frameWait.observe(observed);setSpinnerDue(frameWait.visible()&&value?.bufferedMs===0&&value?.networkStalled===true);if(observed||frameWait.visible())return;const timer=delay(1000);void timer.result.then(()=>{publishPreparationBuffer();setSpinnerDue(frameWait.visible()&&state()?.bufferedMs===0&&state()?.networkStalled===true);}).catch(()=>{});onCleanup(()=>timer.cancel());});
  createEffect(()=>{if(!props.active||!workForeground()||!motion())return;onFrame(() => { const now = Date.now(); animationDiagnostics.frame(now);animationDiagnostics.end('scale'); if (panVelocity !== 0) { const elapsed = Math.min(50, Math.max(0, now - panFrameAt)), r = range(), next = Math.max(-r.range, Math.min(r.range, pan() + panVelocity * elapsed / 1000)); setPan(next); panVelocity *= Math.exp(-5 * elapsed / 1000); if (Math.abs(panVelocity) < 5 || next === -r.range || next === r.range) panVelocity = 0; panFrameAt = now; void requestTransform(); } if (!rotationStarted) {if(!panVelocity)setMotion(false);return;} const elapsed = now - rotationStarted, t = Math.min(1, elapsed / 300), eased = 1 - Math.pow(1 - t, 3); if (t >= 1) { finishRotation(); if (!panVelocity) setMotion(false); } else { rotationFrameAngle = rotationFrom + (rotationTo - rotationFrom) * eased; setDisplayRotation(normalizeRotation(rotationFrameAngle)); } void requestTransform(); });});
  const showVolumeOverlay = () => {
    setVolumeVisible(true);volumeTimer?.cancel();volumeTimer=delay(900);
    void volumeTimer.result.then(()=>setVolumeVisible(false)).catch(()=>{});
  };
  const submitVolume = async () => {
    if (volumeRunning) { volumeDirty = true; return; }
    volumeRunning = true;
    let requestSource: PlaybackSource | undefined, requestGeneration = -1;
    try {
      do {
        volumeDirty = false;
        const source = props.source, ownGeneration = generation, target = virtualVolume ?? .5;
        requestSource = source; requestGeneration = ownGeneration;
        const next = await media.setVolume(target);
        if (disposed || videoSessionOwner !== sessionOwner) return;
        if (source !== props.source || ownGeneration !== generation) { if (volumeDirty) continue; return; }
        observedVolume = next.volume;
        if (target === virtualVolume) setState(previous => previous ? { ...previous, volume: next.volume, volumeMax: next.volumeMax,
          volumeIndex: next.volumeIndex, muted: next.muted, appliedVolume: next.appliedVolume, ringerMode: next.ringerMode, silenced: next.silenced } : previous);
        else volumeDirty = true;
      } while (volumeDirty && !disposed);
    } catch (value) { if (!disposed && props.active && requestSource === props.source && requestGeneration === generation) failed(value); }
    finally { volumeRunning = false; }
  };
  const crownVolume = (direction: -1 | 1) => { const maxSteps = Math.max(1, state()?.volumeMax ?? 15), current = virtualVolume ?? state()?.volume ?? .5; crownDirection=direction; const guarded = guardedCrownVolume(current, direction / maxSteps, maxSteps, props.source.volumeGuard === true, crownGuard, Date.now()); crownGuard = guarded.state; virtualVolume = guarded.volume; void submitVolume(); };
  const adjustVolume = (delta: number) => { const direction = normalizedRelativeAxisStep(delta); if (!props.active || !props.source.digitalCrownVolume || direction === 0) return false; crownVolume(direction); showVolumeOverlay(); return true; };
  // Detail panel steppers: whole system volume steps, deliberate taps, so no crown guard.
  const stepVolume = (steps: number) => { if (!props.active || !steps) return; const maxSteps = Math.max(1, state()?.volumeMax ?? 15), current = virtualVolume ?? state()?.volume ?? .5; crownDirection = steps > 0 ? 1 : -1; crownGuard = { lastEventMs: Number.NEGATIVE_INFINITY }; virtualVolume = Math.max(0, Math.min(maxSteps, Math.round(current * maxSteps) + steps)) / maxSteps; void submitVolume(); };
  // Playback speed (hosts that report state.speed). The chosen speed follows page changes
  // and re-prepares: a state that disagrees is corrected once per source generation.
  const [speedTarget, setSpeedTarget] = createSignal(1);
  const speedSupported = () => typeof state()?.speed === "number";
  let speedRunning = false, speedDirty = false;
  let speedCorrected: { source: PlaybackSource; generation: number; nativeGeneration?: number; target: number } | undefined;
  const submitSpeed = async () => {
    if (speedRunning) { speedDirty = true; return; }
    speedRunning = true;
    try {
      let target: number;
      do {
        speedDirty = false;
        const source = props.source, ownGeneration = generation, nativeGeneration = state()?.sourceGeneration;
        if (disposed || !props.active || !ready() || !speedSupported() || videoSessionOwner !== sessionOwner) return;
        target = speedTarget();
        const next = await media.setSpeed(target);
        if (disposed || videoSessionOwner !== sessionOwner) return;
        // A retained session can have the same native generation as its neighbour.
        // Source identity and the application generation must also still match.
        if (source !== props.source || ownGeneration !== generation || nativeGeneration !== state()?.sourceGeneration) { speedDirty = true; continue; }
        // Speed replies can arrive after a seek/poll: never roll those fields back.
        setState(previous => previous ? { ...previous, speed: next.speed } : previous);
      } while (speedDirty || target !== speedTarget());
    } catch (value) { appLogger.w('VideoPlayer', `setSpeed failed ${playerFailureCode(value)}`); }
    finally { speedRunning = false; }
  };
  const changeSpeed = (value: number) => { setSpeedTarget(value); void submitSpeed(); };
  createEffect(() => {
    const value = state(), target = speedTarget(), source = props.source;
    if (typeof value?.speed !== "number" || Math.abs(value.speed - target) < .001 || !ready() || !props.active || videoSessionOwner !== sessionOwner) return;
    if (speedCorrected?.source === source && speedCorrected.generation === generation && speedCorrected.nativeGeneration === value.sourceGeneration && speedCorrected.target === target) return;
    speedCorrected = { source, generation, nativeGeneration: value.sourceGeneration, target };
    untrack(() => void submitSpeed());
  });
  // Detail & playback-control panel: opened by the edge arrow or a right-to-left drag.
  let detail: PlayerDetailHandle | undefined;
  const detailViewport = createMemo(() => {
    const width = props.width, height = screenHeight();
    const diameter = Math.min(width, height);
    return props.round
      ? { x: (width - diameter) / 2, y: (height - diameter) / 2, width: diameter, height: diameter, radius: diameter / 2 }
      : { x: 0, y: 0, width, height, radius: 0 };
  });
  const slide = createDetailSlide(() => detailViewport().width);
  const detailShown = slide.shown;
  createEffect(()=>{
    const value=state(),source=props.source,own=generation;
    const enabled=()=>!disposed&&props.active&&source.platform==='douyin'&&!!props.onReload&&ready()&&!reconnecting()&&!detailShown()&&
      lifecycle()==='active'&&videoSessionOwner===sessionOwner&&autoplayAllowed&&!networkPrompt();
    bufferedStall.observe(value??undefined,own,enabled(),delay,ticket=>{void(async()=>{
      if(!bufferedStall.current(ticket)||disposed||generation!==own||props.source!==source||!enabled())return;
      try{
        // Recheck the real player: an omitted/coalesced push must not reload a
        // player that has already recovered or was paused by the user.
        const fresh=await media.state();
        if(disposed||generation!==own||props.source!==source||!bufferedStall.current(ticket))return;
        if(bufferedStall.matches(ticket,fresh,own,enabled()))void reload(false,{code:'not_ready'});
        else setState(fresh);
      }catch(value){if(!disposed&&generation===own&&props.source===source&&bufferedStall.current(ticket))failed(value,false,'state');}
    })();});
  });
  const canOpenDetail = () => props.active && props.offset === 0 && !error() && !networkPrompt() && !dragAxis() && !handoff();
  createEffect(() => { if (!props.active) slide.reset(); });
  props.ref?.({
    reloadAttempts:()=>reloadCount,
    shellState:async()=>{if(disposed||!props.active||videoSessionOwner!==sessionOwner||!ready())throw new ShellCommandError('not_ready');return {...await media.state(),reloadCount,loopModeIndex:loopMode()==='off'?0:loopMode()==='single'?1:2,loopModeCount:loopModes().length,gestureReady:props.active&&props.offset===0&&!detailShown(),gestureOffset:Number.isFinite(props.offset)?props.offset:0,gestureDetailShown:detailShown(),gestureLifecycleActive:lifecycle()==='active',gestureRotation:displayRotation()};},
    shellPlaying:async playing=>{if(disposed||!props.active||videoSessionOwner!==sessionOwner||!ready())throw new ShellCommandError('not_ready');const own=generation;autoplayAllowed=playing;resumeAfterLifecycle=false;const next=await(playing?media.play():media.pause());if(disposed||own!==generation||videoSessionOwner!==sessionOwner)throw new ShellCommandError('unavailable');setState(next);if(!playing)emitCheckpoint('pause_or_exit',next.positionMs,next.durationMs);},
    invalidatePrefetch(id){neighborRevision++;forwardResolved=false;forwardTarget=undefined;sessionPool?.invalidateStandby(id);if(props.active&&ready())void warmForward().catch(()=>{});},previewKind:()=>previewPath()?'actual_frame':!props.source.immersive&&props.source.posterUrl?'cover':undefined,loopMode,availableLoopModes:loopModes,setLoopMode,cycleLoopMode,gestureRotation:displayRotation,onCrown: delta => { if (detailShown()) { detail?.crown(delta); return true; } return adjustVolume(delta); }, canSwipeBack: () => { if (detailShown()) return false; if (props.source.platform === "douyin") return true; const r = range(); return r.axis !== "x" || r.range <= 0 || pan() >= r.range - 1; },
    sideSwipe: { begin: () => canOpenDetail() && !detailShown() && slide.begin(), move: dx => slide.move(dx), end: vx => slide.end(vx), cancel: () => slide.cancel() } });
  onCleanup(() => { bufferedStall.cancel();recoveryDeadline.cancel();removeLifecycle();autoAdvance.cancel();playbackTrace?.event('exit');disposed = true; deferredDrags.length=0;deferredPan=undefined; generation++;neighborRevision++;dragRevision++;autoplayAllowed=false; const current = state(); if (ready() && current) emitCheckpoint("pause_or_exit", current.positionMs, current.durationMs); surfaceGesture.dispose(); horizontalPanGesture.dispose(); prepareOp?.cancel(); pollTimer?.cancel(); tapTimer?.cancel(); volumeTimer?.cancel(); releaseOwnedPlayback(); });
  // Round screens: while the crown capsule shows, control rows in the (rotatable) layer move off it or leave it blank.
  const layerQuarter = () => normalizeRotation(Math.round(displayRotation() / 90) * 90);
  const avoidRow = (icons: RowIcon[], top: number, height: number) => createMemo(() => props.round && volumeVisible() && controlsVisible() ? avoidVolumeArc(VOLUME_ARC, icons, top, height, -layerQuarter()) : undefined);
  const topPair = avoidRow([{ left: 79.5, width: 24 }, { left: 129.5, width: 24 }], 16, 24);
  const topTriple = avoidRow([{ left: 57.5, width: 24 }, { left: 104.5, width: 24 }, { left: 151.5, width: 24 }], 18, 24);
  const bottomRow = avoidRow([{ left: 57.5, width: 24 }, { left: 102.5, width: 28 }, { left: 151.5, width: 24 }], 194, 28);
  const dx = (row: () => { dx: number[] } | undefined, i: number) => row()?.dx[i] ?? 0, hidden = (row: () => { hidden: boolean[] } | undefined, i: number) => row()?.hidden[i] ?? false;
  const portraitVideo = createMemo(() => { const w = state()?.width ?? props.source.videoWidth ?? 0, h = state()?.height ?? props.source.videoHeight ?? 0; return w > 0 && h > 0 ? h > w : props.source.platform === "douyin"; });
  const detailCover = createMemo(() => props.source.posterUrl ? { url: props.source.posterUrl, bucket: props.source.platform === "bili" ? "bili-preview" as const : undefined, portrait: portraitVideo() } : undefined, undefined, { equals: (a, b) => a?.url === b?.url && a?.portrait === b?.portrait && a?.bucket === b?.bucket });
  const volumePercent = () => systemVolumePercent(state()?.volumeIndex ?? Math.round((state()?.volume??0)*(state()?.volumeMax??1)),state()?.volumeMax??1);
  const uiScale = () => Math.min(props.width / 233, props.height / 233), uiLeft = () => (props.width - 233) / 2, uiTop = () => (props.height - 233) / 2;
  const errorWidth=()=>Math.max(170,props.width-62);
  const errorLines=createMemo(()=>measuredLines(props.onReload?error():'播放失败',errorWidth()-16,text=>getOps().measureText(text,0),3));
  const errorTextHeight=()=>Math.max(1,errorLines().length)*14;
  const errorHeight=()=>errorTextHeight()+14+32;
  const buffering = () => state()?.state === "buffering" || state()?.buffered === false || state()?.isBuffering === true;
  const prepared = () => ready() && !!state()?.durationMs;
  // Guest previews do not share the native page matrix. During paging,
  // rotation or nonstandard scale, render only native decoded pixels.
  const guestPreviewVisible=()=>!error()&&!networkPrompt()&&!dragAxis()&&!handoff()&&mode()==="standard"&&displayRotation()%360===0;
  const showDragPoster=()=>!error()&&!networkPrompt()&&!nativeDrag()&&mode()==="standard"&&displayRotation()%360===0&&dragPoster();
  const dragPosterOffset=()=>{const poster=dragPoster();if(!poster)return 0;const remaining=(1-dragProgress())*props.height;return poster.direction==="up"?remaining:-remaining;};
  let benchmarkSpinner=false,spinnerBenchmark:VideoBenchmarkAction|undefined;
  createEffect(()=>{
    const visible=props.source.platform==='douyin'&&props.source.immersive&&spinnerDue()&&state()?.bufferedMs===0&&state()?.networkStalled===true&&(!firstFrame()||handoff())&&(!dragAxis()||handoff())&&!error()&&!networkPrompt();
    if(visible&&!benchmarkSpinner&&pendingBenchmark){spinnerBenchmark=pendingBenchmark;benchmark.presented('spinner_shown',spinnerBenchmark.seq,{generation:spinnerBenchmark.generation,buffered_ms:state()?.bufferedMs??0,network_stalled:state()?.networkStalled===true,reason:'network_stalled'});}
    if(!visible&&benchmarkSpinner&&spinnerBenchmark){benchmark.cancelPresented('spinner_shown',spinnerBenchmark.seq);spinnerBenchmark=undefined;}
    benchmarkSpinner=!!visible;
  });
  createEffect(()=>{if(renderDiagnostics&&props.source.platform==='douyin'&&props.source.immersive&&!props.active)benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true,ringer_mode:state()!.ringerMode??'unknown',silenced:state()!.silenced===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:'absent'});});
  onCleanup(()=>{if(renderDiagnostics&&props.source.platform==='douyin'&&props.source.immersive)benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true,ringer_mode:state()!.ringerMode??'unknown',silenced:state()!.silenced===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:'absent'});});
  let coverWasVisible=false,coverGeneration=0;
  createEffect(()=>{
    if(!renderDiagnostics)return;
    const visible=!!(props.source.platform==='douyin'&&props.source.immersive&&((!firstFrame()&&(previewPath()||props.source.posterUrl))||dragPoster()));
    if(visible){coverWasVisible=true;coverGeneration=generation;}
    else if(coverWasVisible){coverWasVisible=false;const checkpoint=renderCheckpoint({sampleAlpha:true});appLogger.i('DouyinTiming',`coverRemoved prepareMs=${Date.now()-prepareStarted} generation=${coverGeneration} reason=${error()?'error':firstFrame()?'first-frame':'ready'} checkpoint=${checkpoint??0}`);}
  });
  return <View ref={value => surface = value} class="absolute left-[0] right-[0]" style={{ insetT: top(), height: props.height }}><Show when={guestPreviewVisible()&&props.source.platform==="douyin"&&(props.source.immersive||previewPath())&&!handoff()&&!firstFrame()&&(previewPath()||!props.source.immersive&&props.source.posterUrl)}><RemoteImage url={props.source.posterUrl??""} filePath={previewPath()} onError={()=>{const path=previewPath();if(path)setBadFrame(path);}} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></Show><Show when={showDragPoster()}>{poster=><View class="absolute inset-0" style={{translateY:dragPosterOffset()}}><RemoteImage url={poster().url} filePath={poster().filePath} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></View>}</Show>
    <View class="absolute inset-0" style={{ rotate: displayRotation() }}>
      <Show when={!!props.onReload} fallback={<Show when={spinnerVisible()}><View class="absolute w-[40] h-[40] rounded-[20] bg-[#00000099]" style={{ insetL: (props.width - 40) / 2, insetT: (props.height - 40) / 2 }}><PlayerSpinner src="../assets/icons/player-loading.svg" left={6} top={6} size={28}/></View></Show>}><PlayerLoadingIndicator width={props.width} height={props.height} visible={props.active&&lifecycle()==='active'&&props.offset===0&&!detailShown()&&!error()&&!networkPrompt()&&(reconnecting()||!ready()||buffering()||handoff())} phase={reconnecting()?'reconnecting':props.source.previewOnly?'fetching':buffering()?'buffering':'preparing'}/></Show>
      <Show when={props.active && error() && !networkPrompt()}><View class="absolute rounded-[24] bg-[#000000cc]" style={{insetL:(props.width-errorWidth())/2,insetT:(props.height-errorHeight())/2,width:errorWidth(),height:errorHeight()}}>
        <Text class="absolute text-xs text-[#b6b6b6] text-center" style={{insetL:8,insetT:0,width:errorWidth()-16,height:errorTextHeight(),lineHeight:14}}>{errorLines().join('\n')}</Text>
        <View class="absolute rounded-[16] bg-[#2a2a2a] items-center justify-center active:scale-96" style={{insetL:(errorWidth()-72)/2,insetT:errorTextHeight()+14,width:72,height:32}} onPress={() => void retry()} focusable><Text class="text-xs text-white">重试</Text></View>
      </View></Show>
      <Show when={volumeVisible() && !props.round}><View class="absolute left-[72] right-[72] h-[50] rounded-[25] bg-[#111111dd] items-center justify-center" style={{ insetT: (props.height - 51) / 2 }}><Text class="text-[21px] leading-[26] text-white">{volumePercent()}%</Text></View></Show>
      <Show when={(props.round || !volumeVisible()) && loopHint()}>{hint => <View class="absolute left-[52] right-[52] h-[50] rounded-[25] bg-[#111111dd] items-center justify-center" style={{ insetT: (props.height - 51) / 2 }}><Text class="text-base leading-[20] text-white">{hint()}</Text></View>}</Show>
    </View>
    <Show when={!error() && !networkPrompt() && controlsVisible()}><View class="absolute" style={{ insetL: uiLeft(), insetT: uiTop(), width: 233, height: 233, scale: uiScale(), rotate: displayRotation(), originX: 0, originY: 0 }}>
      <View class="absolute left-[0] right-[0] top-[0] h-[62] bg-gradient-to-b from-[#000000cc] to-transparent" />
      <Show when={loopModes().length > 1} fallback={<><PlayerButton left={69.5 + dx(topPair, 0)} hidden={hidden(topPair, 0)} top={6} size={44} icon={mode() === "standard" ? "fullscreen" : mode() === "expanded" ? "panorama" : "fullscreen-exit"} iconSize={24} onPress={changeMode} /><PlayerButton left={119.5 + dx(topPair, 1)} hidden={hidden(topPair, 1)} top={6} size={44} icon="rotate" iconSize={24} accessibilityLabel={douyinPlayer() ? "旋转画面，长按反向旋转" : undefined} onPress={() => rotateBy(90)} /></>}>
        {/* Three across: icon corners stay inside the 233 circle at this height. */}
        <PlayerButton left={47.5 + dx(topTriple, 0)} hidden={hidden(topTriple, 0)} top={8} size={44} icon={mode() === "standard" ? "fullscreen" : mode() === "expanded" ? "panorama" : "fullscreen-exit"} iconSize={24} onPress={changeMode} /><PlayerButton left={94.5 + dx(topTriple, 1)} hidden={hidden(topTriple, 1)} top={8} size={44} icon={`loop-${loopMode()}`} iconSize={24} accessibilityLabel={LOOP_LABELS[loopMode()]} onPress={tapLoopMode} /><PlayerButton left={141.5 + dx(topTriple, 2)} hidden={hidden(topTriple, 2)} top={8} size={44} icon="rotate" iconSize={24} accessibilityLabel={douyinPlayer() ? "旋转画面，长按反向旋转" : undefined} onPress={() => rotateBy(90)} />
      </Show>
      <Show when={Number.isFinite(state()?.durationMs)&&(state()?.durationMs??0)>0}>
        <PlayerTimeline positionMs={state()?.positionMs??0} durationMs={state()?.durationMs??0}/>
      </Show>
      <PlayerButton left={47.5 + dx(bottomRow, 0)} hidden={hidden(bottomRow, 0)} top={186} size={44} icon="rewind" iconSize={24} enabled={props.active && !detailShown() && prepared()} onPress={() => void seekTo(-4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, -1))} /><PlayerButton left={91.5 + dx(bottomRow, 1)} hidden={hidden(bottomRow, 1)} top={183} size={50} icon={state()?.state === "playing" ? "pause" : "play"} iconSize={28} enabled={props.active && !detailShown() && prepared()} onPress={() => void toggle()} /><PlayerButton left={141.5 + dx(bottomRow, 2)} hidden={hidden(bottomRow, 2)} top={186} size={44} icon="forward" iconSize={24} enabled={props.active && !detailShown() && prepared()} onPress={() => void seekTo(4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, 1))} />
    </View></Show>
    <Show when={props.active && controlsVisible() && !error() && !networkPrompt() && !detailShown() && !(props.round && volumeVisible())}><PlayerDetailArrow left={uiLeft()} top={uiTop()} scale={uiScale()} rotation={displayRotation()} round={props.round} onOpen={() => { if (canOpenDetail()) slide.open(); }} /></Show>
    <Show when={volumeVisible() && props.round && !detailShown()}><VolumeArcCapsule width={props.width} height={props.height} percent={volumePercent()} muted={state()?.muted === true} /></Show>
    <Show when={detailShown()}><View class="absolute overflow-hidden" style={{
      insetL: detailViewport().x, insetT: detailViewport().y - top(), width: detailViewport().width,
      height: detailViewport().height, radius: detailViewport().radius,
    }}>
      <View debugName="PlayerDetailPicture" class="absolute left-[0] top-[0]" style={{
        width: detailViewport().width, height: detailViewport().height, rotate: displayRotation(), originX: 0, originY: 0,
      }}>
        <PlayerDetailPanel width={detailViewport().width} height={detailViewport().height} rotation={displayRotation} slide={slide} ref={value => detail = value}
          title={() => props.source.title} author={() => props.source.author} description={() => props.source.description} cover={detailCover}
          positionMs={() => state()?.positionMs ?? 0} durationMs={() => state()?.durationMs ?? 0} seekable={prepared} onSeek={delta => void seekTo(delta)}
          volumePercent={volumePercent} muted={() => state()?.muted === true} onVolume={(steps, crown) => { if (crown) { const direction = normalizedRelativeAxisStep(steps); if (direction && props.active) crownVolume(direction); } else stepVolume(steps); }}
          speed={() => speedSupported() ? speedTarget() : undefined} onSpeed={changeSpeed} />
      </View>
    </View></Show>
  </View>;
}
