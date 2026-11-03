import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {localMediaStore,mediaPrefixCache} from '@podjs/framework/media-prefix-cache';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {hostOperation,videoSessions} from '@podjs/framework/services';
import {ImmersiveEntry} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {DouyinVideoSessionPool} from '../../../src/ui/douyin/video-sessions.ts';
import {createHostDouyinStock} from '../../../src/douyin/stock-host.ts';
import {storedDouyinMetadata,douyinPrestoreConfig} from '../../../src/douyin/prestore-policy.ts';
import type {DouyinItem} from '../../../src/douyin/types.ts';
const metrics=getDisplayMetrics(),never=new Promise<any>(()=>{});
const remote={awemeId:'dywait-synthetic',playUrl:'http://127.0.0.1:18756/front/1.mp4?x-expires=9999999999',description:'DYWAIT synthetic',authorName:'fixture',durationMs:12000,variants:[]} as unknown as DouyinItem;
const cases=['secure-held-cache','stock-held-cache','empty-stock-cache','stored-secure-held','hidden-failure','foreground-retry'] as const;
const mark=(name:string,fields:Record<string,unknown>={})=>{traceServiceWork('dywait.fixture.'+name,()=>{},typeof fields.count==='number'?fields.count:cases.indexOf(fields.case as typeof cases[number])+1);};
const [view,setView]=createSignal<()=>any>();
mount(()=> <Show when={view()} fallback={<Text class="text-base text-white">DYWAIT setup</Text>}>{render=>render()()}</Show>);
async function main(){
 await localMediaStore.configure(douyinPrestoreConfig(undefined)).result;
 const registered=await mediaPrefixCache.register('dywait-synthetic',remote.playUrl,{},true,[],Date.now()+3600000).result;
 const prepared=await localMediaStore.prepare('dywait-synthetic',registered.uri,storedDouyinMetadata(remote),true).result;
 if(!prepared.ready||!prepared.item)throw Error('synthetic store not ready');
 const local={...remote,playUrl:prepared.item.uri};mark('inventory',{count:1,bytes:prepared.item.bytes});
 const [step,setStep]=createSignal(0),[done,setDone]=createSignal(false),[playing,setPlaying]=createSignal(false),[source,setSource]=createSignal<PlaybackSource>();
 let nativeHidden=new Set<string>();
 const pool=new DouyinVideoSessionPool({...videoSessions,capabilities:()=>hostOperation<any>('video.session.capabilities',{}).result,prepare:options=>{if(options.prewarm)nativeHidden.add(options.sessionId);return videoSessions.prepare(options);},setTransform:async(id,options)=>{if(nativeHidden.has(id)){mark('injected-hidden-transport');throw {code:'transport'};}return videoSessions.setTransform(id,options);}});
 const next=()=>{setPlaying(false);setDone(false);setStep((step()+1)%cases.length);mark('case',{case:cases[step()]});};
 const base={authState:()=>step()===1||step()===2?'logged-in':'unknown',subscribeAuth:()=>()=>{},isLoggedIn:()=>never,listWatchedIds:()=>never,freshPlaybackSnapshot:(v:any)=>v,restorePlaybackQueue:async()=>({items:[remote],anchorAwemeId:remote.awemeId,cursor:'fixture',hasMore:true,resolved:{},savedAtMillis:Date.now()}),restoreFeed:()=>never,fetchFeedPage:()=>{mark('background-feed');return never;}} as any;
 const stock=createHostDouyinStock(base);
 mark('case',{case:cases[0]});
 function App(){return <>
 <Show when={!done()&&!playing()}><Show keyed when={step()+1}>{(_case:number)=> <ImmersiveEntry client={base} route={{name:'entry'}} width={metrics.logicalWidth} height={metrics.logicalHeight} active restoreStock={()=>step()===1?never:step()===3?stock.restore():Promise.resolve([])} onPlay={request=>{mark('entered',{case:cases[step()],local:request.item.playUrl.startsWith('file:')});if(step()===3){setSource({platform:'douyin',immersive:true,url:request.item.playUrl,title:'stock',awemeId:request.item.awemeId});setPlaying(true);}else setDone(true);}} onNavigate={()=>{}} onBack={()=>{}} onRequestQrLogin={()=>{}} input={async()=>null} onUnsupported={()=>{}} settings={{originalContentEnabled:false,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}}}/>}</Show></Show>
 <Show when={playing()}><VideoPlayerScreen source={source()!} initialPool={step()===4?pool:undefined} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round onFirstFrame={()=>mark('frame',{case:cases[step()]})} onPrepareAdjacent={step()===4?async()=>({key:'hidden',source:{platform:'douyin',immersive:true,url:local.playUrl,title:'hidden',awemeId:'hidden'}}):undefined} onRetry={async()=>{mark('retry',{case:cases[step()]});setSource({platform:'douyin',immersive:true,url:local.playUrl,title:'recovered',awemeId:local.awemeId});}}/></Show>
 <Show when={done()}><Text class="absolute left-[45] top-[95] text-base text-white">DYWAIT {cases[step()]} entered</Text></Show>
 <View focusable accessibilityRole="button" accessibilityLabel="NEXT CASE" class="absolute left-[80] top-[55] w-[110] h-[28] bg-[#333333] rounded-[18] items-center justify-center" onPress={()=>{if(step()===3){next();setSource({platform:'douyin',immersive:true,url:local.playUrl,title:'active',awemeId:'active'});setPlaying(true);}else if(step()===4){next();setSource({platform:'douyin',immersive:true,url:'file:///unverified-dywait.mp4',title:'rejected',awemeId:'rejected'});setPlaying(true);}else next();}}><Text class="text-xs text-white">NEXT CASE</Text></View>
 </>;}
 setView(()=>App);
}
void main().catch(()=>mark('fixture-failed'));
