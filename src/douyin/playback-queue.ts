import {benchmark} from '@podjs/framework/benchmark';
import {applyPreferredDouyinPlayback} from './playback-selector.ts';
import type { DouyinClient } from "./client.ts";
import type { DouyinItem, DouyinResult } from "./types.ts";

export interface DouyinPlaybackQueueState { item: DouyinItem; playlist: DouyinItem[]; index: number; cursor: string | null; hasMore: boolean; }
export interface DouyinPlaybackQueueOptions { items: DouyinItem[]; selectedAwemeId: string; cursor?: string | null; hasMore?: boolean; limit?: number; fixedSources?: boolean; localPlayback?:(id:string)=>Promise<unknown>; }
const cancelled=<T>():DouyinResult<T>=>({ok:false,code:"CANCELLED",message:"播放队列操作已被更新的导航取消"});

export class DouyinPlaybackQueue {
  private items:DouyinItem[];
  private index:number;
  private cursor:string|null;
  private hasMore:boolean;
  private generation=0;
  private previewGeneration=0;
  private previewRevisions={next:[0,0,0,0,0],previous:[0,0,0,0,0]};
  private quarantined=new Set<string>();
  private persistence:Promise<void>=Promise.resolve();
  private pendingWrites=0;
  private write(work:()=>Promise<void>):Promise<void>{
    this.pendingWrites++;
    const pending=this.persistence.catch(()=>{}).then(work).finally(()=>{this.pendingWrites--;});
    this.persistence=pending;return pending;
  }
  private pageRequest?:Promise<DouyinResult<null>>;
  // One coalesced page can exceed a small window. Keep its tail off-window
  // until a resolved selection makes room, without losing the retry anchor.
  private ahead:DouyinItem[]=[];
  private queued(){return this.ahead.length?[...this.items,...this.ahead]:this.items;}
  private queuedItem(index:number){return index<this.items.length?this.items[index]:this.ahead[index-this.items.length];}
  private replaceQueued(index:number,item:DouyinItem){if(index<this.items.length)this.items[index]=item;else this.ahead[index-this.items.length]=item;}
  private removeQueued(index:number){if(index<this.items.length)this.items.splice(index,1);else this.ahead.splice(index-this.items.length,1);}
  private windowAt(index:number){
    const items=this.queued(),start=Math.min(index,Math.max(0,items.length-this.limit));
    return {items:items.slice(start,start+this.limit),ahead:items.slice(start+this.limit),index:index-start};
  }
  private select(index:number){const window=this.windowAt(index);this.items=window.items;this.ahead=window.ahead;this.index=window.index;}
  private emptyPages=0;
  private retryAt=0;
  private autoFailures=0;
  private readonly limit:number;
  private readonly fixedSources:boolean;
  constructor(private readonly client:DouyinClient,private readonly options:DouyinPlaybackQueueOptions){
    this.fixedSources=options.fixedSources===true;
    this.limit=Math.max(1,Math.min(200,Math.floor(options.limit??(options.hasMore === false ? 200 : 40))));
    const items=this.unique(options.items),selected=options.selectedAwemeId.trim(),index=Math.max(0,items.findIndex(x=>x.awemeId===selected));
    this.items=items.slice(Math.max(0,index-this.limit+1),Math.max(this.limit,index+1));
    this.index=Math.max(0,this.items.findIndex(x=>x.awemeId===selected));
    this.cursor=options.cursor?.trim()||null;this.hasMore=!this.fixedSources&&options.hasMore===true;
  }
  snapshot():Omit<DouyinPlaybackQueueState,"item">&{item:DouyinItem|null}{return {item:this.items[this.index]??null,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore};}
  /** Actual session-local removal set; native reason/count/timestamps are not recorded here. */
  diagnostics(){return {index:this.index,itemCount:this.items.length,hasMore:this.hasMore,generation:this.generation,previewGeneration:this.previewGeneration,quarantinedAwemeIds:[...this.quarantined]};}
  refreshPrefetchItem(id:string,item:DouyinItem):boolean{const target=this.queued().findIndex(value=>value.awemeId===id);if(target<0)return false;this.generation++;this.previewGeneration++;this.replaceQueued(target,applyPreferredDouyinPlayback(item));return true;}
  /** Recheck selection synchronously: a pending neighbour may have become foreground. */
  quarantinePrefetch(id:string):boolean{const target=this.queued().findIndex(value=>value.awemeId===id);if(target<0||target===this.index)return false;this.generation++;this.previewGeneration++;this.quarantined.add(id);this.removeQueued(target);if(target<this.index)this.index--;return true;}
  updateCurrentUrl(url:string){const current=this.items[this.index];if(current&&url.trim())this.items[this.index]={...current,playUrl:url};}
  /** A failed transport registration must not move the anchor away from the still selected source. */
  restoreSelection(awemeId:string):boolean{
    const index=this.queued().findIndex(item=>item.awemeId===awemeId);if(index<0)return false;
    this.cancel();this.select(index);return true;
  }
  cancel(){this.generation++;this.previewGeneration++;}
  /** Playback records on foreground preparation, never speculative resolution.
   * Native list/history detail-entry writes separately update the same deduplicated store. */
  /** Save the current pager before playback succeeds, as native buildResumeIntent does. */
  async persist():Promise<void>{
    const state=this.snapshot();if(!state.item)return;
    const write=this.write(()=>this.client.savePlaybackQueue(state.playlist,state.item!.awemeId,state.cursor,state.hasMore));
    await write;
  }
  resetAutomaticFailures(){this.autoFailures=0;}
  claimAutomaticFailure(){return ++this.autoFailures<3;}
  async settled():Promise<void>{
    const state=this.snapshot();if(!state.item)return;const item=state.item;
    const write=this.write(async()=>{await this.client.recordPresented?.(item);await this.client.recordHistory(item);await this.client.saveRecentWindow(state.playlist,item.awemeId,state.cursor,state.hasMore);await this.client.savePlaybackQueue(state.playlist,item.awemeId,state.cursor,state.hasMore);});
    await write;
  }
  async prefetch():Promise<void>{if(this.fixedSources)return;const op=this.generation;for(const item of this.queued().slice(this.index+1,this.index+3)){if(op!==this.generation)return;await this.client.resolvePlayback(item.awemeId,{prefetch:true,feedItem:item,allowDetail:false});}}
  /** Resolve one adjacent pager item without moving the persisted playback anchor. */
  async preview(direction:"next"|"previous",distance:1|2|3|4|5=1):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const epoch=this.previewGeneration,op=++this.previewRevisions[direction][distance-1],nav=this.generation;
    const current=()=>epoch===this.previewGeneration&&op===this.previewRevisions[direction][distance-1]&&nav===this.generation;
    if(distance>2){
      const target=this.index+(direction==='next'?distance:-distance);
      if(target<0||target>=this.queued().length)return {ok:false,code:'UNSUPPORTED',message:'没有邻域视频'};
      // Far speculation never fetches another feed page or an item detail.
      return this.resolvePreviewAt(target,current);
    }
    if(distance===2){
      const anchor=this.items[this.index]?.awemeId;
      if(direction==='next'&&this.index+2>=this.queued().length&&this.hasMore){const page=await this.loadPage();if(!current())return cancelled();if(!page.ok)return page;}
      if(!current()||this.items[this.index]?.awemeId!==anchor)return cancelled();
      const target=this.index+(direction==='next'?2:-2);
      if(target<0||target>=this.queued().length)return {ok:false,code:'UNSUPPORTED',message:'没有跨项视频'};
      return this.resolvePreviewAt(target,current);
    }
    if(direction==='previous'){
      if(this.index<=0)return {ok:false,code:'UNSUPPORTED',message:'已经是第一个视频'};
      return this.resolvePreviewAt(this.index-1,current);
    }
    return this.advance(current,target=>this.resolvePreviewAt(target,current));
  }
  /** Keep enough metadata ahead for normal paging; transport remains coalesced.
   * This does not resolve detail, allocate a decoder or move the selection. */
  async fillAhead(minimum=8):Promise<void>{
    if(this.fixedSources||!this.hasMore||this.queued().length-this.index-1>=Math.max(2,Math.min(16,minimum))||Date.now()<this.retryAt)return;
    await this.loadPage();
  }
  private preservesItem(code:string){return ['NOT_LOGGED_IN','CANCELLED','REQUEST_FAILED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE'].includes(code);}
  private async loadPage():Promise<DouyinResult<null>>{
    if(this.pageRequest)return this.pageRequest;
    if(this.ahead.length)return {ok:true,data:null};
    const cursor=this.cursor,anchor=this.items[this.index]?.awemeId;
    const work=(async():Promise<DouyinResult<null>>=>{
      // Repeated duplicate pages retry later, then refresh the feed, never mark it exhausted.
      const trace=benchmark.begin('pool_stage',{pool_stage:'refill_start',queue_index:this.queued().length,anchor_index:this.index});
      const page=await this.client.fetchFeedPage({cursor:this.emptyPages>=2?null:cursor,count:12,deferPersistence:true});
      benchmark.mark('pool_stage',trace,{pool_stage:'refill_end',queue_index:page.ok?page.data.items.length:0,anchor_index:this.index});
      if(!page.ok)return page;
      if(cursor!==this.cursor)return cancelled();
      const before=new Set(this.items.map(item=>item.awemeId));
      let merged=this.unique([...this.items,...page.data.items]).filter(item=>!this.quarantined.has(item.awemeId));
      const added=merged.some(item=>!before.has(item.awemeId));
      this.emptyPages=added?0:this.emptyPages+1;
      const overflow=Math.max(0,merged.length-this.limit);
      // A navigation inside this queue does not invalidate its feed cursor.
      // A reverse jump must still keep the selected item inside the bound.
      if(overflow>this.index&&this.items[this.index]?.awemeId!==anchor)return cancelled();
      this.cursor=page.data.nextCursor;this.hasMore=page.data.hasMore;
      if(overflow>this.index){
        this.ahead=merged.slice(this.items.length);
        this.items=merged.slice(0,this.items.length);
      }else{
        if(overflow){merged=merged.slice(overflow);this.index-=overflow;}
        this.items=merged;
      }
      if(!added&&this.hasMore){
        const retryAfterMs=Math.min(5000,500*2**Math.min(3,this.emptyPages-1));this.retryAt=Date.now()+retryAfterMs;
        return {ok:false,code:'TEMPORARILY_UNAVAILABLE',message:'暂无新视频，稍后重试',retryAfterMs};
      }
      return {ok:true,data:null};
    })();this.pageRequest=work;
    try{return await work;}finally{if(this.pageRequest===work)this.pageRequest=undefined;}
  }
  private async advance(current:()=>boolean,resolve:(target:number)=>Promise<DouyinResult<DouyinPlaybackQueueState>>,maxCandidates=3):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    if(Date.now()<this.retryAt)return {ok:false,code:'TEMPORARILY_UNAVAILABLE',message:'稍后重试',retryAfterMs:this.retryAt-Date.now()};
    let lastFailure:DouyinResult<DouyinPlaybackQueueState>={ok:false,code:'UNSUPPORTED',message:'已经是最后一个视频'};
    for(let attempt=0;attempt<Math.max(1,Math.min(3,maxCandidates));attempt++){
      if(this.index+1>=this.queued().length&&this.hasMore){const page=await this.loadPage();if(!current())return cancelled();if(!page.ok)return page;}
      const target=this.index+1;
      if(target>=this.queued().length)return lastFailure;
      const result=await resolve(target);
      if(!current()&&!result.ok)return cancelled();if(result.ok)return result;
      if(this.preservesItem(result.code))return result;
      lastFailure=result;this.quarantined.add(this.queuedItem(target)!.awemeId);this.removeQueued(target);
    }
    this.retryAt=Date.now()+500;return lastFailure;
  }
  /** Selection follows input, independently of transport or decoder readiness.
   * Advancing the generation fences all older resolutions and previews. */
  selectIntent(direction:"next"|"previous",distance:1|2=1):DouyinResult<DouyinPlaybackQueueState>{
    const target=this.index+(direction==='next'?distance:-distance);
    const clamped=Math.max(0,Math.min(this.queued().length-1,target));
    if(clamped===this.index)return {ok:false,code:'UNSUPPORTED',message:'没有相邻视频'};
    return this.commitPreview(this.queuedItem(clamped)!.awemeId);
  }
  /** Commit only the item previously resolved for a pager promotion. */
  commitPreview(awemeId:string):DouyinResult<DouyinPlaybackQueueState>{
    const target=this.queued().findIndex(item=>item.awemeId===awemeId);this.previewGeneration++;this.generation++;
    if(target<0)return {ok:false,code:"CANCELLED",message:"预加载视频已失效"};
    this.select(target);const item=this.items[this.index]!;
    return {ok:true,data:{item,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore},source:"feed-cache"};
  }
  async recover():Promise<DouyinResult<DouyinPlaybackQueueState>>{
    if(this.fixedSources)return this.current();
    this.previewGeneration++;const op=++this.generation;const result=await this.resolveAt(this.index,op,true);
    if(op!==this.generation)return cancelled();if(result.ok||this.preservesItem(result.code))return result;return this.discard(2);
  }
  async discard(maxCandidates=3):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const failed=this.items[this.index],op=this.generation+1;
    // Keep the retry anchor until another source is ready. A failed next() must
    // never leave index=-1 and make the player's Retry button ineffective.
    const result=await this.next(maxCandidates);
    if(op!==this.generation)return cancelled();if(!result.ok)return result;
    if(failed){
      this.quarantined.add(failed.awemeId);
      const removed=this.items.findIndex(item=>item.awemeId===failed.awemeId);
      if(removed>=0){this.items.splice(removed,1);if(removed<this.index)this.index--;}
    }
    return {...result,data:{...result.data,playlist:[...this.items],index:this.index}};
  }
  async current():Promise<DouyinResult<DouyinPlaybackQueueState>>{this.previewGeneration++;return this.resolveAt(this.index,++this.generation);}
  async previous():Promise<DouyinResult<DouyinPlaybackQueueState>>{this.previewGeneration++;const op=++this.generation;if(this.index<=0)return {ok:false,code:"UNSUPPORTED",message:"已经是第一个视频"};return this.resolveAt(this.index-1,op);}
  async next(maxCandidates=3):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    this.previewGeneration++;const op=++this.generation;
    return this.advance(()=>op===this.generation,target=>this.resolveAt(target,op),maxCandidates);
  }

  private async resolveAt(target:number,op:number,forceRefresh=false):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const candidate=this.queuedItem(target);if(!candidate)return {ok:false,code:"UNSUPPORTED",message:"播放队列为空"};
    const resolved:DouyinResult<DouyinItem>=this.fixedSources||!forceRefresh&&await this.options.localPlayback?.(candidate.awemeId)?{ok:true,data:candidate}:await this.client.resolvePlayback(candidate.awemeId,{forceRefresh,feedItem:candidate,allowDetail:false});
    if(op!==this.generation)return cancelled();if(!resolved.ok)return resolved;
    this.replaceQueued(target,resolved.data);this.select(target);
    return {ok:true,data:{item:resolved.data,playlist:[...this.items],index:this.index,cursor:this.cursor,hasMore:this.hasMore},source:resolved.source};
  }
  private async resolvePreviewAt(target:number,current:()=>boolean):Promise<DouyinResult<DouyinPlaybackQueueState>>{
    const candidate=this.queuedItem(target);if(!candidate)return {ok:false,code:"UNSUPPORTED",message:"播放队列为空"};
    const resolved:DouyinResult<DouyinItem>=this.fixedSources||await this.options.localPlayback?.(candidate.awemeId)?{ok:true,data:candidate}:await this.client.resolvePlayback(candidate.awemeId,{feedItem:candidate,allowDetail:false});
    if(!current())return cancelled();
    target=this.queued().findIndex(item=>item.awemeId===candidate.awemeId);
    if(target<0||target===this.index)return cancelled();if(!resolved.ok)return resolved;
    this.replaceQueued(target,resolved.data);const window=this.windowAt(target);
    return {ok:true,data:{item:resolved.data,playlist:window.items,index:window.index,cursor:this.cursor,hasMore:this.hasMore},source:resolved.source};
  }
  private unique(items:DouyinItem[]){const seen=new Set<string>();return items.map(applyPreferredDouyinPlayback).filter(item=>{const id=item.awemeId.trim();if(!id||seen.has(id))return false;seen.add(id);return true;});}
}
