import {kv} from '@podjs/framework/watch';
import {mediaPrefixCache,localMediaStore,type LocalMediaItem} from '@podjs/framework/media-prefix-cache';
import {discovery,delay} from '@podjs/framework/services';
import {appLogger} from '../logs/app-logger.ts';
import {videoOptEnabled} from '../media/video-opt.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {stockContentKey,stockNetworkAllowed,type DouyinStockService} from './stock.ts';
import {douyinMediaExpiry} from './media-expiry.ts';
import {douyinPlaybackAudio} from './playback-selector.ts';
import {completeDouyinRendition,douyinPrestoreConfig,storedDouyinMetadata,restoredDouyinItem} from './prestore-policy.ts';

/** Inventory comes from the native verified complete store. Browsing supplies
 * candidates; no stock-owned feed, detail, cookie refresh or URL retry exists. */
export function createHostDouyinStock(client:DouyinClient):DouyinStockService {
 client.usePrestoreTrafficPolicy?.();
 let candidates:DouyinItem[]=[],epoch=0,offeredRevision=0,enabled=false,running:Promise<void>|undefined,stopped=false;
 const keys=new Map<string,string>(),consumed=new Set<string>();
 const config=()=>douyinPrestoreConfig(kv.get('watchrss.douyin.prestore.v1'));
 const allowed=async()=>!stopped&&config().enabled&&kv.get<boolean>('watchrss.douyin.stock.enabled')!==false&&await client.isLoggedIn()&&stockNetworkAllowed(await discovery.networkSnapshot(),videoOptEnabled('traffic'),kv.get<boolean>('watchrss.douyin.stock.wifi-only')!==false);
 const source=(value:LocalMediaItem|undefined)=>{
  if(!value?.frame?.available||!(value.audioTracks>0)||!(value.videoTracks>0))return;
  const item=restoredDouyinItem(value.metadata,value.uri);if(!item)return;
  keys.set(item.awemeId,value.key);while(keys.size>16)keys.delete(keys.keys().next().value!);
  return {uri:value.uri,frame:value.frame,item};
 };
 const inventory=async()=>{const values=(await localMediaStore.list().result).items;return values.filter(v=>source(v));};
 const lookup=async(id:string)=>{
  let key=keys.get(id);if(!key){await inventory();key=keys.get(id);}if(!key)return;
  return source((await localMediaStore.lookup(key).result).item);
 };
 const service:DouyinStockService={
  present:localMediaStore.present,hide:localMediaStore.hide,
  async restore(){
   const report=(count:number,bytes:number,reason:'ready'|'disabled'|'native_empty'|'no_eligible'|'history_timeout'|'history_failed'|'native_failed')=>appLogger.i('DouyinStock',`entry_stock count=${count} bytes=${bytes} reason=${reason}`);
   if(!config().enabled){report(0,0,'disabled');return [];}
   // The manifest's watched flag is durable. The supplementary SQL/legacy
   // history filter must not hold verified offline playback behind secure IO.
   let reason:'ready'|'history_timeout'|'history_failed'='ready';
   const history=client.listWatchedIds().catch(()=>{reason='history_failed';return [] as string[];});
   let values:LocalMediaItem[];try{values=await inventory();}catch{report(0,0,'native_failed');return [];}
   if(!values.length){report(0,0,'native_empty');return [];}
   const timer=delay(50);
   const ids=await Promise.race([history,timer.result.then(()=>{reason='history_timeout';return [] as string[];})]);timer.cancel();
   const watched=new Set(ids),eligible=values.filter(v=>!v.watched&&!watched.has(String(v.metadata.awemeId))&&!consumed.has(String(v.metadata.awemeId)));
   report(eligible.length,eligible.reduce((bytes,v)=>bytes+v.bytes,0),eligible.length?reason:'no_eligible');return eligible.map(v=>source(v)!.item);
  },
  ready:lookup,playbackReady:lookup,lookup:async id=>(await lookup(id))?.uri,
  consume(id){consumed.add(id);while(consumed.size>200)consumed.delete(consumed.values().next().value!);const key=keys.get(id);if(key)void localMediaStore.watched(key).result.catch(()=>{});},
  clear(){service.suspend();keys.clear();consumed.clear();void localMediaStore.clear().result.catch(()=>{});},
  suspend(){enabled=false;epoch++;void localMediaStore.cancel().result.catch(()=>{});},
  async networkChanged(){if(await allowed())await service.resume();else service.suspend();},
  offer(items,anchor){offeredRevision++;const center=Math.max(0,items.findIndex(i=>i.awemeId===anchor));candidates=items.slice(center+(anchor?1:0),center+21).filter(i=>/^https?:/.test(i.playUrl));void service.resume().catch(()=>{});},
  resume(){const wasEnabled=enabled;enabled=true;if(running)return wasEnabled?running:running.catch(()=>{}).then(()=>enabled?service.resume():undefined);const own=++epoch,offerRevision=offeredRevision,current=()=>enabled&&own===epoch;
   const work=(async()=>{
    const cfg=config();await localMediaStore.configure(cfg).result;if(!current()||!await allowed())return;
    let slots=(await inventory()).filter(v=>!v.watched).length;const watched=new Set(await client.listWatchedIds());
    for(const candidate of candidates){
     if(!current()||offerRevision!==offeredRevision||slots>=cfg.count||!await allowed())return;
     if(watched.has(candidate.awemeId)||consumed.has(candidate.awemeId))continue;
     const item=completeDouyinRendition(candidate);if(!item)continue;const key=stockContentKey(item);
     if((await localMediaStore.lookup(key).result).item)continue;
     const audio=douyinPlaybackAudio(item),now=Date.now(),expiry=Math.min(douyinMediaExpiry(item.playUrl,now),audio?douyinMediaExpiry(audio,now):Infinity);if(expiry<=Date.now())continue;
     const headers=await client.buildPlaybackHeaders();if(!current()||expiry<=Date.now())continue;
     // A single selected rendition. No mirror race is needed for idle storage.
     const {uri}=await mediaPrefixCache.register(key,item.playUrl,headers,true,[],expiry,audio).result;
     try{const result=await localMediaStore.prepare(key,uri,storedDouyinMetadata(item),true).result;if(result.ready){source(result.item);if(consumed.has(item.awemeId)){await localMediaStore.watched(key).result;continue;}slots++;}}
     catch(error){if((error as {code?:string}).code==='media_traffic_stopped'){stopped=true;client.stopMediaTraffic?.();service.suspend();return;}if(!current())return;}
    }
   })();running=work;return work.finally(()=>{if(running===work){running=undefined;if(enabled&&offerRevision!==offeredRevision)void service.resume().catch(()=>{});}});
  },
 };
 return service;
}
