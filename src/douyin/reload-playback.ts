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
  const headers=await client.buildPlaybackHeaders();
  if(!current())return;
  const item=mode==='detail'?{
    ...result.data,
    variants:result.data.variants?.filter(variant=>!oldUrls.has(variant.playUrl))
      .map(variant=>({...variant,playUrls:variant.playUrls?.filter(url=>!oldUrls.has(url))})),
  }:result.data;
  return {item,headers};
}
