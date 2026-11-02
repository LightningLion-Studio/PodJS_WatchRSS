import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {hostOperation,delay} from '@podjs/framework/services';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {DouyinVideoSessionPool} from '../../../src/ui/douyin/video-sessions.ts';
const metrics=getDisplayMetrics(),pool=new DouyinVideoSessionPool();
const sources:PlaybackSource[]=Array.from({length:12},(_,i)=>({url:`http://127.0.0.1:18758/front/${i}.mp4`,title:`Local ${i}`,awemeId:String(i),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:240,videoHeight:240}));
function App(){
 const [started,start]=createSignal(false),[index,select]=createSignal(4),[stats,setStats]=createSignal('');
 const open=async()=>{
  for(let i=0;i<sources.length;i++){const r=await hostOperation<{uri:string}>('video.cache.register',{key:`dyframe-ui-${i}`,url:sources[i].url}).result;sources[i]={...sources[i],url:r.uri};}
  start(true);
  for(let n=0;n<180;n++){
   await delay(1000).result;const d=await pool.diagnostics();const c=d?.capabilities;
   if(c){const line={index:index(),frames:c.keyframeEntries,bytes:c.keyframeBytes,live:c.decoderInUse,limit:c.decoderLimit,advertised:c.decoderAdvertisedInstances};setStats(`#${line.index} frame ${line.frames} live ${line.live}`);(globalThis as any).pod?.emit(JSON.stringify({t:'diagnostic.serviceWork',label:'dyframe.frames',elapsedMs:0,exclusiveMs:0,units:line.frames}));}
  }
 };
 return <><Show when={!started()}><View class="absolute bg-[#123456] items-center justify-center" style={{insetL:30,insetT:90,width:170,height:50}} focusable onPress={()=>void open()}><Text class="text-white text-lg">SLOW KEYFRAMES</Text></View></Show>
 <Show when={started()}><VideoPlayerScreen initialPool={pool} source={sources[index()]} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={handle=>handle.setLoopMode('single')}
 canSelectTarget={direction=>direction==='next'?index()<11:index()>0}
 onSelectTarget={(direction,distance)=>select(Math.max(0,Math.min(11,index()+(direction==='next'?distance:-distance))))}
 onNext={()=>{select(Math.min(11,index()+1));}} onPrevious={()=>{select(Math.max(0,index()-1));}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:sources[n]}:undefined;}}
 onPromoteAdjacent={async target=>{select(Number(target.key));return true;}} />
 <View class="absolute" style={{insetL:35,insetT:200}}><Text class="text-white text-xs">{stats()}</Text></View>
 </Show></>;
}
mount(App);
