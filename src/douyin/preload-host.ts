import {preserveSelectedDouyinItem,videoOptEnabled,takeVideoResolution,registerVideoResolution} from '../media/video-opt.ts';
import {kv} from '@podjs/framework/watch';
import {video} from '@podjs/framework/services';
import {DouyinPrefetchResults,type PrefetchFailure} from './prefetch-results.ts';
import type {MediaPrefetchResult} from '@podjs/framework/media-prefix-cache';
import {traceDouyinVariants} from './playback-diagnostics.ts';
import {mediaPrefixCache} from '@podjs/framework/media-prefix-cache';
import {discovery,onNetworkChange} from '@podjs/framework/services';
import {managedCache} from '../cache/host.ts';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {douyinPreloadAllowed} from './preload.ts';
import {douyinProxyWindow,douyinPrefetchBytes,douyinPreviewBytes} from './proxy-policy.ts';
import {selectPreferredDouyinVariant,applyPreferredDouyinPlayback} from './playback-selector.ts';

export interface DouyinPrefetchHooks {
 isForeground(id:string):boolean;
 sourceRefreshed(id:string,previousUri:string,item:DouyinItem,uri:string,headers:Record<string,string>):void|Promise<void>;
 quarantine(id:string,failure:PrefetchFailure):boolean|Promise<boolean>;
}
/** Business window/consent only. Range transport, storage bounds and cancellation live in PodJS. */
export function createHostDouyinPreload(client:DouyinClient) {
 let owner:unknown,plan:{items:readonly DouyinItem[];anchor?:string;mode:'active'|'entry';hooks?:DouyinPrefetchHooks}|undefined;
 let generation=0,lastAllowed:boolean|undefined,unsubscribe:(()=>void)|undefined,networkGeneration=0;
 let saved:PrefetchFailure[]=[];try{const value=kv.get<unknown>('watchrss.douyin.prefetch-failures');if(Array.isArray(value))saved=value;}catch{}
 const results=new DouyinPrefetchResults(Date.now,saved);let resultOff:(()=>void)|undefined,token=0;
 const foreground=(id:string)=>plan?.hooks?.isForeground(id)??(plan?.mode==='active'&&plan.anchor===id);
 const sources=new Map<string,DouyinItem>();
 const remember=(uri:string,item:DouyinItem)=>{sources.set(uri,item);while(sources.size>200)sources.delete(sources.keys().next().value!);return uri;};
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
  const selected=preserveSelectedDouyinItem(item);if(!selected.playUrl)return undefined;
  const uri=(await mediaPrefixCache.register(selected.awemeId,selected.playUrl,headers).result).uri;
  registerVideoResolution(uri,takeVideoResolution(selected.playUrl,'douyin'));return remember(uri,selected);
 };
 const run=async(own:number)=>{
  if(!plan)return;const enabled=await allowed();if(own!==generation)return;lastAllowed=enabled;
  if(!enabled){await mediaPrefixCache.window([]).result;return;}
  await cleanupOldFiles();if(own!==generation||!plan)return;
  results.begin();const targets=douyinProxyWindow(plan.items,plan.anchor,plan.mode).slice(0,videoOptEnabled('traffic')?2:undefined),mode=plan.mode;
  const headers=await client.buildPlaybackHeaders();if(own!==generation)return;
  // Foreground resolution stays independent: one rejected neighbour cannot block its prepare.
  const prepared:{uri:string;prefetchBytes:number;captureBytes:number;itemToken:string;generation:number}[]=[];
  let foregroundBitrate=mode==='active'?selectPreferredDouyinVariant(targets[0]?.variants??[])?.bitrate??0:0;
  for(const item of targets){
   if(own!==generation)return;const center=Math.max(0,plan!.items.findIndex(value=>value.awemeId===plan!.anchor));
   // Backward entries register existing sources only. They never request detail.
   const backward=mode==='active'&&plan!.items.findIndex(value=>value.awemeId===item.awemeId)<center;
   const result=backward?{ok:true as const,data:item}:await client.resolvePlayback(item.awemeId,{prefetch:true});if(own!==generation)return;
   if(!result.ok){appLogger.i('DouyinProxy',`resolve failed category=${result.code}`);continue;}
   const uri=await register(result.data,headers);if(own!==generation)return;if(!uri)continue;
   if(mode==='active'&&item.awemeId===plan?.anchor)foregroundBitrate=(result.data.variants??[]).find(v=>v.playUrl===result.data.playUrl)?.bitrate??0;
   const itemToken=`p${++token}`;results.bind({id:item.awemeId,itemToken,generation:own,uri,url:result.data.playUrl});
   prepared.push({uri,itemToken,generation:own,prefetchBytes:backward?0:douyinPrefetchBytes(undefined,result.data.durationMs,prepared.length),captureBytes:douyinPreviewBytes(undefined,result.data.durationMs)});
   if(own!==generation)return;
   // Publish progressively; do not wait for a slow old detail request to warm current+next.
   await mediaPrefixCache.window(prepared,foregroundBitrate).result;
  }
  if(own===generation)await stats();
 };
 const consume=async(event:MediaPrefetchResult)=>{
  const action=results.result(event,foreground);if(action)try{kv.set('watchrss.douyin.prefetch-failures',results.snapshot());}catch{}if(!action||action.action==='none')return;
  const {binding}=action,own=generation,currentPlan=plan;if(!currentPlan)return;
  if(action.action==='refresh'){
   const fresh=await client.resolvePlayback(binding.id,{forceRefresh:true,prefetch:!foreground(binding.id)});
   if(own!==generation||plan!==currentPlan||!results.current(binding)||!fresh.ok)return;
   const headers=await client.buildPlaybackHeaders(),uri=await register(fresh.data,headers);
   if(!uri||own!==generation||plan!==currentPlan||!results.current(binding))return;
   currentPlan.items=currentPlan.items.map(item=>item.awemeId===binding.id?fresh.data:item);
   await currentPlan.hooks?.sourceRefreshed(binding.id,binding.uri,fresh.data,uri,headers);
   if(own===generation&&plan===currentPlan)await run(++generation);
  }else if(!foreground(binding.id)){
   const failure=results.snapshot().find(value=>value.id===binding.id)!;
   const removed=await currentPlan.hooks?.quarantine(binding.id,failure);
   if(own!==generation||plan!==currentPlan||foreground(binding.id)||!removed)return;
   currentPlan.items=currentPlan.items.filter(item=>item.awemeId!==binding.id);await run(++generation);
  }
 };
 const stop=(expected?:unknown)=>{
  if(expected!==undefined){bluetoothOwners.delete(expected);if(expected!==owner)return;}else bluetoothOwners.clear();
  results.begin();resultOff?.();resultOff=undefined;generation++;networkGeneration++;lastAllowed=undefined;owner=undefined;plan=undefined;unsubscribe?.();unsubscribe=undefined;
  void mediaPrefixCache.window([]).result.catch(()=>{});
 };
 const networkChanged=()=>{const op=++networkGeneration;void allowed().then(value=>{if(op!==networkGeneration||!plan||value===lastAllowed)return;void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));}).catch(()=>{});};
 managedCache.registerProducer('douyin-preload',{pins:()=>new Set<string>(),async clear(){if(migrating)return;stop();await mediaPrefixCache.clear().result;await video.clearFrames?.();kv.delete?.('watchrss.douyin.prefetch-failures');}});
 return {
  // A proxy is not a complete local file; queue resolution must continue enforcing URL TTL.
  capabilities:()=>({coverCache:true,actualFrame:true,prefixBytes:true,completeVideo:false}),
  async restoreFrame(item:DouyinItem,headers:Record<string,string>){return video.restoreFrame(`douyin:${item.awemeId}`,{url:preserveSelectedDouyinItem(item).playUrl,headers});},
  failures:()=>results.snapshot(),
  sourceFor:(uri:string)=>sources.get(uri),
  lookup:async(_id:string):Promise<string|undefined>=>undefined,
  async playback(item:DouyinItem,headers:Record<string,string>){await cleanupOldFiles();const resolved=await client.resolvePlayback(item.awemeId);if(!resolved.ok){appLogger.i('DouyinProxy',`foreground resolve failed category=${resolved.code}`);throw Object.assign(new Error(resolved.message),{code:resolved.code,retryAfterMs:resolved.retryAfterMs});}traceDouyinVariants(resolved.data,'foreground',resolved.source==='feed-cache'?'feed-cache':'network');try{return await register(resolved.data,headers)??resolved.data.playUrl;}catch{appLogger.w('DouyinProxy','registration failed; using network');return remember(resolved.data.playUrl,resolved.data);}},
  async invalidate(_id:string){sources.clear();await mediaPrefixCache.clear().result;},stop,stats,
  allowBluetooth(value:boolean,expected:unknown){if(bluetoothOwners.has(expected)===value)return;if(value)bluetoothOwners.add(expected);else bluetoothOwners.delete(expected);if(expected===owner)networkChanged();},
  start(next:unknown,items:readonly DouyinItem[],anchor:string|undefined,mode:'active'|'entry',hooks?:DouyinPrefetchHooks){
   if(next!==owner){client.resetPrefetchFailures?.();results.begin(true);unsubscribe?.();unsubscribe=undefined;lastAllowed=undefined;}owner=next;plan={items,anchor,mode,hooks};
   resultOff??=mediaPrefixCache.onResult?.(event=>{void consume(event).catch(()=>appLogger.w('DouyinProxy','prefetch result handling failed'));});
   unsubscribe??=onNetworkChange(networkChanged,networkChanged);void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));
  },
 };
}
