import {mediaPrefixCache} from '@podjs/framework/media-prefix-cache';
import {discovery,onNetworkChange} from '@podjs/framework/services';
import {managedCache} from '../cache/host.ts';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {douyinPreloadAllowed} from './preload.ts';
import {douyinProxyWindow,douyinPrefetchBytes,douyinPreviewBytes} from './proxy-policy.ts';
import {selectPreferredDouyinVariant,applyPreferredDouyinPlayback} from './playback-selector.ts';

/** Business window/consent only. Range transport, storage bounds and cancellation live in PodJS. */
export function createHostDouyinPreload(client:DouyinClient) {
 let owner:unknown,plan:{items:readonly DouyinItem[];anchor?:string;mode:'active'|'entry'}|undefined;
 let generation=0,lastAllowed:boolean|undefined,unsubscribe:(()=>void)|undefined,networkGeneration=0;
 const bluetoothOwners=new Set<unknown>();
 let migration:Promise<void>|undefined,migrating=false;
 const cleanupOldFiles=()=>migration??=(async()=>{
  const before=await managedCache.stats();const bytes=before.bucketBytes['douyin-preload'];
  migrating=true;try{await managedCache.clearBucket('douyin-preload');}finally{migrating=false;}
  appLogger.i('DouyinProxy',`oldWholeFilesRemoved bytes=${bytes}`);
 })().catch(()=>{migration=undefined;throw new Error('old_media_cache_cleanup_failed');});
 const stats=async()=>{const s=await mediaPrefixCache.stats().result;appLogger.i('DouyinProxy',`cache files=${s.files} bytes=${s.bytes} downloadedBytes=${s.downloadedBytes} cacheReadBytes=${s.cacheReadBytes} networkReadBytes=${s.networkReadBytes} maxBytes=${s.maxBytes}`);return s;};
 const allowed=async()=>douyinPreloadAllowed(await discovery.networkSnapshot(),bluetoothOwners.has(owner));
 const register=async(item:DouyinItem,headers:Record<string,string>)=>{
  const selected=applyPreferredDouyinPlayback(item);if(!selected.playUrl)return undefined;
  return (await mediaPrefixCache.register(selected.awemeId,selected.playUrl,headers).result).uri;
 };
 const run=async(own:number)=>{
  if(!plan)return;const enabled=await allowed();if(own!==generation)return;lastAllowed=enabled;
  if(!enabled){await mediaPrefixCache.window([]).result;return;}
  await cleanupOldFiles();if(own!==generation||!plan)return;
  const targets=douyinProxyWindow(plan.items,plan.anchor,plan.mode),mode=plan.mode;
  const headers=await client.buildPlaybackHeaders();if(own!==generation)return;
  // Foreground resolution stays independent: one rejected neighbour cannot block its prepare.
  const prepared:{uri:string;prefetchBytes:number;captureBytes:number}[]=[];
  let foregroundBitrate=mode==='active'?selectPreferredDouyinVariant(targets[0]?.variants??[])?.bitrate??0:0;
  for(const item of targets){
   if(own!==generation)return;const result=await client.resolvePlayback(item.awemeId);if(own!==generation)return;
   if(!result.ok){appLogger.i('DouyinProxy',`resolve failed category=${result.code}`);continue;}
   const uri=await register(result.data,headers);if(own!==generation)return;if(!uri)continue;
   if(mode==='active'&&item.awemeId===plan?.anchor)foregroundBitrate=selectPreferredDouyinVariant(result.data.variants??[])?.bitrate??0;
   prepared.push({uri,prefetchBytes:douyinPrefetchBytes(undefined,result.data.durationMs,prepared.length),captureBytes:douyinPreviewBytes(undefined,result.data.durationMs)});
   if(own!==generation)return;
   // Publish progressively; do not wait for a slow old detail request to warm current+next.
   await mediaPrefixCache.window(prepared,foregroundBitrate).result;
  }
  if(own===generation)await stats();
 };
 const stop=(expected?:unknown)=>{
  if(expected!==undefined){bluetoothOwners.delete(expected);if(expected!==owner)return;}else bluetoothOwners.clear();
  generation++;networkGeneration++;lastAllowed=undefined;owner=undefined;plan=undefined;unsubscribe?.();unsubscribe=undefined;
  void mediaPrefixCache.window([]).result.catch(()=>{});
 };
 const networkChanged=()=>{const op=++networkGeneration;void allowed().then(value=>{if(op!==networkGeneration||!plan||value===lastAllowed)return;void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));}).catch(()=>{});};
 managedCache.registerProducer('douyin-preload',{pins:()=>new Set<string>(),async clear(){if(migrating)return;stop();await mediaPrefixCache.clear().result;}});
 return {
  // A proxy is not a complete local file; queue resolution must continue enforcing URL TTL.
  lookup:async(_id:string):Promise<string|undefined>=>undefined,
  async playback(item:DouyinItem,headers:Record<string,string>){await cleanupOldFiles();const resolved=await client.resolvePlayback(item.awemeId);if(!resolved.ok){appLogger.i('DouyinProxy',`foreground resolve failed category=${resolved.code}`);throw new Error(resolved.message);}try{return await register(resolved.data,headers)??resolved.data.playUrl;}catch{appLogger.w('DouyinProxy','registration failed; using network');return resolved.data.playUrl;}},
  async invalidate(_id:string){await mediaPrefixCache.clear().result;},stop,stats,
  allowBluetooth(value:boolean,expected:unknown){if(bluetoothOwners.has(expected)===value)return;if(value)bluetoothOwners.add(expected);else bluetoothOwners.delete(expected);if(expected===owner)networkChanged();},
  start(next:unknown,items:readonly DouyinItem[],anchor:string|undefined,mode:'active'|'entry'){
   if(next!==owner){unsubscribe?.();unsubscribe=undefined;lastAllowed=undefined;}owner=next;plan={items,anchor,mode};
   unsubscribe??=onNetworkChange(networkChanged,networkChanged);void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));
  },
 };
}
