// Emulator-only fixture for the player detail & playback-control panel. It plays local
// clips pushed into the app's files; covers come from a local HTTP server on the host
// (10.0.2.2). Nothing contacts Douyin or Bilibili: the Douyin scene is a Douyin-shaped
// source with synthetic metadata. The file `pd-douyin` switches to that scene.
// The x-axis gesture below mirrors the app shell (src/ui/screen.tsx): right-to-left
// drags go to the player's sideSwipe, left-to-right drags are Back (logged here).
import {mount} from '@pocketjs/framework/solid';
import {createSignal, onMount, Show} from 'solid-js';
import {createGesture} from '@pocketjs/framework/gesture';
import {Text} from '@pocketjs/framework/components';
import {getDisplayMetrics,onAxisDelta,onSystemBack,RelativeAxis,setNavigationState} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {VideoPlayerScreen,type VideoPlayerHandle,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';

const metrics=getDisplayMetrics(),width=metrics.logicalWidth,height=metrics.logicalHeight;
const host='http://10.0.2.2:18931';
const description='清晨六点，从江边出发，沿着旧城墙一路骑到山脚。这一期记录了路上遇到的早点铺、修车师傅和一群晨练的老人，最后在山顶等到了日出。视频里用到的路线、装备和补给清单都放在评论区置顶，欢迎大家一起来骑。';
const rss:PlaybackSource={url:'pd-landscape.mp4',title:'沿江骑行到山顶看日出：一条适合周末的城市骑行路线',author:'城市骑行日记 · 每周更新的骑行频道',description,
 posterUrl:`${host}/cover-landscape.jpg`,platform:'rss',digitalCrownVolume:true,volumeGuard:false};
const douyin:PlaybackSource={url:'pd-portrait.mp4',awemeId:'fixture-0001',immersive:true,platform:'douyin',digitalCrownVolume:true,volumeGuard:false,
 posterUrl:`${host}/cover-portrait.jpg`,title:'今天的晚霞也太好看了吧！在楼顶等了一个小时终于拍到 #晚霞 #治愈系 #城市风光 #随手拍',
 author:'晚霞收集者',description:'今天的晚霞也太好看了吧！在楼顶等了一个小时终于拍到 #晚霞 #治愈系 #城市风光 #随手拍'};
const [scene,setScene]=createSignal<'rss'|'douyin'>('rss'),[debug,setDebug]=createSignal(false),[lastNote,setLastNote]=createSignal('');
// Shell events are shown in a debug line (file `pd-debug`); release consoles are silent.
const note=(text:string)=>setLastNote(`${new Date().toISOString().slice(14,19)} ${text}`);
let player:VideoPlayerHandle|undefined,side:VideoPlayerHandle['sideSwipe']|undefined;
onAxisDelta(RelativeAxis.Primary,delta=>{if(!player?.onCrown(delta))note(`crown unhandled ${delta}`);});
const has=async(name:string)=>(await fileChunks.stat(name).catch(()=>({file:false}))).file;
async function watchScene(){for(;;){setScene(await has('pd-douyin')?'douyin':'rss');setDebug(await has('pd-debug'));await delay(300).result;}}
function Shell(){
 // Like a pushed route in the app: Back is dispatched to JS instead of finishing the activity.
 onMount(()=>setNavigationState({canGoBack:true}));
 onSystemBack(()=>{note('back reached the shell');return true;});
 createGesture({region:{rect:()=>player?.canSwipeBack()!==false?{x:0,y:0,w:width,h:height}:null},axis:'x',panSlop:8,
 onPanStart:c=>{const s=c.dx<0?player?.sideSwipe:undefined;if(s?.begin()){side=s;s.move(c.dx);note('side swipe open');return;}note(`back swipe dx=${Math.round(c.dx)}`);},
 onPanMove:c=>{side?.move(c.dx);},
 onPanEnd:c=>{if(side){const s=side;side=undefined;s.end(c.vx);return;}note(`back swipe end vx=${Math.round(c.vx)}`);},
 onCancel:()=>{if(side){const s=side;side=undefined;s.end(0);}}});
 return <><Show when={scene()==='rss'} fallback={
 <VideoPlayerScreen width={width} height={height} active offset={0} round={metrics.shape==='round'} ref={value=>player=value} source={douyin}/>}>
 <VideoPlayerScreen width={width} height={height} active offset={0} round={metrics.shape==='round'} ref={value=>player=value} source={rss}/>
</Show>
 <Show when={debug()}><Text class="absolute left-[40] right-[40] top-[30] text-xs text-[#00ff00] text-center">{lastNote()}</Text></Show></>;
}
mount(()=><Shell/>);
void watchScene();
