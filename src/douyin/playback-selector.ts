import type {DouyinItem,DouyinVideoVariant} from './types.ts';

export const DOUYIN_TARGET_RESOLUTION=480;
/** Prefer a rendition covering the 466 px watch without paying for redundant pixels. */
export function normalizedDouyinResolution(v:DouyinVideoVariant):number|undefined {
  const label=[v.definition,v.quality,v.gearName].filter(x=>x!=null).join(' ').toLowerCase();
  const match=/(?<!\d)(2160|1440|1080|720|540|480)(?:p)?(?!\d)/.exec(label);
  if(match)return Number(match[1]);
  const sides=[v.width,v.height].filter(n=>n>0&&Number.isFinite(n));if(!sides.length)return;
  const short=Math.min(...sides);
  for(const base of [540,720,1080,1440,2160])if(short>=base&&short<=base*16/15)return base;
  return short;
}
export function selectPreferredDouyinVariant(variants:readonly DouyinVideoVariant[]):DouyinVideoVariant|undefined {
  const playable=variants.filter(v=>v.playUrl.trim()&&(v.codec!=='h265'||douyinCodecRuntimePolicy.canDecodeHevc(v)));
  const known=playable.filter(v=>v.codec!=='unknown'),pool=known.length?known:playable;
  const distance=(v:DouyinVideoVariant)=>{const r=normalizedDouyinResolution(v);return r===undefined?536870911:r>=466?r-466:100000+466-r;};
  return pool.reduce<DouyinVideoVariant|undefined>((best,v)=>{
    if(!best)return v;
    const compare=distance(v)-distance(best)||(v.bitrate>0?v.bitrate:Number.MAX_SAFE_INTEGER)-(best.bitrate>0?best.bitrate:Number.MAX_SAFE_INTEGER)||(v.codec==='h264'?0:1)-(best.codec==='h264'?0:1)||Math.max(best.width,best.height)-Math.max(v.width,v.height);
    return compare<0?v:best;
  },undefined);
}
export function selectPreferredDouyinUrl(variants:readonly DouyinVideoVariant[],fallback?:string|null):string|undefined {
  const selected=selectPreferredDouyinVariant(variants);if(selected)return selected.playUrl;
  const url=fallback?.trim();return url&&!variants.some(v=>v.codec==='h265'&&v.playUrl.trim()===url&&!douyinCodecRuntimePolicy.canDecodeHevc(v))?url:undefined;
}
/** Also reapplied at persisted/history/saved and queue boundaries: old snapshots used play_addr. */
export function applyPreferredDouyinPlayback<T extends DouyinItem>(item:T):T {
  if(!item||typeof item.playUrl!=='string')return item;
  const url=selectPreferredDouyinUrl(Array.isArray(item.variants)?item.variants:[],item.playUrl)??'';
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
