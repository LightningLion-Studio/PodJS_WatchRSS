import type {DouyinItem} from './types.ts';
export const DOUYIN_PROXY={entryLimit:24,prefetchCount:20,backwardCount:3,snapshotCount:6,minEntryBytes:128*1024,maxEntryBytes:4*1024*1024,maxPrefetchBytes:2*1024*1024,minTotalBytes:6*1024*1024,maxTotalBytes:16*1024*1024} as const;
/** Samples for approximately 1.5 s plus a bounded header allowance. Native MP4 planning adds moov. */
export function douyinPreviewBytes(contentLength:number|undefined,durationMs:number,bitrate=0):number {
 const rate=bitrate>0?bitrate:contentLength&&durationMs>0?contentLength*8000/durationMs:512*1024;
 const bytes=Math.ceil(rate*1.5/8)+128*1024;
 return Math.min(contentLength&&contentLength>0?contentLength:Infinity,DOUYIN_PROXY.maxEntryBytes,Math.max(DOUYIN_PROXY.minEntryBytes,bytes));
}
export function douyinPrefetchBytes(length:number|undefined,durationMs:number,_order=0,bitrate=0):number {
 return Math.min(douyinPreviewBytes(length,durationMs,bitrate),DOUYIN_PROXY.maxPrefetchBytes);
}
export function douyinPrefetchBandwidth(foregroundBitrate?:number,totalBytesPerSecond?:number):number {
 const total=totalBytesPerSecond===undefined?undefined:Math.max(0,totalBytesPerSecond);
 if(!foregroundBitrate||foregroundBitrate<=0)return total??Infinity;
 if(!total)return 0;
 return Math.max(0,total-Math.ceil(foregroundBitrate*13/80));
}
export function douyinProxyWindow(items:readonly DouyinItem[],anchor:string|undefined,mode:'entry'|'active',ahead:number=DOUYIN_PROXY.prefetchCount):DouyinItem[] {
 if(!items.length)return [];const center=Math.max(0,items.findIndex(i=>i.awemeId===anchor));const order=[center,center+1,...(mode==='active'?Array.from({length:DOUYIN_PROXY.backwardCount},(_,i)=>center-i-1):[]),...Array.from({length:Math.max(0,Math.min(20,ahead)-1)},(_,i)=>center+i+2)];
 const seen=new Set<string>();return order.map(i=>items[i]).filter((item):item is DouyinItem=>{if(!item||!item.awemeId.trim()||!item.playUrl.trim()||seen.has(item.awemeId))return false;seen.add(item.awemeId);return true;}).slice(0,DOUYIN_PROXY.entryLimit);
}
