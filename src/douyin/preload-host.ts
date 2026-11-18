import {douyinCacheUnavailable,directDouyinMediaUrl} from './cache-availability.ts';
import {douyinPrestoreConfig} from './prestore-policy.ts';
import {PlaybackCache,playbackPayloadBytes} from './cache-budget.ts';
import {douyinMediaExpiry,douyinMediaNetworkDeadline} from './media-expiry.ts';
import {douyinPlaybackMirrors} from './playback-mirrors.ts';
import {preserveSelectedDouyinItem,videoOptEnabled,takeVideoResolution,registerVideoResolution} from '../media/video-opt.ts';
import {kv} from '@podjs/framework/watch';
import {video} from '@podjs/framework/services';
import {DouyinPrefetchResults,type PrefetchFailure,type PrefetchBinding} from './prefetch-results.ts';
import type {MediaPrefetchResult} from '@podjs/framework/media-prefix-cache';
import {traceDouyinVariants} from './playback-diagnostics.ts';
import {mediaPrefixCache,localMediaStore} from '@podjs/framework/media-prefix-cache';
import {discovery,onNetworkChange} from '@podjs/framework/services';
import {managedCache} from '../cache/host.ts';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {douyinPreloadAllowed} from './preload.ts';
import {DOUYIN_PROXY,douyinProxyWindow,douyinPrefetchBytes,douyinPreviewBytes} from './proxy-policy.ts';
import {DOUYIN_MAX_SHORT_EDGE,douyinPlaybackAudio,selectPreferredDouyinVariant} from './playback-selector.ts';
import {withoutDouyinSource} from './playback-ingress.ts';

