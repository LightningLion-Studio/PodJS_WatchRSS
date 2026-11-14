import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {createSignal,Show,onCleanup} from 'solid-js';
import {getDisplayMetrics,onLifecycleChange} from '@podjs/framework/watch';
import {http,fileChunks} from '@podjs/framework/services';
import {base64ToBytes,utf8ToString} from '@podjs/framework/bytes';
import {VideoPlayerScreen,type PlaybackSource} from '../../../src/ui/VideoPlayerScreen.tsx';
import {freshVideoSource} from '../../../src/media/reload-source.ts';
const metrics=getDisplayMetrics(),base='http://10.0.2.2:18764';
function App(){
 const [scene,setScene]=createSignal('manual'),[source,setSource]=createSignal<PlaybackSource>(),[inPlayer,start]=createSignal(false);
 let sequence=0;
 onCleanup(onLifecycleChange(value=>console.log('RELOAD_FIXTURE lifecycle='+value)));
 const resolve=async(positionMs=0,current=()=>true)=>{
  const path=`reload/response-${++sequence}.json`;
  try{
   await http.download(`${base}/resolve?scene=${scene()}`,path,65536).result;
   const result=JSON.parse(utf8ToString(base64ToBytes((await fileChunks.read(path,0)).dataBase64)));
   if(!current())return;
   const next=freshVideoSource(source()!,{url:result.url,expiresAtMs:result.expiresAtMs},positionMs);
   console.log(`RELOAD_FIXTURE resolution=${sequence} position=${positionMs} scene=${scene()}`);
   setSource(next);
  }finally{void fileChunks.remove(path).catch(()=>{});}
 };
 const open=(value:string)=>{
  setScene(value);sequence=0;
  setSource({platform:value==='sessions'?'douyin':'bili',immersive:value==='sessions',awemeId:value==='sessions'?'fixture':undefined,title:'Local reload fixture',previewOnly:true});start(true);
  void resolve().catch(error=>{console.log('RELOAD_FIXTURE initial_error');setSource(previous=>({...previous!,preparationError:error}));});
 };
 return <View class={inPlayer()?"absolute inset-0":"absolute inset-0 bg-black"}>
  <Show when={!inPlayer()}><View class="absolute left-[40] right-[40] top-[34]">
   {['manual','resume','slow','sessions'].map(value=><View class="h-[36] rounded-[18] bg-[#333333] items-center justify-center" focusable onPress={()=>open(value)}><Text class="text-sm text-white">{value}</Text></View>)}
  </View></Show>
  <Show when={inPlayer()}><VideoPlayerScreen source={source()!} width={metrics.logicalWidth} height={metrics.logicalHeight} round active offset={0}
   onReload={resolve} onFirstFrame={()=>console.log('RELOAD_FIXTURE first_frame')}
   onProgress={position=>console.log('RELOAD_FIXTURE position='+position)}
   onCheckpoint={(kind,position)=>console.log(`RELOAD_FIXTURE checkpoint=${kind} position=${position}`)}/></Show>
 </View>;
}
mount(App);
