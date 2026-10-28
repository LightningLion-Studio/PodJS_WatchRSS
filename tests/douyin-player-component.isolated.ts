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
let sessionsCapable=false,decoderLimit=1,lifecycleState='active';const lifecycleListeners=new Set<(value:string)=>void>();
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}},hasCapability:()=>sessionsCapable,lifecycle:()=>lifecycleState,onLifecycleChange:(listener:(value:string)=>void)=>{lifecycleListeners.add(listener);return()=>lifecycleListeners.delete(listener);},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
let debugAllowed=false,diagnosticBindings=0,diagnosticDisposals=0,diagnosticReader:(()=>Promise<unknown>)|undefined;
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{get allowed(){return debugAllowed;},bindSessions(reader:()=>Promise<unknown>){diagnosticBindings++;diagnosticReader=reader;return ()=>{diagnosticDisposals++;};}}}));
let network:(s:InternetStatus)=>void,initial:InternetStatus='available';
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:typeof network)=>{network=fn;fn(initial);return()=>{};}}));
let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let heldPrepare:Promise<any>|undefined;
let pauses=0,legacyStops=0,sessionReleases=0;const boundsCalls:any[]=[];
let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,state:name,positionMs:321,durationMs:1000,width:100,height:100,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={prepare:(options:any)=>{prepares.push(options);const error=nextError;nextError=undefined;const held=heldPrepare;heldPrepare=undefined;return {result:error?Promise.reject(error):held??Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current=state('playing');},pause:async()=>{pauses++;return current=state('paused');},state:async()=>current,seek:async()=>current,stop:async()=>{legacyStops++;current=state('stopped');},setBounds:async(b:any)=>{boundsCalls.push(b);},setTransform:async()=>{},setVolume:async()=>current,setLoop:async()=>current};
mock.module('@podjs/framework/services',()=>({video,videoSessions:{prepare:(options:any)=>({result:Promise.resolve({...state('ready'),sessionId:options.sessionId}),cancel(){}}),play:async()=>state('playing'),state:async()=>current,setTransform:async()=>state('playing'),setBounds:async()=>state('playing'),setLoop:async()=>state('ready'),release:async()=>{sessionReleases++;return {released:true};}},hostOperation:(method:string)=>{if(method!=='video.session.capabilities')throw Error('unexpected session operation');return {result:Promise.resolve({decoderLimit,surfacePromotion:true,verticalTransition:true}),cancel(){}};},delay:()=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);return{result,cancel(){ticks=ticks.filter(t=>t!==release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());ticks=[];sessionsCapable=false;decoderLimit=1;lifecycleState='active';});
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return[];return[value,...nodes(value.props.children)];}
function mount(status:InternetStatus,url='https://video/current',immersive=false,platform:'douyin'|'bili'='douyin',recoveryDeadlineMs?:number){
 initial=status;prepares=[];plays=0;retries=0;failures=0;ticks=[];current=state('idle');
 const activeEvents:Array<{source:string|undefined;active:boolean}>=[];
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform,url,title:'current',immersive,recoveryDeadlineMs},width:233,height:233,active:true,offset:0,round:true,onRetry:async()=>{retries++;},onPlaybackFailure:()=>{failures++;},onPlaybackActiveChanged:(source,active)=>activeEvents.push({source,active})});});
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

