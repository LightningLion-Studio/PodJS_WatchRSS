import type { DouyinClient } from "./client.ts";
import type { DouyinItem, DouyinResult } from "./types.ts";

export interface DouyinPlaybackQueueState { item: DouyinItem; playlist: DouyinItem[]; index: number; cursor: string | null; hasMore: boolean; }
export interface DouyinPlaybackQueueOptions { items: DouyinItem[]; selectedAwemeId: string; cursor?: string | null; hasMore?: boolean; limit?: number; }
const cancelled=<T>():DouyinResult<T>=>({ok:false,code:"CANCELLED",message:"播放队列操作已被更新的导航取消"});

export class DouyinPlaybackQueue {
  private items:DouyinItem[];
  private index:number;
  private cursor:string|null;
  private hasMore:boolean;
  private generation=0;
  private readonly limit:number;
  constructor(private readonly client:DouyinClient,options:DouyinPlaybackQueueOptions){this.limit=Math.max(1,Math.min(40,Math.floor(options.limit??40)));this.items=this.unique(options.items).slice(0,this.limit);const selected=options.selectedAwemeId.trim();this.index=Math.max(0,this.items.findIndex(x=>x.awemeId===selected));this.cursor=options.cursor?.trim()||null;this.hasMore=options.hasMore===true;}
  snapshot():Omit<DouyinPlaybackQueueState,"item">&{item:DouyinItem|null}{return {item:this.items[this.index]??null,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore};}
  cancel(){this.generation++;}
  async current():Promise<DouyinResult<DouyinPlaybackQueueState>>{return this.resolveAt(this.index,++this.generation);}
  async previous():Promise<DouyinResult<DouyinPlaybackQueueState>>{const op=++this.generation;if(this.index<=0)return {ok:false,code:"UNSUPPORTED",message:"已经是第一个视频"};return this.resolveAt(this.index-1,op);}
  async next():Promise<DouyinResult<DouyinPlaybackQueueState>>{const op=++this.generation;let target=this.index+1;if(target>=this.items.length&&this.hasMore){const page=await this.client.fetchFeedPage({cursor:this.cursor,count:12});if(op!==this.generation)return cancelled();if(!page.ok)return page;this.cursor=page.data.nextCursor;this.hasMore=page.data.hasMore;let merged=this.unique([...this.items,...page.data.items]);const overflow=Math.max(0,merged.length-this.limit);if(overflow){merged=merged.slice(overflow);this.index=Math.max(0,this.index-overflow);}this.items=merged;target=this.index+1;}if(target>=this.items.length)return {ok:false,code:"UNSUPPORTED",message:"已经是最后一个视频"};return this.resolveAt(target,op);}
  private async resolveAt(target:number,op:number):Promise<DouyinResult<DouyinPlaybackQueueState>>{const candidate=this.items[target];if(!candidate)return {ok:false,code:"UNSUPPORTED",message:"播放队列为空"};const resolved=await this.client.resolvePlayback(candidate.awemeId);if(op!==this.generation)return cancelled();if(!resolved.ok)return resolved;this.items[target]=resolved.data;this.index=target;return {ok:true,data:{item:resolved.data,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore},source:resolved.source};}
  private unique(items:DouyinItem[]){const seen=new Set<string>();return items.filter(item=>{const id=item.awemeId.trim();if(!id||seen.has(id))return false;seen.add(id);return true;});}
}
