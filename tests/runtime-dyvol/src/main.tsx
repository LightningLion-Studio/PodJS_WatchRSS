import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show,onCleanup} from 'solid-js';
import {getDisplayMetrics,onAxisDelta,RelativeAxis} from '@podjs/framework/watch';
import {video} from '@podjs/framework/services';
import {VideoPlayerScreen,type PlaybackSource,type VideoPlayerHandle} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const sources:PlaybackSource[]=Array.from({length:3},(_,index)=>({url:'dyvol-local.mp4',title:`Local fixture ${index}`,awemeId:String(index+1),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:320,videoHeight:480,digitalCrownVolume:true,volumeGuard:false,startVolumeLimit:0}));
function App(){
 const [started,start]=createSignal(false),[index,select]=createSignal(0);let handle:VideoPlayerHandle|undefined;
 onCleanup(onAxisDelta(RelativeAxis.Primary,delta=>{handle?.onCrown(delta);}));
 const open=async()=>{console.log("DYVOL entry_press");try{await video.captureBackdrop({opaque:true});start(true);}catch(error){console.error("DYVOL entry_failed",String(error));}};
 return <>
  <View class="absolute inset-0 bg-[#ff00ff] items-center justify-center" style={{opacity:started()?0:1}} focusable onPress={()=>void open()}><Text class="text-white text-lg">LOCAL VIDEO</Text></View>
  <Show when={started()}><VideoPlayerScreen source={sources[index()]} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={value=>{handle=value;value.setLoopMode('single');}}
   onNext={()=>{select(v=>Math.min(2,v+1));}} onPrevious={()=>{select(v=>Math.max(0,v-1));}}
   onPrepareAdjacent={async(direction,distance=1)=>{const target=index()+(direction==='next'?distance:-distance);return target<0||target>=sources.length?undefined:{key:String(target),source:sources[target]};}}
   onPromoteAdjacent={async prepared=>{select(Number(prepared.key));return true;}} />
  </Show>
 </>;
}
mount(App);
