import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {delay} from '@podjs/framework/services';
import {localMediaStore} from '@podjs/framework/media-prefix-cache';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {ImmersiveEntry} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {createHostDouyinStock} from '../../../src/douyin/stock-host.ts';
import {createHostDouyinPreload} from '../../../src/douyin/preload-host.ts';
import type {DouyinItem,DouyinVideoVariant} from '../../../src/douyin/types.ts';
const metrics=getDisplayMetrics(),base='http://127.0.0.1:18776';
const mark=(name:string,n=0)=>traceServiceWork('dywaitc.'+name,()=>{},n);
const variant=(path:string,bitrate:number,width=540,dash=false):DouyinVideoVariant=>({playUrl:base+path+'?x-expires=9999999999',width,height:width*16/9,bitrate,codec:'h264',format:dash?'dash':'mp4',...(dash?{audioUrl:base+'/audio.mp4?x-expires=9999999999'}:{})});
const items:DouyinItem[]=['mux15.mp4','dash20.mp4','mux29.mp4'].map((file,i)=>{
 const low=variant('/'+file,[2200000,2800000,3800000][i],540,i===1),high=variant('/oversize.mp4',6000000,720),smaller=variant('/mux15.mp4',2000000,480);
 return {awemeId:'dywaitc-'+(i+1),description:'Synthetic large '+(i+1),authorName:'fixture',authorId:'fixture',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:60000,playUrl:high.playUrl,variants:[high,low,smaller]};
});
const snapshot={items,anchorAwemeId:items[0].awemeId,cursor:'fixture',hasMore:true,savedAtMillis:Date.now(),resolved:{}};
const client={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({}),freshPlaybackSnapshot:(v:any)=>v,restorePlaybackQueue:async()=>snapshot,restoreFeed:async()=>snapshot,fetchFeedPage:()=>{mark('unexpected_feed');return new Promise(()=>{});}} as any;
const stock=createHostDouyinStock(client),preload=createHostDouyinPreload(client,stock);
const [ready,setReady]=createSignal(false),[cover,setCover]=createSignal(false),[source,setSource]=createSignal<PlaybackSource>(),[failed,setFailed]=createSignal(false);
let playlist:DouyinItem[]=[],index=0,claimed=false;
const played=new Set<string>();
async function open(item:DouyinItem,releaseStartupPreview?:()=>void){
 const bundle=await preload.readySource(item);if(!bundle?.url.startsWith('file:'))throw Error('verified local source missing');
 setSource({url:bundle.url,previewFrame:bundle.previewFrame,title:item.description,awemeId:item.awemeId,platform:'douyin',immersive:true,releaseStartupPreview});mark('local_source',index+1);
}
const next=()=>{if(index+1<playlist.length){index++;void open(playlist[index]).catch(()=>setFailed(true));}};
function App(){return <>
 <Show when={!ready()&&!failed()}><Text class="absolute left-[45] top-[100] text-sm text-white">Preparing 3 large clips</Text></Show>
 <Show when={failed()}><Text class="absolute left-[45] top-[100] text-sm text-white">Fixture failed</Text></Show>
 <Show when={ready()&&!cover()&&!source()}><View focusable accessibilityRole="button" accessibilityLabel="OPEN COVER" class="absolute left-[55] top-[90] w-[130] h-[45] bg-[#333333] rounded-[20] items-center justify-center" onPress={()=>{mark('cover_open');setCover(true);}}><Text class="text-xs text-white">OPEN COVER</Text></View></Show>
 <Show when={cover()&&!source()}><ImmersiveEntry client={client} route={{name:'entry'}} width={metrics.logicalWidth} height={metrics.logicalHeight} active
 restoreStock={async()=>{await delay(300).result;return stock.restore();}} claimStockEntry={()=>{if(claimed)return false;claimed=true;return true;}}
 presentStock={(item,ms)=>stock.present!(item.playUrl,{x:0,y:0,width:metrics.logicalWidth,height:metrics.logicalHeight},ms)} hideStock={n=>{void stock.hide?.(n).result;}}
 onPlay={request=>{playlist=request.playlist??[request.item];index=0;void open(request.item,request.releaseStartupPreview).catch(()=>setFailed(true));}} onNavigate={()=>{}} onBack={()=>{}} onRequestQrLogin={()=>{}} onUnsupported={()=>{}} input={async()=>null}
 settings={{originalContentEnabled:false,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}}}/></Show>
 <Show when={source()}>{value=><VideoPlayerScreen source={value()} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={h=>h.setLoopMode('single')}
 onFirstFrame={()=>{const item=playlist[index];if(item&&!played.has(item.awemeId)){played.add(item.awemeId);mark('played',index+1);stock.consume(item.awemeId);}}} onNext={next}/>}</Show>
 <Show when={source()}><View focusable accessibilityRole="button" accessibilityLabel="NEXT STORED" class="absolute left-[65] top-[60] w-[105] h-[28] bg-[#333333] rounded-[14] items-center justify-center" onPress={next}><Text class="text-xs text-white">NEXT STORED</Text></View></Show>
 </>;}
mount(App);
void (async()=>{
 const before=(await localMediaStore.list().result).items.filter(i=>!i.watched);
 if(before.length<3){stock.offer!(items);await stock.resume();}
 const stored=(await localMediaStore.list().result).items.filter(i=>!i.watched);if(stored.length!==3)throw Error('three complete clips required');
 mark('inventory_ready',stored.length);mark('inventory_bytes',stored.reduce((n,v)=>n+v.bytes,0));setReady(true);
})().catch(()=>{mark('fixture_failed');setFailed(true);});
