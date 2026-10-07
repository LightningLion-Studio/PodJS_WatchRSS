import {douyinDebug} from '../debug/douyin-host.ts';
import {restoredSignal,booleanState} from './route-activity.tsx';
import {appLogger} from '../logs/app-logger.ts';
import { observeHostInternet } from "../onboarding/network-host.ts";
import type { InternetStatus } from "../onboarding/state.ts";
import { douyinPlayerNetwork, douyinSourceNeedsInternet, douyinNetworkFailure } from "./douyin/player-network.ts";
import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { hitNode, pressNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { hasCapability, lifecycle, onLifecycleChange, normalizedRelativeAxisStep } from "@podjs/framework/watch";
import { video, delay, type HostOperation, type VideoPrepare, type VideoState } from "@podjs/framework/services";
import { formatPlayerTime, guardedCrownVolume, nextScaleMode, playerPanRange, progressWidth, seekHoldStep, type CrownVolumeGuardState, type PlayerScaleMode } from "./video-player.ts";
import { DouyinVideoSessionPool, douyinPagerProgress, douyinPagerSettleProgress, shouldFallbackFromVideoSessions, shouldSettleDouyinPager, shouldUseDouyinVideoSessions, type DouyinPagerDirection, type DouyinPreparedSource } from "./douyin/video-sessions.ts";
import { RemoteImage } from "./RemoteImage.tsx";

// The host exposes one session, even when navigation retains several screens.
let videoSessionOwner:symbol|undefined;

type ExtendedVideoState = VideoState & { volume?: number; buffered?: boolean; isBuffering?: boolean };

export interface PlaybackSource { detailPlayback?:boolean; immersive?:boolean; awemeId?:string; posterUrl?:string; backgroundPlayback?: boolean; url?: string; videoUrl?: string; audioUrl?: string; webUrl?: string; headers?: Record<string, string>; type?: string; videoMime?:string; videoWidth?:number; videoHeight?:number; title: string; resumePositionMs?: number; volumeGuard?: boolean; startVolumeLimit?: number | null; digitalCrownVolume?: boolean; platform?: "bili" | "douyin" | "rss" }
export interface VideoPlayerHandle { onCrown(delta: number): boolean; canSwipeBack(): boolean }

function PlayerButton(props: { left: number; top: number; size: number; icon: "fullscreen" | "panorama" | "fullscreen-exit" | "rotate" | "rewind" | "forward" | "play" | "pause"; iconSize: number; enabled?: boolean; onPress: () => void; onHold?: (elapsedMs: number) => void }) {
  let node: NodeMirror | undefined, holding = false, holdStart = 0, nextSeek = 0;
  const gesture = createGesture({ region: { node: () => node }, longPressSeconds: .5,
    onTap: () => { if (props.enabled !== false) props.onPress(); },
    onLongPress: () => { if (props.enabled === false || !props.onHold) return; holding = true; holdStart = Date.now(); nextSeek = 0; },
    onUp: () => { holding = false; }, onCancel: () => { holding = false; }
  });
  onFrame(() => { if (!holding || !props.onHold) return; const elapsed = Date.now() - holdStart; if (elapsed >= nextSeek) { props.onHold(elapsed); nextSeek = elapsed + 200; } });
  onCleanup(() => gesture.dispose());
  return <View ref={value => node = value} onPress={() => { if (props.enabled !== false) props.onPress(); }} focusable={props.enabled !== false} style={{ insetL: props.left, insetT: props.top, width: props.size, height: props.size, opacity: props.enabled === false ? .5 : 1 }} class="absolute items-center justify-center">
    <Show when={props.icon === "fullscreen"}><Image src="../assets/icons/player-fullscreen.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "panorama"}><Image src="../assets/icons/player-panorama.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "fullscreen-exit"}><Image src="../assets/icons/player-fullscreen-exit.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rotate"}><Image src="../assets/icons/player-rotate.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "rewind"}><Image src="../assets/icons/player-rewind.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "forward"}><Image src="../assets/icons/player-forward.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "play"}><Image src="../assets/icons/player-play.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show><Show when={props.icon === "pause"}><Image src="../assets/icons/player-pause.svg" style={{ width: props.iconSize, height: props.iconSize }} /></Show>
  </View>;
}

