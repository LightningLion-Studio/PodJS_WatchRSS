import type {DouyinClient} from './client.ts';
import type {DouyinItem} from './types.ts';
import {douyinVideoTarget} from '../reader/media.ts';
import {DouyinSavedPlaybackDiagnostic,savedPlaybackContext} from './saved-playback-diagnostics.ts';

/** Detail/history entry shares the same opening trace as the RSS reader player. */
export async function prepareSavedDetailPlayback(client:DouyinClient,item:DouyinItem,isCurrent:()=>boolean){
 let context:{kind:string;savedAtMillis?:number}={kind:'unknown'};
 try{context=savedPlaybackContext(await client.listSaved(),item.awemeId);}catch{}
 if(!isCurrent())return;
 const diagnostic=new DouyinSavedPlaybackDiagnostic({...context,itemId:item.awemeId,url:item.playUrl});
 try{
  const result=await client.resolvePlayback(item.awemeId,{observeResolution:value=>diagnostic.resolution('initial',value)});
  if(!isCurrent()){diagnostic.abandon();return;}
  const playback=result.ok?result.data:item.playUrl.trim()&&!douyinVideoTarget(item.playUrl)?item:null;
  if(!playback)throw Error(result.ok?'播放地址为空':result.message);
  diagnostic.address('initial',item.playUrl&&!douyinVideoTarget(item.playUrl)?item.playUrl:undefined,playback.playUrl);
  return {playback,diagnostic};
 }catch(error){if(isCurrent())diagnostic.openError();else diagnostic.abandon();diagnostic.end();throw error;}
}
