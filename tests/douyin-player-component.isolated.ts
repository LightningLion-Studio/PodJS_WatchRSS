import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps } from 'solid-js';
import type { InternetStatus } from '../src/onboarding/state.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'d2-player-solid',setup(builder){builder.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>({kind,props});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>element('Image',p)}));
const gestures:any[]=[];
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);return {dispose(){}};}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>text.length*8})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>element('Poster',props)}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>false,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
let debugAllowed=false,diagnosticBindings=0,diagnosticDisposals=0,diagnosticReader:(()=>Promise<unknown>)|undefined;
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{get allowed(){return debugAllowed;},bindSessions(reader:()=>Promise<unknown>){diagnosticBindings++;diagnosticReader=reader;return ()=>{diagnosticDisposals++;};}}}));
let network:(s:InternetStatus)=>void,initial:InternetStatus='available';
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:typeof network)=>{network=fn;fn(initial);return()=>{};}}));
let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let heldPrepare:Promise<any>|undefined;
let pauses=0;const boundsCalls:any[]=[];
let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,state:name,positionMs:321,durationMs:1000,width:100,height:100,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={prepare:(options:any)=>{prepares.push(options);const error=nextError;nextError=undefined;const held=heldPrepare;heldPrepare=undefined;return {result:error?Promise.reject(error):held??Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current=state('playing');},pause:async()=>{pauses++;return current=state('paused');},state:async()=>current,seek:async()=>current,stop:async()=>{},setBounds:async(b:any)=>{boundsCalls.push(b);},setTransform:async()=>{},setVolume:async()=>current};
mock.module('@podjs/framework/services',()=>({video,videoSessions:{},hostOperation:()=>{throw Error('unexpected session operation');},delay:()=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);return{result,cancel(){ticks=ticks.filter(t=>t!==release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());ticks=[];});
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return[];return[value,...nodes(value.props.children)];}
function mount(status:InternetStatus,url='https://video/current',immersive=false,platform:'douyin'|'bili'='douyin'){
 initial=status;prepares=[];plays=0;retries=0;failures=0;ticks=[];current=state('idle');
 const activeEvents:Array<{source:string|undefined;active:boolean}>=[];
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform,url,title:'current',immersive},width:233,height:233,active:true,offset:0,round:true,onRetry:async()=>{retries++;},onPlaybackFailure:()=>{failures++;},onPlaybackActiveChanged:(source,active)=>activeEvents.push({source,active})});});
 return {activeEvents,text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),press:(label:string)=>{const button=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children===label));expect(button).toBeDefined();button!.props.onPress();}};
}
test('D2 initial network gate clears on WiFi without fetching or replacing queue',async()=>{
 const f=mount('unavailable');await flush();expect(f.text()).toContain('未检测到可用互联网');expect(prepares).toHaveLength(0);
 network('available');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(retries).toBe(0);
 network('unavailable');await flush();expect(f.text()).not.toContain('未检测到可用互联网');expect(plays).toBe(1);
});
test('D2 Bluetooth continue prepares once and resumes existing ready player without route retry',async()=>{
 const f=mount('bluetooth');await flush();expect(prepares).toHaveLength(0);f.press('继续');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(retries).toBe(0);
 // A new page requires a fresh confirmation. Mount separately with an already prepared WiFi stream.
 stops.pop()!();const ready=mount('available');await flush();current=state('paused');ticks.shift()!();await flush();network('bluetooth');await flush();ready.press('继续');await flush();
 expect(prepares).toHaveLength(1);expect(plays).toBe(2);expect(retries).toBe(0);
});
test('D2 typed network prepare error on available WiFi shows native overlay and retries same source',async()=>{
 nextError={code:'network_error'};const f=mount('available');await flush();expect(f.text()).toContain('请连接 WiFi 或移动网络');expect(failures).toBe(0);
 f.press('重试');await flush();expect(prepares).toHaveLength(2);expect(prepares[1].url).toBe('https://video/current');expect(retries).toBe(0);expect(plays).toBe(1);
});
test('D2 actual terminal network state masks failure and keeps selected source',async()=>{
 const f=mount('available');await flush();current={...state('error'),errorCode:'network_error'};ticks.shift()!();await flush();expect(f.text()).toContain('未检测到可用互联网');expect(failures).toBe(0);
 f.press('重试');await flush();expect(prepares).toHaveLength(2);expect(retries).toBe(0);
});
test('D2 local video remains playable while offline',async()=>{
 const f=mount('unavailable','file:///cache/video.mp4');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(f.text()).not.toContain('未检测到可用互联网');
});

