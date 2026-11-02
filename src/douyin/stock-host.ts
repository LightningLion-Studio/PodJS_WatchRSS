import {benchmark} from '@podjs/framework/benchmark';
import {backgroundMediaWork} from '../media/background-work.ts';
import {kv} from '@podjs/framework/watch';
import {mediaPrefixCache} from '@podjs/framework/media-prefix-cache';
import {discovery,video} from '@podjs/framework/services';
import {videoOptEnabled,preserveSelectedDouyinItem} from '../media/video-opt.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {DouyinStock,DOUYIN_STOCK_KEY,stockContentKey,stockNetworkAllowed,STOCK_COUNT} from './stock.ts';

export function createHostDouyinStock(client:DouyinClient){
 let feedWork:ReturnType<typeof backgroundMediaWork>|undefined;
 const registrations=new Map<string,{uri:string;remote:string;authorization:number}>();
 const authorization=()=>client.playbackAuthorizationVersion?.()??0;
 const register=async(item:DouyinItem,headers?:Record<string,string>,force=false)=>{
  const key=stockContentKey(item),version=authorization(),known=registrations.get(key);
  if(!force&&!headers&&known?.remote===item.playUrl&&known.authorization===version)return known.uri;
  const currentHeaders=headers??await client.buildPlaybackHeaders();if(version!==authorization())throw Error('authorization_changed');
  const {uri}=await mediaPrefixCache.register(key,item.playUrl,currentHeaders,true).result;
  if(version!==authorization())throw Error('authorization_changed');
  registrations.set(key,{uri,remote:item.playUrl,authorization:version});while(registrations.size>16)registrations.delete(registrations.keys().next().value!);
  return uri;
 };
 return new DouyinStock({
  read:()=>kv.get(DOUYIN_STOCK_KEY),write:entries=>{kv.set(DOUYIN_STOCK_KEY,entries);benchmark.begin('startup_stage',{startup_stage:'stock_saved',slots:entries.length});},now:Date.now,
  allowed:async()=>kv.get<boolean>('watchrss.douyin.stock.enabled')!==false&&await client.isLoggedIn()&&stockNetworkAllowed(await discovery.networkSnapshot(),videoOptEnabled('traffic'),kv.get<boolean>('watchrss.douyin.stock.wifi-only')!==false),
  watched:()=>client.listWatchedIds(),
  feed:async()=>{const work=backgroundMediaWork();feedWork=work;let result;try{result=await client.fetchFeedPage({count:12,background:work});}finally{if(feedWork===work)feedWork=undefined;}return result.ok?result.data.items.map(preserveSelectedDouyinItem):[];},
  prepare:async(item,bytes)=>{
   const stats=await mediaPrefixCache.stats().result;
   const budget=Math.max(512*1024,Math.min(bytes,Math.floor(stats.maxBytes/STOCK_COUNT)));
   return mediaPrefixCache.prepare(await register(item),budget,`douyin:${item.awemeId}`).result;
  },
  lookup:async(entry,headers)=>{
   const version=authorization();let uri=await register(entry.item,headers),state;
   try{state=await mediaPrefixCache.inspect(uri).result;}catch{uri=await register(entry.item,headers,true);state=await mediaPrefixCache.inspect(uri).result;}
   if(state.prefixBytes<entry.prefixBytes||state.tailBytes<entry.tailBytes)return undefined;
   const frame=await video.restoreFrame(`douyin:${entry.item.awemeId}`,{url:uri});
   return version===authorization()&&frame.available?{uri,frame}:undefined;
  },
  cancel:()=>{feedWork?.cancel();feedWork=undefined;void mediaPrefixCache.window([]).result.catch(()=>{});},
 });
}
