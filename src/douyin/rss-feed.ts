import {traceServiceWork} from "@podjs/framework/service-trace";
import type { DouyinClient } from './client.ts';
import type { DouyinItem } from './types.ts';

export type DouyinRssRow=Pick<DouyinItem,'awemeId'|'description'|'authorName'|'likeCount'>;
export interface DouyinRssArchive {
  write(group:number,items:DouyinItem[]):Promise<void>;
  read(group:number,id:string):Promise<DouyinItem|undefined>;
  drop(group:number):Promise<void>;
}
function freshDouyinItems(seen:Set<string>,items:readonly DouyinItem[]):DouyinItem[] {
  const fresh:DouyinItem[]=[];
  for(const item of items){
    if(seen.has(item.awemeId))continue;
    seen.add(item.awemeId);
    fresh.push(item);
  }
  return fresh;
}
export function appendDouyinItems(source:readonly DouyinItem[],incoming:readonly DouyinItem[]):DouyinItem[] {
  return [...source,...freshDouyinItems(new Set(source.map(item=>item.awemeId)),incoming)];
}
let nextGroup=0;
const IN_MEMORY_ITEMS=24;
class RssItems {
  private readonly group=++nextGroup;
  private full=new Map<string,DouyinItem>();
  private usedStorage=false;
  private owners=0;
  private retired=false;
  private closed=false;
  private write?:Promise<void>;
  constructor(private archive?:DouyinRssArchive){}
  retain(){this.owners++;}
  release(){this.owners--;if(this.retired)this.discard();}
  add(items:DouyinItem[]) {
    for(const item of items)this.full.set(item.awemeId,item);
    if(this.write||!this.archive||this.full.size<=IN_MEMORY_ITEMS)return;
    const archive=this.archive;
    this.write=(async()=>{
      while(!this.closed&&this.full.size>IN_MEMORY_ITEMS){
        const page:DouyinItem[]=[];
        for(const item of this.full.values()){
          page.push(item);
          if(page.length>=Math.min(12,this.full.size-IN_MEMORY_ITEMS))break;
        }
        this.usedStorage=true;
        await archive.write(this.group,page);
        for(const item of page)this.full.delete(item.awemeId);
      }
    })().catch(()=>{/* The in-memory items remain usable if cache storage is full. */}).finally(()=>{this.write=undefined;});
  }
  async get(id:string){return this.full.get(id)??await this.archive?.read(this.group,id);}
  discard(){
    this.retired=true;
    if(this.closed||this.owners)return;
    this.closed=true;this.full.clear();
    void Promise.resolve(this.write).then(()=>this.usedStorage&&this.archive?this.archive.drop(this.group):undefined).catch(()=>{});
  }
}
export interface DouyinRssFeedSnapshot {items:DouyinRssRow[];cursor?:string;hasMore:boolean;records:RssItems;}
export interface DouyinRssFeedState extends DouyinRssFeedSnapshot { loading: boolean; error: string }
export class DouyinRssFeedController {
  state:DouyinRssFeedState;
  private ids:Set<string>;
  private disposed=false;
  private revision=0;
  constructor(private client:Pick<DouyinClient,'fetchFeedPage'>,initial?:DouyinRssFeedSnapshot,
    private changed:(state:DouyinRssFeedState)=>void=()=>{},
    private saved:(snapshot:DouyinRssFeedSnapshot)=>void=()=>{},private archive?:DouyinRssArchive){
    this.state={items:initial?.items??[],records:initial?.records??new RssItems(archive),cursor:initial?.cursor,hasMore:initial?.hasMore??true,loading:false,error:''};
    this.state.records.retain();
    this.ids=new Set(this.state.items.map(item=>item.awemeId));
  }
  item(id:string){return this.ids.has(id)?this.state.records.get(id):Promise.resolve(undefined);}
  reset(){
    if(this.disposed)return;
    this.revision++;this.ids.clear();
    this.state.records.discard();this.state.records.release();
    const records=new RssItems(this.archive);records.retain();
    this.publish({items:[],records,cursor:undefined,hasMore:true,loading:false,error:''});
  }
  get loading() { return this.state.loading; }
  get hasMore() { return this.state.hasMore; }
  refresh() { return this.load(false); }
  loadMore() { return this.load(true); }
  dispose(){if(!this.disposed){this.disposed=true;this.state.records.release();}}
  private publish(patch: Partial<DouyinRssFeedState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; traceServiceWork("douyin.rss.publish",()=>this.changed(this.state)); } }
  private async load(append: boolean) {
    if (this.disposed || this.loading || append && !this.hasMore) return;
    const revision=this.revision;
    this.publish({ loading: true, error: '' });
    try {
      const result = await this.client.fetchFeedPage({ cursor: append ? this.state.cursor : undefined, count: 12,publishBeforeSave:true });
      if (this.disposed||revision!==this.revision) return;
      if (!result.ok) { this.publish({ error: result.message }); return; }
      const records=append?this.state.records:new RssItems(this.archive);
      if(!append){this.state.records.discard();this.state.records.release();records.retain();this.ids.clear();}
      const newRows=traceServiceWork('douyin.rss.append',()=>{
        const fresh=freshDouyinItems(this.ids,result.data.items);
        records.add(fresh);
        return fresh.map(({awemeId,description,authorName,likeCount})=>({awemeId,description,authorName,likeCount}));
      });
      const snapshot={records,items:append?this.state.items.concat(newRows):newRows,
        cursor:result.data.nextCursor??(append?this.state.cursor:undefined),hasMore:result.data.hasMore};
      traceServiceWork("douyin.rss.save",()=>this.saved(snapshot)); this.publish(snapshot);
    } catch (error) { if(revision===this.revision)this.publish({ error: String(error) }); }
    finally { if(revision===this.revision)this.publish({ loading: false }); }
  }
}
