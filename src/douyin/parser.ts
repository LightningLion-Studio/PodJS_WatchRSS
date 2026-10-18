import {traceDouyinVariants} from './playback-diagnostics.ts';
import {applyPreferredDouyinPlayback} from './playback-selector.ts';
import {traceServiceWork} from "@podjs/framework/service-trace";
import type { DouyinCodec, DouyinContent, DouyinFeedPage, DouyinItem, DouyinVideoVariant } from "./types.ts";

const object = (v: unknown): Record<string, any> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === "string" ? v : v == null ? "" : String(v);
const number = (v: unknown): number => Number.isFinite(Number(v)) ? Number(v) : 0;
const firstUrl = (v: unknown): string => array(object(v)?.url_list).map(string).find(Boolean) ?? "";
function codec(v: Record<string, any>, fallback: DouyinCodec = "unknown"): DouyinCodec { const label=`${string(v.gear_name)} ${string(v.codec_type)}`.toLowerCase(); return number(v.is_h265)===1?"h265":/(h264|avc|avc1)/.test(label)?"h264":/(h265|hevc|hev1|hvc1|bvc1|bytevc1)/.test(label)?"h265":fallback; }
function variant(v: unknown, fallback: DouyinCodec = "unknown", gearName?: string): DouyinVideoVariant | null { const row=object(v), addr=object(row?.play_addr) ?? row; const playUrl=firstUrl(addr); if(!row||!addr||!playUrl)return null; const extra=object(row.video_extra); return {playUrl,codec:codec(row,fallback),bitrate:number(row.bit_rate),width:number(addr.width),height:number(addr.height),...(string(extra?.definition)?{definition:string(extra?.definition)}:{}),...(string(extra?.quality)||string(row.quality_type)?{quality:string(extra?.quality)||string(row.quality_type)}:{}),...(string(row.gear_name)||gearName?{gearName:string(row.gear_name)||gearName}: {})}; }
function variants(video: Record<string,any>): DouyinVideoVariant[] { const out:DouyinVideoVariant[]=[]; for(const row of array(video.bit_rate)){const v=variant(row);if(v&&!out.some(x=>x.playUrl===v.playUrl))out.push(v);} for(const [key,c] of [["play_addr_h264","h264"],["play_addr_h265","h265"],["play_addr_bytevc1","h265"],["play_addr","unknown"]] as const){const v=variant(object(video[key]),c,key);if(v&&!out.some(x=>x.playUrl===v.playUrl))out.push(v);} return out; }
export function parseDouyinItem(value: unknown,origin:"feed"|"detail"="detail"): DouyinItem | null { const row=object(value), author=object(row?.author), stats=object(row?.statistics), video=object(row?.video); if(!row||!video)return null; const vs=traceServiceWork("douyin.item.variants",()=>variants(video)), playUrl=firstUrl(video.play_addr)||vs[0]?.playUrl||"", awemeId=string(row.aweme_id).trim(); if(!awemeId||!playUrl)return null; const item=applyPreferredDouyinPlayback({awemeId,description:string(row.desc),createdAtSeconds:number(row.create_time),authorId:string(author?.uid),authorName:string(author?.nickname),...(firstUrl(author?.avatar_thumb)?{authorAvatar:firstUrl(author?.avatar_thumb)}:{}),likeCount:number(stats?.digg_count),commentCount:number(stats?.comment_count),shareCount:number(stats?.share_count),collectCount:number(stats?.collect_count),playUrl,...(firstUrl(video.cover)?{coverUrl:firstUrl(video.cover)}:{}),durationMs:number(video.duration),variants:vs});traceDouyinVariants(item,origin);return item; }
export function parseDouyinFeed(raw:string):DouyinFeedPage { const root=object(traceServiceWork("douyin.feed.json",()=>JSON.parse(raw),raw.length)); if(!root)throw new Error("响应不是 JSON 对象"); const items=traceServiceWork("douyin.feed.map",()=>array(root.aweme_list).map(row=>parseDouyinItem(row,"feed")).filter((v):v is DouyinItem=>v!==null),array(root.aweme_list).length); const cursor=number(root.max_cursor)>0?String(number(root.max_cursor)):string(root.cursor).trim()||null; return {items,nextCursor:cursor,hasMore:number(root.has_more)==1}; }
export function parseDouyinDetail(raw:string):DouyinContent { const detail=object(object(traceServiceWork("douyin.detail.json",()=>JSON.parse(raw),raw.length))?.aweme_detail); if(!detail)throw new Error("响应缺少 aweme_detail"); const type=number(detail.aweme_type); if(type===68||type===150){const images=array(detail.images).map(firstUrl).filter(Boolean);if(!images.length)throw new Error("图文内容缺少图片");return {kind:"note",awemeId:string(detail.aweme_id),description:string(detail.desc),authorName:string(object(detail.author)?.nickname),likeCount:number(object(detail.statistics)?.digg_count),imageUrls:images};} const item=parseDouyinItem(detail);if(!item)throw new Error("视频内容缺少标识或播放地址");return {kind:"video",item}; }

const urlAddress={url_list:null,width:null,height:null} as const;
const variantFields={play_addr:urlAddress,url_list:null,width:null,height:null,gear_name:null,codec_type:null,is_h265:null,bit_rate:null,video_extra:{definition:null,quality:null},quality_type:null} as const;
const itemFields={aweme_id:null,desc:null,create_time:null,author:{uid:null,nickname:null,avatar_thumb:{url_list:null}},statistics:{digg_count:null,comment_count:null,share_count:null,collect_count:null},video:{bit_rate:[variantFields],play_addr_h264:variantFields,play_addr_h265:variantFields,play_addr_bytevc1:variantFields,play_addr:variantFields,cover:{url_list:null},duration:null}} as const;
/** Only discard fields the existing mapper never reads. Native JSON projection
 * retains exact raw primitive spellings; the same mapper owns all app semantics. */
export async function parseDouyinFeedAsync(raw:string):Promise<DouyinFeedPage>{
 const {projectJsonAsync}=await import('@podjs/framework/json');
 const {prepareTextLayout,yieldWorkTurn}=await import('@podjs/framework/text-layout');
 const root=object(await projectJsonAsync(raw,{aweme_list:[itemFields],max_cursor:null,cursor:null,has_more:null}));
 if(!root)throw new Error('响应不是 JSON 对象');
 const items:DouyinItem[]=[];
 function* steps():Generator<void,void>{for(const row of array(root!.aweme_list)){const item=traceServiceWork('douyin.feed.item',()=>parseDouyinItem(row,"feed"));if(item)items.push(item);yield;}}
 let key=0;const task=prepareTextLayout(steps(),{key:()=>key++,entry:()=>undefined,publish:()=>{}},{yieldTurn:yieldWorkTurn,rowLimit:1});await task.done;
 const cursor=number(root.max_cursor)>0?String(number(root.max_cursor)):string(root.cursor).trim()||null;
 return {items,nextCursor:cursor,hasMore:number(root.has_more)==1};
}
