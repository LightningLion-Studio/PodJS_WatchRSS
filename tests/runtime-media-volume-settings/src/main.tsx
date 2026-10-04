import {mount} from '@pocketjs/framework/solid';
import {createSignal,createMemo,Show} from 'solid-js';
import {View} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {mediaVolumeSettingsRows} from '../../../src/ui/media-volume-settings.tsx';
import {adjacentPlaybackStartVolumeLimit,formatPlaybackStartVolumeLimit} from '../../../src/media/start-volume.ts';
import {SettingsStore,DEFAULT_SETTINGS} from '../../../src/settings/store.ts';
const sleep=(ms:number)=>delay(ms).result;
const [current,setCurrent]=createSignal<{stage:string;row:number}|null>(null);
const store=new SettingsStore();
const [settings,setSettings]=createSignal(store.load());
const metrics=getDisplayMetrics();
async function run(){
 await sleep(1500);
 kv.set('volume-settings-policy',[null,...Array.from({length:21},(_,i)=>i*5),-1,3,101].map(value=>({value,previous:adjacentPlaybackStartVolumeLimit(value,-1),next:adjacentPlaybackStartVolumeLimit(value,1),formatted:formatPlaybackStartVolumeLimit(value)})));
 for(const [stage,row,patch] of [
  ['control-on',0,{mediaVolumeControl:true,mediaVolumeGuard:true}],
  ['control-off',0,{mediaVolumeControl:false}],
  ['guard-unavailable',1,{mediaVolumeControl:false}],
  ['guard-on',1,{mediaVolumeControl:true,mediaVolumeGuard:true}],
  ['guard-off',1,{mediaVolumeGuard:false}],
  ['unlimited',2,{playbackStartVolumeLimit:null}],
  ['mute',2,{playbackStartVolumeLimit:0}],
  ['ten',2,{playbackStartVolumeLimit:10}],
  ['hundred',2,{playbackStartVolumeLimit:100}],
 ] as const){
  setSettings(store.update(patch));setCurrent({stage,row});await sleep(1800);
  kv.set('volume-settings-result',{state:'running',stage,settings:store.load(),logicalWidth:metrics.logicalWidth});
  const end=Date.now()+60000;while(!(await fileChunks.stat('volume-advance-'+stage)).file){if(Date.now()>end)throw Error('Snapshot timeout '+stage);await sleep(100);}
 }
 setCurrent(null);kv.set('volume-settings-result',{state:'passed',stage:'done',settings:store.load()});
}
function App(){return <Show when={current()} keyed>{value=>{
 const rows=createMemo(()=>mediaVolumeSettingsRows({width:metrics.logicalWidth,height:metrics.logicalHeight,get state(){return settings();},onChange:p=>setSettings(store.update(p)),onNavigate:()=>{},onUnsupported:message=>kv.set('volume-message',message)},metrics.logicalWidth-36));
 return <View class="absolute left-[18] right-[18] top-[55]" style={{height:rows()[value.row].height}}>{rows()[value.row].render()}</View>;
}}</Show>;}
mount(App);void run().catch(error=>kv.set('volume-settings-result',{state:'failed',error:String(error)}));
