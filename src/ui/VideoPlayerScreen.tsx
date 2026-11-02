import {playerFailureCode,playerFailureFields,formatPlayerFailure,closedPlayerState} from '../media/player-errors.ts';
import type {FailureStage} from '@podjs/framework/benchmark';
import {benchmark,type VideoBenchmarkAction} from '@podjs/framework/benchmark';
import {VideoFirstFrameWait} from '@podjs/framework/video-paging';
import {douyinCodecRuntimePolicy} from '../douyin/playback-selector.ts';
import {PlaybackPrepareDeadline} from '@podjs/framework/media-policy';
import {playbackFailure} from '../media/playback-failure.ts';
import {takeVideoResolution,type VideoPlaybackTrace} from '../media/video-opt.ts';
import {framePreviewPath,frameSource,type DouyinFramePreview} from '../douyin/frame-preview.ts';
import {kv} from "@podjs/framework/watch";
import {availableLoopModes, nextLoopMode, VideoLoopPreferences, VideoViewingProgress, VideoAutoAdvance, type VideoLoopMode} from "../media/loop-mode.ts";
import {renderCheckpoint} from '@podjs/framework/render-checkpoint';
import {douyinDebug} from '../debug/douyin-host.ts';
import {restoredSignal,booleanState} from './route-activity.tsx';
import {appLogger} from '../logs/app-logger.ts';
import { observeHostInternet } from "../onboarding/network-host.ts";
import type { InternetStatus } from "../onboarding/state.ts";
import { douyinPlayerNetwork, douyinSourceNeedsInternet, douyinNetworkFailure } from "./douyin/player-network.ts";
import { batch, createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { hasCapability, lifecycle, onLifecycleChange, normalizedRelativeAxisStep } from "@podjs/framework/watch";
import { video, onVideoAudioChanged, onVideoFirstFrame, delay, type HostOperation, type VideoPrepare, type VideoBounds, type VideoState } from "@podjs/framework/services";
import { formatPlayerTime, systemVolumePercent, guardedCrownVolume, nextScaleMode, playerPanRange, progressWidth, seekHoldStep, type CrownVolumeGuardState, type PlayerScaleMode } from "./video-player.ts";
import { DouyinVideoSessionPool, douyinPagerDelta, douyinPagerProgress, douyinPagerSettleDuration, douyinPagerSettleProgress, shouldFallbackFromVideoSessions, shouldSettleDouyinPager, shouldUseDouyinVideoSessions, type DouyinPagerDirection, type DouyinPreparedSource } from "./douyin/video-sessions.ts";
import { RemoteImage } from "./RemoteImage.tsx";

// The host exposes one session, even when navigation retains several screens.
let videoSessionOwner:symbol|undefined;
const recoveredSources=new WeakSet<object>();

type ExtendedVideoState = VideoState & { volume?: number; buffered?: boolean; isBuffering?: boolean };

export interface PlaybackSource { startupSeq?:number; biliApiSource?:'watch'|'web'; recoveryDeadlineMs?:number; previewOnly?:boolean;previewFrame?:DouyinFramePreview; detailPlayback?:boolean; immersive?:boolean; awemeId?:string; posterUrl?:string; backgroundPlayback?: boolean; url?: string; videoUrl?: string; audioUrl?: string; webUrl?: string; headers?: Record<string, string>; type?: string; videoMime?:string; videoWidth?:number; videoHeight?:number; title: string; resumePositionMs?: number; volumeGuard?: boolean; startVolumeLimit?: number | null; digitalCrownVolume?: boolean; platform?: "bili" | "douyin" | "rss" }
export interface VideoPlayerHandle { invalidatePrefetch(id:string):void; previewKind():"actual_frame"|"cover"|undefined; loopMode():VideoLoopMode; availableLoopModes():readonly VideoLoopMode[]; setLoopMode(mode:VideoLoopMode):void; cycleLoopMode():void; onCrown(delta: number): boolean; canSwipeBack(): boolean }

const LOOP_LABELS: Record<VideoLoopMode, string> = { off: "不循环", single: "单视频循环", next: "自动下一个" };
function PlayerButton(props: { left: number; top: number; size: number; icon: "fullscreen" | "panorama" | "fullscreen-exit" | "rotate" | "rewind" | "forward" | "play" | "pause" | "loop-off" | "loop-single" | "loop-next"; accessibilityLabel?: string; iconSize: number; enabled?: boolean; onPress: () => void; onHold?: (elapsedMs: number) => void }) {
  let node: NodeMirror | undefined, holding = false, holdStart = 0, nextSeek = 0;
  const gesture = createGesture({ region: { node: () => node }, longPressSeconds: .5,
    onTap: () => { if (props.enabled !== false) props.onPress(); },
    onLongPress: () => { if (props.enabled === false || !props.onHold) return; holding = true; holdStart = Date.now(); nextSeek = 0; },
    onUp: () => { holding = false; }, onCancel: () => { holding = false; }
  });
  onFrame(() => { if (!holding || !props.onHold) return; const elapsed = Date.now() - holdStart; if (elapsed >= nextSeek) { props.onHold(elapsed); nextSeek = elapsed + 200; } });
  onCleanup(() => gesture.dispose());
  return <View ref={value => node = value} onPress={() => { if (props.enabled !== false) props.onPress(); }} focusable={props.enabled !== false} accessibilityLabel={props.accessibilityLabel} accessibilityRole={props.accessibilityLabel ? "button" : undefined} style={{ insetL: props.left, insetT: props.top, width: props.size, height: props.size, opacity: props.enabled === false ? .5 : 1 }} class="absolute items-center justify-center">
    <Show when={props.icon === "fullscreen"}><Image src="../assets/icons/player-fullscreen.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "panorama"}><Image src="../assets/icons/player-panorama.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "fullscreen-exit"}><Image src="../assets/icons/player-fullscreen-exit.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rotate"}><Image src="../assets/icons/player-rotate.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rewind"}><Image src="../assets/icons/player-rewind.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "forward"}><Image src="../assets/icons/player-forward.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "play"}><Image src="../assets/icons/player-play.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "pause"}><Image src="../assets/icons/player-pause.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-off"}><Image src="../assets/icons/player-loop-off.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-single"}><Image src="../assets/icons/player-loop-single.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "loop-next"}><Image src="../assets/icons/player-loop-next.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show>
  </View>;
}

