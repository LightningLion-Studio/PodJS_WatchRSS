import {kv} from '@podjs/framework/watch';
import {mediaPrefixCache,localMediaStore,type LocalMediaItem} from '@podjs/framework/media-prefix-cache';
import {discovery,delay} from '@podjs/framework/services';
import {appLogger} from '../logs/app-logger.ts';
import {videoOptEnabled} from '../media/video-opt.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {stockContentKey,stockNetworkAllowed,type DouyinStockService} from './stock.ts';
import {douyinMediaExpiry,douyinMediaNetworkDeadline} from './media-expiry.ts';
import {DOUYIN_MAX_SHORT_EDGE,douyinPlaybackAudio} from './playback-selector.ts';
import {completeDouyinRendition,douyinPrestoreConfig,storedDouyinMetadata,restoredDouyinItem} from './prestore-policy.ts';

/** Inventory comes from the native verified complete store. Browsing supplies
 * candidates; no stock-owned feed, detail, cookie refresh or URL retry exists. */
export function createHostDouyinStock(client:DouyinClient):DouyinStockService {
 let candidates:DouyinItem[]=[],epoch=0,offeredRevision=0,enabled=false,running:Promise<void>|undefined;
 let transfer:{item:DouyinItem;uri?:string;changed?:boolean}|undefined;
 const operations=new Set<{cancel():void}>();
 const wait=async<T>(operation:{result:Promise<T>;cancel():void}):Promise<T>=>{operations.add(operation);try{return await operation.result;}finally{operations.delete(operation);}};
 const maxKeys=16;
 const keys=new Map<string,{key:string;authorization:string}>(),consumed=new Set<string>();
 type InventoryEntry={value:LocalMediaItem;item:DouyinItem};
 type InventoryIndex={epoch:number;authorization:string;ids?:Set<string>;capacity?:{unwatched:number;expires:number};reading?:Promise<InventoryEntry[]>};
 let index:InventoryIndex|undefined;
 let configured:string|undefined;
 const config=()=>douyinPrestoreConfig(kv.get('watchrss.douyin.prestore.v1'));
 const allowed=async()=>config().enabled&&kv.get<boolean>('watchrss.douyin.stock.enabled')!==false&&await client.isLoggedIn()&&stockNetworkAllowed(await discovery.networkSnapshot(),videoOptEnabled('traffic'),kv.get<boolean>('watchrss.douyin.stock.wifi-only')!==false);
 const scope=()=>client.stockAuthorizationScope();
 const source=async(value:LocalMediaItem|undefined,authorization:string|undefined)=>{
  if(!authorization||value?.metadata.stockAuthorization!==authorization)return;
  if(!value?.frame?.available||!(value.audioTracks>0)||!(value.videoTracks>0))return;
  const item=restoredDouyinItem(value.metadata,value.uri);if(!item){await localMediaStore.remove(value.key).result;return;}
  return {uri:value.uri,frame:value.frame,item};
 };
 const bind=(id:string,key:string,authorization:string)=>{
  const known=keys.get(id);
  if(known?.key===key&&known.authorization===authorization)return;
  keys.set(id,{key,authorization});while(keys.size>maxKeys)keys.delete(keys.keys().next().value!);
 };
 const indexFor=(own:number,authorization:string)=>{
  if(!index||index.epoch!==own||index.authorization!==authorization)index={epoch:own,authorization};
  return index;
 };
 const invalidateInventory=()=>{if(index)index={epoch:index.epoch,authorization:index.authorization};};
 const readInventory=(current:InventoryIndex)=>{
  if(current.reading)return current.reading;
  current.reading=(async()=>{
   const {items}=await localMediaStore.list(DOUYIN_MAX_SHORT_EDGE).result;
   const entries:InventoryEntry[]=[];
   for(const value of items){
    if(current.epoch!==epoch||index!==current)return [];
    const ready=await source(value,current.authorization);
    if(ready)entries.push({value,item:ready.item});
   }
   if(current.epoch!==epoch||index!==current)return [];
   // Publish only after the entire scan succeeds. A prepared replacement can
   // keep its older rendition on disk, so preserve the live binding if present.
   const selected=new Map<string,InventoryEntry>();
   for(const entry of entries){
    const id=entry.item.awemeId,prior=selected.get(id),bound=keys.get(id);
    if(prior&&bound?.authorization===current.authorization&&prior.value.key===bound.key)continue;
    selected.set(id,entry);
   }
   for(const [id,entry] of selected)bind(id,entry.value.key,current.authorization);
   // Native list hashes every complete movie and its frame. Keep only IDs for
   // misses. A playable hit still verifies that specific file at lookup time.
   current.ids=selected.size<=maxKeys?new Set(selected.keys()):undefined;
   current.capacity={unwatched:entries.filter(entry=>!entry.value.watched).length,expires:Date.now()+5*60_000};
   return entries;
  })().finally(()=>{current.reading=undefined;});
  return current.reading;
 };
 const stillAuthorized=(own:number,authorization:string)=>own===epoch&&index?.authorization===authorization;
 const inventoryFor=async(own:number,authorization:string)=>{
  let current=indexFor(own,authorization);
  for(;;){
   const entries=await readInventory(current);
   const latest=index;
   if(own!==epoch||latest?.authorization!==authorization)return [];
   if(latest===current)return entries;
   current=latest;
  }
 };
 const inventory=async()=>{
  const own=epoch,authorization=await scope();
  return own===epoch&&authorization?inventoryFor(own,authorization):[];
 };
 const lookup=async(id:string)=>{
  const own=epoch,authorization=await scope();if(own!==epoch||!authorization)return;
  const current=indexFor(own,authorization);
  if(current.ids&&!current.ids.has(id))return;
  if(keys.get(id)?.authorization!==authorization)await inventoryFor(own,authorization);
  while(stillAuthorized(own,authorization)){
   const binding=keys.get(id),observed=index;
   if(binding?.authorization!==authorization)return;
   const {item}=await localMediaStore.lookup(binding.key,DOUYIN_MAX_SHORT_EDGE).result;
   if(!stillAuthorized(own,authorization))return;
   if(index!==observed||keys.get(id)!==binding)continue;
   const ready=await source(item,authorization);
   if(!stillAuthorized(own,authorization))return;
   if(index!==observed||keys.get(id)!==binding)continue;
   if(!ready||ready.item.awemeId!==id){keys.delete(id);if(index)index.capacity=undefined;return;}
   return ready;
  }
 };
 const service:DouyinStockService={
  present:localMediaStore.present,hide:localMediaStore.hide,
  async completeIds(){
   const own=epoch,authorization=await scope();
   if(own!==epoch||!authorization)return new Set<string>();
   const cached=indexFor(own,authorization);
   if(cached.ids&&cached.capacity&&cached.capacity.expires>Date.now())return new Set(cached.ids);
   const entries=await inventoryFor(own,authorization);
   return new Set(entries.map(entry=>entry.item.awemeId));
  },
  async restore(){
   const own=epoch;
   const report=(count:number,bytes:number,reason:'ready'|'disabled'|'native_empty'|'no_eligible'|'history_timeout'|'history_failed'|'native_failed')=>appLogger.i('DouyinStock',`entry_stock count=${count} bytes=${bytes} reason=${reason}`);
   if(!config().enabled){report(0,0,'disabled');return [];}
   // The manifest's watched flag is durable. The supplementary SQL/legacy
   // history filter must not hold verified offline playback behind secure IO.
   let reason:'ready'|'history_timeout'|'history_failed'='ready';
   const history=client.listWatchedIds().catch(()=>{reason='history_failed';return [] as string[];});
   let values:Awaited<ReturnType<typeof inventory>>;try{values=await inventory();}catch{report(0,0,'native_failed');return [];}
   if(!values.length){report(0,0,'native_empty');return [];}
   const timer=delay(50);
   const ids=await Promise.race([history,timer.result.then(()=>{reason='history_timeout';return [] as string[];})]);timer.cancel();
   if(own!==epoch)return [];
   const watched=new Set(ids),eligible=values.filter(({value,item})=>{
    const bound=keys.get(item.awemeId);
    return (!bound||bound.key===value.key)&&!value.watched&&!watched.has(item.awemeId)&&!consumed.has(item.awemeId);
   });
   report(eligible.length,eligible.reduce((bytes,entry)=>bytes+entry.value.bytes,0),eligible.length?reason:'no_eligible');return eligible.map(entry=>entry.item);
  },
  ready:lookup,playbackReady:lookup,lookup:async id=>(await lookup(id))?.uri,
  consume(id){
   consumed.add(id);while(consumed.size>200)consumed.delete(consumed.values().next().value!);
   const binding=keys.get(id);
   if(binding)void localMediaStore.watched(binding.key).result.finally(invalidateInventory).catch(()=>{});
  },
  clear(){service.suspend();keys.clear();consumed.clear();void localMediaStore.clear().result.finally(invalidateInventory).catch(()=>{});},
  suspend(){enabled=false;epoch++;index=undefined;configured=undefined;for(const operation of operations)operation.cancel();operations.clear();void localMediaStore.cancel().result.catch(()=>{});},
  async networkChanged(){if(await allowed())await service.resume();else service.suspend();},
  offer(items,anchor){
   offeredRevision++;
   const active=transfer,next=items.find(item=>item.awemeId===active?.item.awemeId);
   if(active&&next&&completeDouyinRendition(next)?.playUrl!==active.item.playUrl){
    active.changed=true;
    for(const operation of operations)operation.cancel();
   }
   const center=Math.max(0,items.findIndex(i=>i.awemeId===anchor));
   candidates=items.slice(center+(anchor?1:0),center+21).filter(i=>/^https?:/.test(i.playUrl));
   void service.resume().catch(()=>{});
  },
  resume(){const wasEnabled=enabled;enabled=true;if(running)return wasEnabled?running:running.catch(()=>{}).then(()=>enabled?service.resume():undefined);const own=epoch,offerRevision=offeredRevision,current=()=>enabled&&own===epoch;
   const work=(async()=>{
    const authorization=await scope();if(!current()||!authorization)return;
    const cfg=config(),settings=JSON.stringify(cfg);
    if(settings!==configured){
     await localMediaStore.configure(cfg).result;if(!current())return;
     configured=settings;invalidateInventory();
    }
    if(!await allowed()||!current())return;
    const capacity=indexFor(own,authorization).capacity;
    let slots=capacity&&capacity.expires>Date.now()?capacity.unwatched:
     (await inventoryFor(own,authorization)).filter(entry=>!entry.value.watched).length;
    if(slots>=cfg.count||!current())return;
    const watched=new Set(await client.listWatchedIds());
    for(const candidate of candidates){
     if(!current()||offerRevision!==offeredRevision||slots>=cfg.count||!await allowed()||!current())return;
     if(watched.has(candidate.awemeId)||consumed.has(candidate.awemeId))continue;
     const item=completeDouyinRendition(candidate);if(!item)continue;const key=stockContentKey(item)+':authorization:'+authorization;
     const known=(await localMediaStore.lookup(key,DOUYIN_MAX_SHORT_EDGE).result).item;if(!current())return;if(known)continue;
     const audio=douyinPlaybackAudio(item),now=Date.now(),expiry=Math.min(douyinMediaExpiry(item.playUrl,now),audio?douyinMediaExpiry(audio,now):Infinity);if(expiry<=Date.now())continue;
     const headers=await client.buildPlaybackHeaders();if(!current()||offerRevision!==offeredRevision||expiry<=Date.now())continue;
     // A single selected rendition. No mirror race is needed for idle storage.
     const active:NonNullable<typeof transfer>={item};
     transfer=active;
     try{
      const {uri}=await wait(mediaPrefixCache.register(key,item.playUrl,headers,true,[],douyinMediaNetworkDeadline([item.playUrl,...(audio?[audio]:[])]),audio,DOUYIN_MAX_SHORT_EDGE));
      active.uri=uri;
      if(!current()||active.changed)continue;
      const result=await wait(localMediaStore.prepare(key,uri,{...storedDouyinMetadata(item),stockAuthorization:authorization},true)).finally(invalidateInventory);
      if(!current())return;
      const ready=!active.changed&&result.ready&&await source(result.item,authorization);
      if(current()&&!active.changed&&ready&&result.item){
       bind(ready.item.awemeId,result.item.key,authorization);
       if(consumed.has(item.awemeId))await localMediaStore.watched(key).result;
       else slots++;
      }
     }catch(error){
      if((error as {code?:string}).code==='media_traffic_stopped'){service.suspend();return;}
      if(!current())return;
     }finally{
      transfer=undefined;
      if(active.changed){
       if(active.uri)await mediaPrefixCache.remove(active.uri).result.catch(()=>{});
       await localMediaStore.remove(key).result.catch(()=>{});
      }
     }
    }
   })();running=work;return work.finally(()=>{if(running===work){running=undefined;if(enabled&&offerRevision!==offeredRevision)void service.resume().catch(()=>{});}});
  },
 };
 client.subscribeAuth?.(state=>{if(state==='logged-in')return;service.suspend();candidates=[];keys.clear();consumed.clear();});
 return service;
}
