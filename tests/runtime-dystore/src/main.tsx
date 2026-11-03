import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,createEffect,Show} from 'solid-js';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {localMediaStore} from '@podjs/framework/media-prefix-cache';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {createHostDouyinStock} from '../../../src/douyin/stock-host.ts';
import {createHostDouyinPreload} from '../../../src/douyin/preload-host.ts';
import {ImmersiveEntry} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import {douyinDecoderProfile} from '../../../src/ui/douyin/video-sessions.ts';
import type {DouyinItem} from '../../../src/douyin/types.ts';
const metrics=getDisplayMetrics(),began=Date.now();
const items:DouyinItem[]=Array.from({length:60},(_,offset)=>{const i=300+offset,url=`http://127.0.0.1:18756/dash/${i}.mp4?x-expires=9999999999`,muxed=`http://127.0.0.1:18756/front/${i}.mp4?x-expires=9999999999`,audio=`http://127.0.0.1:18756/audio/${i}.mp4?x-expires=9999999999`;return {awemeId:String(i),description:`Synthetic ${i}`,authorName:'DYSTORE-2 fixture',authorId:'local',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:url,durationMs:12000,variants:[{playUrl:url,format:'dash',audioUrl:audio,codec:'h264',width:240,height:240,bitrate:100000},{playUrl:muxed,format:'mp4',codec:'h264',width:240,height:240,bitrate:132000}]};});
const empty={items:[],anchorAwemeId:null,cursor:null,hasMore:false,savedAtMillis:0};
const client={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({}),playbackAuthorizationVersion:()=>0,resetPrefetchFailures(){},freshPlaybackSnapshot:(v:any)=>v,restoreFeed:async()=>empty,restorePlaybackQueue:async()=>empty,resolvePlayback:async(id:string)=>({ok:true,data:items.find(i=>i.awemeId===id)}),fetchFeedPage:async()=>{traceServiceWork('dystore.fixture.feed',()=>{});return {ok:true,data:{items,nextCursor:null,hasMore:false}};}} as any;
for(const method of ['configure','prepare','list','watched','cancel'] as const){const original=(localMediaStore as any)[method];(localMediaStore as any)[method]=(...args:any[])=>{traceServiceWork('dystore.store.'+method+'.request',()=>{});const op=original(...args);return {...op,result:op.result.then((value:any)=>{traceServiceWork('dystore.store.'+method+'.result',()=>{},method==='list'?value.items.filter((v:any)=>!v.watched).length:0);return value;},(error:any)=>{traceServiceWork('dystore.store.'+method+'.error',()=>{});throw error;})};};}
const stock=createHostDouyinStock(client),offer=stock.offer!;stock.offer=(items,anchor)=>{traceServiceWork('dystore.offer',()=>{},items.length);offer(items,anchor);};
const preload=createHostDouyinPreload(client,stock),owner={};
function App(){
 let entryClaimed=false;
 const [playlist,setPlaylist]=createSignal(items),[index,select]=createSignal(0),[source,setSource]=createSignal<PlaybackSource>(),[inPlayer,setInPlayer]=createSignal(false);
 const cover=()=>{traceServiceWork('dystore.return.cover',()=>{});setInPlayer(false);};
 const open=async(item:DouyinItem,releaseStartupPreview?:()=>void)=>{
  const ready=await preload.readySource(item);const url=ready?.url??await preload.playback(item,{});
  setSource({releaseStartupPreview,url,title:item.description,awemeId:item.awemeId,platform:'douyin',immersive:true,...douyinDecoderProfile(ready?.item??item),previewFrame:ready?.previewFrame});
  setInPlayer(true);
  traceServiceWork(url.startsWith('file:')?'dystore.local.source':'dystore.remote.source',()=>{},Number(item.awemeId));traceServiceWork('dystore.source.elapsed_ms',()=>{},Date.now()-began);console.log(`DYSTORE source id=${item.awemeId} local=${Number(url.startsWith('file:'))} frame=${Number(!!ready?.previewFrame)} elapsed_ms=${Date.now()-began}`);
 };
 createEffect(()=>{const selected=source();if(selected&&inPlayer()){const list=playlist();preload.start(owner,list,selected.awemeId,'active');}});
 const advance=async(n:number)=>{n=Math.max(0,Math.min(playlist().length-1,n));select(n);await open(playlist()[n]);};
 const adjacent=async(direction:'next'|'previous',distance=1)=>{const item=playlist()[index()+(direction==='next'?distance:-distance)];if(!item)return;const ready=await preload.readySource(item);return {key:item.awemeId,source:{url:ready?.url??await preload.playback(item,{}),title:item.description,awemeId:item.awemeId,platform:'douyin' as const,immersive:true,previewFrame:ready?.previewFrame,...douyinDecoderProfile(ready?.item??item)}};};
 return <><Show when={!inPlayer()}><ImmersiveEntry route={{name:'entry'}} client={client} width={metrics.logicalWidth} height={metrics.logicalHeight} active
 restoreStock={()=>stock.restore()} claimStockEntry={()=>{if(entryClaimed)return false;entryClaimed=true;return true;}}
 presentStock={(item,guestEntryMs)=>localMediaStore.present(item.playUrl,{x:0,y:0,width:metrics.logicalWidth,height:metrics.logicalHeight},guestEntryMs)}
 hideStock={token=>{void localMediaStore.hide(token).result;}}
 onPreloadWindow={(owner,list,anchor)=>preload.start(owner,list,anchor??undefined,'entry')} onPreloadStop={owner=>preload.stop(owner)}
 onPlay={request=>{setPlaylist(request.playlist??[request.item]);select(Math.max(0,(request.playlist??[]).findIndex(i=>i.awemeId===request.item.awemeId)));void open(request.item,request.releaseStartupPreview);}}
 onNavigate={()=>{}} onBack={()=>{}} onRequestQrLogin={()=>{}} input={async()=>null} onUnsupported={()=>{}}
 settings={{originalContentEnabled:false,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}}}/></Show>
 <Show when={inPlayer()}><VideoPlayerScreen source={source()!} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={h=>h.setLoopMode('single')}
 onFirstFrame={()=>{const id=playlist()[index()].awemeId;traceServiceWork('dystore.ready.index',()=>{},Number(id));traceServiceWork('dystore.ready.elapsed_ms',()=>{},Date.now()-began);console.log(`DYSTORE ready id=${id} elapsed_ms=${Date.now()-began}`);stock.consume(id);void localMediaStore.list().result.then(s=>console.log(`DYSTORE inventory count=${s.items.filter(i=>!i.watched).length}`));}}
 canSelectTarget={d=>d==='next'?index()+1<playlist().length:true} onSelectTarget={(d,n)=>{if(d==='previous'&&index()===0)cover();else void advance(index()+(d==='next'?n:-n));}}
 onNext={()=>{void advance(index()+1);}} onPrevious={()=>{if(index()===0)cover();else void advance(index()-1);}} onPrepareAdjacent={adjacent} onPromoteAdjacent={async target=>{const n=playlist().findIndex(i=>i.awemeId===target.key);select(n);setSource(target.source);return true;}} /></Show></>;
}
mount(App);
