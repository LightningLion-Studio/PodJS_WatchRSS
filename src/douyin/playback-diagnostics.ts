import {benchmark} from '@podjs/framework/benchmark';
import {appLogger} from '../logs/app-logger.ts';
import {normalizedDouyinResolution,selectPreferredDouyinVariant} from './playback-selector.ts';
import type {DouyinItem} from './types.ts';

/** Only numeric variant metadata and fixed enums; never IDs, labels, URLs or headers. */
export function douyinVariantSummary(item:DouyinItem){
 const variants=item.variants??[],selected=selectPreferredDouyinVariant(variants);
 const gear=(value:string|undefined)=>{const match=/(?:^|_)([0-9]{3,4})(?:_|p|$)/.exec(value??'');return match?Number(match[1]):0;};
 const safe=(value:number)=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
 return {count:variants.length,selected:variants.indexOf(selected!),variants:variants.slice(0,32).map(v=>({
  codec:v.codec==='h264'?'h264':v.codec==='h265'?'h265':'unknown',width:safe(v.width),height:safe(v.height),
  bitrate:safe(v.bitrate),gear:gear(v.gearName),resolution:safe(normalizedDouyinResolution(v)??0),playable:!!v.playUrl.trim(),
 }))};
}
export function traceDouyinVariants(item:DouyinItem,outlet:'feed'|'detail'|'foreground',source?:'feed-cache'|'network'){
 const summary=douyinVariantSummary(item);let seq=0;for(const [index,v]of summary.variants.entries()){const row={variant_outlet:outlet,variant_index:index,variant_count:summary.count,width:v.width,height:v.height,bitrate:v.bitrate,gear:v.gear,codec:v.codec as 'h264'|'h265'|'unknown',selected:index===summary.selected};if(seq)benchmark.mark('media_variant',seq,row);else seq=benchmark.begin('media_variant',row);}
 appLogger.i('DouyinVariants',JSON.stringify({outlet,...(source?{source}:{}),...douyinVariantSummary(item)}));
}
