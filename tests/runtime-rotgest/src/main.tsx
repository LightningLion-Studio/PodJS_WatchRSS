// Isolated emulator fixture. All video sources are local files. No service API.
import {mount} from '@pocketjs/framework/solid';
import {createMemo,createSignal,Show} from 'solid-js';
import {createGesture} from '@pocketjs/framework/gesture';
import {Text,View} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getDisplayMetrics,setNavigationState} from '@podjs/framework/watch';
import {VideoPlayerScreen,type VideoPlayerHandle,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {playerGesture} from '../../../src/ui/player-gestures.ts';
const metrics=getDisplayMetrics(),width=metrics.logicalWidth,height=metrics.logicalHeight;
function Shell(){
 const [home,setHome]=createSignal(false),[index,setIndex]=createSignal(0),[event,setEvent]=createSignal('READY'),[angle,setAngle]=createSignal(0);
 let player:VideoPlayerHandle|undefined,side:VideoPlayerHandle['sideSwipe']|undefined,back=false;
 setNavigationState({canGoBack:true});
 const rotation=()=>player?.gestureRotation()??0;
 onFrame(()=>setAngle(Math.round(rotation())));
 createGesture(playerGesture({region:{rect:()=>!home()&&player?.canSwipeBack()!==false?{x:0,y:0,w:width,h:height}:null},axis:'x',panSlop:8,
  onPanStart:c=>{if(c.dx<0&&player?.sideSwipe.begin()){side=player.sideSwipe;side.move(c.dx);setEvent('PANEL');}else back=c.dx>0;},
  onPanMove:c=>side?.move(c.dx),onPanEnd:c=>{if(side){side.end(c.vx);side=undefined;}else if(back){setEvent('BACK HOME');setHome(true);}back=false;},
  onCancel:()=>{side?.cancel();side=undefined;back=false;},
 },rotation,()=>({x:0,y:0,w:width,h:height})));
 const source=createMemo<PlaybackSource>(()=>({url:`rotgest-${index()%2}.mp4`,title:`LOCAL VIDEO ${index()}`,platform:'douyin',immersive:true}));
 return <View class="absolute inset-0"><Show when={!home()} fallback={<Text class="absolute left-[40] right-[40] top-[90] text-lg text-white text-center">HOME</Text>}>
 <VideoPlayerScreen source={source()} width={width} height={height} active offset={0} round ref={v=>player=v}
 onNext={()=>{setEvent('NEXT');setIndex(i=>i+1);}} onPrevious={()=>{setEvent('PREVIOUS');setIndex(i=>Math.max(0,i-1));}}/>
 </Show><Text class="absolute left-[45] right-[45] top-[65] text-xs text-[#00ff00] text-center">{`${event()} index=${index()} angle=${angle()}`}</Text></View>;
}
mount(()=><Shell/>);
