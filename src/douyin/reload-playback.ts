import {playerFailureCode} from '../media/player-errors.ts';
import {directDouyinMediaUrl} from './cache-availability.ts';
import {douyinPlaybackFailure} from './errors.ts';
import {douyinPlaybackAddresses} from './media-expiry.ts';
import {douyinPlaybackMirrors} from './playback-mirrors.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';

export type DouyinReloadMode = 'feed' | 'current' | 'detail';

export async function reloadDouyinPlayback(
  client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,
  id:string,
  current:()=>boolean,
  feedItem:DouyinItem,
  mode:DouyinReloadMode='feed',
  previousUrls:readonly string[]=[],
  requireFreshAddress=false,
){
  if(!current())return;
  const options=mode==='detail'
    ?{forceRefresh:true,allowDetail:true,freshRequest:true}
    :{forceRefresh:mode==='feed',allowDetail:false,freshRequest:mode==='feed',feedItem};
  const result=await client.resolvePlayback(id,options);
  if(!current())return;
  if(!result.ok)throw Object.assign(new Error(result.message),douyinPlaybackFailure(result));
  if(result.data.awemeId!==id || (mode!=='current' && !directDouyinMediaUrl(result.data.playUrl))){
    throw Object.assign(new Error('未返回该视频的可用播放地址'),{code:'TEMPORARILY_UNAVAILABLE'});
  }
  const oldUrls=requireFreshAddress?new Set([feedItem.playUrl,...douyinPlaybackMirrors(feedItem),...previousUrls]):undefined;
  if(oldUrls?.has(result.data.playUrl)){
    throw Object.assign(new Error('未返回该视频的新播放地址'),{code:'TEMPORARILY_UNAVAILABLE'});
  }
  const item=oldUrls?{
    ...result.data,
    variants:result.data.variants?.filter(variant=>!oldUrls.has(variant.playUrl))
      .map(variant=>({...variant,playUrls:variant.playUrls?.filter(url=>!oldUrls.has(url))})),
  }:result.data;
  const {directExpiresAtMs}=douyinPlaybackAddresses(item);
  if(directExpiresAtMs!==undefined&&directExpiresAtMs<=Date.now()){
    throw Object.assign(new Error('播放地址已过期'),{code:'source_expired'});
  }
  const headers=await client.buildPlaybackHeaders();
  if(!current())return;
  return {item,headers};
}

export function douyinDetailRestricted(error:unknown):boolean {
  const failure=douyinPlaybackFailure(error);
  const fault=playerFailureCode(error);
  if(failure.code==='NOT_LOGGED_IN'||fault==='cancelled'||fault==='stale')return false;
  return fault==='restricted'||fault==='permission_denied'||
    (failure.code==='TEMPORARILY_UNAVAILABLE'&&failure.retryAfterMs!==undefined)||
    [401,403,412,429].includes(failure.httpStatus??0);
}
