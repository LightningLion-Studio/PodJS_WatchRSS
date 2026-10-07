import type {ContentBlock} from '../reader/content.ts';
import {resolveUrl} from '../core/parser.ts';
export const CACHE_BUCKETS=['douyin-preload','images','bili-preview','rss-offline'] as const;
export type CacheBucket=typeof CACHE_BUCKETS[number];
export type CacheFile={path:string;bucket:CacheBucket;size:number;modified:number};
export const CACHE_ROOT='managed-cache';
export function cacheSizeLabel(mb:number):string {if(mb<1024)return `${Math.floor(mb)}M`;const tenths=Math.floor(mb*10/1024);return `${Math.floor(tenths/10)}${tenths%10?'.'+tenths%10:''}G`;}
export function cachePrefetchMode(mode:string):{label:string;summary:string;count:number|null} {
 return mode==='关闭'?{label:'0张',summary:'不提前缓存原文媒体',count:0}:mode==='全部'?{label:'全部',summary:'进入原文后后台缓存全部媒体',count:null}:{label:'4张',summary:'进入原文后后台缓存前 4 项媒体',count:4};
}
/** Native detail prefetch selects distinct nonlocal Image blocks; Video blocks are a separate path. */
export function inlineImageTargets(blocks:readonly ContentBlock[],baseUrl:string|undefined,mode:string):string[] {
 const urls=[...new Set(blocks.filter((b):b is Extract<ContentBlock,{type:'image'}>=>b.type==='image').map(b=>resolveUrl(b.url,baseUrl)??b.url).filter(url=>/^https?:\/\//i.test(url)))];
 const count=cachePrefetchMode(mode).count;return count===null?urls:urls.slice(0,count);
}
/** Same bucket priority and 6 -> 4 Douyin reserve as native ManagedCacheService; offline is never evicted. */
export function cacheEvictionOrder(files:readonly CacheFile[],limit:number,pinned:ReadonlySet<string>=new Set()):CacheFile[] {
 let total=files.reduce((n,f)=>n+f.size,0);const removed=new Set<string>(),result:CacheFile[]=[];
 for(const [bucket,reserve] of [['douyin-preload',6],['images',0],['bili-preview',0],['douyin-preload',4]] as const){
  const rows=files.filter(f=>f.bucket===bucket&&!removed.has(f.path)).sort((a,b)=>a.modified-b.modified);
  const candidates=reserve?rows.slice(0,Math.max(0,rows.length-reserve)):rows;
  for(const f of candidates){if(total<=limit)break;if(pinned.has(f.path))continue;removed.add(f.path);result.push(f);total-=f.size;}
 }
 return result;
}
