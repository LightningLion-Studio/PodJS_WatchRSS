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
export function createHostDouyinPreload(client:DouyinClient,stock?:import('./stock.ts').DouyinStock) {
 let owner:unknown,plan:{items:readonly DouyinItem[];anchor?:string;mode:'active'|'entry';hooks?:DouyinPrefetchHooks}|undefined;
 type Target={uri:string;prefetchBytes:number;captureBytes:number;itemToken:string;generation:number};
 const published=new Map<string,Target>();
 let generation=0,lastAllowed:boolean|undefined,unsubscribe:(()=>void)|undefined,networkGeneration=0;
 let saved:PrefetchFailure[]=[];try{const value=kv.get<unknown>('watchrss.douyin.prefetch-failures');if(Array.isArray(value))saved=value;}catch{}
 const results=new DouyinPrefetchResults(Date.now,saved);let resultOff:(()=>void)|undefined,token=0;
 const foreground=(id:string)=>plan?.hooks?.isForeground(id)??(plan?.mode==='active'&&plan.anchor===id);
 const sources=new Map<string,DouyinItem>();
 const remember=(uri:string,item:DouyinItem)=>{sources.set(uri,item);while(sources.size>200)sources.delete(sources.keys().next().value!);return uri;};
 const bluetoothOwners=new Set<unknown>();
 let ownerHeaders:{owner:unknown;authorization:number;value:Promise<Record<string,string>>}|undefined;
 const headersForOwner=()=>{const authorization=client.playbackAuthorizationVersion?.()??0;if(ownerHeaders&&ownerHeaders.owner===owner&&ownerHeaders.authorization===authorization)return ownerHeaders.value;
  const record={owner,authorization,value:client.buildPlaybackHeaders()};ownerHeaders=record;void record.value.catch(()=>{if(ownerHeaders===record)ownerHeaders=undefined;});return record.value;};
 let migration:Promise<void>|undefined,migrating=false;
 const cleanupOldFiles=()=>migration??=(async()=>{
  const before=await managedCache.stats();const bytes=before.bucketBytes['douyin-preload'];
  if(!(bytes>0))return;
  migrating=true;try{await managedCache.clearBucket('douyin-preload');}finally{migrating=false;}
  appLogger.i('DouyinProxy',`oldWholeFilesRemoved bytes=${bytes}`);
 })().catch(()=>{appLogger.w('DouyinProxy','legacy cache cleanup failed; playback continues');});
 const stats=async()=>{const s=await mediaPrefixCache.stats().result;appLogger.i('DouyinProxy',`cache files=${s.files} bytes=${s.bytes} downloadedBytes=${s.downloadedBytes} cacheReadBytes=${s.cacheReadBytes} networkReadBytes=${s.networkReadBytes} maxBytes=${s.maxBytes}`);return s;};
 const allowed=async()=>douyinPreloadAllowed(await discovery.networkSnapshot(),bluetoothOwners.has(owner));
 const playbackLookup=async(id:string)=>stock?.playbackReady?(await stock.playbackReady(id))?.uri:stock?.lookup(id);
 const register=async(item:DouyinItem,headers:Record<string,string>)=>{
  const selected=preserveSelectedDouyinItem(item);if(!selected.playUrl)return undefined;
  const uri=(await mediaPrefixCache.register(selected.awemeId,selected.playUrl,headers).result).uri;
  registerVideoResolution(uri,takeVideoResolution(selected.playUrl,'douyin'));return remember(uri,selected);
 };
 const run=async(own:number)=>{
  if(!plan)return;const enabled=await allowed();if(own!==generation)return;lastAllowed=enabled;
  if(!enabled){published.clear();await mediaPrefixCache.window([]).result;return;}
  await cleanupOldFiles();if(own!==generation||!plan)return;
  results.begin();const targets=douyinProxyWindow(plan.items,plan.anchor,plan.mode).slice(0,videoOptEnabled('traffic')?2:undefined),mode=plan.mode;
  const headers=await headersForOwner();if(own!==generation)return;
  // Foreground resolution stays independent: one rejected neighbour cannot block its prepare.
  const prepared:{id:string;target:Target}[]=[];
  const publish=async(foregroundBitrate:number)=>{
   const resolved=new Map(prepared.map(x=>[x.id,x.target])),window=targets.map(item=>({id:item.awemeId,target:resolved.get(item.awemeId)??published.get(item.awemeId)})).filter((x):x is {id:string;target:Target}=>!!x.target);
   await mediaPrefixCache.window(window.map(x=>x.target),foregroundBitrate).result;
   if(own===generation){published.clear();for(const x of window)published.set(x.id,x.target);}
  };
  let foregroundBitrate=mode==='active'?selectPreferredDouyinVariant(targets[0]?.variants??[])?.bitrate??0:0;
  for(const item of targets){
   if(own!==generation)return;const center=Math.max(0,plan!.items.findIndex(value=>value.awemeId===plan!.anchor));
   // Backward entries register existing sources only. They never request detail.
   const backward=mode==='active'&&plan!.items.findIndex(value=>value.awemeId===item.awemeId)<center;
   const stocked=await playbackLookup(item.awemeId);if(own!==generation)return;
   const result=stocked||backward?{ok:true as const,data:item}:await client.resolvePlayback(item.awemeId,{prefetch:true,feedItem:item,allowDetail:false});if(own!==generation)return;
   if(!result.ok){published.delete(item.awemeId);appLogger.i('DouyinProxy',`resolve failed category=${result.code}`);continue;}
   const uri=stocked??await register(result.data,headers);if(own!==generation)return;if(!uri)continue;
   if(mode==='active'&&item.awemeId===plan?.anchor)foregroundBitrate=(result.data.variants??[]).find(v=>v.playUrl===result.data.playUrl)?.bitrate??0;
   const itemToken=`p${++token}`;const bitrate=(result.data.variants??[]).find(v=>v.playUrl===result.data.playUrl)?.bitrate??0;results.bind({id:item.awemeId,itemToken,generation:own,uri,url:result.data.playUrl});
   prepared.push({id:item.awemeId,target:{uri,itemToken,generation:own,prefetchBytes:stocked||mode==='active'&&item.awemeId===plan?.anchor?0:douyinPrefetchBytes(undefined,result.data.durationMs,prepared.length,bitrate),captureBytes:douyinPreviewBytes(undefined,result.data.durationMs,bitrate)}});
   if(own!==generation)return;
   // Preserve still-wanted transfers while publishing newly resolved sources.
   await publish(foregroundBitrate);
  }
  if(own===generation){await publish(foregroundBitrate);await stats();}
 };
 const consume=async(event:MediaPrefetchResult)=>{
  const action=results.result(event,foreground);if(action)try{kv.set('watchrss.douyin.prefetch-failures',results.snapshot());}catch{}if(!action||action.action==='none')return;
  const {binding}=action,own=generation,currentPlan=plan;if(!currentPlan)return;
  if(action.action==='refresh'){
   const item=currentPlan.items.find(value=>value.awemeId===binding.id);if(!item)return;
   const fresh=await client.resolvePlayback(binding.id,{forceRefresh:true,prefetch:!foreground(binding.id),feedItem:item,allowDetail:false});
   if(own!==generation||plan!==currentPlan||!results.current(binding)||!fresh.ok)return;
   const headers=await headersForOwner(),uri=await register(fresh.data,headers);
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
  published.clear();results.begin();resultOff?.();resultOff=undefined;generation++;networkGeneration++;lastAllowed=undefined;ownerHeaders=undefined;owner=undefined;plan=undefined;unsubscribe?.();unsubscribe=undefined;
  void mediaPrefixCache.window([]).result.catch(()=>{});
 };
 const networkChanged=()=>{const op=++networkGeneration;void allowed().then(value=>{if(op!==networkGeneration||!plan||value===lastAllowed)return;void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));}).catch(()=>{});};
 managedCache.registerProducer('douyin-preload',{pins:()=>new Set<string>(),async clear(){if(migrating)return;stop();await mediaPrefixCache.clear().result;await video.clearFrames?.();kv.delete?.('watchrss.douyin.prefetch-failures');stock?.clear();}});
 return {
  // A proxy is not a complete local file; queue resolution must continue enforcing URL TTL.
  capabilities:()=>({coverCache:true,actualFrame:true,prefixBytes:true,completeVideo:false}),
  async restoreFrame(item:DouyinItem,headers:Record<string,string>){return video.restoreFrame(`douyin:${item.awemeId}`,{url:preserveSelectedDouyinItem(item).playUrl,headers});},
  async readySource(item:DouyinItem,headers?:Record<string,string>){
   const ready=stock?.playbackReady?await stock.playbackReady(item.awemeId,headers):await stock?.ready?.(item.awemeId,headers);if(!ready)return undefined;
   const frame=ready.frame??await video.restoreFrame(`douyin:${item.awemeId}`,{url:ready.uri});
   return frame.available?{item:ready.item??item,url:remember(ready.uri,ready.item??item),previewFrame:{entryId:item.awemeId,frame}}:undefined;
  },
  async previewFrame(item:DouyinItem){const uri=await playbackLookup(item.awemeId);if(!uri)return undefined;const frame=await video.restoreFrame(`douyin:${item.awemeId}`,{url:uri});return frame.available?{entryId:item.awemeId,frame}:undefined;},
  failures:()=>results.snapshot(),
  sourceFor:(uri:string)=>sources.get(uri),
  lookup:async(id:string):Promise<string|undefined>=>playbackLookup(id),
  async playback(item:DouyinItem,headers:Record<string,string>){const local=await playbackLookup(item.awemeId);if(local)return remember(local,item);await cleanupOldFiles();const resolved=await client.resolvePlayback(item.awemeId,{feedItem:item,allowDetail:false});if(!resolved.ok){appLogger.i('DouyinProxy',`foreground resolve failed category=${resolved.code}`);throw Object.assign(new Error(resolved.message),{code:resolved.code,retryAfterMs:resolved.retryAfterMs});}traceDouyinVariants(resolved.data,'foreground',resolved.source==='feed-cache'?'feed-cache':'network');try{return await register(resolved.data,headers)??resolved.data.playUrl;}catch{appLogger.w('DouyinProxy','registration failed; using network');return remember(resolved.data.playUrl,resolved.data);}},
  async invalidate(_id:string){sources.clear();await mediaPrefixCache.clear().result;},stop,stats,
  allowBluetooth(value:boolean,expected:unknown){if(bluetoothOwners.has(expected)===value)return;if(value)bluetoothOwners.add(expected);else bluetoothOwners.delete(expected);if(expected===owner)networkChanged();},
  start(next:unknown,items:readonly DouyinItem[],anchor:string|undefined,mode:'active'|'entry',hooks?:DouyinPrefetchHooks){
   if(next!==owner){published.clear();client.resetPrefetchFailures?.();results.begin(true);unsubscribe?.();unsubscribe=undefined;lastAllowed=undefined;}owner=next;plan={items,anchor,mode,hooks};
   resultOff??=mediaPrefixCache.onResult?.(event=>{void consume(event).catch(()=>appLogger.w('DouyinProxy','prefetch result handling failed'));});
   unsubscribe??=onNetworkChange(networkChanged,networkChanged);void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));
  },
 };
}