// Run the real component with the production capability advertised but the
// watch's one-decoder response, rather than bypassing the session probe.
function mountRetained(platform:'douyin'|'bili'|'rss'='douyin',backgroundPlayback=false,recoveryDeadlineMs?:number){
 const source={platform,immersive:platform==='douyin',url:'https://video/retained',title:'retained',backgroundPlayback,recoveryDeadlineMs};
 initial='available';prepares=[];plays=0;legacyStops=0;sessionReleases=0;gestures.length=0;
 let setActive!:(active:boolean)=>void,dispose!:()=>void;
 const root=createRoot(stop=>{dispose=stop;stops.push(stop);const [active,set]=createSignal(true);setActive=set;
  return VideoPlayerScreen({source,width:233,height:233,get active(){return active();},offset:0,round:true});
 });
 return {setActive,dispose,root,source};
}
test('one-decoder fallback stops the legacy player when its screen is disposed',async()=>{
 sessionsCapable=true;const f=mountRetained();await flush();expect(plays).toBe(1);
 f.dispose();await flush();expect(legacyStops).toBe(1);
});
test('leaving Douyin before prepare completes stops immediately and ignores the late result',async()=>{
 let resolve!:(value:any)=>void;heldPrepare=new Promise(r=>resolve=r);
 const f=mountRetained();await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(0);
 f.setActive(false);await flush();expect(legacyStops).toBe(1);
 resolve(state('ready'));await flush();expect(plays).toBe(0);
 f.setActive(true);await flush();expect(prepares).toHaveLength(2);expect(plays).toBe(1);
});
test('leaving a ready Douyin player releases playback rather than retaining a paused session',async()=>{
 const f=mountRetained('douyin',true);await flush();expect(plays).toBe(1);
 f.setActive(false);await flush();expect(legacyStops).toBe(1);
 network('unavailable');network('available');ticks.splice(0).forEach(t=>t());await flush();expect(plays).toBe(1);
});
test('leaving during an outstanding play stops and cannot resume from its late completion',async()=>{
 const original=video.play;let resolve!:(value:any)=>void;
 video.play=()=>{plays++;return new Promise(r=>resolve=r);};
 try{const f=mountRetained();await flush();expect(plays).toBe(1);f.setActive(false);await flush();expect(legacyStops).toBe(1);
 resolve(state('playing'));await flush();expect(plays).toBe(1);expect(legacyStops).toBe(1);
 }finally{video.play=original;}
});
test('an old screen cleanup cannot stop a new legacy owner',async()=>{
 sessionsCapable=true;const old=mountRetained();await flush();const next=mountRetained('bili');await flush();
 old.dispose();await flush();expect(legacyStops).toBe(0);next.dispose();await flush();expect(legacyStops).toBe(1);
});
for(const platform of ['bili','rss'] as const)test(`${platform} retains its existing background-capable inactive path`,async()=>{
 const f=mountRetained(platform,true);await flush();expect(plays).toBe(1);const before=pauses;
 f.setActive(false);await flush();expect(legacyStops).toBe(0);expect(pauses).toBe(before+1);
 f.setActive(true);await flush();expect(plays).toBe(2);expect(prepares).toHaveLength(1);
});
test('handoff failure arriving after exit cannot pause the next screen player',async()=>{
 initial='available';gestures.length=0;legacyStops=0;const now=Date.now;let time=1000;Date.now=()=>time;
 let reject!:(e:Error)=>void,started=false,dispose!:()=>void;
 try{
  createRoot(stop=>{dispose=stop;stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://video/handoff',title:'handoff'},width:233,height:233,active:true,offset:0,round:true,onNext:()=>{started=true;return new Promise((_,r)=>reject=r);}});});await flush();
  const surface=gestures[0];surface.onPanStart();surface.onPanMove({dy:-110});surface.onPanEnd({vy:-2});await flush();
  for(let i=0;i<15&&!started;i++){time+=60;ticks.splice(0).forEach(t=>t());await flush();}expect(started).toBe(true);
  dispose();await flush();mountRetained('bili');await flush();const before=pauses;
  reject(Error('HTTP 403'));await flush();expect(pauses).toBe(before);expect(current.state).toBe('playing');
 }finally{Date.now=now;}
});

for(const platform of ['bili','rss'] as const)test(`${platform} background permission survives host lifecycle background`,async()=>{
 mountRetained(platform,true);await flush();const before=pauses;lifecycleState='background';
 lifecycleListeners.forEach(listener=>listener('background'));await flush();expect(pauses).toBe(before);expect(legacyStops).toBe(0);expect(current.state).toBe('playing');
});
test('fallback disposal cancels pending prepare and ignores its late completion',async()=>{
 sessionsCapable=true;let resolve!:(value:any)=>void;heldPrepare=new Promise(r=>resolve=r);const f=mountRetained();await flush();
 f.dispose();await flush();expect(legacyStops).toBe(1);resolve(state('ready'));await flush();expect(plays).toBe(0);
});
test('an old prepare completing after a new owner cannot start or stop that owner',async()=>{
 let resolve!:(value:any)=>void;heldPrepare=new Promise(r=>resolve=r);const f=mountRetained();await flush();f.setActive(false);await flush();
 mountRetained('bili');await flush();resolve(state('ready'));await flush();expect(plays).toBe(1);expect(legacyStops).toBe(0);
});
test('real session playback releases sessions without stopping the shared legacy player',async()=>{
 sessionsCapable=true;decoderLimit=2;const f=mountRetained();await flush();expect(prepares).toHaveLength(0);
 f.dispose();await flush();expect(sessionReleases).toBeGreaterThanOrEqual(2);expect(legacyStops).toBe(0);
});
test('returning to the retained Douyin page prepares again at the observed position',async()=>{
 const f=mountRetained();await flush();f.setActive(false);await flush();f.setActive(true);await flush();
 expect(prepares).toHaveLength(2);expect(prepares[1].resumePositionMs).toBe(321);expect(plays).toBe(2);
});


test('recovery deadline stops hanging prepare and late READY cannot restart it',async()=>{
 let finish!:(v:any)=>void;heldPrepare=new Promise(r=>finish=r);const before=legacyStops;mount('available','https://video/current',false,'bili',Date.now()+1000);await flush();
 const timers=[...ticks];for(const tick of timers)tick();await flush();expect(legacyStops).toBeGreaterThan(before);expect(plays).toBe(0);
 finish(state('ready'));await flush();expect(plays).toBe(0);
});
test('rendered first frame disarms recovery deadline without stopping successful playback',async()=>{
 mount('available','https://video/current',false,'bili',Date.now()+1000);await flush();const before=legacyStops;for(const tick of [...ticks])tick();await flush();expect(legacyStops).toBe(before);expect(plays).toBe(1);
});


test('successful recovery is not expired again when returning to its retained screen',async()=>{
 const f=mountRetained('douyin',false,Date.now()+1000);await flush();f.setActive(false);await flush();const before=legacyStops;
 f.source.recoveryDeadlineMs=Date.now()-1000;f.setActive(true);await flush();for(const tick of [...ticks])tick();await flush();expect(legacyStops).toBe(before);expect(plays).toBe(2);
});
