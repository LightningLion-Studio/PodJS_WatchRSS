import * as hostServices from '@podjs/framework/services';
import * as hostWatch from '@podjs/framework/watch';
import {kv} from '@podjs/framework/watch';
import {selectSustainableVariant, type PlaybackFeedback} from '@podjs/framework/media-policy';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinItem,DouyinVideoVariant} from '../douyin/types.ts';
import {DOUYIN_MAX_SHORT_EDGE,applyPreferredDouyinPlayback,douyinCodecRuntimePolicy,normalizedDouyinResolution,
  prefersLowMemoryDouyinRendition,selectPreferredDouyinVariant} from '../douyin/playback-selector.ts';

type Feature = 'recovery' | 'adaptive' | 'metrics' | 'traffic';
export function videoOptEnabled(feature: Feature): boolean {
  const config = kv.get<Record<string,unknown>>('watchrss.video-opt.v1');
  if (!config || config[feature] !== true || typeof config.percent !== 'number' || !Number.isFinite(config.percent) || config.percent <= 0) return false;
  let bucket = kv.get<number>('watchrss.video-opt.bucket');
  if (typeof bucket !== 'number' || !Number.isInteger(bucket) || bucket < 0 || bucket >= 10000) {
    bucket = Math.floor(Math.random() * 10000); kv.set('watchrss.video-opt.bucket', bucket);
  }
  return bucket < Math.min(100, config.percent) * 100;
}
let networkEpoch=0;
export const videoNetworkEpoch=()=>networkEpoch;
export function invalidateVideoNetwork(){networkEpoch++;clearVideoFeedback();}
let feedback: PlaybackFeedback = {}, observedAt = 0, decodePressureUntil = 0;
export function clearVideoFeedback() { feedback = {}; observedAt = 0; decodePressureUntil = 0; }
export function observeVideoFeedback(value: PlaybackFeedback) {
  feedback = {throughputBps: value.throughputBps, rebufferCount: value.rebufferCount}; observedAt = Date.now();
}
function adaptiveAvcPool(item:DouyinItem, now:number) {
  const variants=(item.variants??[]).filter(v=>v?.codec==='h264'&&typeof v.playUrl==='string'&&v.playUrl.trim()
    &&(v.format!=='dash'||!!v.audioUrl?.trim())&&Number.isFinite(v.width)&&Number.isFinite(v.height)
    &&v.width>0&&v.height>0&&Math.min(v.width,v.height)<=DOUYIN_MAX_SHORT_EDGE
    &&(normalizedDouyinResolution(v)??Infinity)<=DOUYIN_MAX_SHORT_EDGE);
  if(now<decodePressureUntil||prefersLowMemoryDouyinRendition()){
    const small=variants.filter(v=>Math.min(v.width,v.height)<=360&&(normalizedDouyinResolution(v)??Infinity)<=360);
    if(small.length)return small;
  }
  return variants;
}
function selectAdaptiveDouyinItem<T extends DouyinItem>(item:T,pool:DouyinVideoVariant[],now:number):T {
  const recentNetwork=observedAt>0&&now-observedAt<=60_000;
  if (!recentNetwork&&now>=decodePressureUntil) return item;
  const preferred = selectPreferredDouyinVariant(pool);
  const selected = selectSustainableVariant(pool, preferred, recentNetwork?feedback:{});
  return selected ? {...item, playUrl:selected.playUrl} : item;
}
export function adaptiveDouyinItem<T extends DouyinItem>(item:T):T {
  if(!videoOptEnabled('adaptive'))return item;
  const now=Date.now();
  return selectAdaptiveDouyinItem(item,adaptiveAvcPool(item,now),now);
}
export function preserveSelectedDouyinItem<T extends DouyinItem>(item:T):T {
  if(videoOptEnabled('adaptive')&&item.variants?.some(v=>v.codec==='h264'&&(v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl))))return item;
  return applyPreferredDouyinPlayback(item);
}
const hevcProbes=new Map<string,Promise<boolean>>();
const unsupportedHevcSizes=new Map<string,number>();
/** Experimental selection only publishes a new source after a real decoder probe. */
export async function decodableDouyinItem<T extends DouyinItem>(item:T):Promise<T> {
  if(!hostWatch.hasCapability('media.video.sessions'))return item;
  if(!douyinCodecRuntimePolicy.shouldPreferH264InAutoMode()){
    const candidates=(item.variants??[]).filter(v=>v.codec==='h265'&&v.width>0&&v.height>0).sort((a,b)=>Math.min(a.width,a.height)-Math.min(b.width,b.height)||a.bitrate-b.bitrate).slice(0,4);
    const sizes=new Set<string>();
    for(const v of candidates){
      const key=`${v.width}x${v.height}`;if(sizes.has(key))continue;sizes.add(key);
      // A confirmed size is process-local. Native admission still checks its
      // current runtime decoder limit for every prepare. Repeated neighbour
      // resolution must not enqueue the same capability scan on the UI thread.
      if(douyinCodecRuntimePolicy.canDecodeHevc(v)||(unsupportedHevcSizes.get(key)??0)>Date.now())continue;
      let probe=hevcProbes.get(key);
      if(!probe){
        probe=Promise.resolve().then(()=>hostServices.videoSessions.capabilities({videoMime:'video/hevc',videoWidth:v.width,videoHeight:v.height})).then(result=>{
          if(result.decoderSizeSupported===false&&!result.decoderRuntimeDowngraded){
            unsupportedHevcSizes.delete(key);
            unsupportedHevcSizes.set(key,Date.now()+60_000);
            if(unsupportedHevcSizes.size>32)unsupportedHevcSizes.delete(unsupportedHevcSizes.keys().next().value!);
          }
          return result.decoderSizeSupported===true&&result.decoderRuntimeDowngraded!==true;
        }).catch(()=>false).finally(()=>hevcProbes.delete(key));
        hevcProbes.set(key,probe);
      }
      douyinCodecRuntimePolicy.confirmHevcSize(v,await probe);
    }
    item=applyPreferredDouyinPlayback(item);
  }
  if(!videoOptEnabled('adaptive'))return item;
  const now=Date.now(),pool=adaptiveAvcPool(item,now);
  const selected=selectAdaptiveDouyinItem(item,pool,now);
  pool.sort((a,b)=>a.bitrate-b.bitrate);
  const preferred=pool.find(v=>v.playUrl===selected.playUrl);
  const candidates=[...(preferred?[preferred]:[]),...pool.filter(v=>v!==preferred&&(!preferred||v.bitrate<preferred.bitrate))].slice(0,4);
  for(const v of candidates){
    if(v.width<=0||v.height<=0)continue;
    try{const result=await hostServices.videoSessions.capabilities({videoMime:'video/avc',videoWidth:v.width,videoHeight:v.height});
      if(result.decoderSizeSupported===true&&!result.decoderRuntimeDowngraded)return {...item,playUrl:v.playUrl};
    }catch{return item;}
  }
  return item;
}
let sequence = 0;
const resolutions = new Map<string,VideoPlaybackTrace>();
export function registerVideoResolution(url:string, trace:VideoPlaybackTrace) {
  resolutions.delete(url);resolutions.set(url,trace);
  while(resolutions.size>32)resolutions.delete(resolutions.keys().next().value!);
}
export function takeVideoResolution(url:string, platform:'bili'|'douyin'|'rss') {
  const trace=resolutions.get(url);
  return trace??new VideoPlaybackTrace(platform);
}
interface VideoSample {
  state?:string; positionMs?:number; isBuffering?:boolean; hasRenderedFirstFrame?:boolean;
  sourceGeneration?:number; width?:number; height?:number; metrics?:Record<string,number|undefined>;
}
interface FrameDropWindow {
  source:number; startAt:number; startPosition:number; startDrops:number;
  lastAt:number; lastPosition:number; lastDrops:number; warming:boolean; previousBad?:{at:number;drops:number};
}
/** Process-local numeric correlation only. No platform IDs, errors, headers or URLs. */
export class VideoPlaybackTrace {
  readonly session = ++sequence;
  private firstFrame = false;
  private lastSample = -Infinity;
  private apiRoute=0;
  private trackDrops=false;
  private dropWindow?:FrameDropWindow;
  setBiliRoute(route:'watch'|'web'|undefined){this.apiRoute=route==='watch'?1:route==='web'?2:0;}
  constructor(private platform:'bili'|'douyin'|'rss', private started = Date.now()) {}
  event(stage:'api'|'candidate'|'prepare'|'first_frame'|'sample'|'exit', values:Record<string,unknown> = {}) {
    if(stage==='prepare'||stage==='exit'){
      this.firstFrame=false;
      this.dropWindow=undefined;
      this.trackDrops=stage==='prepare'&&this.platform==='douyin'&&videoOptEnabled('adaptive');
    }
    if (!videoOptEnabled('metrics') && !(this.platform==='bili'&&['api','candidate','first_frame'].includes(stage))) return;
    const allowed = ['apiMs','candidate','width','height','bitrate','sourceGeneration','bytesLoaded','firstByteMs','firstFrameMs','rebufferCount','rebufferMs','droppedFrames','throughputBps','cacheHit'];
    const safe:Record<string,number> = {};
    for (const key of allowed) if (typeof values[key] === 'number' && Number.isFinite(values[key])) safe[key] = Math.max(0, Math.floor(values[key] as number));
    appLogger.i('VideoOpt', JSON.stringify({session:this.session,platform:this.platform,stage,apiRoute:this.apiRoute,elapsedMs:Math.max(0,Date.now()-this.started),...safe}));
  }
  private observeFrameDrops(state:VideoSample,presented:boolean,now:number) {
    const drops=state.metrics?.droppedFrames,source=state.sourceGeneration,position=state.positionMs;
    if(!presented||state.state!=='playing'||state.isBuffering||!state.hasRenderedFirstFrame
      ||typeof source!=='number'||!Number.isSafeInteger(source)||typeof drops!=='number'||!Number.isSafeInteger(drops)||drops<0
      ||typeof position!=='number'||!Number.isFinite(position)||position<0){
      this.dropWindow=undefined;
      return;
    }
    const w=this.dropWindow;
    // Begin a new baseline after a seek, repeat, long interruption or native counter reset.
    if(!w||source!==w.source||drops<w.lastDrops||position<w.lastPosition||now<w.lastAt
      ||now-w.lastAt>5000||position-w.lastPosition>2*(now-w.lastAt)+1000){
      this.dropWindow={source,startAt:now,startPosition:position,startDrops:drops,lastAt:now,lastPosition:position,lastDrops:drops,warming:true};
      return;
    }
    w.lastAt=now;w.lastPosition=position;w.lastDrops=drops;
    const elapsed=now-w.startAt;
    if(elapsed<2000)return;
    // Media hosts report cumulative dropped frames and may deliver them in bursts.
    // Ignore startup, then require two distinct windows losing at least two frames/s.
    if(!w.warming&&position>w.startPosition&&drops-w.startDrops>=elapsed/500){
      const previous=w.previousBad;
      if(previous&&now-previous.at<=30_000&&drops-previous.drops>=(now-previous.at)/500)decodePressureUntil=now+30_000;
      w.previousBad={at:now,drops};
    }else if(position<=w.startPosition)w.previousBad=undefined;
    w.warming=false;w.startAt=now;w.startPosition=position;w.startDrops=drops;
  }
  sample(state:VideoSample, presented = true) {
    const metrics = state.metrics ?? {};
    const now=Date.now();
    if(this.trackDrops)this.observeFrameDrops(state,presented,now);
    if (state.hasRenderedFirstFrame && presented && !this.firstFrame) { this.firstFrame = true; this.event('first_frame',{...metrics,sourceGeneration:state.sourceGeneration,width:state.width,height:state.height}); }
    if (now-this.lastSample >= 8000) { this.lastSample=now; this.event('sample',{...metrics,sourceGeneration:state.sourceGeneration}); }
    if (typeof metrics.throughputBps==='number' && Number.isFinite(metrics.throughputBps) && metrics.throughputBps > 0) observeVideoFeedback(metrics);
  }
}
