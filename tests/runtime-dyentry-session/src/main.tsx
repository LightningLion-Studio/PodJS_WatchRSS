import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,createEffect,Show,onCleanup} from 'solid-js';
import {fileChunks} from '@podjs/framework/services';
import {bytesToBase64,stringToUtf8} from '@podjs/framework/bytes';
import {getDisplayMetrics,onLifecycleChange,onSystemBack,setNavigationState,kv} from '@podjs/framework/watch';
import {localMediaStore,mediaPrefixCache} from '@podjs/framework/media-prefix-cache';
import {ImmersiveEntry} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {DouyinClient} from '../../../src/douyin/client.ts';
import {storedDouyinMetadata,douyinPrestoreConfig} from '../../../src/douyin/prestore-policy.ts';
import {captureActivityNavigation} from '../../../src/navigation/activity-navigation.ts';
import {startupActivityNavigation} from '../../../src/navigation/startup-navigation.ts';
import type {DouyinItem} from '../../../src/douyin/types.ts';
const metrics=getDisplayMetrics();
const remote={awemeId:'dyentry-offline',playUrl:'http://127.0.0.1:18788/fixture.mp4',description:'DYENTRY synthetic video',authorName:'Offline fixture',durationMs:90000,variants:[]} as unknown as DouyinItem;
const events:Record<string,unknown>[]= [];let writing=Promise.resolve();
const mark=(kind:string,fields:Record<string,unknown>={})=>{
 events.push({at:Date.now(),kind,...fields});if(events.length>300)events.shift();
 const data=bytesToBase64(stringToUtf8(JSON.stringify(events)));
 writing=writing.then(()=>fileChunks.write('dyentry/evidence.json',data)).then(()=>{});
};
const [view,setView]=createSignal<()=>any>();
mount(()=> <Show when={view()} fallback={<Text class="text-base text-white">DYENTRY setup</Text>}>{render=>render()()}</Show>);
async function main(){
 await localMediaStore.configure(douyinPrestoreConfig({bytesPerSecond:1024*1024,minBattery:0,minFreeBytes:0})).result;
 const registered=await mediaPrefixCache.register(remote.awemeId,remote.playUrl,{},true,[],Date.now()+3600000).result;
 const prepared=await localMediaStore.prepare(remote.awemeId,registered.uri,storedDouyinMetadata(remote),true).result;
 mark('prepared',{ready:prepared.ready});
 if(!prepared.ready||!prepared.item)throw Error('mock media unavailable');
 const item={...remote,playUrl:prepared.item.uri};mark('inventory',{local:item.playUrl.startsWith('file:')});
 // Synthetic authentication lives only in this adapter. No login or platform HTTP.
 const client=new DouyinClient({secureStorage:{get:async()=> 'sessionid=offline-fixture',set:async()=>{},remove:async()=>{}},signer:{sign:()=>''},transport:{request:async()=>{mark('forbidden_request');throw Error('platform requests forbidden');}}});
 function App(){
  const previous=kv.get<{saved:Record<string,unknown>}>('dyentry.task');
  const restored=startupActivityNavigation({saved:previous?.saved??{},retained:{}});
  const [page,setPage]=createSignal<'home'|'entry'|'video'>(restored?.at(-1)?.page==='douyin'?'entry':'home');
  const [source,setSource]=createSignal<PlaybackSource>();
  createEffect(()=>setNavigationState({canGoBack:page()!=='home'}));
  let position=0;
  const save=()=>kv.set('dyentry.task',captureActivityNavigation({saved:{},retained:{}},[
   {page:'home'},...(page()==='home'?[]:[{page:'douyin' as const,douyinRoute:{name:'entry' as const}}]),
   ...(page()==='video'?[{page:'video' as const,videoTarget:{kind:'douyin' as const,awemeId:item.awemeId,immersive:true}}]:[]),
  ]));
  const enter=()=>{setPage('entry');save();mark('cover');};
  onCleanup(onSystemBack(()=>{if(page()==='video'){enter();return true;}if(page()==='entry'){setPage('home');save();mark('home');return true;}return false;}));
  onCleanup(onLifecycleChange(state=>{save();mark('lifecycle',{state,page:page(),position});}));
  mark('startup',{page:page(),restored:!!restored});
  return <View class="absolute inset-0 bg-black">
   <Show when={page()==='home'}><View class="absolute left-[50] top-[85] w-[133] h-[50] rounded-[25] bg-[#333333] items-center justify-center" onPress={enter} focusable accessibilityRole="button" accessibilityLabel="Open Douyin mock"><Text class="text-base text-white">打开抖音 mock</Text></View></Show>
   <Show when={page()==='entry'}><ImmersiveEntry client={client} route={{name:'entry'}} width={metrics.logicalWidth} height={metrics.logicalHeight} active restoreStock={async()=>[item]} onPlay={request=>{setSource({platform:'douyin',immersive:true,url:request.item.playUrl,title:remote.description,awemeId:item.awemeId});setPage('video');save();mark('play',{awemeId:item.awemeId});}} onNavigate={()=>{}} onBack={()=>setPage('home')} settings={{originalContentEnabled:true,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}}} input={async()=>null} onUnsupported={()=>{}}/></Show>
   <Show when={page()==='video'}><VideoPlayerScreen source={source()!} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round
    onReload={async(resume,current)=>{if(current())setSource({...source()!,resumePositionMs:resume});}}
    onFirstFrame={()=>mark('first_frame',{position})} onProgress={value=>{position=value;mark('progress',{position});}}
    onCheckpoint={(kind,value)=>{position=value;mark('checkpoint',{checkpoint:kind,position});}}/></Show>
  </View>;
 }
 setView(()=>App);
}
void main().catch(error=>{mark('fixture_failed',{message:String(error)});setView(()=>(()=><Text class="absolute left-[30] top-[90] text-sm text-white">Fixture failed: {String(error)}</Text>));});
