import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {delay,video} from '@podjs/framework/services';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {ImmersiveEntry} from '../../../src/ui/douyin/ImmersiveEntry.tsx';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
const metrics=getDisplayMetrics();
const items=Array.from({length:8},(_,i)=>({awemeId:String(i),description:'Local fixture',playUrl:'dyentry-local.mp4',authorId:'',authorName:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:12000,variants:[]}));
const snapshot={items,anchorAwemeId:'0',cursor:'local',hasMore:true};
// No network client, storage, account, or credentials. Only the feed port is substituted.
const client:any={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},restoreFeed:async()=>snapshot,restorePlaybackQueue:async()=>snapshot,freshPlaybackSnapshot:(v:any)=>v,fetchFeedPage:async()=>{await delay(1600).result;return {ok:true,data:{items,nextCursor:'local',hasMore:true}};}};
const sources:PlaybackSource[]=items.map((v,i)=>({url:v.playUrl,title:'Fixture '+i,awemeId:v.awemeId,platform:'douyin',immersive:true,videoMime:'video/avc',videoWidth:320,videoHeight:480,digitalCrownVolume:true}));
function App(){
 const [started,start]=createSignal(false),[index,select]=createSignal(3);
 const open=async()=>{await video.captureBackdrop({opaque:true});start(true);};
 return <><Show when={!started()}><ImmersiveEntry client={client} route={{name:'entry'}} width={metrics.logicalWidth} height={metrics.logicalHeight} active onNavigate={()=>{}} onBack={()=>{}} onPlay={()=>void open()} {...{} as any}/></Show>
 <Show when={started()}><VideoPlayerScreen source={sources[index()]} width={metrics.logicalWidth} height={metrics.logicalHeight} active offset={0} round ref={v=>v.setLoopMode('single')}
 onNext={()=>{select(v=>Math.min(7,v+1));}} onPrevious={()=>{select(v=>Math.max(0,v-1));}}
 onPrepareAdjacent={async(direction,distance=1)=>{const n=index()+(direction==='next'?distance:-distance);return sources[n]?{key:String(n),source:sources[n]}:undefined;}}
 onPromoteAdjacent={async v=>{select(Number(v.key));traceServiceWork('dyentry.selected',()=>{},Number(v.key));return true;}}/></Show></>;
}
mount(App);
