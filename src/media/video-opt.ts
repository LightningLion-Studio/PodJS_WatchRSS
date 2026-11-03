import * as hostServices from '@podjs/framework/services';
import * as hostWatch from '@podjs/framework/watch';
import {kv} from '@podjs/framework/watch';
import {selectSustainableVariant, type PlaybackFeedback} from '@podjs/framework/media-policy';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinItem} from '../douyin/types.ts';
import {douyinCodecRuntimePolicy,selectPreferredDouyinVariant,applyPreferredDouyinPlayback} from '../douyin/playback-selector.ts';

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
let feedback: PlaybackFeedback = {}, observedAt = 0;
export function clearVideoFeedback() { feedback = {}; observedAt = 0; }
export function observeVideoFeedback(value: PlaybackFeedback) {
  feedback = {throughputBps: value.throughputBps, rebufferCount: value.rebufferCount}; observedAt = Date.now();
}
export function adaptiveDouyinItem<T extends DouyinItem>(item:T):T {
  if (!videoOptEnabled('adaptive') || Date.now()-observedAt > 60_000) return item;
  // Explicit AVC metadata only; unknown/HEVC tracks cannot enter experimental selection.
  const pool = (item.variants ?? []).filter(v => v.codec === 'h264');
  const preferred = selectPreferredDouyinVariant(pool);
  const selected = selectSustainableVariant(pool, preferred, feedback);
  return selected ? {...item, playUrl:selected.playUrl} : item;
}
export function preserveSelectedDouyinItem<T extends DouyinItem>(item:T):T {
  if(videoOptEnabled('adaptive')&&item.variants?.some(v=>v.codec==='h264'&&(v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl))))return item;
  return applyPreferredDouyinPlayback(item);
}
const hevcProbes=new Map<string,Promise<boolean>>();
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
      if(douyinCodecRuntimePolicy.canDecodeHevc(v))continue;
      let probe=hevcProbes.get(key);
      if(!probe){probe=Promise.resolve().then(()=>hostServices.videoSessions.capabilities({videoMime:'video/hevc',videoWidth:v.width,videoHeight:v.height})).then(result=>result.decoderSizeSupported===true&&result.decoderRuntimeDowngraded!==true).catch(()=>false).finally(()=>hevcProbes.delete(key));hevcProbes.set(key,probe);}
      douyinCodecRuntimePolicy.confirmHevcSize(v,await probe);
    }
    item=applyPreferredDouyinPlayback(item);
  }
  if(!videoOptEnabled('adaptive'))return item;
  const selected=adaptiveDouyinItem(item),pool=(item.variants??[]).filter(v=>v.codec==='h264').sort((a,b)=>a.bitrate-b.bitrate);
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
/** Process-local numeric correlation only. No platform IDs, errors, headers or URLs. */
export class VideoPlaybackTrace {
  readonly session = ++sequence;
  private firstFrame = false;
  private lastSample = -Infinity;
  private apiRoute=0;
  setBiliRoute(route:'watch'|'web'|undefined){this.apiRoute=route==='watch'?1:route==='web'?2:0;}
  constructor(private platform:'bili'|'douyin'|'rss', private started = Date.now()) {}
  event(stage:'api'|'candidate'|'prepare'|'first_frame'|'sample'|'exit', values:Record<string,unknown> = {}) {
    if(stage==='prepare')this.firstFrame=false;
    if (!videoOptEnabled('metrics') && !(this.platform==='bili'&&['api','candidate','first_frame'].includes(stage))) return;
    const allowed = ['apiMs','candidate','width','height','bitrate','sourceGeneration','bytesLoaded','firstByteMs','firstFrameMs','rebufferCount','rebufferMs','droppedFrames','throughputBps','cacheHit'];
    const safe:Record<string,number> = {};
    for (const key of allowed) if (typeof values[key] === 'number' && Number.isFinite(values[key])) safe[key] = Math.max(0, Math.floor(values[key] as number));
    appLogger.i('VideoOpt', JSON.stringify({session:this.session,platform:this.platform,stage,apiRoute:this.apiRoute,elapsedMs:Math.max(0,Date.now()-this.started),...safe}));
  }
  sample(state:{hasRenderedFirstFrame?:boolean;sourceGeneration?:number;width?:number;height?:number;metrics?:Record<string,number|undefined>}, presented = true) {
    const metrics = state.metrics ?? {};
    if (state.hasRenderedFirstFrame && presented && !this.firstFrame) { this.firstFrame = true; this.event('first_frame',{...metrics,sourceGeneration:state.sourceGeneration,width:state.width,height:state.height}); }
    if (Date.now()-this.lastSample >= 8000) { this.lastSample=Date.now(); this.event('sample',{...metrics,sourceGeneration:state.sourceGeneration}); }
    // Only native network transfer observations feed adaptation; no inference from ready/position.
    if (typeof metrics.throughputBps==='number' && Number.isFinite(metrics.throughputBps) && metrics.throughputBps > 0) observeVideoFeedback(metrics);
  }
}
