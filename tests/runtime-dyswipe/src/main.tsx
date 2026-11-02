import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {video} from '@podjs/framework/services';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const sources:PlaybackSource[]=Array.from({length:400},(_,i)=>({url:`swipe-${i%8}.mp4`,title:`Fixture ${i}`,awemeId:String(i),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:240,videoHeight:240}));
function App(){
 const [started,start]=createSignal(false),[index,select]=createSignal(100);
 const open=async()=>{await video.captureBackdrop({opaque:true});start(true);traceServiceWork('dyswipe.fixture.started',()=>{},100);};
 return <><Show when={!started()}><View class="absolute inset-0 bg-[#123456] items-center justify-center" focusable onPress={()=>void open()}><Text class="text-white text-lg">LOCAL SWIPE</Text></View></Show>
 <Show when={started()}><VideoPlayerScreen source={sources[index()]} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={handle=>handle.setLoopMode('single')}
 onNext={()=>{const n=Math.min(sources.length-1,index()+1);select(n);traceServiceWork('dyswipe.fixture.selected',()=>{},n);}} onPrevious={()=>{const n=Math.max(0,index()-1);select(n);traceServiceWork('dyswipe.fixture.selected',()=>{},n);}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:sources[n]}:undefined;}}
 onPromoteAdjacent={async target=>{select(Number(target.key));traceServiceWork('dyswipe.fixture.selected',()=>{},Number(target.key));return true;}} />
 </Show></>;
}
mount(App);