export function VideoPlayerScreen(props: { initialPool?:DouyinVideoSessionPool; source: PlaybackSource; width: number; height: number; /** Screen y of the player area; height is the area below it. */ top?: number; active: boolean; offset: number; round: boolean; onBluetoothAllowed?:(value:boolean)=>void; onPlaybackActiveChanged?:(source:string|undefined,active:boolean)=>void; onFirstFrame?:()=>void; onError?: (message: string) => void; onOpenWeb?: () => void; onProgress?: (positionMs: number, durationMs: number) => void; onCheckpoint?: (kind: "ready" | "pause_or_exit" | "error" | "ended", positionMs: number, durationMs: number) => void; onNext?: () => void | Promise<void>; onPrevious?: () => void | Promise<void>; onAdjacentPoster?:(direction:"next"|"previous")=>string|undefined; onPrepareAdjacent?:(direction:"next"|"previous",distance?:1|2)=>Promise<DouyinPreparedSource|undefined>; onPromoteAdjacent?:(prepared:DouyinPreparedSource)=>Promise<boolean>; onActions?:()=>void; onRetry?:(positionMs:number)=>void|Promise<void>; onPlaybackFailure?:(positionMs:number,error?:unknown)=>void|Promise<void>; onPanStateChange?: (offset: number, range: number) => void; ref?: (handle: VideoPlayerHandle) => void }) {
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
  const saveablePlayer=props.source.platform==='douyin'&&props.source.immersive===true;
  const [state, setState] = createSignal<ExtendedVideoState | null>(null), [error, setError] = createSignal("");
  createEffect(()=>{
    const source=props.source.platform==='bili'?'bilibili':props.source.platform==='douyin'?'douyin':undefined;
    props.onPlaybackActiveChanged?.(source,!!source&&props.active&&state()?.state==='playing'&&!state()?.isBuffering&&!error());
  });
  const [ready, setReady] = createSignal(false), [controlsVisible, setControlsVisible] = restoredSignal('saved','player-controls',true,booleanState,saveablePlayer);
  const [mode, setMode] = restoredSignal<PlayerScaleMode>('saved','player-scale',"standard",(v):v is PlayerScaleMode=>v==='standard'||v==='expanded'||v==='shrunk',saveablePlayer), [rotation, setRotation] = createSignal(0);
  const [displayRotation, setDisplayRotation] = createSignal(0), [pan, setPan] = createSignal(0), [volumeVisible, setVolumeVisible] = createSignal(false), [loadingRotation, setLoadingRotation] = createSignal(0);
  const [internet, setInternet] = createSignal<InternetStatus>("checking");
  const [allowBluetooth, setAllowBluetooth] = restoredSignal('saved','player-bluetooth',false,booleanState,saveablePlayer);
  const [networkFailure, setNetworkFailure] = createSignal(false);
  const [sessionsDisabled,setSessionsDisabled]=createSignal(false),[dragProgress,setDragProgress]=createSignal(0),[dragPoster,setDragPoster]=createSignal<{url:string;direction:DouyinPagerDirection}|null>(null),[dragAxis,setDragAxis]=createSignal<DouyinPagerDirection|undefined>(),[handoff,setHandoff]=createSignal(false),[firstFrame,setFirstFrame]=createSignal(false),[nativeDrag,setNativeDrag]=createSignal(false),[spinnerDue,setSpinnerDue]=createSignal(false);
  let benchmarkSeq=0,benchmarkGeneration=1,lastBenchmarkHeartbeat=0;
  let pendingBenchmark:VideoBenchmarkAction|undefined,pendingBenchmarkSource:PlaybackSource|undefined;
  const frameWait=new VideoFirstFrameWait();frameWait.reset();
  const [startLimitConsumed,setStartLimitConsumed]=restoredSignal('saved','player-start-limit-consumed',false,booleanState,saveablePlayer);
  const sessionCapable=shouldUseDouyinVideoSessions(props.source,hasCapability("media.video.sessions"));
  const sessionPool=sessionCapable?(props.initialPool??new DouyinVideoSessionPool()):undefined;
  const usingSessions=()=>!!sessionPool&&!sessionsDisabled();
  const sessionSource=(source:PlaybackSource):DouyinPreparedSource=>({key:source.awemeId??source.url??source.videoUrl??"current",source});
  createEffect(()=>{props.onBluetoothAllowed?.(allowBluetooth());});
  const networkPrompt = () => props.source.platform === "douyin" ? douyinPlayerNetwork(internet(), state()?.state === "playing" && !error(), allowBluetooth(), douyinSourceNeedsInternet(props.source.url ?? props.source.videoUrl), networkFailure(), props.source.immersive ? {cacheBacked:/^podjs-media-cache:\/\//i.test(props.source.url??props.source.videoUrl??''),hasRenderedFirstFrame:state()?.hasRenderedFirstFrame,buffering:state()?.state === "buffering" || state()?.isBuffering === true,hasError:!!error()} : undefined) : null;
  onMount(() => { if (props.source.platform === "douyin") onCleanup(observeHostInternet(setInternet)); });
  const sessionOwner=Symbol("video-screen");
  createEffect(()=>{if(props.active&&props.source.platform==='douyin'&&props.source.immersive&&douyinDebug.allowed)
    onCleanup(douyinDebug.bindSessions(async()=>usingSessions()&&videoSessionOwner===sessionOwner?sessionPool!.diagnostics():undefined));});
  const [badFrame,setBadFrame]=createSignal<string>();
  const previewPath=()=>{const path=framePreviewPath(props.source.previewFrame,props.source.awemeId);return path!==badFrame()?path:undefined;};
  const recoveryDeadline=new PlaybackPrepareDeadline();
  let preparedSource:PlaybackSource|undefined;
  let firstFrameSource:PlaybackSource|undefined;
  createEffect(()=>{if(firstFrame()&&state()?.hasRenderedFirstFrame&&preparedSource===props.source){
    recoveryDeadline.cancel();recoveredSources.add(props.source);
    if(firstFrameSource!==props.source){firstFrameSource=props.source;props.onFirstFrame?.();}
    if(pendingBenchmark&&props.source!==pendingBenchmarkSource){benchmark.confirmVideoFrame(pendingBenchmark.seq,pendingBenchmark.generation);pendingBenchmark=undefined;}
  }});
  onCleanup(onVideoFirstFrame(value=>{
    if(disposed||videoSessionOwner!==sessionOwner||!props.active||handoff())return;
    if(usingSessions()?!value.sessionId||!sessionPool!.ownsActiveSession(value.sessionId):!!value.sessionId)return;
    if(state()?.sourceGeneration!==undefined&&state()!.sourceGeneration!==value.sourceGeneration)return;
    if(!value.hasRenderedFirstFrame)return;
    batch(()=>{setFirstFrame(true);setState(previous=>({...previous,...value}));setSpinnerDue(false);});
  }));
  let playbackTrace:VideoPlaybackTrace|undefined;
  createEffect(()=>{const value=state();if(value)playbackTrace?.sample(value,props.active&&(!usingSessions()||(value as {presented?:boolean}).presented===true));});
  let sessionCapacity:"unchecked"|"checking"|"available"|"unavailable"=sessionCapable?"unchecked":"unavailable";
  let autoplayAllowed=false;
  let prepareStarted=0;
  let disposed = false, generation = 0, lastPlaybackState = "", checkpointPosition = 0, checkpointDuration = 0, pollTimer: HostOperation<void> | undefined, tapTimer: HostOperation<void> | undefined, volumeTimer: HostOperation<void> | undefined, prepareOp: HostOperation<VideoState> | undefined;
  let surface: NodeMirror | undefined, rotationFrom = 0, rotationTo = 0, rotationStarted = 0, panningStart = 0, panVelocity = 0, panFrameAt = Date.now();
  let transformRunning = false, transformDirty = false, seekRunning = false, desiredSeek = 0, volumeRunning = false, volumeDirty = false, virtualVolume: number | undefined, observedVolume: number | undefined, crownGuard: CrownVolumeGuardState = { lastEventMs: Number.NEGATIVE_INFINITY };
  const top = () => props.top ?? 0, screenHeight = () => props.height + top();
  // The clip stays the screen circle, expressed in the shifted surface's local coordinates.
  // Without prewarmed sessions the one surface follows the drag like a native pager page, then hides until the next item's first frame.
  const dragOffsetY = () => { if (usingSessions()&&nativeDrag()) return 0; const axis = dragAxis(); return axis === "up" ? -dragProgress() * props.height : axis === "down" ? dragProgress() * props.height : 0; };
  const bounds = () => ({ x: 0, y: top(), width: props.width, height: props.height, translateX: props.offset, translateY: dragOffsetY(), visible: props.active && !handoff(), roundClip: props.round ? { cx: props.width / 2, cy: screenHeight() / 2 - top(), radius: Math.min(props.width, screenHeight()) / 2 } : undefined });
  const media={
    prepare:(options:VideoPrepare)=>usingSessions()?sessionPool!.prepare(sessionSource(props.source),options):video.prepare(options),
    retire:(handoff=false)=>usingSessions()?sessionPool!.retire(handoff):video.retire(handoff),
    play:()=>usingSessions()?sessionPool!.play():video.play(),pause:(action?:VideoBenchmarkAction,handoff=false)=>usingSessions()?sessionPool!.pause(action,handoff):video.pause(handoff),
    seek:(positionMs:number)=>usingSessions()?sessionPool!.seek(positionMs):video.seek(positionMs),
    stop:()=>usingSessions()?sessionPool!.stop():video.stop(),state:()=>usingSessions()?sessionPool!.state():video.state(),
    setBounds:(value:VideoBounds)=>usingSessions()?sessionPool!.setBounds(value):video.setBounds(value),
    setTransform:(value:{rotationDeg?:number;scaleMode?:"standard"|"expanded"|"shrunk";panX?:number;panY?:number})=>usingSessions()?sessionPool!.setTransform(value):video.setTransform(value),
    setVolume:(value:number)=>usingSessions()?sessionPool!.setVolume(value):video.setVolume(value),
    setMuted:(muted:boolean)=>usingSessions()?sessionPool!.setMuted(muted):video.setMuted(muted),
    setLoop:(value:boolean)=>usingSessions()?sessionPool!.setLoop(value):video.setLoop(value),
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
  const toggleSystemMute=async()=>{
    const own=generation;
    try{const current=await media.state();if(disposed||own!==generation||videoSessionOwner!==sessionOwner||!props.active)return;const next=await media.setMuted(current.muted!==true);if(disposed||own!==generation||videoSessionOwner!==sessionOwner)return;setState(next);virtualVolume=next.volume;observedVolume=next.volume;showVolumeOverlay();}
    catch(error){failed(error,false,'volume');}
  };
  const captureFrame=()=>{
    const source=preparedSource,current=state();
    if(source?.platform!=='douyin'||!source.awemeId||videoSessionOwner!==sessionOwner||!(current?.hasRenderedFirstFrame||firstFrame())||current?.sourceGeneration===undefined)return;
    const options={key:`douyin:${source.awemeId}`,source:frameSource(source),sourceGeneration:current.sourceGeneration};
    try{void (usingSessions()?sessionPool!.captureFrame(options):video.captureFrame(options)).catch(()=>{});}catch{}
  };
  createEffect(()=>{const loop=loopMode()==="single";if(ready()&&videoSessionOwner===sessionOwner)void media.setLoop(loop).catch(value=>{if(usingSessions())void degradeSessions(value);else failed(value);});});
  const failed = (value: unknown,terminal=false,stage:FailureStage='unknown') => {
    if(disposed||!props.active||lifecycle()!=='active'||videoSessionOwner!==sessionOwner)return;
    const detail=playerFailureFields(value,stage),fault=playerFailureCode(value);
    if(fault==='cancelled'||fault==='stale')return;
    if(!terminal&&props.source.platform==='douyin'&&props.source.immersive&&props.onPlaybackFailure&&['network','expired'].includes(playbackFailure(value))){benchmark.begin('error_page',{reason:'candidate_retry',...detail});return;}
    benchmark.begin('error_page',{reason:'exhausted',...detail}); if(benchmarkSeq)benchmark.mark("error",benchmarkSeq,{generation:pendingBenchmark?.generation??benchmarkGeneration,...detail}); appLogger.e('VideoPlayer','Playback failed'); setHandoff(false); if (!disposed) { const message = formatPlayerFailure(fault); setNetworkFailure(douyinNetworkFailure(value)); setError(message); emitCheckpoint("error", checkpointPosition, checkpointDuration); props.onError?.(message); } };
  const recoverPlaybackFailure = (value: unknown) => {
    if(disposed||!props.active||lifecycle()!=='active'||videoSessionOwner!==sessionOwner)return;
    const failure=playbackFailure(value);
    // A rejected watch CDN source still gets its one Web resolution. API login
    // and risk responses are handled by the resolver, never by this player.
    const watchFallback=props.source.platform==='bili'&&props.source.biliApiSource==='watch';
    const immersiveDouyin=props.source.platform==='douyin'&&props.source.immersive;
    if(immersiveDouyin&&playbackFailure(value)==='other')return;
    if(props.source.platform==='douyin'&&props.source.videoMime==='video/hevc'&&failure==='decode')douyinCodecRuntimePolicy.recordAutoHevcFailure();
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
  const range = () => playerPanRange(mode(), props.width, props.height, state()?.width ?? 0, state()?.height ?? 0, rotation());
  const requestTransform = async () => { if(videoSessionOwner!==sessionOwner)return; if (transformRunning) { transformDirty = true; return; } transformRunning = true; const requestGeneration=generation; try { do { transformDirty = false; const ownGeneration = generation, r = range(), value = Math.max(-r.range, Math.min(r.range, pan())); if (value !== pan()) setPan(value); await media.setTransform({ rotationDeg: displayRotation(), scaleMode: mode(), ...(r.axis === "x" ? { panX: value } : { panY: value }) }); if (ownGeneration === generation) props.onPanStateChange?.(value, r.range); else transformDirty = true; } while (transformDirty && !disposed); } catch (value) { if(!disposed&&props.active&&requestGeneration===generation&&videoSessionOwner===sessionOwner){if(usingSessions())void degradeSessions(value,'transform');else failed(value,false,'transform');} } finally { transformRunning = false; } };
  // Video volume is owned by STREAM_MUSIC. Old saved start limits/private
  // zero-gain values must never re-mute a system-unmuted installation.
  const enforceStartVolume = async (next: ExtendedVideoState, _limit: number | null | undefined) => next;

  // Native calls run in order, so the surface stays transparent from prepare until its first frame; only the JS poster needs telling.
  const watchFirstFrame = async (ownGeneration: number) => { if (!props.source.immersive || props.source.platform !== "douyin") return; while (!disposed && ownGeneration === generation && videoSessionOwner === sessionOwner && !firstFrame() && !ready()) { try { const next = await media.state(); if (disposed || ownGeneration !== generation || videoSessionOwner !== sessionOwner || next.state === "error") return; setState(next); if (next.hasRenderedFirstFrame) { appLogger.i('DouyinTiming',`firstFrameObserved prepareMs=${Date.now()-prepareStarted}`);setFirstFrame(true); if (dragSettling) setDragPoster(null); return; } await delay(32).result; } catch { return; } } };
  const poll = async (ownGeneration: number) => { if (disposed || ownGeneration !== generation || videoSessionOwner!==sessionOwner) return; if(!props.active||videoSessionOwner!==sessionOwner){pollTimer=delay(400);void pollTimer.result.then(()=>void poll(ownGeneration)).catch(()=>{});return;} try { const next = await media.state(); if (ownGeneration !== generation || videoSessionOwner!==sessionOwner) return; if (next.state === "error") { if (lastPlaybackState !== "error") { failed({code:next.errorCode}); recoverPlaybackFailure({code:next.errorCode}); } lastPlaybackState = "error"; return; } const firstObserved=next.hasRenderedFirstFrame&&!state()?.hasRenderedFirstFrame;setState(next); if(next.hasRenderedFirstFrame){setFirstFrame(true);if(firstObserved)captureFrame();} if (!volumeRunning && next.volume !== observedVolume) { virtualVolume = next.volume; observedVolume = next.volume; } const progress=viewing.observe(next); checkpointPosition = progress.positionMs; checkpointDuration = progress.durationMs; if(progress.completed)emitCheckpoint("ended",progress.positionMs,progress.durationMs); else if(progress.reportProgress)props.onProgress?.(progress.positionMs, progress.durationMs); lastPlaybackState = next.state; if(progress.firstEnd)void advanceAfterEnd().catch(failed); } catch (value) { if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner||!props.active)return;if(usingSessions())void degradeSessions(value,'state');else{failed(value,false,'state');if(props.source.platform==="bili"){lastPlaybackState="error";recoverPlaybackFailure(value);}} } if (!disposed && ownGeneration === generation && lastPlaybackState !== "error") { pollTimer = delay(handoff()?32:400); void pollTimer.result.then(() => void poll(ownGeneration)).catch(() => {}); } };
  const prepare = (retryNetwork = false) => {
    if(disposed||!props.active||lifecycle()!=="active"||props.source.previewOnly)return;
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
    networkPaused=false;resetViewing(props.source);const previous=state(),sameSource=preparedSource===props.source;const source=sameSource&&videoSessionOwner!==sessionOwner&&previous?{...props.source,resumePositionMs:previous.positionMs}:props.source;if(!sameSource){neighborRevision++;forwardTarget=undefined;backwardTarget=undefined;backwardWarm=undefined;forwardResolved=false;forwardWarm=undefined;}preparedSource=props.source;videoSessionOwner=sessionOwner;autoplayAllowed=props.active&&(usingSessions()?lifecycle()==="active":source.backgroundPlayback===true||lifecycle()==="active");props.onError?.("");if(ready()&&previous)emitCheckpoint("pause_or_exit",previous.positionMs,previous.durationMs);const ownGeneration=++generation;prepareStarted=Date.now();recoveryDeadline.cancel();playbackTrace?.event('exit');playbackTrace=takeVideoResolution(source.url??source.videoUrl??'',source.platform??'rss');playbackTrace.event('prepare');failedMove=undefined;prepareOp?.cancel();pollTimer?.cancel();if(!saveablePlayer)setMode("standard");setRotation(0);setDisplayRotation(0);setPan(0);rotationStarted=0;panVelocity=0;crownGuard={lastEventMs:Number.NEGATIVE_INFINITY};virtualVolume=undefined;observedVolume=undefined;setError("");setReady(false);setFirstFrame(false);if(!handoff())frameWait.reset();setSpinnerDue(frameWait.visible());setState(null);lastPlaybackState="";checkpointPosition=source.resumePositionMs??0;checkpointDuration=0;if(source.platform==='douyin'&&source.videoMime==='video/hevc')douyinCodecRuntimePolicy.recordAutoHevcAttempt();const op=media.prepare({...source,...(pendingBenchmark?{benchmark:pendingBenchmark}:{}),loop:loopMode()==="single",bounds:{...bounds(),visible:props.active,translateY:0},autoplay:false} as VideoPrepare);prepareOp=op;
    if(Number.isFinite(source.recoveryDeadlineMs)&&!recoveredSources.has(props.source))recoveryDeadline.arm(source.recoveryDeadlineMs!-Date.now(),delay,
      ()=>!disposed&&ownGeneration===generation&&videoSessionOwner===sessionOwner&&!firstFrame(),
      ()=>{generation++;prepareOp?.cancel();pollTimer?.cancel();autoAdvance.cancel();void (usingSessions()?sessionPool!.releaseAll():media.stop()).catch(()=>{});failed({code:'timeout'});});
    if(handoff())setHandoff(false);void watchFirstFrame(ownGeneration);void op.result.then(async next=>{if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;let prepared:ExtendedVideoState=next;if((source.resumePositionMs??0)>0){prepared=await media.seek(source.resumePositionMs!) as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;}if(!saveablePlayer||!startLimitConsumed()){prepared=await enforceStartVolume(prepared,source.startVolumeLimit);if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(saveablePlayer)setStartLimitConsumed(true);}if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(autoplayAllowed&&!networkPrompt())prepared=await media.play() as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;appLogger.i('VideoPlayer',`ready durationMs=${prepared.durationMs}`);setReady(true);if(prepared.hasRenderedFirstFrame){setFirstFrame(true);}setState(prepared);captureFrame();virtualVolume=prepared.volume;observedVolume=prepared.volume;checkpointPosition=prepared.positionMs;checkpointDuration=prepared.durationMs;emitCheckpoint("ready",prepared.positionMs,prepared.durationMs);await requestTransform();if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;void warmForward();void poll(ownGeneration);}).catch(value=>{if(!disposed&&props.active&&ownGeneration===generation&&videoSessionOwner===sessionOwner){if(usingSessions()&&!douyinNetworkFailure(value))void degradeSessions(value,'prepare');else{failed(value,false,'prepare');recoverPlaybackFailure(value);}}});
  };
  let retrying = false, failedMove:(()=>void|Promise<void>)|undefined;
  const retry = async () => {
    if (retrying) return;
    if(failedMove){
      retrying=true;const move=failedMove,from=props.source;setError("");
      try{await move();failedMove=undefined;if(!disposed&&props.source===from)prepare(true);}
      catch(value){if(!disposed)failed(value);}finally{retrying=false;}
      return;
    }
    // Native onRetry recreates this source; do not resolve/discard a queue item on network retry.
    const retryNetwork = !!networkPrompt();
    setNetworkFailure(false);
    if (!props.source.previewOnly&&(retryNetwork || !props.onRetry || props.source.platform === "douyin" && !props.source.immersive && !props.source.detailPlayback)) { prepare(true); return; }
    appLogger.w('VideoPlayer','Retry playback');
    retrying = true;
    try { await props.onRetry?.(checkpointPosition); } catch (value) { if (!disposed) failed(value); } finally { retrying = false; }
  };
  let resumeAfterLifecycle=false;
  const removeLifecycle=onLifecycleChange(next=>{
    if(next==="active"){
      if(!props.active||videoSessionOwner!==sessionOwner)return;
      if(ready()){const own=generation;void media.state().then(value=>{if(!disposed&&own===generation&&props.active&&videoSessionOwner===sessionOwner)setState(value);}).catch(()=>{});}
      if(usingSessions()&&!ready())untrack(prepare);
      else if(resumeAfterLifecycle&&ready()){
        resumeAfterLifecycle=false;autoplayAllowed=true;const own=generation;
        void media.play().then(value=>{if(disposed||own!==generation||videoSessionOwner!==sessionOwner)return;setState(value);void poll(own);}).catch(value=>{if(!disposed&&own===generation&&lifecycle()==='active')failed(value,false,'play');});
      }
      return;
    }
    if((!usingSessions()&&props.source.backgroundPlayback)||videoSessionOwner!==sessionOwner)return;
    captureFrame();resumeAfterLifecycle=autoplayAllowed&&(!ready()||state()?.state==='playing');autoplayAllowed=false;autoAdvance.cancel();
    // A lifecycle release invalidates control replies just like route exit.
    generation++;prepareOp?.cancel();pollTimer?.cancel();recoveryDeadline.cancel();
    if(usingSessions()){
      const value=state();if(value)emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);
      preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});
    }else if(ready())void media.pause().then(value=>{if(disposed)return;setState(value);checkpointPosition=value.positionMs;checkpointDuration=value.durationMs;emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);}).catch(failed);
  });
  createEffect(() => { const source=props.source;if(props.active&&!networkPrompt()&&source!==preparedSource)untrack(prepare); });
  // Immersive native stopForegroundPlayback pauses buffering; it preserves the selected item.
  let networkPaused = false;
  createEffect(() => {
    const blocked = !!networkPrompt(), status = internet();
    if (!props.source.immersive || !props.active || videoSessionOwner !== sessionOwner) return;
    if (blocked && untrack(ready) && !untrack(error) && !networkPaused) {
      networkPaused = true; autoplayAllowed = false;
      const ownGeneration = generation;
      void media.pause().then(value => { if (!disposed && ownGeneration === generation) setState(value); }).catch(failed);
    } else if (networkPaused && !blocked && (status === "available" || status === "bluetooth" && allowBluetooth()) && !untrack(error)) {
      networkPaused = false; autoplayAllowed = true;
      const ownGeneration = generation;
      void media.play().then(value => { if (!disposed && ownGeneration === generation) setState(value); }).catch(failed);
    }
  });
  let updating = false, dirty = false;
  const syncBounds = async () => { if (updating) { dirty = true; return; } updating = true; const requestGeneration=generation; try { do { dirty = false; await media.setBounds(bounds()); } while (dirty && !disposed); } catch (value) { if(!disposed&&props.active&&requestGeneration===generation&&videoSessionOwner===sessionOwner){if(usingSessions())void degradeSessions(value,'bounds');else failed(value,false,'bounds');} } finally { updating = false; } };
  createEffect(() => { props.offset; props.active; dragOffsetY(); handoff(); if (props.offset !== 0 || !props.active) panVelocity = 0; if (ready()&&videoSessionOwner===sessionOwner) void syncBounds(); });
  const toggle = async () => { try { const pausing = state()?.state === "playing", next = await (pausing ? media.pause() : media.play()); setState(next); checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; if (pausing) emitCheckpoint("pause_or_exit", next.positionMs, next.durationMs); } catch (value) { failed(value); } };
  const seekTo = async (delta: number) => { const current = state(); if (!current) return; if (!seekRunning) desiredSeek = current.positionMs; desiredSeek = Math.max(0, Math.min(current.durationMs || Number.MAX_SAFE_INTEGER, desiredSeek + delta)); if (seekRunning) return; seekRunning = true; try { do { const target = desiredSeek, next = await media.seek(target); setState(next); checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; if (target === desiredSeek) break; } while (!disposed); } catch (value) { failed(value); } finally { seekRunning = false; } };
  const rotate = () => { rotationFrom = displayRotation(); rotationTo = rotation() + 90; setRotation(rotationTo); rotationStarted = Date.now(); };
  const changeMode = () => { panVelocity = 0; setMode(nextScaleMode(mode())); setPan(0); void requestTransform(); };
  const backgroundTap = () => { if (tapTimer) { tapTimer.cancel(); tapTimer = undefined; void toggle(); return; } tapTimer = delay(280); void tapTimer.result.then(() => { tapTimer = undefined; setControlsVisible(value => !value); }).catch(() => {}); };
  let backwardTarget:DouyinPreparedSource|undefined,backwardWarm:Promise<DouyinPreparedSource|undefined>|undefined;
  let degradingSessions=false,neighborRevision=0,forwardResolved=false,forwardWarm:Promise<DouyinPreparedSource|undefined>|undefined,forwardTarget:DouyinPreparedSource|undefined;
  const cancelledSessionError=(value:unknown)=>/cancel|stale|abort/i.test(String((value as {code?:unknown}|null)?.code??'')+' '+String(value));
  const degradeSessions=async(value:unknown,stage:FailureStage='unknown')=>{
    if(disposed||!props.active||videoSessionOwner!==sessionOwner)return;
    if(!shouldFallbackFromVideoSessions(value)){if(!cancelledSessionError(value)){failed(value,false,stage);recoverPlaybackFailure(value);}return;}
    if(!usingSessions()||degradingSessions||disposed)return;
    degradingSessions=true;appLogger.w("VideoPlayer","videoSessions failed; falling back to legacy video");
    generation++;prepareOp?.cancel();pollTimer?.cancel();neighborRevision++;
    try{await sessionPool!.releaseAll();}catch(releaseError){appLogger.w("VideoPlayer","videoSessions cleanup failed");}
    if(disposed){degradingSessions=false;return;}
    batch(()=>{sessionCapacity="unavailable";setSessionsDisabled(true);preparedSource=undefined;forwardTarget=undefined;setReady(false);setState(null);degradingSessions=false;});
    if(props.active&&!networkPrompt()&&preparedSource!==props.source)untrack(prepare);
  };
  const previewAdjacent=async(direction:"next"|"previous",revision:number,revealPoster=false):Promise<DouyinPreparedSource|undefined>=>{
    if(!props.onPrepareAdjacent)return;
    const target=await props.onPrepareAdjacent(direction);
    if(!target||revision!==neighborRevision||disposed)return;
    if(revealPoster&&!props.source.immersive&&target.source.posterUrl)setDragPoster({url:target.source.posterUrl,direction:direction==="next"?"up":"down"});
    return target;
  };
  const prepareAdjacent=async(direction:"next"|"previous",revision:number,revealPoster=false):Promise<DouyinPreparedSource|undefined>=>{
    if(!usingSessions()||!props.onPrepareAdjacent)return;
    const target=await previewAdjacent(direction,revision,revealPoster);
    if(!target||!usingSessions())return;
    try{
      await sessionPool!.prewarm(target,{...target.source,bounds:bounds(),loop:loopMode()==="single",autoplay:false,muted:true} as VideoPrepare,direction==="next"?"next":"prev");
      return revision===neighborRevision&&usingSessions()&&sessionPool!.hasStandby(target.key)?target:undefined;
    }catch(value){if(revision===neighborRevision&&!cancelledSessionError(value)&&shouldFallbackFromVideoSessions(value)){if(await sessionPool!.supportsPrewarm())return;await degradeSessions(value);return revision===neighborRevision&&!disposed?target:undefined;}return;}
  };
  const warmBackward=()=>{
    if(!usingSessions()||sessionPool!.neighbourCapacity<2||!props.onPrevious||backwardWarm)return;
    const revision=neighborRevision;
    const pending=prepareAdjacent('previous',revision).then(target=>{if(revision===neighborRevision)backwardTarget=target;return target;}).finally(()=>{if(backwardWarm===pending)backwardWarm=undefined;});
    backwardWarm=pending;void pending.catch(()=>{});
  };
  const warmForward=():Promise<DouyinPreparedSource|undefined>=>{
    warmBackward();
    if(!props.onPrepareAdjacent)return Promise.resolve(undefined);
    if(forwardTarget&&(!usingSessions()||sessionPool!.hasStandby(forwardTarget.key)))return Promise.resolve(forwardTarget);
    if(forwardResolved&&!forwardTarget)return Promise.resolve(undefined);
    if(forwardWarm)return forwardWarm;
    const revision=neighborRevision;
    const pending=(usingSessions()?prepareAdjacent("next",revision):previewAdjacent("next",revision)).then(target=>{if(revision!==neighborRevision)return;forwardResolved=true;if(target)forwardTarget=target;return target;}).finally(()=>{if(forwardWarm===pending)forwardWarm=undefined;});
    forwardWarm=pending;return pending;
  };
  let dragRevision=0,dragDirection:DouyinPagerDirection|undefined,dragTarget:DouyinPreparedSource|undefined,dragTargetPromise:Promise<DouyinPreparedSource|undefined>|undefined,dragSettling=false;
  type DeferredDrag={distanceY:number;velocityY:number;cancel:boolean;seq:number;action?:VideoBenchmarkAction};
  let deferredPan:DeferredDrag|undefined,drainingDeferred=false,replayingDeferred=false;
  const deferredDrags:DeferredDrag[]=[];
  const clearDrag=()=>{setNativeDrag(false);dragDirection=undefined;setDragAxis(undefined);dragTarget=undefined;dragTargetPromise=undefined;dragSettling=false;setDragPoster(null);setDragProgress(0);};
  const ensureDragTarget=(direction:DouyinPagerDirection,revision:number)=>{
    const queueDirection:"next"|"previous"=direction==="up"?"next":"previous";
    const poster=props.onAdjacentPoster?.(queueDirection);if(poster&&!props.source.immersive)setDragPoster({url:poster,direction});
    if(!usingSessions()){
      if(direction==='up'&&forwardTarget){dragTarget=forwardTarget;return Promise.resolve(forwardTarget);}
      return Promise.resolve(undefined);
    }
    const candidate=direction==="up"?forwardTarget:backwardTarget;
    const existing=candidate&&sessionPool?.hasStandby(candidate.key)?candidate:undefined;
    if(existing){sessionPool!.selectStandby(existing.key);dragTarget=existing;setNativeDrag(true);setDragPoster(null);return Promise.resolve(existing);}
    const ownNeighbor=neighborRevision;
    const pending=usingSessions()?prepareAdjacent(queueDirection,ownNeighbor,true):previewAdjacent(queueDirection,ownNeighbor,true);
    return pending.then(target=>{
      if(revision!==dragRevision||direction!==dragDirection)return;
      dragTarget=target;if(target&&usingSessions()){sessionPool!.selectStandby(target.key);setNativeDrag(true);setDragPoster(null);void sessionPool!.transition(dragProgress(),direction,bounds()).catch(value=>{if(!cancelledSessionError(value))void degradeSessions(value);});}return target;
    });
  };
  const beginDouyinDrag=(distanceY=0,measured=false)=>{
    if(props.source.platform!=="douyin")return;
    if(!replayingDeferred&&(dragSettling||deferredDrags.length||drainingDeferred)){
      deferredPan={distanceY,velocityY:0,cancel:false,seq:measured?benchmark.begin("gesture_down",{direction:distanceY<0?"next":"prev"}):0};return;
    }
    benchmarkSeq=measured?benchmark.begin("gesture_down",{direction:distanceY<0?"next":"prev"}):0;
    dragRevision++;setNativeDrag(false);dragDirection=undefined;dragTarget=undefined;dragTargetPromise=undefined;setDragProgress(0);setDragPoster(null);
  };
  const moveDouyinDrag=(distanceY:number)=>{
    if(deferredPan&&!replayingDeferred){deferredPan.distanceY=distanceY;return;}
    if(props.source.platform!=="douyin"||dragSettling||distanceY===0)return;
    const direction:DouyinPagerDirection=distanceY<0?"up":"down",progress=douyinPagerProgress(distanceY,props.height),revision=dragRevision;
    setDragProgress(progress);
    if(direction!==dragDirection){setNativeDrag(false);dragDirection=direction;setDragAxis(direction);dragTarget=undefined;dragTargetPromise=ensureDragTarget(direction,revision);}
    if(usingSessions()&&dragTarget&&sessionPool!.hasStandby(dragTarget.key)){
      sessionPool!.selectStandby(dragTarget.key);setNativeDrag(true);setDragPoster(null);
      void sessionPool!.transition(progress,direction,bounds()).catch(value=>{if(revision===dragRevision&&!cancelledSessionError(value))void degradeSessions(value);});
    }
  };
  const animateDouyinTransition=async(revision:number,direction:DouyinPagerDirection,to:0|1)=>{
    const from=dragProgress(),started=Date.now(),duration=douyinPagerSettleDuration(to);
    if(from===to){if(usingSessions()&&nativeDrag()&&to===0)await sessionPool!.transition(to,direction,bounds(),pendingBenchmark);return revision===dragRevision&&!disposed;}
    while(true){
      const elapsed=Date.now()-started,next=douyinPagerSettleProgress(from,to,elapsed);setDragProgress(next);
      if(usingSessions()&&nativeDrag()&&!(to===1&&elapsed>=duration))await sessionPool!.transition(next,direction,bounds(),to===0&&elapsed>=duration?pendingBenchmark:undefined);
      if(revision!==dragRevision||disposed)return false;
      if(elapsed>=duration)break;await delay(16).result;
    }
    return true;
  };
  const finishDouyinDrag=async(velocityY:number,forceCancel=false,replayed?:DeferredDrag)=>{
    if(deferredPan&&!replayed){
      const queued=deferredPan;deferredPan=undefined;queued.velocityY=velocityY;queued.cancel=forceCancel;
      const direction=queued.distanceY<0?'up':'down',progress=douyinPagerProgress(queued.distanceY,props.height);
      const settles=!forceCancel&&!!(direction==='up'?props.onNext:props.onPrevious)&&shouldSettleDouyinPager(progress,velocityY,direction);
      const delta=settles?douyinPagerDelta(progress,velocityY,direction):0;
      if(queued.seq){queued.action={seq:queued.seq,generation:settles?++benchmarkGeneration:benchmarkGeneration,source_generation:state()?.sourceGeneration??0,delta:delta===2?2:1};benchmark.mark('gesture_release',queued.seq,{direction:settles?(delta===2?'fling':direction==='up'?'next':'prev'):'cancel',delta,prewarmed:false,generation:queued.action.generation,source_generation:queued.action.source_generation});}
      // Bound retained intent. Never let a slow publication allocate indefinitely.
      if(deferredDrags.length<16)deferredDrags.push(queued);
      else if(queued.seq)benchmark.mark('error',queued.seq,{reason:'capacity'});
      void drainDeferred();return;
    }
    if(disposed||!props.active||videoSessionOwner!==sessionOwner||props.source.platform!=="douyin"||dragSettling)return;
    const revision=dragRevision,direction=dragDirection,progress=dragProgress();if(!direction){clearDrag();return;}
    dragSettling=true;const move=direction==="up"?props.onNext:props.onPrevious;
    const wantsSettle=!forceCancel&&!!move&&shouldSettleDouyinPager(progress,velocityY,direction);
    // Stop outgoing playback at release, including a cold two-item fling.
    // Keep its decoded surface for the strip; cancellation never enters here.
    let delta:1|2=1;
    const requestedDelta=wantsSettle?douyinPagerDelta(progress,velocityY,direction):0;
    if(replayed){pendingBenchmarkSource=props.source;pendingBenchmark=replayed.action;}
    else if(benchmarkSeq){pendingBenchmarkSource=props.source;pendingBenchmark={seq:benchmarkSeq,generation:wantsSettle?++benchmarkGeneration:benchmarkGeneration,source_generation:state()?.sourceGeneration??0,delta};benchmark.mark("gesture_release",benchmarkSeq,{direction:wantsSettle?(requestedDelta===2?'fling':direction==='up'?'next':'prev'):'cancel',delta:requestedDelta,prewarmed:requestedDelta===1&&!!(usingSessions()&&dragTarget&&sessionPool!.hasStandby(dragTarget.key)),generation:pendingBenchmark.generation,source_generation:pendingBenchmark.source_generation});}

    if(wantsSettle){const stoppedGeneration=generation;void media.pause(pendingBenchmark,true).catch(value=>{if(!disposed&&revision===dragRevision&&stoppedGeneration===generation&&videoSessionOwner===sessionOwner)failed(value);});}

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
            await Promise.race([sessionPool!.prewarm(candidate,{...candidate.source,bounds:bounds(),autoplay:false,muted:true},direction==='up'?'next':'prev'),deadline.result]);
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
    if(wantsSettle&&delta===1&&requestedDelta===1&&usingSessions()&&sessionPool!.neighbourCapacity>=2&&dragTarget&&sessionPool!.hasStandby(dragTarget.key)&&props.onPrepareAdjacent){
      // The decoded outgoing item becomes the opposite neighbour. Reuse its
      // other slot now, overlapping following-item decode with the settle.
      void props.onPrepareAdjacent(direction==='up'?'next':'previous',2).then(async following=>{
        if(!following||!usingSessions()||disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;
        followingKeys.push(following.key);
        await sessionPool!.prewarm(following,{...following.source,bounds:bounds(),loop:loopMode()==='single',autoplay:false,muted:true},direction==='up'?'next':'prev');
      }).catch(()=>{});
    }
    try{
      if(!await animateDouyinTransition(revision,direction,wantsSettle?1:0))return;
      if(!wantsSettle){if(!usingSessions()&&pendingBenchmark)await media.setBounds({...bounds(),benchmark:pendingBenchmark});pendingBenchmark=undefined;clearDrag();neighborRevision++;if(usingSessions())void warmForward();return;}
      const target=dragTarget;
      if(usingSessions()&&target&&sessionPool!.hasStandby(target.key)){
        const ownGeneration=++generation;pollTimer?.cancel();
        sessionPool!.selectStandby(target.key);
        const promoted=await sessionPool!.promote(direction,bounds(),props.active&&lifecycle()==="active",pendingBenchmark,followingKeys);
        if(disposed||revision!==dragRevision||videoSessionOwner!==sessionOwner)return;
        // Install ownership BEFORE publishing the reactive source. Publication
        // must not schedule another prepare/release of the surface on screen.
        let publication:Promise<boolean>|undefined;
        batch(()=>{preparedSource=promoted.source.source;publication=props.onPromoteAdjacent?.(promoted.source);setState(promoted.state);setReady(true);setFirstFrame(promoted.state.hasRenderedFirstFrame===true);setError("");setSpinnerDue(false);clearDrag();});
        forwardTarget=undefined;backwardTarget=undefined;forwardWarm=undefined;backwardWarm=undefined;forwardResolved=false;
        playbackTrace?.event('exit');playbackTrace=takeVideoResolution(promoted.source.source.url??promoted.source.source.videoUrl??'',promoted.source.source.platform??'rss');playbackTrace.event('prepare');resetViewing(promoted.source.source);lastPlaybackState="";preparedSource=promoted.source.source;setState(promoted.state);setReady(true);setError("");checkpointPosition=promoted.state.positionMs;checkpointDuration=promoted.state.durationMs;virtualVolume=promoted.state.volume;observedVolume=promoted.state.volume;
        emitCheckpoint("ready",promoted.state.positionMs,promoted.state.durationMs);clearDrag();neighborRevision++;if(delta===2)sessionPool!.retainNeighbours([]);void requestTransform();void warmForward();void poll(ownGeneration);
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
    return !!await warmForward();
  },async current=>{
    if(!current()||disposed||!props.active||lifecycle()!=="active"||videoSessionOwner!==sessionOwner||dragSettling||dragDirection)return;
    beginDouyinDrag();moveDouyinDrag(-props.height);await finishDouyinDrag(-125);
  });
  // The capability probe can leave a pool object behind while playback uses
  // the legacy host. Release the backend that actually owns playback.
  const releaseOwnedPlayback=()=>{
    captureFrame();const owns=videoSessionOwner===sessionOwner,legacy=!usingSessions();
    if(owns)videoSessionOwner=undefined;
    if(sessionPool)void sessionPool.releaseAll().catch(()=>{});
    if(owns&&legacy)void video.stop().catch(()=>{});
  };
  let resumeAfterOverlay=false;
  createEffect(()=>{const active=props.active;if(!active){if(props.source.platform==='douyin'){
    deferredDrags.length=0;deferredPan=undefined;resumeAfterOverlay=false;autoplayAllowed=false;autoAdvance.cancel();generation++;neighborRevision++;dragRevision++;
    prepareOp?.cancel();pollTimer?.cancel();tapTimer?.cancel();volumeTimer?.cancel();
    const current=untrack(state);if(videoSessionOwner===sessionOwner&&current)emitCheckpoint("pause_or_exit",current.positionMs,current.durationMs);
    forwardTarget=undefined;clearDrag();setReady(false);setFirstFrame(false);
    untrack(releaseOwnedPlayback);return;
  }resumeAfterOverlay=autoplayAllowed&&untrack(()=>!ready()||state()?.state==="playing");autoplayAllowed=false;if(usingSessions()){const value=untrack(state);if(value)emitCheckpoint("pause_or_exit",value.positionMs,value.durationMs);preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});}else if(untrack(ready)&&videoSessionOwner===sessionOwner)void media.pause().catch(()=>{});}else if(videoSessionOwner!==sessionOwner||usingSessions()&&!untrack(ready)){untrack(prepare);}else if(resumeAfterOverlay){resumeAfterOverlay=false;autoplayAllowed=lifecycle()==="active"||props.source.backgroundPlayback===true;if(autoplayAllowed&&untrack(ready))void media.play().then(setState).catch(failed);}});
  const surfaceGesture = createGesture({ region: { node: () => surface, rect: () => props.active && props.offset === 0 ? { x: 0, y: top(), w: props.width, h: props.height } : null }, axis: "y", panSlop: 8,
    onTap: contact => { const hit = hitNode(contact.x, contact.y, contact.surface); let pressable = hit; while (pressable && !pressable.onPress) pressable = pressable.parent; if (hit && pressable) pressNode(hit); else backgroundTap(); },
    onLongPress:()=>{if(props.active && !networkPrompt())props.onActions?.();},
    onDown: () => { panVelocity = 0; }, onPanStart: contact => { panningStart = pan();if(props.source.platform==="douyin")beginDouyinDrag(contact.dy,true); }, onPanMove: contact => { if(props.source.platform==="douyin"){moveDouyinDrag(contact.dy);return;}const r = range(); if(r.axis !== "y" || r.range <= 0) return; setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dy))); void requestTransform(); },
    onPanEnd: contact => { if (networkPrompt()) return;if(props.source.platform==="douyin"){void finishDouyinDrag(contact.vy);return;} if(range().axis === "y") { panVelocity = contact.vy; panFrameAt = Date.now(); } props.onPanStateChange?.(pan(), range().range); },
    onCancel:()=>{if(props.source.platform==="douyin")void finishDouyinDrag(0,true);}
  });
  const horizontalPanGesture = createGesture({ region: { rect: () => { const r = range(); return props.active && props.source.platform !== "douyin" && r.axis === "x" && r.range > 0 && pan() < r.range - 1 ? { x: 0, y: top(), w: props.width, h: props.height } : null; } }, axis: "x", panSlop: 8,
    onDown: () => { panVelocity = 0; }, onPanStart: () => { panningStart = pan(); }, onPanMove: contact => { const r = range(); setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dx))); void requestTransform(); }, onPanEnd: contact => { panVelocity = contact.vx; panFrameAt = Date.now(); props.onPanStateChange?.(pan(), range().range); }
  });
  onFrame(() => { const now = Date.now(); if(props.source.platform==='douyin'&&props.source.immersive&&props.active&&now-lastBenchmarkHeartbeat>=1000){lastBenchmarkHeartbeat=now;benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:props.active&&props.offset===0&&lifecycle()==='active'&&!error()&&!networkPrompt()?'present':'absent',visibility_reason:!props.active?'inactive':props.offset!==0?'route_offset':lifecycle()!=='active'?'lifecycle':error()?'player_error':networkPrompt()?'network_prompt':'ready',player_state:closedPlayerState(state()?.state),has_frame:state()?.hasRenderedFirstFrame===true,offset_abs_milli:Math.min(1000000000,Math.round(Math.abs(props.offset)*1000))});} frameWait.observe(firstFrame()&&!handoff());setSpinnerDue(frameWait.visible()&&state()?.bufferedMs===0&&state()?.networkStalled===true); if (panVelocity !== 0) { const elapsed = Math.min(50, Math.max(0, now - panFrameAt)), r = range(), next = Math.max(-r.range, Math.min(r.range, pan() + panVelocity * elapsed / 1000)); setPan(next); panVelocity *= Math.exp(-5 * elapsed / 1000); if (Math.abs(panVelocity) < 5 || next === -r.range || next === r.range) panVelocity = 0; panFrameAt = now; void requestTransform(); } if (!state() || buffering()) setLoadingRotation(value => (value + 6) % 360); if (!rotationStarted) return; const elapsed = now - rotationStarted, t = Math.min(1, elapsed / 300), eased = 1 - Math.pow(1 - t, 3); setDisplayRotation(rotationFrom + (rotationTo - rotationFrom) * eased); void requestTransform(); if (t >= 1) rotationStarted = 0; });
  const showVolumeOverlay = () => {
    setVolumeVisible(true);volumeTimer?.cancel();volumeTimer=delay(900);
    void volumeTimer.result.then(()=>setVolumeVisible(false)).catch(()=>{});
  };
  const submitVolume = async () => { if (volumeRunning) { volumeDirty = true; return; } volumeRunning = true; try { do { volumeDirty = false; const target = virtualVolume ?? .5, next = await media.setVolume(target); observedVolume = next.volume; if (target === virtualVolume) setState(next); else volumeDirty = true; } while (volumeDirty && !disposed); } catch (value) { failed(value); } finally { volumeRunning = false; } };
  const adjustVolume = (delta: number) => { const direction = normalizedRelativeAxisStep(delta); if (!props.active || !props.source.digitalCrownVolume || direction === 0) return false; const maxSteps = Math.max(1, state()?.volumeMax ?? 15), current = virtualVolume ?? state()?.volume ?? .5; const guarded = guardedCrownVolume(current, direction / maxSteps, maxSteps, props.source.volumeGuard === true, crownGuard, Date.now()); crownGuard = guarded.state; virtualVolume = guarded.volume; showVolumeOverlay(); void submitVolume(); return true; };
  props.ref?.({ invalidatePrefetch(id){neighborRevision++;forwardResolved=false;forwardTarget=undefined;sessionPool?.invalidateStandby(id);if(props.active&&ready())void warmForward();},previewKind:()=>previewPath()?'actual_frame':!props.source.immersive&&props.source.posterUrl?'cover':undefined,loopMode,availableLoopModes:loopModes,setLoopMode,cycleLoopMode,onCrown: adjustVolume, canSwipeBack: () => { const r = range(); return r.axis !== "x" || r.range <= 0 || pan() >= r.range - 1; } });
  onCleanup(() => { recoveryDeadline.cancel();removeLifecycle();autoAdvance.cancel();playbackTrace?.event('exit');disposed = true; deferredDrags.length=0;deferredPan=undefined; generation++;neighborRevision++;dragRevision++;autoplayAllowed=false; const current = state(); if (ready() && current) emitCheckpoint("pause_or_exit", current.positionMs, current.durationMs); surfaceGesture.dispose(); horizontalPanGesture.dispose(); prepareOp?.cancel(); pollTimer?.cancel(); tapTimer?.cancel(); volumeTimer?.cancel(); releaseOwnedPlayback(); });
  const uiScale = () => Math.min(props.width / 233, props.height / 233), uiLeft = () => (props.width - 233) / 2, uiTop = () => (props.height - 233) / 2;
  const startWidth = () => Math.max(16, Math.ceil(getOps().measureText(formatPlayerTime(state()?.positionMs ?? 0), 19)));
  const endWidth = () => Math.max(16, Math.ceil(getOps().measureText(formatPlayerTime(state()?.durationMs ?? 0), 19)));
  const barWidth = () => Math.max(20, 181 - startWidth() - endWidth() - 11);
  const buffering = () => state()?.state === "buffering" || state()?.buffered === false || state()?.isBuffering === true;
  const prepared = () => ready() && !!state()?.durationMs;
  const dragPosterOffset=()=>{const poster=dragPoster();if(!poster)return 0;const remaining=(1-dragProgress())*props.height;return poster.direction==="up"?remaining:-remaining;};
  let benchmarkSpinner=false,spinnerBenchmark:VideoBenchmarkAction|undefined;
  createEffect(()=>{
    const visible=props.source.platform==='douyin'&&props.source.immersive&&spinnerDue()&&state()?.bufferedMs===0&&state()?.networkStalled===true&&(!firstFrame()||handoff())&&(!dragAxis()||handoff())&&!error()&&!networkPrompt();
    if(visible&&!benchmarkSpinner&&pendingBenchmark){spinnerBenchmark=pendingBenchmark;benchmark.presented('spinner_shown',spinnerBenchmark.seq,{generation:spinnerBenchmark.generation,buffered_ms:state()?.bufferedMs??0,network_stalled:state()?.networkStalled===true,reason:'network_stalled'});}
    if(!visible&&benchmarkSpinner&&spinnerBenchmark){benchmark.cancelPresented('spinner_shown',spinnerBenchmark.seq);spinnerBenchmark=undefined;}
    benchmarkSpinner=!!visible;
  });
  createEffect(()=>{if(props.source.platform==='douyin'&&props.source.immersive&&!props.active)benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:'absent'});});
  onCleanup(()=>{if(props.source.platform==='douyin'&&props.source.immersive)benchmark.begin('player_visible',{...(state()?.volumeIndex!==undefined?{system_index:state()!.volumeIndex,system_max:state()!.volumeMax,system_muted:state()!.muted===true}:{}),...(state()?.appliedVolume!==undefined?{audio_gain_milli:Math.round(state()!.appliedVolume!*1000)}:{}),...(state()?.audioTrackSelected!==undefined?{audio_track:state()!.audioTrackSelected}:{}),state:'absent'});});
  let coverWasVisible=false,coverGeneration=0;
  createEffect(()=>{
    const visible=!!(props.source.platform==='douyin'&&props.source.immersive&&((!firstFrame()&&(previewPath()||props.source.posterUrl))||dragPoster()));
    if(visible){coverWasVisible=true;coverGeneration=generation;}
    else if(coverWasVisible){coverWasVisible=false;const checkpoint=renderCheckpoint({sampleAlpha:true});appLogger.i('DouyinTiming',`coverRemoved prepareMs=${Date.now()-prepareStarted} generation=${coverGeneration} reason=${error()?'error':firstFrame()?'first-frame':'ready'} checkpoint=${checkpoint??0}`);}
  });
  return <View ref={value => surface = value} class="absolute left-[0] right-[0]" style={{ insetT: top(), height: props.height }}><Show when={props.source.platform==="douyin"&&(props.source.immersive||previewPath())&&!handoff()&&!firstFrame()&&(previewPath()||!props.source.immersive&&props.source.posterUrl)}><RemoteImage url={props.source.posterUrl??""} filePath={previewPath()} onError={()=>{const path=previewPath();if(path)setBadFrame(path);}} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></Show><Show when={dragPoster()}>{poster=><View class="absolute inset-0" style={{translateY:dragPosterOffset()}}><RemoteImage url={poster().url} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></View>}</Show><Show when={(props.source.platform==="douyin"&&props.source.immersive?spinnerDue()&&state()?.bufferedMs===0&&state()?.networkStalled===true&&(!firstFrame()||handoff())&&(!dragAxis()||handoff()):(!state()||buffering())) && !error() && !networkPrompt()}><View class="absolute left-[96.5] top-[96.5] w-[40] h-[40] rounded-[20] bg-[#00000099] items-center justify-center"><Image src="../assets/icons/player-loading.svg" class="w-[28] h-[28]" style={{ rotate: loadingRotation() }} /></View></Show>
    <Show when={error() && !networkPrompt()}><View class="absolute left-[31] right-[31] top-[72] h-[90] rounded-[24] bg-[#000000cc] items-center"><Text class="absolute left-[8] right-[8] top-[10] text-xs leading-[14] text-[#b6b6b6] text-center">播放失败</Text><View class="absolute left-[4] top-[42] w-[72] h-[32] rounded-[16] bg-[#2a2a2a] items-center justify-center" onPress={() => void retry()} focusable><Text class="text-xs text-white">重试</Text></View><Show when={props.onOpenWeb}><View class="absolute right-[4] top-[42] w-[86] h-[32] rounded-[16] bg-[#2a2a2a] items-center justify-center" onPress={props.onOpenWeb} focusable><Text class="text-xs text-white">浏览器打开</Text></View></Show></View></Show>
    <Show when={!error() && !networkPrompt() && controlsVisible()}><View class="absolute" style={{ insetL: uiLeft(), insetT: uiTop(), width: 233, height: 233, scale: uiScale(), rotate: displayRotation(), originX: 0, originY: 0 }}>
      <View class="absolute left-[0] right-[0] top-[0] h-[62] bg-gradient-to-b from-[#000000cc] to-transparent" />
      <Show when={loopModes().length > 1} fallback={<><PlayerButton left={69.5} top={6} size={44} icon={mode() === "standard" ? "fullscreen" : mode() === "expanded" ? "panorama" : "fullscreen-exit"} iconSize={24} onPress={changeMode} /><PlayerButton left={119.5} top={6} size={44} icon="rotate" iconSize={24} onPress={rotate} /></>}>
        {/* Three across: icon corners stay inside the 233 circle at this height. */}
        <PlayerButton left={47.5} top={8} size={44} icon={mode() === "standard" ? "fullscreen" : mode() === "expanded" ? "panorama" : "fullscreen-exit"} iconSize={24} onPress={changeMode} /><PlayerButton left={94.5} top={8} size={44} icon={`loop-${loopMode()}`} iconSize={24} accessibilityLabel={LOOP_LABELS[loopMode()]} onPress={tapLoopMode} /><PlayerButton left={141.5} top={8} size={44} icon="rotate" iconSize={24} onPress={rotate} />
      </Show>
      <Show when={props.source.platform==='douyin'}><View class="absolute left-[84.5] top-[64] w-[64] h-[32] rounded-[16] bg-[#111111dd] items-center justify-center" onPress={()=>void toggleSystemMute()} accessibilityLabel={state()?.muted?'取消系统静音':'系统静音'} focusable><Text class="text-xs text-white">{state()?.muted?'取消静音':'静音'}</Text></View></Show>
      <Text style={{ width: startWidth() }} class="absolute left-[26] top-[181] text-[9px] leading-[13] text-white text-right">{formatPlayerTime(state()?.positionMs ?? 0)}</Text><View style={{ insetL: 31.5 + startWidth(), width: barWidth() }} class="absolute top-[183] h-[4] rounded-[2] bg-[#b6b6b659]"><View class="absolute left-[0] top-[0] h-[4] rounded-[2] bg-[#ff6700]" style={{ width: progressWidth(state()?.positionMs ?? 0, state()?.durationMs ?? 0, barWidth()) }} /><View class="absolute right-[0] top-[0] w-[4] h-[4] rounded-[2] bg-[#ff6700]" /></View><Text style={{ width: endWidth() }} class="absolute right-[26] top-[181] text-[9px] leading-[13] text-[#b6b6b6]">{formatPlayerTime(state()?.durationMs ?? 0)}</Text>
      <PlayerButton left={47.5} top={186} size={44} icon="rewind" iconSize={24} enabled={prepared()} onPress={() => void seekTo(-4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, -1))} /><PlayerButton left={91.5} top={183} size={50} icon={state()?.state === "playing" ? "pause" : "play"} iconSize={28} enabled={prepared()} onPress={() => void toggle()} /><PlayerButton left={141.5} top={186} size={44} icon="forward" iconSize={24} enabled={prepared()} onPress={() => void seekTo(4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, 1))} />
    </View></Show>
    <Show when={networkPrompt()}>{prompt => <View class="absolute inset-0 bg-[#000000ee]">
      <View class="absolute" style={{insetL:uiLeft(),insetT:uiTop(),width:233,height:233,scale:uiScale(),originX:0,originY:0}}>
      <Text class="absolute left-[26] right-[26] top-[68] text-sm leading-[18] text-white text-center">{prompt().title}</Text><Text class="absolute left-[26] right-[26] top-[96] text-xs leading-[16] text-[#b6b6b6] text-center">{prompt().detail}</Text>
      <View class="absolute left-[76.5] top-[138] w-[80] h-[36] rounded-[18] bg-[#2a2a2a] items-center justify-center" focusable onPress={() => {
        if (prompt().action === "继续") {
          const resumeByNetwork = networkPaused;
          setAllowBluetooth(true);
          if (!ready()) { if (preparedSource !== props.source || error()) prepare(); }
          else if (!resumeByNetwork) void media.play().then(setState).catch(failed);
        } else void retry();
      }}><Text class="text-sm text-white">{prompt().action}</Text></View>
      </View>
    </View>}</Show>
    <Show when={volumeVisible()}><View class="absolute left-[72] right-[72] top-[91] h-[50] rounded-[25] bg-[#111111dd] items-center justify-center"><Text class="text-[21px] leading-[26] text-white">{systemVolumePercent(state()?.volumeIndex ?? Math.round((state()?.volume??0)*(state()?.volumeMax??1)),state()?.volumeMax??1)}%</Text></View></Show>
    <Show when={!volumeVisible() && loopHint()}>{hint => <View class="absolute left-[52] right-[52] top-[91] h-[50] rounded-[25] bg-[#111111dd] items-center justify-center"><Text class="text-base leading-[20] text-white">{hint()}</Text></View>}</Show>
  </View>;
}
