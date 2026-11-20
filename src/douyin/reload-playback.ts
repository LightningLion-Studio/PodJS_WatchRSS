import {playerFailureCode} from '../media/player-errors.ts';
import {isTransportFailure} from '../network/recovery.ts';
import {douyinPlaybackAddressExpired} from './media-expiry.ts';
import {douyinPlaybackMirrors} from './playback-mirrors.ts';
import {douyinPlaybackFailure} from './errors.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';

export type DouyinReloadMode = 'feed' | 'current' | 'detail';

export function retryableDouyinSourceFailure(error:unknown):boolean {
  if(douyinPlaybackFailure(error).retryAfterMs!==undefined)return false;
  const fault=playerFailureCode(error);
  if(fault==='cancelled'||fault==='stale'||fault==='restricted'||fault==='permission_denied')return false;
  return isTransportFailure(error)||['source_expired','cdn_error','network_error','timeout','cache_error','prepare_failed','video_error'].includes(fault);
}

export async function reloadDouyinPlayback(
  client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,
  id:string,
  current:()=>boolean,
  feedItem:DouyinItem,
  mode:DouyinReloadMode='feed',
  previousUrls:readonly string[]=[],
){
  if(!current())return;
  const options=mode==='detail'
    ?{forceRefresh:true,allowDetail:true,freshRequest:true}
    :{forceRefresh:mode==='feed',allowDetail:false,freshRequest:mode==='feed',feedItem};
  const result=await client.resolvePlayback(id,options);
  if(!current())return;
  if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,...(result.networkFailure?{networkFailure:true}:{}),...(result.httpStatus?{httpStatus:result.httpStatus}:{})});
  const oldUrls=new Set([feedItem.playUrl,...douyinPlaybackMirrors(feedItem),...previousUrls]);
  if(mode==='detail'&&(result.data.awemeId!==id||oldUrls.has(result.data.playUrl))){
    throw Object.assign(new Error('详情未返回该视频的新播放地址'),{code:'TEMPORARILY_UNAVAILABLE'});
  }
  const item=mode==='detail'?{
    ...result.data,
    variants:result.data.variants?.filter(variant=>!oldUrls.has(variant.playUrl))
      .map(variant=>({...variant,playUrls:variant.playUrls?.filter(url=>!oldUrls.has(url))})),
  }:result.data;
  if(mode==='detail'&&douyinPlaybackAddressExpired(item)){
    throw Object.assign(new Error('详情播放地址已过期'),{code:'TEMPORARILY_UNAVAILABLE'});
  }
  const headers=await client.buildPlaybackHeaders();
  if(!current())return;
  return {item,headers};
}