export function VideoPlayerScreen(props: { source: PlaybackSource; width: number; height: number; active: boolean; offset: number; round: boolean; onError?: (message: string) => void; onOpenWeb?: () => void; onProgress?: (positionMs: number, durationMs: number) => void; onCheckpoint?: (kind: "ready" | "pause_or_exit" | "error" | "ended", positionMs: number, durationMs: number) => void; onNext?: () => void | Promise<void>; onPrevious?: () => void | Promise<void>; onPrepareAdjacent?:(direction:"next"|"previous")=>Promise<DouyinPreparedSource|undefined>; onPromoteAdjacent?:(prepared:DouyinPreparedSource)=>Promise<boolean>; onActions?:()=>void; onHeader?:()=>void; onRetry?:(positionMs:number)=>void|Promise<void>; onPlaybackFailure?:(positionMs:number)=>void; onPanStateChange?: (offset: number, range: number) => void; ref?: (handle: VideoPlayerHandle) => void }) {
  const saveablePlayer=props.source.platform==='douyin'&&props.source.immersive===true;
  const [state, setState] = createSignal<ExtendedVideoState | null>(null), [error, setError] = createSignal("");
  const [ready, setReady] = createSignal(false), [controlsVisible, setControlsVisible] = restoredSignal('saved','player-controls',true,booleanState,saveablePlayer);
  const [mode, setMode] = restoredSignal<PlayerScaleMode>('saved','player-scale',"standard",(v):v is PlayerScaleMode=>v==='standard'||v==='expanded'||v==='shrunk',saveablePlayer), [rotation, setRotation] = createSignal(0);
  const [displayRotation, setDisplayRotation] = createSignal(0), [pan, setPan] = createSignal(0), [volumeVisible, setVolumeVisible] = createSignal(false), [loadingRotation, setLoadingRotation] = createSignal(0);
  const [internet, setInternet] = createSignal<InternetStatus>("checking");
  const [allowBluetooth, setAllowBluetooth] = restoredSignal('saved','player-bluetooth',false,booleanState,saveablePlayer);
  const [networkFailure, setNetworkFailure] = createSignal(false);
  const [sessionsDisabled,setSessionsDisabled]=createSignal(false),[dragProgress,setDragProgress]=createSignal(0),[dragPoster,setDragPoster]=createSignal<{url:string;direction:DouyinPagerDirection}|null>(null);
  const [startLimitConsumed,setStartLimitConsumed]=restoredSignal('saved','player-start-limit-consumed',false,booleanState,saveablePlayer);
  const sessionCapable=shouldUseDouyinVideoSessions(props.source,hasCapability("media.video.sessions"));
  const sessionPool=sessionCapable?new DouyinVideoSessionPool():undefined;
  const usingSessions=()=>!!sessionPool&&!sessionsDisabled();
  const sessionSource=(source:PlaybackSource):DouyinPreparedSource=>({key:source.awemeId??source.url??source.videoUrl??"current",source});
  const networkPrompt = () => props.source.platform === "douyin" ? douyinPlayerNetwork(internet(), state()?.state === "playing" && !error(), allowBluetooth(), douyinSourceNeedsInternet(props.source.url ?? props.source.videoUrl), networkFailure(), props.source.immersive ? {hasRenderedFirstFrame:state()?.hasRenderedFirstFrame,buffering:state()?.state === "buffering" || state()?.isBuffering === true,hasError:!!error()} : undefined) : null;
  onMount(() => { if (props.source.platform === "douyin") onCleanup(observeHostInternet(setInternet)); });
  const sessionOwner=Symbol("video-screen");
  createEffect(()=>{if(props.active&&props.source.platform==='douyin'&&props.source.immersive&&douyinDebug.allowed)
    onCleanup(douyinDebug.bindSessions(async()=>usingSessions()&&videoSessionOwner===sessionOwner?sessionPool!.diagnostics():undefined));});
  let preparedSource:PlaybackSource|undefined;
  let sessionCapacity:"unchecked"|"checking"|"available"|"unavailable"=sessionCapable?"unchecked":"unavailable";
  let autoplayAllowed=false;
  let disposed = false, generation = 0, lastPlaybackState = "", checkpointPosition = 0, checkpointDuration = 0, pollTimer: HostOperation<void> | undefined, tapTimer: HostOperation<void> | undefined, volumeTimer: HostOperation<void> | undefined, prepareOp: HostOperation<VideoState> | undefined;
  let surface: NodeMirror | undefined, rotationFrom = 0, rotationTo = 0, rotationStarted = 0, panningStart = 0, panVelocity = 0, panFrameAt = Date.now();
  let transformRunning = false, transformDirty = false, seekRunning = false, desiredSeek = 0, volumeRunning = false, volumeDirty = false, virtualVolume: number | undefined, crownGuard: CrownVolumeGuardState = { lastEventMs: Number.NEGATIVE_INFINITY };
  const bounds = () => ({ x: 0, y: 0, width: props.width, height: props.height, translateX: props.offset, visible: props.active, roundClip: props.round ? { cx: props.width / 2, cy: props.height / 2, radius: Math.min(props.width, props.height) / 2 } : undefined });
  const media={
    prepare:(options:VideoPrepare)=>usingSessions()?sessionPool!.prepare(sessionSource(props.source),options):video.prepare(options),
    play:()=>usingSessions()?sessionPool!.play():video.play(),pause:()=>usingSessions()?sessionPool!.pause():video.pause(),
    seek:(positionMs:number)=>usingSessions()?sessionPool!.seek(positionMs):video.seek(positionMs),
    stop:()=>usingSessions()?sessionPool!.stop():video.stop(),state:()=>usingSessions()?sessionPool!.state():video.state(),
    setBounds:(value:ReturnType<typeof bounds>)=>usingSessions()?sessionPool!.setBounds(value):video.setBounds(value),
    setTransform:(value:{rotationDeg?:number;scaleMode?:"standard"|"expanded"|"shrunk";panX?:number;panY?:number})=>usingSessions()?sessionPool!.setTransform(value):video.setTransform(value),
    setVolume:(value:number)=>usingSessions()?sessionPool!.setVolume(value):video.setVolume(value),
  };
  const failed = (value: unknown) => { appLogger.e('VideoPlayer','Playback failed'); if (!disposed) { const message = String(value); setNetworkFailure(douyinNetworkFailure(value)); setError(message); props.onCheckpoint?.("error", checkpointPosition, checkpointDuration); props.onError?.(message); } };
  const range = () => playerPanRange(mode(), props.width, props.height, state()?.width ?? 0, state()?.height ?? 0, rotation());
  const requestTransform = async () => { if(videoSessionOwner!==sessionOwner)return; if (transformRunning) { transformDirty = true; return; } transformRunning = true; try { do { transformDirty = false; const ownGeneration = generation, r = range(), value = Math.max(-r.range, Math.min(r.range, pan())); if (value !== pan()) setPan(value); await media.setTransform({ rotationDeg: displayRotation(), scaleMode: mode(), ...(r.axis === "x" ? { panX: value } : { panY: value }) }); if (ownGeneration === generation) props.onPanStateChange?.(value, r.range); else transformDirty = true; } while (transformDirty && !disposed); } catch (value) { if(usingSessions())void degradeSessions(value);else failed(value); } finally { transformRunning = false; } };
  const enforceStartVolume = async (next: ExtendedVideoState, limit: number | null | undefined) => { if (limit == null || next.volume == null) return next; const maximum = Math.max(0, Math.min(1, limit / 100)); return next.volume > maximum ? await media.setVolume(maximum) as ExtendedVideoState : next; };
  const poll = async (ownGeneration: number) => { if (disposed || ownGeneration !== generation || videoSessionOwner!==sessionOwner) return; if(!props.active||videoSessionOwner!==sessionOwner){pollTimer=delay(400);void pollTimer.result.then(()=>void poll(ownGeneration)).catch(()=>{});return;} try { const next = await media.state(); if (ownGeneration !== generation || videoSessionOwner!==sessionOwner) return; if (next.state === "error") { if (lastPlaybackState !== "error") { failed({code:next.errorCode}); if (!networkPrompt() && (props.source.platform!=="douyin" || props.source.immersive || props.source.detailPlayback)) props.onPlaybackFailure?.(checkpointPosition); } lastPlaybackState = "error"; return; } setState(next); if (!volumeRunning) virtualVolume = next.volume; checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; props.onProgress?.(next.positionMs, next.durationMs); if (next.state === "ended" && lastPlaybackState !== "ended") props.onCheckpoint?.("ended", next.positionMs, next.durationMs); lastPlaybackState = next.state; } catch (value) { if(usingSessions())void degradeSessions(value);else failed(value); } if (!disposed && ownGeneration === generation && lastPlaybackState !== "error") { pollTimer = delay(400); void pollTimer.result.then(() => void poll(ownGeneration)).catch(() => {}); } };
  const prepare = (retryNetwork = false) => {
    appLogger.d('VideoPlayer',`prepare platform=${props.source.platform??'rss'}`);if(networkPrompt()&&!retryNetwork)return;
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
    networkPaused=false;const previous=state(),sameSource=preparedSource===props.source;const source=sameSource&&videoSessionOwner!==sessionOwner&&previous?{...props.source,resumePositionMs:previous.positionMs}:props.source;preparedSource=props.source;videoSessionOwner=sessionOwner;autoplayAllowed=props.active&&(usingSessions()?lifecycle()==="active":source.backgroundPlayback===true||lifecycle()==="active");props.onError?.("");if(ready()&&previous)props.onCheckpoint?.("pause_or_exit",previous.positionMs,previous.durationMs);const ownGeneration=++generation;prepareOp?.cancel();pollTimer?.cancel();if(!saveablePlayer)setMode("standard");setRotation(0);setDisplayRotation(0);setPan(0);rotationStarted=0;panVelocity=0;crownGuard={lastEventMs:Number.NEGATIVE_INFINITY};virtualVolume=undefined;setError("");setReady(false);setState(null);lastPlaybackState="";checkpointPosition=source.resumePositionMs??0;checkpointDuration=0;const op=media.prepare({...source,loop:source.immersive===true,bounds:bounds(),autoplay:false} as VideoPrepare);prepareOp=op;void op.result.then(async next=>{if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;let prepared:ExtendedVideoState=next;if((source.resumePositionMs??0)>0){prepared=await media.seek(source.resumePositionMs!) as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;}if(!saveablePlayer||!startLimitConsumed()){prepared=await enforceStartVolume(prepared,source.startVolumeLimit);if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(saveablePlayer)setStartLimitConsumed(true);}if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;if(autoplayAllowed&&!networkPrompt())prepared=await media.play() as ExtendedVideoState;if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;appLogger.i('VideoPlayer',`ready durationMs=${prepared.durationMs}`);setReady(true);setState(prepared);virtualVolume=prepared.volume;checkpointPosition=prepared.positionMs;checkpointDuration=prepared.durationMs;props.onCheckpoint?.("ready",prepared.positionMs,prepared.durationMs);await requestTransform();if(disposed||ownGeneration!==generation||videoSessionOwner!==sessionOwner)return;void warmForward();void poll(ownGeneration);}).catch(value=>{if(ownGeneration===generation&&videoSessionOwner===sessionOwner){if(usingSessions()&&!douyinNetworkFailure(value))void degradeSessions(value);else{failed(value);if(!networkPrompt() && (props.source.platform!=="douyin" || props.source.immersive || props.source.detailPlayback))props.onPlaybackFailure?.(checkpointPosition);}}});
  };
  let retrying = false;
  const retry = async () => {
    if (retrying) return;
    // Native onRetry recreates this source; do not resolve/discard a queue item on network retry.
    const retryNetwork = !!networkPrompt();
    setNetworkFailure(false);
    if (retryNetwork || !props.onRetry || props.source.platform === "douyin" && !props.source.immersive && !props.source.detailPlayback) { prepare(true); return; }
    appLogger.w('VideoPlayer','Retry playback');
    retrying = true;
    try { await props.onRetry(checkpointPosition); } catch (value) { if (!disposed) failed(value); } finally { retrying = false; }
  };
  const removeLifecycle=onLifecycleChange(next=>{
    if(next==="active"){if(usingSessions()&&props.active&&!ready())untrack(prepare);return;}
    if((!usingSessions()&&props.source.backgroundPlayback)||videoSessionOwner!==sessionOwner)return;
    autoplayAllowed=false;
    if(usingSessions()){
      const value=state();if(value)props.onCheckpoint?.("pause_or_exit",value.positionMs,value.durationMs);
      preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});
    }else if(ready())void media.pause().then(value=>{if(disposed)return;setState(value);checkpointPosition=value.positionMs;checkpointDuration=value.durationMs;props.onCheckpoint?.("pause_or_exit",value.positionMs,value.durationMs);}).catch(failed);
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
  const syncBounds = async () => { if (updating) { dirty = true; return; } updating = true; try { do { dirty = false; await media.setBounds(bounds()); } while (dirty && !disposed); } catch (value) { if(usingSessions())void degradeSessions(value);else failed(value); } finally { updating = false; } };
  createEffect(() => { props.offset; props.active; if (props.offset !== 0 || !props.active) panVelocity = 0; if (ready()&&videoSessionOwner===sessionOwner) void syncBounds(); });
  const toggle = async () => { try { const pausing = state()?.state === "playing", next = await (pausing ? media.pause() : media.play()); setState(next); checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; if (pausing) props.onCheckpoint?.("pause_or_exit", next.positionMs, next.durationMs); } catch (value) { failed(value); } };
  const seekTo = async (delta: number) => { const current = state(); if (!current) return; if (!seekRunning) desiredSeek = current.positionMs; desiredSeek = Math.max(0, Math.min(current.durationMs || Number.MAX_SAFE_INTEGER, desiredSeek + delta)); if (seekRunning) return; seekRunning = true; try { do { const target = desiredSeek, next = await media.seek(target); setState(next); checkpointPosition = next.positionMs; checkpointDuration = next.durationMs; if (target === desiredSeek) break; } while (!disposed); } catch (value) { failed(value); } finally { seekRunning = false; } };
  const rotate = () => { rotationFrom = displayRotation(); rotationTo = rotation() + 90; setRotation(rotationTo); rotationStarted = Date.now(); };
  const changeMode = () => { panVelocity = 0; setMode(nextScaleMode(mode())); setPan(0); void requestTransform(); };
  const backgroundTap = () => { if (tapTimer) { tapTimer.cancel(); tapTimer = undefined; void toggle(); return; } tapTimer = delay(280); void tapTimer.result.then(() => { tapTimer = undefined; setControlsVisible(value => !value); }).catch(() => {}); };
  let degradingSessions=false,neighborRevision=0,forwardWarm:Promise<DouyinPreparedSource|undefined>|undefined,forwardTarget:DouyinPreparedSource|undefined;
  const cancelledSessionError=(value:unknown)=>!shouldFallbackFromVideoSessions(value);
  const degradeSessions=async(value:unknown)=>{
    if(!usingSessions()||degradingSessions||disposed)return;
    degradingSessions=true;appLogger.w("VideoPlayer","videoSessions failed; falling back to legacy video");
    generation++;prepareOp?.cancel();pollTimer?.cancel();neighborRevision++;
    try{await sessionPool!.releaseAll();}catch(releaseError){appLogger.w("VideoPlayer","videoSessions cleanup failed");}
    if(disposed){degradingSessions=false;return;}sessionCapacity="unavailable";setSessionsDisabled(true);preparedSource=undefined;forwardTarget=undefined;setReady(false);setState(null);degradingSessions=false;
    if(props.active&&!networkPrompt())untrack(prepare);
  };
  const previewAdjacent=async(direction:"next"|"previous",revision:number,revealPoster=false):Promise<DouyinPreparedSource|undefined>=>{
    if(!props.onPrepareAdjacent)return;
    const target=await props.onPrepareAdjacent(direction);
    if(!target||revision!==neighborRevision||disposed)return;
    if(revealPoster&&target.source.posterUrl)setDragPoster({url:target.source.posterUrl,direction:direction==="next"?"up":"down"});
    return target;
  };
  const prepareAdjacent=async(direction:"next"|"previous",revision:number,revealPoster=false):Promise<DouyinPreparedSource|undefined>=>{
    if(!usingSessions()||!props.onPrepareAdjacent)return;
    const target=await previewAdjacent(direction,revision,revealPoster);
    if(!target||!usingSessions())return;
    try{
      await sessionPool!.prewarm(target,{...target.source,bounds:bounds(),loop:true,autoplay:false,muted:true} as VideoPrepare);
      return revision===neighborRevision&&usingSessions()?target:undefined;
    }catch(value){if(revision===neighborRevision&&!cancelledSessionError(value)){await degradeSessions(value);return revision===neighborRevision&&!disposed?target:undefined;}return;}
  };
  const warmForward=():Promise<DouyinPreparedSource|undefined>=>{
    if(!usingSessions()||!props.onPrepareAdjacent)return Promise.resolve(undefined);
    if(forwardTarget&&sessionPool!.hasStandby(forwardTarget.key))return Promise.resolve(forwardTarget);
    if(forwardWarm)return forwardWarm;
    const revision=neighborRevision;
    forwardWarm=prepareAdjacent("next",revision).then(target=>{if(target)forwardTarget=target;return target;}).finally(()=>{forwardWarm=undefined;});return forwardWarm;
  };
  let dragRevision=0,dragDirection:DouyinPagerDirection|undefined,dragTarget:DouyinPreparedSource|undefined,dragTargetPromise:Promise<DouyinPreparedSource|undefined>|undefined,dragSettling=false;
  const clearDrag=()=>{dragDirection=undefined;dragTarget=undefined;dragTargetPromise=undefined;dragSettling=false;setDragPoster(null);setDragProgress(0);};
  const ensureDragTarget=(direction:DouyinPagerDirection,revision:number)=>{
    const queueDirection:"next"|"previous"=direction==="up"?"next":"previous";
    const existing=direction==="up"&&forwardTarget&&sessionPool?.hasStandby(forwardTarget.key)?forwardTarget:undefined;
    if(existing){dragTarget=existing;return Promise.resolve(existing);}
    const ownNeighbor=++neighborRevision;
    const pending=usingSessions()?prepareAdjacent(queueDirection,ownNeighbor,true):previewAdjacent(queueDirection,ownNeighbor,true);
    return pending.then(target=>{
      if(revision!==dragRevision||direction!==dragDirection)return;
      dragTarget=target;if(target&&usingSessions())setDragPoster(null);return target;
    });
  };
  const beginDouyinDrag=()=>{
    if(props.source.platform!=="douyin"||dragSettling)return;
    dragRevision++;dragDirection=undefined;dragTarget=undefined;dragTargetPromise=undefined;setDragProgress(0);setDragPoster(null);
    if(ready())void media.pause().then(setState).catch(value=>{if(usingSessions()&&!cancelledSessionError(value))void degradeSessions(value);});
  };
  const moveDouyinDrag=(distanceY:number)=>{
    if(props.source.platform!=="douyin"||dragSettling||distanceY===0)return;
    const direction:DouyinPagerDirection=distanceY<0?"up":"down",progress=douyinPagerProgress(distanceY,props.height),revision=dragRevision;
    setDragProgress(progress);
    if(direction!==dragDirection){dragDirection=direction;dragTarget=undefined;dragTargetPromise=ensureDragTarget(direction,revision);}
    const targetPromise=dragTarget?Promise.resolve(dragTarget):dragTargetPromise;
    if(usingSessions())void targetPromise?.then(target=>{if(target&&revision===dragRevision&&direction===dragDirection&&usingSessions())return sessionPool!.transition(progress,direction,bounds());}).catch(value=>{if(revision===dragRevision&&!cancelledSessionError(value))void degradeSessions(value);});
  };
  const animateDouyinTransition=async(revision:number,direction:DouyinPagerDirection,to:0|1)=>{
    const from=dragProgress(),started=Date.now();
    while(true){
      const elapsed=Date.now()-started,next=douyinPagerSettleProgress(from,to,elapsed);setDragProgress(next);
      if(usingSessions())await sessionPool!.transition(next,direction,bounds());
      if(revision!==dragRevision||disposed)return false;
      if(elapsed>=220)break;await delay(16).result;
    }
    return true;
  };
  const finishDouyinDrag=async(velocityY:number,forceCancel=false)=>{
    if(props.source.platform!=="douyin"||dragSettling)return;
    const revision=dragRevision,direction=dragDirection,progress=dragProgress();if(!direction){void media.play().then(setState).catch(failed);clearDrag();return;}
    dragSettling=true;const wantsSettle=!forceCancel&&shouldSettleDouyinPager(progress,velocityY,direction);
    const target=dragTarget??await dragTargetPromise;
    if(revision!==dragRevision||disposed)return;
    if(!target){
      if(ready())await media.play().then(setState).catch(failed);clearDrag();
      if(wantsSettle){const move=direction==="up"?props.onNext:props.onPrevious;if(move)await Promise.resolve(move());}
      return;
    }
    try{
      if(!await animateDouyinTransition(revision,direction,wantsSettle?1:0))return;
      if(!wantsSettle){if(ready())await media.play().then(setState);clearDrag();neighborRevision++;if(usingSessions())void warmForward();return;}
      if(usingSessions()){
        const promoted=await sessionPool!.promote(direction,bounds(),props.active&&lifecycle()==="active");
        if(!await props.onPromoteAdjacent?.(promoted.source))throw new Error("video session queue promotion was cancelled");
        forwardTarget=undefined;
        preparedSource=promoted.source.source;setState(promoted.state);setReady(true);setError("");checkpointPosition=promoted.state.positionMs;checkpointDuration=promoted.state.durationMs;virtualVolume=promoted.state.volume;
        props.onCheckpoint?.("ready",promoted.state.positionMs,promoted.state.durationMs);clearDrag();neighborRevision++;void requestTransform();void warmForward();
      }else{
        const move=direction==="up"?props.onNext:props.onPrevious;if(move)await Promise.resolve(move());clearDrag();
      }
    }catch(value){if(revision===dragRevision&&!cancelledSessionError(value))void degradeSessions(value);}
  };
  let resumeAfterOverlay=false;
  createEffect(()=>{const active=props.active;if(!active){resumeAfterOverlay=autoplayAllowed&&untrack(()=>!ready()||state()?.state==="playing");autoplayAllowed=false;if(usingSessions()){const value=untrack(state);if(value)props.onCheckpoint?.("pause_or_exit",value.positionMs,value.durationMs);preparedSource=undefined;neighborRevision++;dragRevision++;forwardTarget=undefined;clearDrag();setReady(false);void sessionPool!.releaseAll().catch(()=>{});}else if(untrack(ready)&&videoSessionOwner===sessionOwner)void media.pause().catch(()=>{});}else if(videoSessionOwner!==sessionOwner||usingSessions()&&!untrack(ready)){untrack(prepare);}else if(resumeAfterOverlay){resumeAfterOverlay=false;autoplayAllowed=lifecycle()==="active"||props.source.backgroundPlayback===true;if(autoplayAllowed&&untrack(ready))void media.play().then(setState).catch(failed);}});
  const surfaceGesture = createGesture({ region: { node: () => surface, rect: () => props.active && props.offset === 0 ? { x: 0, y: 0, w: props.width, h: props.height } : null }, axis: "y", panSlop: 8,
    onTap: contact => { const hit = hitNode(contact.x, contact.y, contact.surface); let pressable = hit; while (pressable && !pressable.onPress) pressable = pressable.parent; if (hit && pressable) pressNode(hit); else backgroundTap(); },
    onLongPress:()=>{if(props.active && !networkPrompt())props.onActions?.();},
    onDown: () => { panVelocity = 0; }, onPanStart: () => { panningStart = pan();if(props.source.platform==="douyin")beginDouyinDrag(); }, onPanMove: contact => { if(props.source.platform==="douyin"){moveDouyinDrag(contact.dy);return;}const r = range(); if(r.axis !== "y" || r.range <= 0) return; setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dy))); void requestTransform(); },
    onPanEnd: contact => { if (networkPrompt()) return;if(props.source.platform==="douyin"){void finishDouyinDrag(contact.vy);return;} if(range().axis === "y") { panVelocity = contact.vy; panFrameAt = Date.now(); } props.onPanStateChange?.(pan(), range().range); },
    onCancel:()=>{if(props.source.platform==="douyin")void finishDouyinDrag(0,true);}
  });
  const actionGesture=createGesture({region:{rect:()=>props.active&&!networkPrompt()&&props.onActions?{x:0,y:0,w:props.width,h:props.height}:null},axis:"x",panSlop:8,onPanEnd:contact=>{if(Math.abs(contact.dx)>50)props.onActions?.();}});
  const horizontalPanGesture = createGesture({ region: { rect: () => { const r = range(); return props.active && props.source.platform !== "douyin" && r.axis === "x" && r.range > 0 && pan() < r.range - 1 ? { x: 0, y: 0, w: props.width, h: props.height } : null; } }, axis: "x", panSlop: 8,
    onDown: () => { panVelocity = 0; }, onPanStart: () => { panningStart = pan(); }, onPanMove: contact => { const r = range(); setPan(Math.max(-r.range, Math.min(r.range, panningStart + contact.dx))); void requestTransform(); }, onPanEnd: contact => { panVelocity = contact.vx; panFrameAt = Date.now(); props.onPanStateChange?.(pan(), range().range); }
  });
  onFrame(() => { const now = Date.now(); if (panVelocity !== 0) { const elapsed = Math.min(50, Math.max(0, now - panFrameAt)), r = range(), next = Math.max(-r.range, Math.min(r.range, pan() + panVelocity * elapsed / 1000)); setPan(next); panVelocity *= Math.exp(-5 * elapsed / 1000); if (Math.abs(panVelocity) < 5 || next === -r.range || next === r.range) panVelocity = 0; panFrameAt = now; void requestTransform(); } if (!state() || buffering()) setLoadingRotation(value => (value + 6) % 360); if (!rotationStarted) return; const elapsed = now - rotationStarted, t = Math.min(1, elapsed / 300), eased = 1 - Math.pow(1 - t, 3); setDisplayRotation(rotationFrom + (rotationTo - rotationFrom) * eased); void requestTransform(); if (t >= 1) rotationStarted = 0; });
  const submitVolume = async () => { if (volumeRunning) { volumeDirty = true; return; } volumeRunning = true; try { do { volumeDirty = false; const target = virtualVolume ?? .5, next = await media.setVolume(target); if (target === virtualVolume) setState(next); else volumeDirty = true; } while (volumeDirty && !disposed); } catch (value) { failed(value); } finally { volumeRunning = false; } };
  const adjustVolume = (delta: number) => { const direction = normalizedRelativeAxisStep(delta); if (!props.active || !props.source.digitalCrownVolume || direction === 0) return false; const maxSteps = Math.max(1, state()?.volumeMax ?? 15), current = virtualVolume ?? state()?.volume ?? .5; const guarded = guardedCrownVolume(current, direction / maxSteps, maxSteps, props.source.volumeGuard === true, crownGuard, Date.now()); crownGuard = guarded.state; virtualVolume = guarded.volume; setVolumeVisible(true); volumeTimer?.cancel(); void submitVolume(); volumeTimer = delay(900); void volumeTimer.result.then(() => setVolumeVisible(false)).catch(() => {}); return true; };
  props.ref?.({ onCrown: adjustVolume, canSwipeBack: () => { if(props.onActions)return false; const r = range(); return r.axis !== "x" || r.range <= 0 || pan() >= r.range - 1; } });
  onCleanup(() => { removeLifecycle();disposed = true; generation++; const current = state(); if (ready() && current) props.onCheckpoint?.("pause_or_exit", current.positionMs, current.durationMs); surfaceGesture.dispose(); actionGesture.dispose(); horizontalPanGesture.dispose(); prepareOp?.cancel(); pollTimer?.cancel(); tapTimer?.cancel(); volumeTimer?.cancel(); if(videoSessionOwner===sessionOwner){videoSessionOwner=undefined;if(sessionPool)void sessionPool.releaseAll();else void video.stop().catch(() => {});} });
  const uiScale = () => Math.min(props.width / 233, props.height / 233), uiLeft = () => (props.width - 233) / 2, uiTop = () => (props.height - 233) / 2;
  const startWidth = () => Math.max(16, Math.ceil(getOps().measureText(formatPlayerTime(state()?.positionMs ?? 0), 19)));
  const endWidth = () => Math.max(16, Math.ceil(getOps().measureText(formatPlayerTime(state()?.durationMs ?? 0), 19)));
  const barWidth = () => Math.max(20, 181 - startWidth() - endWidth() - 11);
  const buffering = () => state()?.state === "buffering" || state()?.buffered === false || state()?.isBuffering === true;
  const prepared = () => ready() && !!state()?.durationMs;
  const dragPosterOffset=()=>{const poster=dragPoster();if(!poster)return 0;const remaining=(1-dragProgress())*props.height;return poster.direction==="up"?remaining:-remaining;};
  return <View ref={value => surface = value} class="absolute inset-0"><Show when={sessionCapable&&!ready()&&props.source.posterUrl}><RemoteImage url={props.source.posterUrl!} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></Show><Show when={dragPoster()}>{poster=><View class="absolute inset-0" style={{translateY:dragPosterOffset()}}><RemoteImage url={poster().url} width={props.width} height={props.height} fit={mode()==="expanded"?"cover":"contain"} class="absolute inset-0" /></View>}</Show><Show when={(!state() || buffering()) && !error() && !networkPrompt()}><View class="absolute left-[96.5] top-[96.5] w-[40] h-[40] rounded-[20] bg-[#00000099] items-center justify-center"><Image src="../assets/icons/player-loading.svg" class="w-[28] h-[28]" style={{ rotate: loadingRotation() }} /></View></Show>
    <Show when={error() && !networkPrompt()}><View class="absolute left-[31] right-[31] top-[72] h-[90] rounded-[24] bg-[#000000cc] items-center"><Text class="absolute left-[8] right-[8] top-[10] text-xs leading-[14] text-[#b6b6b6] text-center">播放失败</Text><View class="absolute left-[4] top-[42] w-[72] h-[32] rounded-[16] bg-[#2a2a2a] items-center justify-center" onPress={() => void retry()} focusable><Text class="text-xs text-white">重试</Text></View><Show when={props.onOpenWeb}><View class="absolute right-[4] top-[42] w-[86] h-[32] rounded-[16] bg-[#2a2a2a] items-center justify-center" onPress={props.onOpenWeb} focusable><Text class="text-xs text-white">浏览器打开</Text></View></Show></View></Show>
    <Show when={!error() && !networkPrompt() && controlsVisible()}><View class="absolute" style={{ insetL: uiLeft(), insetT: uiTop(), width: 233, height: 233, scale: uiScale(), rotate: displayRotation(), originX: 0, originY: 0 }}>
      <View class="absolute left-[0] right-[0] top-[0] h-[62] bg-gradient-to-b from-[#000000cc] to-transparent" />
      <Show when={props.onHeader}><View class="absolute left-[30] right-[30] top-[52] h-[28] items-center" onPress={props.onHeader} focusable><Text class="text-xs text-white">抖音 ›</Text></View></Show>
      <PlayerButton left={69.5} top={6} size={44} icon={mode() === "standard" ? "fullscreen" : mode() === "expanded" ? "panorama" : "fullscreen-exit"} iconSize={24} onPress={changeMode} /><PlayerButton left={119.5} top={6} size={44} icon="rotate" iconSize={24} onPress={rotate} />
      <Text style={{ width: startWidth() }} class="absolute left-[26] top-[181] text-[9px] leading-[13] text-white text-right">{formatPlayerTime(state()?.positionMs ?? 0)}</Text><View style={{ insetL: 31.5 + startWidth(), width: barWidth() }} class="absolute top-[183] h-[4] rounded-[2] bg-[#b6b6b659]"><View class="absolute left-[0] top-[0] h-[4] rounded-[2] bg-[#ff6700]" style={{ width: progressWidth(state()?.positionMs ?? 0, state()?.durationMs ?? 0, barWidth()) }} /><View class="absolute right-[0] top-[0] w-[4] h-[4] rounded-[2] bg-[#ff6700]" /></View><Text style={{ width: endWidth() }} class="absolute right-[26] top-[181] text-[9px] leading-[13] text-[#b6b6b6]">{formatPlayerTime(state()?.durationMs ?? 0)}</Text>
      <PlayerButton left={47.5} top={186} size={44} icon="rewind" iconSize={24} enabled={prepared()} onPress={() => void seekTo(-4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, -1))} /><PlayerButton left={91.5} top={183} size={50} icon={state()?.state === "playing" ? "pause" : "play"} iconSize={28} enabled={prepared()} onPress={() => void toggle()} /><PlayerButton left={141.5} top={186} size={44} icon="forward" iconSize={24} enabled={prepared()} onPress={() => void seekTo(4000)} onHold={elapsed => void seekTo(seekHoldStep(elapsed, 1))} />
    </View></Show>
    <Show when={networkPrompt()}>{prompt => <View class="absolute inset-0 bg-[#000000ee] items-center justify-center">
      <Text class="text-sm text-white">{prompt().title}</Text><Text class="text-xs text-[#b6b6b6]">{prompt().detail}</Text>
      <View class="w-[80] h-[36] rounded-[18] bg-[#2a2a2a] items-center justify-center" focusable onPress={() => {
        if (prompt().action === "继续") {
          const resumeByNetwork = networkPaused;
          setAllowBluetooth(true);
          if (!ready()) { if (preparedSource !== props.source || error()) prepare(); }
          else if (!resumeByNetwork) void media.play().then(setState).catch(failed);
        } else void retry();
      }}><Text class="text-sm text-white">{prompt().action}</Text></View>
    </View>}</Show>
    <Show when={volumeVisible()}><View class="absolute left-[72] right-[72] top-[91] h-[50] rounded-[25] bg-[#111111dd] items-center justify-center"><Text class="text-[21px] leading-[26] text-white">{Math.round((state()?.volume ?? .5) * 100)}%</Text></View></Show>
  </View>;
}