export interface DouyinPrefetchHooks {
 isForeground(id:string):boolean;
 sourceRefreshed(id:string,previousUri:string,item:DouyinItem,uri:string,headers:Record<string,string>):void|Promise<void>;
 rejectSource?(binding:PrefetchBinding):boolean|Promise<boolean>;
 quarantine(id:string,failure:PrefetchFailure):boolean|Promise<boolean>;
}
/** Business window/consent only. Range transport, storage bounds and cancellation live in PodJS. */
export function createHostDouyinPreload(client:DouyinClient,stock?:import('./stock.ts').DouyinStockService) {
 let owner:unknown,plan:{items:readonly DouyinItem[];anchor?:string;mode:'active'|'entry';hooks?:DouyinPrefetchHooks}|undefined;
 type Target={uri:string;prefetchBytes:number;captureBytes:number;itemToken:string;generation:number;preStore?:boolean};
 const published=new Map<string,Target>();
 let trafficStoppedUntil=0;let generation=0,lastAllowed:boolean|undefined,unsubscribe:(()=>void)|undefined,networkGeneration=0;
 let saved:PrefetchFailure[]=[];try{const value=kv.get<unknown>('watchrss.douyin.prefetch-failures');if(Array.isArray(value))saved=value;}catch{}
 const results=new DouyinPrefetchResults(Date.now,saved);let resultOff:(()=>void)|undefined,token=0;
 const foreground=(id:string)=>plan?.hooks?.isForeground(id)??(plan?.mode==='active'&&plan.anchor===id);
 const sources=new PlaybackCache<string,DouyinItem>(2*1024*1024,16,(item,key)=>playbackPayloadBytes(item)+key.length*2);
 const registered=new PlaybackCache<string,{uri:string;playUrl:string;mirrors:string[];audioUrl?:string;authorization:number;headersKey:string;expires:number}>(2*1024*1024,16,value=>2*(value.uri.length+value.playUrl.length+(value.audioUrl?.length??0)+value.headersKey.length+value.mirrors.reduce((n,url)=>n+url.length,0)));
 const remember=(uri:string,item:DouyinItem)=>{sources.delete(uri);sources.set(uri,item);while(sources.size>16)sources.delete(sources.keys().next().value!);return uri;};
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
 const optionalCache=async<T>(work:()=>Promise<T>):Promise<T|undefined>=>{try{return await work();}catch(error){if(!douyinCacheUnavailable(error))throw error;appLogger.w('DouyinProxy','optional cache unavailable');return undefined;}};
 const pending=new Map<string,Promise<string|undefined>>();
 const forget=(id:string,uri:string)=>{
  sources.delete(uri);
  if(registered.get(id)?.uri===uri)registered.delete(id);
  if(published.get(id)?.uri===uri)published.delete(id);
 };
 const sameMirrors=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((url,i)=>url===b[i]);
 const register=(item:DouyinItem,headers:Record<string,string>,current:()=>boolean=()=>true)=>{
  const id=item.awemeId,prior=pending.get(id);
  const work=(async()=>{
   if(prior)await prior.catch(()=>{});
   if(!current())return;
   const selected=preserveSelectedDouyinItem(item);
   if(!selected.playUrl)return;
   const audioUrl=douyinPlaybackAudio(selected),mirrors=douyinPlaybackMirrors(selected);
   const authorization=client.playbackAuthorizationVersion?.()??0,headersKey=JSON.stringify(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]).sort()),previous=registered.get(id);
   if(previous&&previous.authorization===authorization&&previous.headersKey===headersKey&&previous.playUrl===selected.playUrl&&previous.audioUrl===audioUrl&&sameMirrors(previous.mirrors,mirrors)&&Date.now()<previous.expires)return remember(previous.uri,selected);
   const expires=Math.min(...[selected.playUrl,...mirrors].map(url=>douyinMediaExpiry(url,Date.now())));
   const {uri}=await mediaPrefixCache.register(id,selected.playUrl,headers,false,mirrors,douyinMediaNetworkDeadline([selected.playUrl,...mirrors,...(audioUrl?[audioUrl]:[])]),audioUrl,DOUYIN_MAX_SHORT_EDGE,previous?.uri??'').result;
   if(previous&&previous.uri!==uri)forget(id,previous.uri);
   if(!current()){await mediaPrefixCache.remove(uri).result.catch(()=>{});return;}
   registered.delete(id);registered.set(id,{uri,playUrl:selected.playUrl,audioUrl,mirrors,authorization,headersKey,expires});
   registerVideoResolution(uri,takeVideoResolution(selected.playUrl,'douyin'));return remember(uri,selected);
  })();
  pending.set(id,work);
  void work.finally(()=>{if(pending.get(id)===work)pending.delete(id);}).catch(()=>{});
  return work;
 };
 const run=async(own:number)=>{
  if(!plan)return;const cfg=douyinPrestoreConfig(kv.get('watchrss.douyin.prestore.v1'));const enabled=Date.now()>=trafficStoppedUntil&&await allowed();if(own!==generation)return;lastAllowed=enabled;
  if(!enabled){published.clear();await mediaPrefixCache.window([]).result;return;}
  await cleanupOldFiles();if(own!==generation||!plan)return;
  results.begin();const targets=douyinProxyWindow(plan.items,plan.anchor,plan.mode,cfg.enabled?cfg.ahead:6).slice(0,videoOptEnabled('traffic')?2:undefined),mode=plan.mode;
  const headers=await headersForOwner();if(own!==generation)return;
  // Foreground resolution stays independent: one rejected neighbour cannot block its prepare.
  const prepared:{id:string;target:Target}[]=[];
  const publish=async(foregroundBitrate:number)=>{
   const resolved=new Map(prepared.map(x=>[x.id,x.target])),window=targets.map(item=>({id:item.awemeId,target:resolved.get(item.awemeId)??published.get(item.awemeId)})).filter((x):x is {id:string;target:Target}=>!!x.target);
   await mediaPrefixCache.window(window.map(x=>x.target),foregroundBitrate).result;
   if(own===generation){published.clear();for(const x of window)published.set(x.id,x.target);}
  };
  let foregroundBitrate=mode==='active'?selectPreferredDouyinVariant(targets[0]?.variants??[])?.bitrate??0:0;
  const targetFor=(item:DouyinItem,uri:string,stocked=false):Target=>{
   const itemToken=`p${++token}`,bitrate=(item.variants??[]).find(v=>v.playUrl===item.playUrl)?.bitrate??0;
   const registration=registered.get(item.awemeId);
   results.bind({id:item.awemeId,itemToken,generation:own,uri,
    url:registration?.uri===uri?registration.playUrl:item.playUrl,
    mirror:registration?.uri===uri?registration.mirrors[0]:undefined});
   return {uri,itemToken,generation:own,preStore:cfg.enabled,prefetchBytes:stocked||mode==='active'&&item.awemeId===plan?.anchor?0:douyinPrefetchBytes(undefined,item.durationMs,0,bitrate),captureBytes:douyinPreviewBytes(undefined,item.durationMs,bitrate)};
  };
  // A reverse gesture can return to a decoded source outside the last window.
  // Publish known, still-authorized registrations before serial stock/resolution
  // awaits. Native can reload its disk pixels while those unrelated reads wait.
  // Reuse the existing 16-entry/2 MiB registration budget, not another history.
  const authorization=client.playbackAuthorizationVersion?.()??0,headersKey=JSON.stringify(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]).sort());
  for(const item of targets){
   const known=registered.get(item.awemeId),selected=preserveSelectedDouyinItem(item);
   if(known&&known.authorization===authorization&&known.headersKey===headersKey&&known.playUrl===selected.playUrl&&known.audioUrl===douyinPlaybackAudio(selected)&&sameMirrors(known.mirrors,douyinPlaybackMirrors(selected))&&Date.now()<known.expires)
    prepared.push({id:item.awemeId,target:targetFor(selected,known.uri)});
  }
  if(prepared.length)await publish(foregroundBitrate);
  for(const item of targets){
   if(own!==generation)return;const center=Math.max(0,plan!.items.findIndex(value=>value.awemeId===plan!.anchor));
   // Backward entries register existing sources only. They never request detail.
   const backward=mode==='active'&&plan!.items.findIndex(value=>value.awemeId===item.awemeId)<center;
   const stocked=await playbackLookup(item.awemeId);if(own!==generation)return;
   if(stocked?.startsWith('file:'))continue;
   // Background expiry never triggers a feed request. Foreground resolution owns bootstrap refresh.
   if(!stocked&&douyinMediaExpiry(preserveSelectedDouyinItem(item).playUrl,Date.now())<=Date.now())continue;
   const result=stocked||backward?{ok:true as const,data:item}:await client.resolvePlayback(item.awemeId,{prefetch:true,feedItem:item,allowDetail:false});if(own!==generation)return;
   if(!result.ok){published.delete(item.awemeId);const seeded=prepared.findIndex(value=>value.id===item.awemeId);if(seeded>=0)prepared.splice(seeded,1);appLogger.i('DouyinProxy',`resolve failed category=${result.code}`);continue;}
   const uri=stocked??await register(result.data,headers,()=>own===generation);if(own!==generation)return;if(!uri)continue;
   if(mode==='active'&&item.awemeId===plan?.anchor)foregroundBitrate=(result.data.variants??[]).find(v=>v.playUrl===result.data.playUrl)?.bitrate??0;
   const target=targetFor(result.data,uri,!!stocked),existing=prepared.findIndex(value=>value.id===item.awemeId);
   if(existing<0)prepared.push({id:item.awemeId,target});else prepared[existing]={id:item.awemeId,target};
   if(own!==generation)return;
   // Preserve still-wanted transfers while publishing newly resolved sources.
   await publish(foregroundBitrate);
  }
  if(own===generation){await publish(foregroundBitrate);stock?.offer?.(targets,plan?.anchor);await stats();}
 };
 const consume=async(event:MediaPrefetchResult)=>{
  if(event.httpStatus===403||event.httpStatus===429){trafficStoppedUntil=Date.now()+30_000;stock?.suspend?.();stop();return;}
  const action=results.result(event,foreground);if(action)try{kv.set('watchrss.douyin.prefetch-failures',results.snapshot());}catch{}if(!action||action.action==='none')return;
  const {binding}=action,own=generation,currentPlan=plan;if(!currentPlan)return;
  if(action.action==='rejectSource'){
   if(binding.generation!==own)return;
   forget(binding.id,binding.uri);
   if(await currentPlan.hooks?.rejectSource?.(binding))return;
   const item=currentPlan.items.find(value=>value.awemeId===binding.id);
   const next=item&&withoutDouyinSource(item,binding.url);
   if(own!==generation||plan!==currentPlan)return;
   await client.removePlaybackSource?.(binding.id,binding.url);
   if(own!==generation||plan!==currentPlan)return;
   currentPlan.items=currentPlan.items.flatMap(value=>value.awemeId!==binding.id?[value]:next?[next]:[]);
   await run(++generation);
   return;
  }
  if(action.action==='refresh'){
   const item=currentPlan.items.find(value=>value.awemeId===binding.id);if(!item)return;
   const fresh=await client.resolvePlayback(binding.id,{forceRefresh:true,prefetch:!foreground(binding.id),feedItem:item,allowDetail:false});
   if(own!==generation||plan!==currentPlan||!results.current(binding)||!fresh.ok)return;
   const headers=await headersForOwner(),uri=await register(fresh.data,headers,()=>own===generation&&plan===currentPlan&&results.current(binding));
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
  stock?.suspend?.();sources.clear();registered.clear();published.clear();results.begin();resultOff?.();resultOff=undefined;generation++;networkGeneration++;lastAllowed=undefined;ownerHeaders=undefined;owner=undefined;plan=undefined;unsubscribe?.();unsubscribe=undefined;
  void mediaPrefixCache.window([]).result.catch(()=>{});
 };
 const networkChanged=()=>{const op=++networkGeneration;void allowed().then(value=>{if(op!==networkGeneration||!plan||value===lastAllowed)return;void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));}).catch(()=>{});};
 managedCache.registerProducer('douyin-preload',{pins:()=>new Set<string>(),async clear(){if(migrating)return;trafficStoppedUntil=0;stop();await mediaPrefixCache.clear().result;await video.clearFrames?.();kv.delete?.('watchrss.douyin.prefetch-failures');stock?.clear();}});
 client.subscribeAuth?.(state=>{if(state!=='logged-in'){trafficStoppedUntil=0;stop();}});
 return {
  // A proxy is not a complete local file; queue resolution must continue enforcing URL TTL.
  capabilities:()=>({coverCache:true,actualFrame:true,prefixBytes:true,completeVideo:true}),
  async restoreFrame(item:DouyinItem,headers:Record<string,string>){return video.restoreFrame(`douyin:${item.awemeId}`,{url:preserveSelectedDouyinItem(item).playUrl,headers,maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE});},
  async readySource(item:DouyinItem,headers?:Record<string,string>){return optionalCache(async()=>{
   const ready=stock?.playbackReady?await stock.playbackReady(item.awemeId,headers):await stock?.ready?.(item.awemeId,headers);if(!ready)return undefined;
   const frame=ready.frame??await video.restoreFrame(`douyin:${item.awemeId}`,{url:ready.uri,maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE});
   return frame.available?{item:ready.item??item,url:remember(ready.uri,ready.item??item),previewFrame:{entryId:item.awemeId,frame}}:undefined;
  });},
  async previewFrame(item:DouyinItem){return optionalCache(async()=>{const uri=await playbackLookup(item.awemeId);if(!uri)return undefined;const frame=await video.restoreFrame(`douyin:${item.awemeId}`,{url:uri,maxVideoShortEdge:DOUYIN_MAX_SHORT_EDGE});return frame.available?{entryId:item.awemeId,frame}:undefined;});},
  failures:()=>results.snapshot(),
  sourceFor:(uri:string)=>sources.get(uri),
  lookup:async(id:string):Promise<string|undefined>=>optionalCache(()=>playbackLookup(id)),
  async playback(item:DouyinItem,headers:Record<string,string>){
   const windowItem=()=>plan?.items.find(value=>value.awemeId===item.awemeId);
   const initial=windowItem(),current=()=>{const latest=windowItem();return latest===initial||!latest||latest.playUrl===initial?.playUrl;};
   const cancelled=()=>Object.assign(new Error('播放来源已更换'),{code:'CANCELLED'});
   const local=await optionalCache(()=>playbackLookup(item.awemeId));
   if(!current())throw cancelled();
   if(local)return remember(local,item);
   await cleanupOldFiles();
   const resolved=await client.resolvePlayback(item.awemeId,{feedItem:item,allowDetail:false});
   if(!current())throw cancelled();
   if(!resolved.ok){appLogger.i('DouyinProxy',`foreground resolve failed category=${resolved.code}`);throw Object.assign(new Error(resolved.message),{code:resolved.code,retryAfterMs:resolved.retryAfterMs});}
   traceDouyinVariants(resolved.data,'foreground',resolved.source==='feed-cache'?'feed-cache':'network');
   try{
    const uri=await register(resolved.data,headers,current);
    if(!current())throw cancelled();
    if(!uri)throw Object.assign(new Error('没有可用的视频播放流'),{code:'UNSUPPORTED'});
    return uri;
   }catch(error){
    if(!current())throw cancelled();
    const urls=[resolved.data.playUrl,...(douyinPlaybackAudio(resolved.data)?[douyinPlaybackAudio(resolved.data)!]:[])],deadline=douyinMediaNetworkDeadline(urls);
    if(douyinCacheUnavailable(error)&&urls.every(directDouyinMediaUrl)&&(deadline===undefined||Date.now()<deadline)){
     appLogger.w('DouyinProxy','cache registration unavailable; using authorized media source');return remember(resolved.data.playUrl,resolved.data);
    }
    throw error;
   }
  },
  forgetSource:forget,
  async invalidate(_id:string){sources.clear();registered.clear();await mediaPrefixCache.clear().result;},stop,stats,
  allowBluetooth(value:boolean,expected:unknown){if(bluetoothOwners.has(expected)===value)return;if(value)bluetoothOwners.add(expected);else bluetoothOwners.delete(expected);if(expected===owner)networkChanged();},
  start(next:unknown,items:readonly DouyinItem[],anchor:string|undefined,mode:'active'|'entry',hooks?:DouyinPrefetchHooks){
   if(next!==owner){published.clear();client.resetPrefetchFailures?.();results.begin(true);unsubscribe?.();unsubscribe=undefined;lastAllowed=undefined;}owner=next;plan={items,anchor,mode,hooks};
   resultOff??=mediaPrefixCache.onResult?.(event=>{void consume(event).catch(()=>appLogger.w('DouyinProxy','prefetch result handling failed'));});
   unsubscribe??=onNetworkChange(networkChanged,networkChanged);void run(++generation).catch(()=>appLogger.w('DouyinProxy','window failed'));
  },
 };
}
