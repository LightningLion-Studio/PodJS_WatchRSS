import {playerFailureCode} from '../media/player-errors.ts';
import {directDouyinMediaUrl} from './cache-availability.ts';
import {douyinPlaybackFailure} from './errors.ts';
import {douyinPlaybackAddresses} from './media-expiry.ts';
import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';

export type DouyinReloadMode = 'feed' | 'current' | 'detail';

interface ReloadAddresses {
  playUrl: string;
  audioUrl?: string;
  mirrors: readonly string[];
}

interface ReloadOptions {
  previousAddresses?: ReloadAddresses;
  includeMirrors?: boolean;
}

export async function reloadDouyinPlayback(
  client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,
  id:string,
  current:()=>boolean,
  feedItem:DouyinItem,
  mode:DouyinReloadMode='feed',
  previousUrls:readonly string[]=[],
  requireFreshAddress=false,
  {previousAddresses,includeMirrors=mode==='detail'}:ReloadOptions={},
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
  let item=result.data;
  if(requireFreshAddress){
    const previous=previousAddresses??{playUrl:feedItem.playUrl,...douyinPlaybackAddresses(feedItem)};
    const oldUrls=new Set([previous.playUrl,...previous.mirrors,...previousUrls]);
    const addresses=douyinPlaybackAddresses(item);
    if(oldUrls.has(item.playUrl)){
      // An unchanged video can still have a replacement track or mirror.
      const audioChanged=!!previous.audioUrl&&!!addresses.audioUrl&&previous.audioUrl!==addresses.audioUrl;
      const mirrorChanged=includeMirrors&&previous.mirrors.length>0&&
        addresses.mirrors.some(url=>url!==previous.playUrl&&!previous.mirrors.includes(url));
      if(item.playUrl!==previous.playUrl||(previous.audioUrl&&!addresses.audioUrl)||(!audioChanged&&!mirrorChanged)){
        throw Object.assign(new Error('未返回该视频的新播放地址'),{code:'TEMPORARILY_UNAVAILABLE'});
      }
    }else{
      item={
        ...item,
        variants:item.variants?.filter(variant=>!oldUrls.has(variant.playUrl))
          .map(variant=>({...variant,playUrls:variant.playUrls?.filter(url=>!oldUrls.has(url))})),
      };
    }
  }
  const {expiresAtMs,directExpiresAtMs}=douyinPlaybackAddresses(item);
  const expiry=requireFreshAddress&&includeMirrors?expiresAtMs:directExpiresAtMs;
  if(expiry!==undefined&&expiry<=Date.now()){
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
