import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,createMemo,Show} from 'solid-js';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {video} from '@podjs/framework/services';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const sources:PlaybackSource[]=Array.from({length:400},(_,i)=>({url:`swipe-${i%8}.mp4`,title:`Fixture ${i}`,awemeId:String(i),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:240,videoHeight:240}));
function App(){
 const [started,start]=createSignal(false),[index,select]=createSignal(100),[layout,setLayout]=createSignal<'local'|'front'|'tail'>('local');
 const selectedSource=createMemo(()=>layout()==='local'?sources[index()]:{...sources[index()],url:`http://127.0.0.1:18756/${layout()}/${index()}.mp4`});
 const open=async(mode:'local'|'front'|'tail'='local')=>{setLayout(mode);await openPlayer();};
 const openPlayer=async()=>{await video.captureBackdrop({opaque:true});start(true);traceServiceWork('dyswipe.fixture.started',()=>{},100);};
 return <><Show when={!started()}>{(['local','front','tail'] as const).map((mode,i)=><View class="absolute left-[15] right-[15] bg-[#123456] items-center justify-center" style={{insetT:40+i*50,height:42}} focusable onPress={()=>void open(mode)}><Text class="text-white text-lg">{mode==='local'?'LOCAL SWIPE':`SLOW ${mode.toUpperCase()}`}</Text></View>)}</Show>
 <Show when={started()}><VideoPlayerScreen source={selectedSource()} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={handle=>handle.setLoopMode('single')}
 onSelectTarget={(direction,distance)=>{const n=Math.max(0,Math.min(sources.length-1,index()+(direction==='next'?distance:-distance)));select(n);traceServiceWork('dyswipe.fixture.selected',()=>{},n);}}
 onNext={()=>{const n=Math.min(sources.length-1,index()+1);select(n);traceServiceWork('dyswipe.fixture.selected',()=>{},n);}} onPrevious={()=>{const n=Math.max(0,index()-1);select(n);traceServiceWork('dyswipe.fixture.selected',()=>{},n);}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:layout()==='local'?sources[n]:{...sources[n],url:`http://127.0.0.1:18756/${layout()}/${n}.mp4`}}:undefined;}}
 onPromoteAdjacent={async target=>{select(Number(target.key));traceServiceWork('dyswipe.fixture.selected',()=>{},Number(target.key));return true;}} />
 </Show></>;
}
mount(App);
