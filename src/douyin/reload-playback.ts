import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
/** Queue playback uses the ordinary feed contract, including on reload.
 * If the refreshed page omits this ID, keep the target failed and retryable;
 * never probe the separately restricted detail endpoint or replay the old URL. */
export async function reloadDouyinPlayback(client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,id:string,current:()=>boolean,feedItem:DouyinItem){
  const result=await client.resolvePlayback(id,{forceRefresh:true,allowDetail:false,freshRequest:true,feedItem});
  if(!current())return;
  if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,...(result.networkFailure?{networkFailure:true}:{}),...(result.httpStatus?{httpStatus:result.httpStatus}:{})});
  const headers=await client.buildPlaybackHeaders();
  return current()?{item:result.data,headers}:undefined;
}
