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
  private quarantined=new Set<string>();
  private persistence:Promise<void>=Promise.resolve();
  private readonly limit:number;
  constructor(private readonly client:DouyinClient,options:DouyinPlaybackQueueOptions){
    this.limit=Math.max(1,Math.min(40,Math.floor(options.limit??40)));
    const items=this.unique(options.items),selected=options.selectedAwemeId.trim(),index=Math.max(0,items.findIndex(x=>x.awemeId===selected));
    this.items=items.slice(Math.max(0,index-this.limit+1),Math.max(this.limit,index+1));
    this.index=Math.max(0,this.items.findIndex(x=>x.awemeId===selected));
    this.cursor=options.cursor?.trim()||null;this.hasMore=options.hasMore===true;
  }
  snapshot():Omit<DouyinPlaybackQueueState,"item">&{item:DouyinItem|null}{return {item:this.items[this.index]??null,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore};}
  cancel(){this.generation++;}
  /** Only a prepared foreground player records history, never speculative resolution. */
  async settled():Promise<void>{
    const state=this.snapshot();if(!state.item)return;const item=state.item;
    const write=this.persistence.catch(()=>{}).then(async()=>{await this.client.recordHistory(item);await this.client.saveRecentWindow(state.playlist,item.awemeId,state.cursor,state.hasMore);});
    this.persistence=write;await write;
  }
  async prefetch():Promise<void>{const op=this.generation;for(const item of this.items.slice(this.index+1,this.index+3)){if(op!==this.generation)return;await this.client.resolvePlayback(item.awemeId);}}
  async recover():Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const op=++this.generation;const result=await this.resolveAt(this.index,op,true);
    if(op!==this.generation)return cancelled();if(result.ok)return result;return this.discard();
  }
  async discard():Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const current=this.items[this.index];if(current){this.quarantined.add(current.awemeId);this.items.splice(this.index,1);this.index--;}
    return this.next();
  }
  async current():Promise<DouyinResult<DouyinPlaybackQueueState>>{return this.resolveAt(this.index,++this.generation);}
  async previous():Promise<DouyinResult<DouyinPlaybackQueueState>>{const op=++this.generation;if(this.index<=0)return {ok:false,code:"UNSUPPORTED",message:"已经是第一个视频"};return this.resolveAt(this.index-1,op);}
  async next():Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const op=++this.generation;
    let lastFailure:DouyinResult<DouyinPlaybackQueueState>={ok:false,code:"UNSUPPORTED",message:"已经是最后一个视频"};
    // Bound both failed candidates and duplicate-only server pages; never spin on a bad cursor.
    for(let attempt=0;attempt<40;attempt++){
      let target=this.index+1;
      if(target>=this.items.length&&this.hasMore){
        const oldCursor=this.cursor,page=await this.client.fetchFeedPage({cursor:this.cursor,count:12});
        if(op!==this.generation)return cancelled();if(!page.ok)return page;
        this.cursor=page.data.nextCursor;this.hasMore=page.data.hasMore&&this.cursor!==oldCursor;
        let merged=this.unique([...this.items,...page.data.items]).filter(item=>!this.quarantined.has(item.awemeId));
        const overflow=Math.max(0,merged.length-this.limit);
        if(overflow){merged=merged.slice(overflow);this.index=Math.max(-1,this.index-overflow);}
        this.items=merged;target=this.index+1;
      }
      if(target>=this.items.length){if(this.hasMore)continue;return lastFailure;}
      const result=await this.resolveAt(target,op);
      if(op!==this.generation)return cancelled();if(result.ok)return result;
      if(result.code==="NOT_LOGGED_IN")return result;
      lastFailure=result;this.quarantined.add(this.items[target].awemeId);this.items.splice(target,1);
    }
    return lastFailure;
  }
  private async resolveAt(target:number,op:number,forceRefresh=false):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const candidate=this.items[target];if(!candidate)return {ok:false,code:"UNSUPPORTED",message:"播放队列为空"};
    const resolved=await this.client.resolvePlayback(candidate.awemeId,{forceRefresh});
    if(op!==this.generation)return cancelled();if(!resolved.ok)return resolved;
    this.items[target]=resolved.data;this.index=target;
    return {ok:true,data:{item:resolved.data,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore},source:resolved.source};
  }
  private unique(items:DouyinItem[]){const seen=new Set<string>();return items.filter(item=>{const id=item.awemeId.trim();if(!id||seen.has(id))return false;seen.add(id);return true;});}
}
