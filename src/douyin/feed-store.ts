import {applyPreferredDouyinPlayback} from './playback-selector.ts';
import {projectJsonAsync} from "@podjs/framework/json";
import {yieldWorkTurn} from "@podjs/framework/text-layout";
import {traceServiceWork} from "@podjs/framework/service-trace";
import {appLogger} from '../logs/app-logger.ts';
import {logPlatformId} from '../logs/fields.ts';
import {applyDouyinState,readDouyinState,type DouyinStateStorage} from "./state-storage.ts";
import type { DouyinFeedSnapshot, DouyinItem } from "./types.ts";

export interface RecentFeed extends DouyinFeedSnapshot { anchorAwemeId: string | null; savedAtMillis: number; resolved: Record<string, number> }
const EMPTY = (): RecentFeed => ({ items: [], cursor: null, hasMore: false, anchorAwemeId: null, savedAtMillis: 0, resolved: {} });
export const QUEUE_KEY = "douyin.playback-queue.v1";
export const FEED_KEY = "douyin.feed.v1", RECENT_KEY = "douyin.recent-window.v1";
export function normalizeItems(items: DouyinItem[]): DouyinItem[] {
  const seen = new Set<string>();
  return items.map(preferredItem).filter(item => { const id = typeof item?.awemeId === "string" ? item.awemeId.trim() : ""; if (!id || typeof item.playUrl !== "string" || !item.playUrl.trim() || seen.has(id)) return false; seen.add(id); return true; }).map(item => item.awemeId===item.awemeId.trim()&&item.playUrl===item.playUrl.trim()?item:{ ...item, awemeId: item.awemeId.trim(), playUrl: item.playUrl.trim() });
}
export const snapshotRecordKey=(key:string)=>key.replace(/\.v1$/,'.v2');
export const playbackItemKey=(id:string)=>`douyin.playback-item.v2.${id}`;
export const PLAYBACK_ITEMS_KEY='douyin.playback-items.v2';
const SNAPSHOTS=[FEED_KEY,RECENT_KEY,QUEUE_KEY];
type SnapshotRecord=Omit<RecentFeed,'items'>&{ids:string[]};
// Capture all DTO scalars and variant scalars without traversing large strings.
// This also detects callers editing a DTO in place between saves.
function itemFields(item:DouyinItem):unknown[]{const fields:unknown[]=[];for(const key of Object.keys(item)){fields.push(key,(item as unknown as Record<string,unknown>)[key]);}for(const variant of item.variants??[])for(const key of Object.keys(variant)){fields.push(key,(variant as unknown as Record<string,unknown>)[key]);}return fields;}
function sameFields(a:unknown[],b:unknown[]):boolean{return a.length===b.length&&a.every((value,i)=>value===b[i]);}
const preferredItems=new WeakMap<DouyinItem,{fields:unknown[];item:DouyinItem}>();
function preferredItem(item:DouyinItem):DouyinItem{
  if(!item||typeof item!=='object')return item;
  const fields=itemFields(item),prior=preferredItems.get(item);
  if(prior&&sameFields(prior.fields,fields))return prior.item;
  const selected=applyPreferredDouyinPlayback(item);preferredItems.set(item,{fields,item:selected});return selected;
}
export class DouyinFeedStore {
  private writes:Promise<unknown>=Promise.resolve();
  private readonly encoded=new WeakMap<DouyinItem,{value:string;fields:unknown[]}>();
  private readonly persisted=new Map<string,{value:string;resolvedAtMillis:number}>();
  constructor(private storage:DouyinStateStorage) {}
  private enqueue<T>(work:()=>Promise<T>):Promise<T>{const pending=this.writes.catch(()=>{}).then(work);this.writes=pending;return pending;}
  private async metadata(key:string):Promise<SnapshotRecord|null>{const raw=await this.storage.get(snapshotRecordKey(key));if(raw===null)return null;const value=JSON.parse(raw);if(!Array.isArray(value?.ids)||value.ids.length>(key===QUEUE_KEY?200:40)||value.ids.some((id:unknown)=>typeof id!=='string'))throw Error('Invalid Douyin snapshot');return value;}
  read(key:string):Promise<RecentFeed>{return this.enqueue(async()=>{
    await yieldWorkTurn().result;
    const metadata=await this.metadata(key);
    if(metadata){
      const items:DouyinItem[]=[];
      for(let i=0;i<metadata.ids.length;i+=4){
        const ids=metadata.ids.slice(i,i+4),rows=await readDouyinState(this.storage,ids.map(playbackItemKey));
        for(let j=0;j<rows.length;j++){
          if(rows[j]===null)throw Error('Missing Douyin playback item');
          const stored=JSON.parse(rows[j]!),item=stored.item;if(item?.awemeId!==ids[j])throw Error('Invalid Douyin playback item');
          const value=JSON.stringify(item);this.encoded.set(item,{value,fields:itemFields(item)});this.persisted.set(item.awemeId,{value,resolvedAtMillis:Number(stored.resolvedAtMillis)||0});items.push(item);
        }
        await yieldWorkTurn().result;
      }
      const {ids:_,...fields}=metadata;return {...fields,items:normalizeItems(items)};
    }
    const raw=await traceServiceWork('douyin.store.get',()=>this.storage.get(key));
    let snapshot:RecentFeed;
    try {
      const value=await projectJsonAsync(raw??'null',{items:[null],cursor:null,hasMore:null,anchorAwemeId:null,savedAtMillis:null,resolved:null}) as Record<string,any>|null;
      if(!value||!Array.isArray(value.items))return EMPTY();
      const items=traceServiceWork('douyin.store.normalize',()=>normalizeItems(value.items)).slice(0,key===QUEUE_KEY?200:40);
      snapshot={items,cursor:typeof value.cursor==='string'?value.cursor:null,hasMore:value.hasMore===true,anchorAwemeId:items.some(x=>x.awemeId===value.anchorAwemeId)?value.anchorAwemeId:null,savedAtMillis:Number(value.savedAtMillis)||0,resolved:value.resolved&&typeof value.resolved==='object'?value.resolved:{}};
    }catch{return EMPTY();}
    await this.saveNow(key,snapshot);await this.storage.remove(key);return snapshot;
  });}
  async bootstrap(): Promise<RecentFeed> {
    await this.writes;
    const [feed, recent] = await Promise.all([this.read(FEED_KEY), this.read(RECENT_KEY)]);
    return traceServiceWork("douyin.store.bootstrapResult",()=>{const resolved:Record<string,number>={}, freshest=new Map<string,DouyinItem>();
    for(const snapshot of [recent,feed])for(const item of snapshot.items){const timestamp=Number(snapshot.resolved[item.awemeId])||0;if(!freshest.has(item.awemeId)||timestamp>resolved[item.awemeId]){freshest.set(item.awemeId,item);resolved[item.awemeId]=timestamp;}}
    const ordered=normalizeItems([...recent.items,...feed.items]).map(item=>freshest.get(item.awemeId)!);
    const anchor=Math.max(0,ordered.findIndex(item=>item.awemeId===recent.anchorAwemeId));
    const items=ordered.slice(anchor,anchor+40);
    appLogger.d("DouyinFeedVM",`read bootstrap pinned=0 feed=${feed.items.length} recent=${recent.items.length} merged=${ordered.length} restored=${items.length} anchor=${logPlatformId(recent.anchorAwemeId)}`);
    return { ...(recent.items.length ? recent : feed), items, anchorAwemeId: recent.anchorAwemeId, resolved };});
  }
  save(key:string,snapshot:RecentFeed):Promise<void>{
    const copy={...snapshot,items:[...snapshot.items]};return this.enqueue(()=>this.saveNow(key,copy));
  }
  private async saveNow(key:string,snapshot:RecentFeed):Promise<void>{
    const items=traceServiceWork('douyin.store.normalize',()=>normalizeItems(snapshot.items)).slice(0,key===QUEUE_KEY?200:40),ids=items.map(item=>item.awemeId);
    const knownRaw=await this.storage.get(PLAYBACK_ITEMS_KEY),known=new Set<string>(knownRaw?JSON.parse(knownRaw):[]);
    // Encode only new/changed immutable item DTOs. Bound each guest turn to one
    // item; durable SQL updates retain one item plus the small ownership index; a page turn never re-encodes a list.
    for(const item of items){
      const fields=itemFields(item),cached=this.encoded.get(item);let value=cached&&sameFields(cached.fields,fields)?cached.value:undefined;
      if(value===undefined){await yieldWorkTurn().result;value=traceServiceWork('douyin.store.itemEncode',()=>JSON.stringify(item));this.encoded.set(item,{value,fields:itemFields(item)});}
      let prior=this.persisted.get(item.awemeId);
      if(!prior&&known.has(item.awemeId)){const raw=await this.storage.get(playbackItemKey(item.awemeId));if(raw){const stored=JSON.parse(raw);prior={value:JSON.stringify(stored.item),resolvedAtMillis:Number(stored.resolvedAtMillis)||0};this.persisted.set(item.awemeId,prior);}}
      const resolvedAtMillis=Number(snapshot.resolved[item.awemeId])||0;
      if(prior&&(prior.resolvedAtMillis>resolvedAtMillis||prior.value===value&&prior.resolvedAtMillis===resolvedAtMillis)&&known.has(item.awemeId))continue;
      known.add(item.awemeId);
      // Reuse the item JSON: do not traverse/serialize its variants again.
      await applyDouyinState(this.storage,[{key:playbackItemKey(item.awemeId),value:'{"resolvedAtMillis":'+resolvedAtMillis+',"item":'+value+'}'},{key:PLAYBACK_ITEMS_KEY,value:JSON.stringify([...known])}]);
      this.persisted.set(item.awemeId,{value,resolvedAtMillis});
    }
    const {items:_,...fields}=snapshot,metadata:SnapshotRecord={...fields,ids};
    const referenced=new Set(ids);
    for(const other of SNAPSHOTS)if(other!==key)for(const id of (await this.metadata(other))?.ids??[])referenced.add(id);
    const obsolete=[...known].filter(id=>!referenced.has(id));
    await applyDouyinState(this.storage,[...obsolete.map(id=>({key:playbackItemKey(id),value:null})),
      {key:snapshotRecordKey(key),value:JSON.stringify(metadata)},{key:PLAYBACK_ITEMS_KEY,value:JSON.stringify([...referenced])}]);
    for(const id of obsolete)this.persisted.delete(id);
  }
  clear():Promise<void>{return this.enqueue(async()=>{
    const raw=await this.storage.get(PLAYBACK_ITEMS_KEY),ids:string[]=raw?JSON.parse(raw):[];
    await applyDouyinState(this.storage,[...ids.map(id=>({key:playbackItemKey(id),value:null})),...SNAPSHOTS.map(key=>({key:snapshotRecordKey(key),value:null})),{key:PLAYBACK_ITEMS_KEY,value:null}]);
    for(const key of SNAPSHOTS)await this.storage.remove(key);this.persisted.clear();
  });}
}
