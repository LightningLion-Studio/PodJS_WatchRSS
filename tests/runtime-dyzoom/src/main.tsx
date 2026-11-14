// Standalone fixture: production player, synthetic queue, local H.264 only.
import {mount} from '@pocketjs/framework/solid';
import {createSignal,createMemo} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {startAppLogger} from '../../../src/logs/logger-host.ts';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const sources:PlaybackSource[]=Array.from({length:400},(_,i)=>({url:`zoom-${i%2}.mp4`,title:`Local ${i}`,awemeId:String(i),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:i%2?180:320,videoHeight:i%2?320:180}));
function App(){
 const [index,select]=createSignal(100),source=createMemo(()=>sources[index()]);
 return <VideoPlayerScreen source={source()} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={handle=>handle.setLoopMode('single')}
 canSelectTarget={direction=>direction==='next'?index()<sources.length-1:index()>0}
 onSelectTarget={(direction,distance)=>select(i=>Math.max(0,Math.min(sources.length-1,i+(direction==='next'?distance:-distance))))}
 onNext={()=>{select(i=>Math.min(sources.length-1,i+1));}} onPrevious={()=>{select(i=>Math.max(0,i-1));}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:sources[n]}:undefined;}}
 onAdjacentKey={(direction,distance=1)=>String(index()+(direction==='next'?distance:-distance))}
 onPromoteAdjacent={async target=>{select(Number(target.key));return true;}}/>;
}
startAppLogger();
mount(App);