test('Bili network prepare failure waits for manual retry without invalidating the source',async()=>{
 nextError={code:'network_error'};const f=mount('available','https://video/current',false,'bili');await flush();
 expect(failures).toBe(0);expect(prepares).toHaveLength(1);expect(f.text()).toContain('播放失败');
 f.press('重试');await flush();expect(retries).toBe(1);expect(failures).toBe(0);
});
test('Bili terminal network failure preserves source while actual source failure advances recovery',async()=>{
 const f=mount('available','https://video/current',false,'bili');await flush();
 current={...state('error'),errorCode:'network_error'};ticks.shift()!();await flush();expect(failures).toBe(0);
 f.press('重试');await flush();expect(retries).toBe(1);
 stops.pop()!();nextError={code:'prepare_failed'};mount('available','https://video/current',false,'bili');await flush();expect(failures).toBe(1);
});

test('D2 immersive paused rendered frame stays visible; buffering network pause resumes on recovery',async()=>{
 const f=mount('available','https://video/current',true);await flush();
 expect(f.activeEvents.at(-1)).toEqual({source:'douyin',active:true});
 current={...state('paused'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();network('unavailable');await flush();
 expect(f.text()).not.toContain('未检测到可用互联网');expect(plays).toBe(1);expect(f.activeEvents.at(-1)?.active).toBe(false);
 network('available');await flush();current={...state('buffering'),hasRenderedFirstFrame:true};ticks.shift()!();await flush();
 network('unavailable');await flush();expect(current.state).toBe('paused');expect(plays).toBe(1);
 network('available');await flush();expect(plays).toBe(2);expect(prepares).toHaveLength(1);expect(retries).toBe(0);expect(f.activeEvents.at(-1)?.active).toBe(true);
 stops.pop()!();expect(f.activeEvents.at(-1)).toEqual({source:undefined,active:false});
});

test('DBG2 slot diagnostics bind only active debug immersive ownership and dispose with the screen',async()=>{
 debugAllowed=false;diagnosticBindings=0;diagnosticDisposals=0;mount('available','https://video/current',true);await flush();expect(diagnosticBindings).toBe(0);stops.pop()!();
 debugAllowed=true;mount('available','https://video/current',false);await flush();expect(diagnosticBindings).toBe(0);stops.pop()!();
 mount('available','https://video/current',true);await flush();expect(diagnosticBindings).toBe(1);expect(await diagnosticReader!()).toBeUndefined();stops.pop()!();expect(diagnosticDisposals).toBe(1);debugAllowed=false;
});

test('legacy one-decoder drag never waits on unresolved adjacent playback and hides old frame through READY',async()=>{
 initial='available';prepares=[];gestures.length=0;boundsCalls.length=0;pauses=0;ticks=[];
 const now=Date.now;let time=1000;Date.now=()=>time;
 try {
  const a={platform:'douyin' as const,immersive:true,awemeId:'a',url:'managed-cache/douyin-preload/a.mp4',posterUrl:'https://cover/a',title:'a'},b={...a,awemeId:'b',url:'managed-cache/douyin-preload/b.mp4',posterUrl:'https://cover/b',title:'b'};
  let setSource!:(source:typeof a)=>void,adjacentCalls=0,moveStarted=false,releaseMove!:()=>void;const moveGate=new Promise<void>(resolve=>releaseMove=resolve);
  const root=createRoot(stop=>{stops.push(stop);const [source,set]=createSignal(a);setSource=set;return VideoPlayerScreen({get source(){return source();},width:233,height:233,active:true,offset:0,round:true,onAdjacentPoster:()=>b.posterUrl,onPrepareAdjacent:()=>{adjacentCalls++;return new Promise(()=>{});},onNext:async()=>{moveStarted=true;await moveGate;setSource(b);}});});
  await flush();const surface=gestures[0];surface.onPanStart();surface.onPanMove({dy:-110});await flush();
  expect(pauses).toBe(0);expect(boundsCalls.at(-1).translateY).toBe(-110);expect(adjacentCalls).toBe(0);
  surface.onPanEnd({vy:-2});await flush();
  for(let i=0;i<15&&!moveStarted;i++){time+=60;const pending=ticks.splice(0);pending.forEach(t=>t());await flush();}
  expect(moveStarted).toBe(true);expect(prepares).toHaveLength(1);expect(boundsCalls.at(-1).visible).toBe(false);
  expect(nodes(root).filter(n=>n.kind==='Poster').map(n=>n.props.url)).toEqual([b.posterUrl]);
  releaseMove();await flush();expect(prepares).toHaveLength(2);expect(prepares[1].bounds).toMatchObject({visible:true,translateY:0});
  // Native video calls are ordered: once the new prepare is queued the surface stays transparent until its own first frame, so handoff ends here.
  expect(boundsCalls.at(-1).visible).toBe(true);
  current={...state('playing'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();
  expect(boundsCalls.at(-1).visible).toBe(true);expect(boundsCalls.at(-1).translateY).toBe(0);
 } finally {Date.now=now;}
});

test('legacy douyin poster yields to the first decoded frame before prepare settles',async()=>{
 const source={platform:'douyin' as const,immersive:true,awemeId:'c',url:'https://video/c',posterUrl:'https://cover/c',title:'c'};
 let settle!:(value:any)=>void;heldPrepare=new Promise(resolve=>settle=resolve);current=state('buffering');
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source,width:233,height:233,active:true,offset:0,round:true});});
 await flush();const posters=()=>nodes(root).filter(n=>n.kind==='Poster').length;
 expect(posters()).toBe(1);ticks.splice(0).forEach(t=>t());await flush();expect(posters()).toBe(1);
 current={...state('buffering'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();
 expect(posters()).toBe(0);settle(current=state('ready'));await flush();expect(posters()).toBe(0);
});

for(const direction of ['up','down'] as const)test(`legacy ${direction} 403 pauses the selected video, removes the adjacent poster and offers explicit retry`,async()=>{
 initial='available';prepares=[];gestures.length=0;boundsCalls.length=0;pauses=0;ticks=[];
 const now=Date.now;let time=1000;Date.now=()=>time;
 try{
  let attempts=0;const move=async()=>{attempts++;throw Error('HTTP 403');};
  const source={platform:'douyin' as const,immersive:true,awemeId:'current',url:'https://video/current',posterUrl:'https://cover/current',title:'current'};
  const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source,width:233,height:233,active:true,offset:0,round:true,onAdjacentPoster:()=> 'https://cover/adjacent',onNext:move,onPrevious:move});});
  await flush();const surface=gestures[0];surface.onPanStart();surface.onPanMove({dy:direction==='up'?-110:110});await flush();expect(pauses).toBe(0);
  surface.onPanEnd({vy:direction==='up'?-2:2});await flush();
  for(let i=0;i<15&&attempts===0;i++){time+=60;ticks.splice(0).forEach(t=>t());await flush();}
  expect(attempts).toBe(1);expect(pauses).toBe(1);expect(current.state).toBe('paused');
  expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join(' ')).toContain('播放失败');
  expect(boundsCalls.at(-1)).toMatchObject({translateY:0,visible:true});
  const retry=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children==='重试'));
  expect(retry).toBeDefined();retry!.props.onPress();await flush();expect(attempts).toBe(2);expect(current.state).toBe('paused');expect(prepares).toHaveLength(1);
 }finally{Date.now=now;}
});

test('ready without a decoded frame keeps the cover until the subsequent state poll',async()=>{
 initial='available';heldPrepare=Promise.resolve({...state('ready'),hasRenderedFirstFrame:false});
 const originalPlay=video.play;video.play=async()=>({...state('playing'),hasRenderedFirstFrame:false});current={...state('buffering'),hasRenderedFirstFrame:false};
 try{
  const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://video/late-frame',title:'late frame',posterUrl:'https://cover/late-frame'},width:233,height:233,active:true,offset:0,round:true});});
  await flush();expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(1);
  current={...state('playing'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
 }finally{video.play=originalPlay;}
});
