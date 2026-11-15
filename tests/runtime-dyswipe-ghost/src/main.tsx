import {mount} from '@pocketjs/framework/solid';
import {createSignal} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const sources:PlaybackSource[]=Array.from({length:12},(_,i)=>({url:`ghost-${i%3}.mp4`,title:`Offline ${i}`,awemeId:String(i),platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:i%3===0?320:i%3===1?180:240,videoHeight:i%3===0?180:i%3===1?320:240,posterUrl:'file:///nonexistent-offline-cover.png'}));
function App(){
 const [index,select]=createSignal(3);
 return <VideoPlayerScreen source={sources[index()]} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round={false} ref={handle=>handle.setLoopMode('single')}
 canSelectTarget={direction=>direction==='next'?index()<11:index()>0}
 onSelectTarget={(direction,distance)=>select(Math.max(0,Math.min(11,index()+(direction==='next'?distance:-distance))))}
 onNext={()=>{select(Math.min(11,index()+1));}} onPrevious={()=>{select(Math.max(0,index()-1));}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:sources[n]}:undefined;}}
 onPromoteAdjacent={async target=>{select(Number(target.key));return true;}} />;
}
mount(App);
