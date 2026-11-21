import {playerFailureCode} from '../media/player-errors.ts';
import {isTransportFailure} from '../network/recovery.ts';
import {directDouyinMediaUrl} from './cache-availability.ts';
import {douyinPlaybackFailure} from './errors.ts';
import {douyinMediaNetworkDeadline} from './media-expiry.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';

export type DouyinReloadMode = 'feed' | 'current' | 'detail';

export async function reloadDouyinPlayback(
  client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,
  id:string,
  current:()=>boolean,
  feedItem:DouyinItem,
  mode:DouyinReloadMode='feed',
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
  const headers=await client.buildPlaybackHeaders();
  if(!current())return;
  return {item:result.data,headers};
}

export function failedDouyinAddresses(addresses:readonly string[],nativeExpired:boolean,now=Date.now()):readonly string[] {
  const expired=addresses.filter(url=>isExpired([url],now));
  // A CDN deadline identifies the failed addresses even when native reports
  // expiry for the entire cache capability. Otherwise keep the failed binding.
  return expired.length||!nativeExpired?expired:addresses;
}

export function assertDouyinAddresses(addresses:readonly string[],failed:readonly string[],now=Date.now()):void {
  if(addresses.some(url=>failed.includes(url))||isExpired(addresses,now)){
    throw Object.assign(new Error('播放地址已过期'),{code:'source_expired'});
  }
}

function isExpired(addresses:readonly string[],now:number):boolean {
  const expiry=douyinMediaNetworkDeadline(addresses);
  return expiry!==undefined&&expiry<=now;
}

export function retryableDouyinSourceFailure(error:unknown):boolean {
  if(douyinPlaybackFailure(error).retryAfterMs!==undefined)return false;
  const fault=playerFailureCode(error);
  if(fault==='cancelled'||fault==='stale'||fault==='restricted'||fault==='permission_denied')return false;
  return isTransportFailure(error)||['source_expired','cdn_error','network_error','timeout','cache_error','prepare_failed','video_error'].includes(fault);
}

export function douyinDetailRestricted(error:unknown):boolean {
  const failure=douyinPlaybackFailure(error);
  const fault=playerFailureCode(error);
  if(failure.code==='NOT_LOGGED_IN'||fault==='cancelled'||fault==='stale')return false;
  return fault==='restricted'||fault==='permission_denied'||
    (failure.code==='TEMPORARILY_UNAVAILABLE'&&failure.retryAfterMs!==undefined)||
    [401,403,412,429].includes(failure.httpStatus??0);
}
