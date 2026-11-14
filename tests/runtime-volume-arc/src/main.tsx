// Emulator-only fixture for the round crown volume capsule (issue #2). It plays a
// local clip pushed into the app's files and never touches the network. The scene
// switches to speech playback when the file `volarc-speech` exists.
import {mount} from '@pocketjs/framework/solid';
import {createSignal, Show} from 'solid-js';
import {getDisplayMetrics,onAxisDelta,RelativeAxis} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {VideoPlayerScreen} from '../../../src/ui/VideoPlayerScreen.tsx';
import {SpeechPlaybackScreen} from '../../../src/ui/SpeechPlaybackScreen.tsx';
import type {SpeechPlaybackState} from '../../../src/reader/speech-playback.ts';

const metrics=getDisplayMetrics(),width=metrics.logicalWidth,height=metrics.logicalHeight;
const [scene,setScene]=createSignal<'video'|'speech'>('video');
const speech={phase:'ready',playing:true,queueIndex:0,queueSize:3,segmentIndex:4,segmentCount:12,autoAdvance:true,rate:1,
 article:{id:'volarc',title:'在城市里，寻找一段安静的路',channelId:'fixture'}} as unknown as SpeechPlaybackState;
const noop=()=>{};
let player:{onCrown:(delta:number)=>boolean}|undefined;
onAxisDelta(RelativeAxis.Primary,delta=>{if(scene()==='video')player?.onCrown(delta);});
async function watchScene(){for(;;){const speechScene=(await fileChunks.stat('volarc-speech').catch(()=>({file:false}))).file;setScene(speechScene?'speech':'video');await delay(300).result;}}
mount(()=><Show when={scene()==='video'} fallback={
 <SpeechPlaybackScreen width={width} height={height} active state={speech} volumeEnabled volumeGuard={false} onToggle={noop} onPrevious={noop} onNext={noop} onStop={noop} onAutoAdvance={noop} onRate={noop} currentArticleActionText="返回文章" onOpenCurrentArticle={noop}/>}>
 <VideoPlayerScreen width={width} height={height} active offset={0} round={metrics.shape==='round'} ref={value=>player=value}
  source={{url:'volarc.mp4',title:'沿途日记',platform:'rss',digitalCrownVolume:true,volumeGuard:false}}/>
</Show>);
void watchScene();
