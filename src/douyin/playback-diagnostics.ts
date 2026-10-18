import {appLogger} from '../logs/app-logger.ts';
import {normalizedDouyinResolution,selectPreferredDouyinVariant} from './playback-selector.ts';
import type {DouyinItem} from './types.ts';

/** Only numeric variant metadata and fixed enums; never IDs, labels, URLs or headers. */
export function douyinVariantSummary(item:DouyinItem){
 const variants=item.variants??[],selected=selectPreferredDouyinVariant(variants);
 const safe=(value:number)=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
 return {count:variants.length,selected:variants.indexOf(selected!),variants:variants.slice(0,32).map(v=>({
  codec:v.codec==='h264'?'h264':v.codec==='h265'?'h265':'unknown',width:safe(v.width),height:safe(v.height),
  bitrate:safe(v.bitrate),resolution:safe(normalizedDouyinResolution(v)??0),playable:!!v.playUrl.trim(),
 }))};
}
export function traceDouyinVariants(item:DouyinItem,outlet:'feed'|'detail'|'foreground',source?:'feed-cache'|'network'){
 appLogger.i('DouyinVariants',JSON.stringify({outlet,...(source?{source}:{}),...douyinVariantSummary(item)}));
}
