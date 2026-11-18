import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
/** Queue playback uses the ordinary feed contract, including on reload.
 * A timed-out native player can retry current metadata through that resolver;
 * its normal expiry and admission checks still apply.
 * If the refreshed page omits this ID, keep the target failed and retryable;
 * never probe the separately restricted detail endpoint or replay an expired URL. */
export async function reloadDouyinPlayback(client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,id:string,current:()=>boolean,feedItem:DouyinItem,retryCurrent=false){
  const result=await client.resolvePlayback(id,{forceRefresh:!retryCurrent,allowDetail:false,freshRequest:!retryCurrent,feedItem});
  if(!current())return;
  if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code,...(result.networkFailure?{networkFailure:true}:{}),...(result.httpStatus?{httpStatus:result.httpStatus}:{})});
  const headers=await client.buildPlaybackHeaders();
  return current()?{item:result.data,headers}:undefined;
}
