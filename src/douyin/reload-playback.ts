import type {DouyinClient} from './client.ts';
/** Reload the selected video by ID. A new recommendation page need not contain
 * the selected ID, so feed-only resolution cannot reconnect an expired stream. */
export async function reloadDouyinPlayback(client:Pick<DouyinClient,'resolvePlayback'|'buildPlaybackHeaders'>,id:string,current:()=>boolean){
  const result=await client.resolvePlayback(id,{forceRefresh:true,allowDetail:true,freshRequest:true});
  if(!current())return;
  if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code});
  const headers=await client.buildPlaybackHeaders();
  return current()?{item:result.data,headers}:undefined;
}
