import {normalizedDouyinResolution,selectPreferredDouyinVariant} from './playback-selector.ts';
import type {DouyinItem} from './types.ts';
/** Product policy only; the framework enforces storage and transport ceilings. */
export function douyinPrestoreConfig(value:unknown){
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const n=(key:string,fallback:number,min:number,max:number)=>typeof v[key]==='number'&&Number.isFinite(v[key])?Math.max(min,Math.min(max,Math.floor(v[key] as number))):fallback;
 return {enabled:v.enabled!==false,ahead:n('ahead',20,1,20),count:n('count',3,1,5),entryBytes:n('entryBytes',32*1024*1024,128*1024,32*1024*1024),totalBytes:n('totalBytes',128*1024*1024,128*1024,128*1024*1024),frameBytes:n('frameBytes',10*1024*1024,128*1024,10*1024*1024),headBytes:n('headBytes',16*1024*1024,128*1024,16*1024*1024),bytesPerSecond:n('bytesPerSecond',256*1024,16*1024,1024*1024),minBattery:n('minBattery',20,0,100),minFreeBytes:n('minFreeBytes',512*1024*1024,0,512*1024*1024)};
}
export function storedDouyinMetadata(item:DouyinItem):Record<string,unknown>{
 const variant=item.variants.find(v=>v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl));
 return {awemeId:item.awemeId.slice(0,256),description:item.description?.slice(0,2000)??'',authorId:item.authorId?.slice(0,256)??'',authorName:item.authorName?.slice(0,256)??'',createdAtSeconds:item.createdAtSeconds??0,durationMs:item.durationMs,
  likeCount:item.likeCount??0,commentCount:item.commentCount??0,shareCount:item.shareCount??0,collectCount:item.collectCount??0,
  codec:variant?.codec??'unknown',width:variant?.width??0,height:variant?.height??0,bitrate:variant?.bitrate??0};
}
export function restoredDouyinItem(metadata:Record<string,unknown>,uri:string):DouyinItem|undefined{
 if(typeof metadata.awemeId!=='string'||!metadata.awemeId||typeof metadata.description!=='string'||typeof metadata.authorName!=='string'||typeof metadata.durationMs!=='number'||!uri.startsWith('file://'))return;
 const number=(k:string)=>typeof metadata[k]==='number'&&Number.isFinite(metadata[k])?metadata[k] as number:0;
 return {awemeId:metadata.awemeId,description:metadata.description,authorName:metadata.authorName,authorId:String(metadata.authorId??''),createdAtSeconds:number('createdAtSeconds'),durationMs:number('durationMs'),likeCount:number('likeCount'),commentCount:number('commentCount'),shareCount:number('shareCount'),collectCount:number('collectCount'),playUrl:uri,
  variants:[{playUrl:uri,codec:metadata.codec==='h264'||metadata.codec==='h265'?metadata.codec:'unknown',width:number('width'),height:number('height'),bitrate:number('bitrate')}]};
}

/** Prefer watch-sized 540p at its lowest bitrate. The native store downloads
 * and remuxes DASH companions; their combined input and output share the cap. */
export function completeDouyinRendition(item:DouyinItem):DouyinItem|undefined {
 const eligible=item.variants.filter(v=>selectPreferredDouyinVariant([v])===v&&/^https?:/.test(v.playUrl));
 const rank=(v:typeof eligible[number])=>{const r=normalizedDouyinResolution(v);return r===540?0:r===undefined?1e9:r>=466?1000+r:100000+466-r;};
 const bitrate=(v:typeof eligible[number])=>v.bitrate>0?v.bitrate:Infinity;
 const chosen=eligible.reduce<typeof eligible[number]|undefined>((best,v)=>{
  if(!best)return v;
  const resolution=rank(v)-rank(best);
  return resolution<0||resolution===0&&(bitrate(v)<bitrate(best)||bitrate(v)===bitrate(best)&&v.codec==='h264'&&best.codec!=='h264')?v:best;
 },undefined);
 if(chosen)return {...item,playUrl:chosen.playUrl,variants:[chosen]};
 // Legacy feeds expose only a play URL; the native track probe is authoritative.
 if(!item.variants.length&&/^https?:/.test(item.playUrl))return item;
}
