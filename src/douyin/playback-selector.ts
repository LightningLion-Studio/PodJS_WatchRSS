import type {DouyinItem,DouyinVideoVariant} from './types.ts';
import {memoryPressureLevel,processMemoryBudgetBytes} from '@podjs/framework/memory';

export const DOUYIN_TARGET_RESOLUTION=480;
export const DOUYIN_MAX_SHORT_EDGE=720;
export const DOUYIN_RESOLUTION_LIMIT='resolution_limit';

export function douyinPlaybackAudio(item:Pick<DouyinItem,'playUrl'|'variants'>,url=item.playUrl):string|undefined {
  const variant=item.variants?.find(v=>v.playUrl===url||v.playUrls?.includes(url));
  return variant?.format==='dash'?variant.audioUrl:undefined;
}
export function labeledResolution(v:DouyinVideoVariant):number|undefined {
  const label=[v.definition,v.quality,v.gearName].filter(x=>x!=null).join(' ').toLowerCase();
  const matches=Array.from(label.matchAll(/(?<![a-z0-9])(\d{3,4})p(?!\d)|(?<!\d)(2160|1440|1080|720|540|480|360|240|144)(?!\d)/g),match=>Number(match[1]??match[2]));
  if(matches.length)return Math.max(...matches);
}

function shortEdge(v:DouyinVideoVariant):number|undefined {
  const sides=[v.width,v.height].filter(n=>n>0&&Number.isFinite(n));
  if(sides.length)return Math.min(...sides);
}

export function normalizedDouyinResolution(v:DouyinVideoVariant):number|undefined {
  const label=labeledResolution(v);
  if(label!==undefined)return label;
  const short=shortEdge(v);
  if(short===undefined)return;
  for(const base of [360,480,540,720,1080,1440,2160])if(short>=base&&short<=base*16/15)return base;
  return short;
}

function resolutionRank(v:DouyinVideoVariant):number {
  const r=normalizedDouyinResolution(v);
  if(r===undefined)return Infinity;
  if(r===480)return 0;
  if(r===360)return 1;
  if(r===540)return 2;
  if(r===720)return 3;
  if(r<360)return 1000-r;
  // Nonstandard in-cap dimensions follow the named renditions.
  return 4+Math.abs(r-DOUYIN_TARGET_RESOLUTION)/DOUYIN_MAX_SHORT_EDGE;
}

export function prefersLowMemoryDouyinRendition():boolean {
  return processMemoryBudgetBytes()>0&&memoryPressureLevel()>=2;
}

export function selectPreferredDouyinVariant(variants:readonly DouyinVideoVariant[]):DouyinVideoVariant|undefined {
  const playable=variants.filter(v=>typeof v?.playUrl==='string'&&v.playUrl.trim()
    &&(v.format!=='dash'||!!v.audioUrl)&&(v.codec!=='h265'||douyinCodecRuntimePolicy.canDecodeHevc(v)));
  // A lower tier is optional. Keep the standard capped order as the fallback.
  const smaller=prefersLowMemoryDouyinRendition()?playable.filter(v=>{
    const resolution=normalizedDouyinResolution(v);
    return resolution!==undefined&&resolution<=320&&(shortEdge(v)??0)<=320;
  }):[];
  const pool=smaller.length?smaller:playable;
  const bitrate=(v:DouyinVideoVariant)=>v.bitrate>0?v.bitrate:Infinity;
  return pool.reduce<DouyinVideoVariant|undefined>((best,v)=>{
    if(!best)return v;
    const compare=resolutionRank(v)-resolutionRank(best)||bitrate(v)-bitrate(best)
      ||Number(best.codec==='h264')-Number(v.codec==='h264');
    return compare<0?v:best;
  },undefined);
}

export function selectPreferredDouyinUrl(variants:readonly DouyinVideoVariant[],fallback?:string|null):string|undefined {
  return selectPreferredDouyinVariant(variants)?.playUrl||(!variants.length?fallback?.trim()||undefined:undefined);
}

/** Also reapplied at persisted/history/saved and queue boundaries: old snapshots used play_addr. */
export function applyPreferredDouyinPlayback<T extends DouyinItem>(item:T):T {
  if(!item||typeof item.playUrl!=='string')return item;
  const variants=Array.isArray(item.variants)?item.variants:[];
  const url=selectPreferredDouyinUrl(variants,item.playUrl)??'';
  return url===item.playUrl?item:{...item,playUrl:url};
}
/** Session-scoped sticky policy. HEVC requires explicit device size confirmation. */
export class DouyinCodecRuntimePolicy {
  private attempts=0;private failures=0;private forced=false;
  private readonly confirmed=new Set<string>();
  confirmHevcSize(v:Pick<DouyinVideoVariant,'width'|'height'>,supported:boolean){const key=`${v.width}x${v.height}`;if(supported&&v.width>0&&v.height>0)this.confirmed.add(key);else this.confirmed.delete(key);}
  canDecodeHevc(v:Pick<DouyinVideoVariant,'width'|'height'>){return !this.forced&&this.confirmed.has(`${v.width}x${v.height}`);}

  shouldPreferH264InAutoMode(){return this.forced;}
  recordAutoHevcAttempt(){this.attempts++;return this.update();}
  recordAutoHevcFailure(){this.failures=Math.min(this.failures+1,Math.max(this.attempts,1));return this.update();}
  snapshot(){return {autoHevcAttempts:this.attempts,autoHevcFailures:this.failures,autoForceH264:this.forced};}
  private update(){const previous=this.forced;this.forced=this.forced||this.attempts>=2&&this.failures*2>this.attempts;return previous!==this.forced;}
}
export const douyinCodecRuntimePolicy=new DouyinCodecRuntimePolicy();
