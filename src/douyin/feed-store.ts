import {PlaybackCache,playbackPayloadBytes} from './cache-budget.ts';
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
/** Persistence must yield even when every item is already durable. */
export async function normalizeItemsInTurns(input:DouyinItem[],limit=input.length):Promise<DouyinItem[]>{
  const items:DouyinItem[]=[],seen=new Set<string>();
  for(let start=0;start<input.length&&items.length<limit;start+=4){
    await yieldWorkTurn().result;
    const batch=traceServiceWork('douyin.store.normalize',()=>normalizeItems(input.slice(start,start+4)));
    for(const item of batch)if(!seen.has(item.awemeId)&&items.length<limit){seen.add(item.awemeId);items.push(item);}
  }
  return items;
}
export const snapshotRecordKey=(key:string)=>key.replace(/\.v1$/,'.v2');
export const playbackItemKey=(id:string)=>`douyin.playback-item.v2.${id}`;
export const PLAYBACK_ITEMS_KEY='douyin.playback-items.v2';
const SNAPSHOTS=[FEED_KEY,RECENT_KEY,QUEUE_KEY];
type SnapshotRecord=Omit<RecentFeed,'items'>&{ids:string[]};
// Capture all DTO scalars and variant scalars without traversing large strings.
// This also detects callers editing a DTO in place between saves.
function itemFields(item:DouyinItem):unknown[]{
  const fields:unknown[]=[];
  const visit=(value:unknown)=>{
    if(Array.isArray(value)){fields.push('array',value.length);for(const entry of value)visit(entry);}
    else if(value!==null&&typeof value==='object'){const keys=Object.keys(value);fields.push('object',keys.length);for(const key of keys){fields.push(key);visit((value as Record<string,unknown>)[key]);}}
    else fields.push(typeof value,value);
  };
  visit(item);return fields;
}
function sameFields(a:unknown[],b:unknown[]):boolean{return a.length===b.length&&a.every((value,i)=>value===b[i]);}
const preferredItems=new PlaybackCache<DouyinItem,{fields:unknown[];item:DouyinItem}>(2*1024*1024,128,(value,key)=>playbackPayloadBytes([key,value]));
function preferredItem(item:DouyinItem):DouyinItem{
  if(!item||typeof item!=='object')return item;
  const fields=itemFields(item),prior=preferredItems.get(item);
  if(prior&&sameFields(prior.fields,fields))return prior.item;
  const selected=applyPreferredDouyinPlayback(item);preferredItems.set(item,{fields,item:selected});return selected;
}
export class DouyinFeedStore {
  private writes:Promise<unknown>=Promise.resolve();
  // Scalar comparison records share the DTO's immutable strings. Retaining
  // both encoded JSON and parsed variants duplicated every signed address.
  private readonly persisted=new PlaybackCache<string,{resolvedAtMillis:number;fields:unknown[]}>(4*1024*1024,200,(value,key)=>2*key.length+playbackPayloadBytes(value.fields));
  // Weak keys do not retain old pagers. A live unchanged DTO can outlast the
  // byte memo without forcing every bounded-queue save to parse it again.
  private readonly durableItems=new WeakMap<DouyinItem,{fields:unknown[];resolvedAtMillis:number;revision:object}>();
  private readonly revisions=new Map<string,object>();
  private revision(id:string,replace=false){
    let value=this.revisions.get(id);if(!value||replace){value={};this.revisions.delete(id);this.revisions.set(id,value);}
    // At most queue(200) + feed(40) + recent(4) durable item owners.
    while(this.revisions.size>244)this.revisions.delete(this.revisions.keys().next().value!);
    return value;
  }
  constructor(private storage:DouyinStateStorage) {}
  memoryStats(){return {preferredEntries:preferredItems.size,preferredBytes:preferredItems.bytes,encodedEntries:0,encodedBytes:0,persistedEntries:this.persisted.size,persistedBytes:this.persisted.bytes};}
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
          const memo={fields:itemFields(item),resolvedAtMillis:Number(stored.resolvedAtMillis)||0};
          this.persisted.set(item.awemeId,memo);this.durableItems.set(item,{...memo,revision:this.revision(item.awemeId,true)});items.push(item);
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
    const items=await normalizeItemsInTurns(snapshot.items,key===QUEUE_KEY?200:40),ids=items.map(item=>item.awemeId);
    const originals=new Map(snapshot.items.map(item=>[item.awemeId.trim(),item]));
    const knownRaw=await this.storage.get(PLAYBACK_ITEMS_KEY),known=new Set<string>(knownRaw?JSON.parse(knownRaw):[]);
    // Encode only new/changed immutable item DTOs. Bound each guest turn to one
    // item; durable SQL updates retain one item plus the small ownership index; a page turn never re-encodes a list.
    let compared=0;
    for(const item of items){
      if(compared++%4===0)await yieldWorkTurn().result;
      const fields=itemFields(item),resolvedAtMillis=Number(snapshot.resolved[item.awemeId])||0;
      const original=originals.get(item.awemeId)??item,live=this.durableItems.get(original);
      if(known.has(item.awemeId)&&live&&live.revision===this.revisions.get(item.awemeId)&&live.resolvedAtMillis===resolvedAtMillis&&sameFields(live.fields,fields))continue;
      let prior=this.persisted.get(item.awemeId);
      if(!prior&&known.has(item.awemeId)){const raw=await this.storage.get(playbackItemKey(item.awemeId));if(raw){const stored=JSON.parse(raw);prior={fields:itemFields(stored.item),resolvedAtMillis:Number(stored.resolvedAtMillis)||0};this.persisted.set(item.awemeId,prior);}}
      // Compare unchanged DTO fields before encoding. A byte-limited JSON memo
      // must not turn every 40-item save into 40 yields and re-encodes.
      if(prior&&known.has(item.awemeId)&&(prior.resolvedAtMillis>resolvedAtMillis||prior.resolvedAtMillis===resolvedAtMillis&&sameFields(prior.fields,fields))){
        this.durableItems.set(original,{fields,resolvedAtMillis,revision:this.revision(item.awemeId)});continue;
      }
      await yieldWorkTurn().result;
      const value=traceServiceWork('douyin.store.itemEncode',()=>JSON.stringify(item));
      known.add(item.awemeId);
      // Reuse the item JSON: do not traverse/serialize its variants again.
      await applyDouyinState(this.storage,[{key:playbackItemKey(item.awemeId),value:'{"resolvedAtMillis":'+resolvedAtMillis+',"item":'+value+'}'},{key:PLAYBACK_ITEMS_KEY,value:JSON.stringify([...known])}]);
      this.persisted.set(item.awemeId,{fields,resolvedAtMillis});
      this.durableItems.set(original,{fields,resolvedAtMillis,revision:this.revision(item.awemeId,true)});
    }
    const {items:_,...fields}=snapshot,metadata:SnapshotRecord={...fields,ids};
    const referenced=new Set(ids);
    for(const other of SNAPSHOTS)if(other!==key)for(const id of (await this.metadata(other))?.ids??[])referenced.add(id);
    const obsolete=[...known].filter(id=>!referenced.has(id));
    await applyDouyinState(this.storage,[...obsolete.map(id=>({key:playbackItemKey(id),value:null})),
      {key:snapshotRecordKey(key),value:JSON.stringify(metadata)},{key:PLAYBACK_ITEMS_KEY,value:JSON.stringify([...referenced])}]);
    for(const id of obsolete){this.persisted.delete(id);this.revisions.delete(id);}
  }
  clear():Promise<void>{return this.enqueue(async()=>{
    const raw=await this.storage.get(PLAYBACK_ITEMS_KEY),ids:string[]=raw?JSON.parse(raw):[];
    await applyDouyinState(this.storage,[...ids.map(id=>({key:playbackItemKey(id),value:null})),...SNAPSHOTS.map(key=>({key:snapshotRecordKey(key),value:null})),{key:PLAYBACK_ITEMS_KEY,value:null}]);
    for(const key of SNAPSHOTS)await this.storage.remove(key);this.persisted.clear();this.revisions.clear();
  });}
}
