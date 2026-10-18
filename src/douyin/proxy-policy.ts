import type {DouyinItem} from './types.ts';
export const DOUYIN_PROXY={entryLimit:16,prefetchCount:2,backwardCount:5,snapshotCount:6,minEntryBytes:512*1024,maxEntryBytes:4*1024*1024,maxPrefetchBytes:2*1024*1024,minTotalBytes:6*1024*1024,maxTotalBytes:16*1024*1024} as const;
/** Native PreviewCache estimates use 30s capture, 16s prefetch, and a 256KiB/s fallback. */
export function douyinPreviewBytes(contentLength:number|undefined,durationMs:number):number {
 const length=contentLength===undefined?undefined:Math.min(2147483647,contentLength);
 if(length!==undefined&&length>0&&durationMs>0)return Math.min(Math.max(DOUYIN_PROXY.minEntryBytes,Math.floor(length*Math.min(durationMs,30000)/durationMs)),length,DOUYIN_PROXY.maxEntryBytes);
 if(durationMs>0)return Math.min(Math.max(DOUYIN_PROXY.minEntryBytes,Math.floor(256*1024*Math.min(durationMs,30000)/1000)),DOUYIN_PROXY.maxEntryBytes);
 return DOUYIN_PROXY.maxEntryBytes;
}
export function douyinPrefetchBytes(length:number|undefined,durationMs:number,order=0):number {
 const base=Math.min(douyinPreviewBytes(length,Math.min(Math.max(0,durationMs),16000)),DOUYIN_PROXY.maxPrefetchBytes);
 const index=Math.max(0,order);return Math.max(DOUYIN_PROXY.minEntryBytes,Math.floor(index===0?base:index===1?base*3/4:index<=3?base/2:base/4));
}
export function douyinPrefetchBandwidth(foregroundBitrate?:number,totalBytesPerSecond?:number):number {
 const total=totalBytesPerSecond===undefined?undefined:Math.max(0,totalBytesPerSecond);
 if(!foregroundBitrate||foregroundBitrate<=0)return total??Infinity;
 if(!total)return 0;
 return Math.max(0,total-Math.ceil(foregroundBitrate*13/80));
}
export function douyinProxyWindow(items:readonly DouyinItem[],anchor:string|undefined,mode:'entry'|'active'):DouyinItem[] {
 if(!items.length)return [];const center=Math.max(0,items.findIndex(i=>i.awemeId===anchor));const order=[center,center+1,center+2,...(mode==='active'?Array.from({length:5},(_,i)=>center-i-1):[])];
 const seen=new Set<string>();return order.map(i=>items[i]).filter((item):item is DouyinItem=>{if(!item||!item.awemeId.trim()||!item.playUrl.trim()||seen.has(item.awemeId))return false;seen.add(item.awemeId);return true;}).slice(0,DOUYIN_PROXY.entryLimit);
}
