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
let spinnerMounts=0;mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>{if(p.src?.includes('player-loading'))spinnerMounts++;return element('Image',p);}}));
const gestures:any[]=[];
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);return {dispose(){}};}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>text.length*8})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
const frames:Array<()=>void>=[];mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:()=>void){frames.push(fn);}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>element('Poster',props)}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
const frameEvents=new Set<(value:any)=>void>();
let sessionPrepareError:unknown;
let pressureLimit:number|undefined;
let replacementPrepareGate:Promise<void>|undefined;
const sessionCalls:any[]=[];const sessionStates=new Map<string,any>();
const sessionValue=(id:string)=>sessionStates.get(id)??{...state("ready"),sessionId:id};
const sessionPort={
 prepare:(options:any)=>{if(options.prewarm&&pressureLimit)decoderLimit=pressureLimit;sessionCalls.push({method:"prepare",...options});const value={...state(options.prewarm?"prewarmed":"ready"),sessionId:options.sessionId,hasRenderedFirstFrame:true,presented:!options.prewarm};sessionStates.set(options.sessionId,value);return {result:options.prewarm&&sessionPrepareError?Promise.reject(sessionPrepareError):(!options.prewarm&&sessionCalls.filter(c=>c.method==="prepare"&&!c.prewarm).length>1&&replacementPrepareGate?replacementPrepareGate.then(()=>value):Promise.resolve(value)),cancel(){}};},
 play:async(id:string)=>{const v={...sessionValue(id),state:"playing"};sessionStates.set(id,v);return v;},
 retire:async(id:string)=>{const v={...sessionValue(id),state:"prewarmed",muted:true};sessionStates.set(id,v);return v;},
 pause:async(id:string)=>{const v={...sessionValue(id),state:"paused"};sessionStates.set(id,v);return v;},
 state:async(id:string)=>sessionValue(id),setTransform:async(id:string)=>sessionValue(id),setBounds:async(id:string)=>sessionValue(id),setLoop:async(id:string)=>sessionValue(id),
 promote:async(id:string,options:any)=>{sessionCalls.push({method:"promote",id,...options});const old=sessionValue(options.replaceSessionId);sessionStates.set(options.replaceSessionId,{...old,state:"prewarmed",muted:true});const v={...sessionValue(id),state:"playing",presented:true};sessionStates.set(id,v);return v;},
 transition:async(options:any)=>{sessionCalls.push({method:"transition",...options});return {...options,composited:true};},
 release:async()=>{sessionReleases++;return {released:true};}
};
let sessionsCapable=false,decoderLimit=1,lifecycleState='active';const lifecycleListeners=new Set<(value:string)=>void>();
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}},hasCapability:()=>sessionsCapable,lifecycle:()=>lifecycleState,onLifecycleChange:(listener:(value:string)=>void)=>{lifecycleListeners.add(listener);return()=>lifecycleListeners.delete(listener);},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
let debugAllowed=false,diagnosticBindings=0,diagnosticDisposals=0,diagnosticReader:(()=>Promise<unknown>)|undefined;
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{get allowed(){return debugAllowed;},bindSessions(reader:()=>Promise<unknown>){diagnosticBindings++;diagnosticReader=reader;return ()=>{diagnosticDisposals++;};}}}));
let network:(s:InternetStatus)=>void,initial:InternetStatus='available';
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:typeof network)=>{network=fn;fn(initial);return()=>{};}}));
let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let heldPrepare:Promise<any>|undefined;
let retires=0;let pauses=0,legacyStops=0,sessionReleases=0;const boundsCalls:any[]=[];
let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,state:name,positionMs:321,durationMs:1000,width:100,height:100,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={retire:async()=>{retires++;return current=state("paused");},prepare:(options:any)=>{prepares.push(options);const error=nextError;nextError=undefined;const held=heldPrepare;heldPrepare=undefined;return {result:error?Promise.reject(error):held??Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current=state('playing');},pause:async()=>{pauses++;return current=state('paused');},state:async()=>current,seek:async()=>current,stop:async()=>{legacyStops++;current=state('stopped');},setBounds:async(b:any)=>{boundsCalls.push(b);},setTransform:async()=>{},setVolume:async()=>current,setLoop:async()=>current};
const sessionFacade=Object.fromEntries(Object.keys(sessionPort).map(method=>[method,(...args:any[])=>(sessionPort as any)[method](...args)]));
mock.module('@podjs/framework/services',()=>({video,onVideoAudioChanged:()=>()=>{},onVideoFirstFrame:(fn:any)=>{frameEvents.add(fn);return()=>frameEvents.delete(fn);},videoSessions:sessionFacade,hostOperation:(method:string)=>{if(method!=='video.session.capabilities')throw Error('unexpected session operation');return {result:Promise.resolve({decoderLimit,maxSessions:decoderLimit,surfacePromotion:true,verticalTransition:true}),cancel(){}};},delay:()=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);return{result,cancel(){ticks=ticks.filter(t=>t!==release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());ticks=[];frames.length=0;sessionPrepareError=undefined;replacementPrepareGate=undefined;sessionsCapable=false;decoderLimit=1;lifecycleState='active';});
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
  await flush();const surface=gestures[0];surface.onPanStart({dy:-1});surface.onPanMove({dy:-110});await flush();
  expect(pauses).toBe(0);expect(boundsCalls.at(-1).translateY).toBe(-110);expect(adjacentCalls).toBe(1);
  surface.onPanEnd({vy:-2});await flush();
  for(let i=0;i<15&&!moveStarted;i++){time+=60;const pending=ticks.splice(0);pending.forEach(t=>t());await flush();}
  expect(moveStarted).toBe(true);expect(prepares).toHaveLength(1);expect(boundsCalls.at(-1).visible).toBe(false);
  expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  releaseMove();await flush();expect(prepares).toHaveLength(2);expect(prepares[1].bounds).toMatchObject({visible:true,translateY:0});
  // Native video calls are ordered: once the new prepare is queued the surface stays transparent until its own first frame, so handoff ends here.
  expect(boundsCalls.at(-1).visible).toBe(true);
  current={...state('playing'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();
  expect(boundsCalls.at(-1).visible).toBe(true);expect(boundsCalls.at(-1).translateY).toBe(0);
 } finally {Date.now=now;}
});

test('immersive legacy never substitutes a cover while waiting for its decoded frame',async()=>{
 const source={platform:'douyin' as const,immersive:true,awemeId:'c',url:'https://video/c',posterUrl:'https://cover/c',title:'c'};
 let settle!:(value:any)=>void;heldPrepare=new Promise(resolve=>settle=resolve);current=state('buffering');
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source,width:233,height:233,active:true,offset:0,round:true});});
 await flush();const posters=()=>nodes(root).filter(n=>n.kind==='Poster').length;
 expect(posters()).toBe(0);ticks.splice(0).forEach(t=>t());await flush();expect(posters()).toBe(0);
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
  await flush();const surface=gestures[0];surface.onPanStart({dy:-1});surface.onPanMove({dy:direction==='up'?-110:110});await flush();expect(pauses).toBe(0);
  surface.onPanEnd({vy:direction==='up'?-2:2});await flush();
  for(let i=0;i<15&&attempts===0;i++){time+=60;ticks.splice(0).forEach(t=>t());await flush();}
  expect(attempts).toBe(1);expect(pauses).toBe(2);expect(current.state).toBe('paused');
  expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join(' ')).toContain('播放失败');
  expect(boundsCalls.at(-1)).toMatchObject({translateY:0,visible:true});
  const retry=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children==='重试'));
  expect(retry).toBeDefined();retry!.props.onPress();await flush();expect(attempts).toBe(2);expect(current.state).toBe('paused');expect(prepares).toHaveLength(1);
 }finally{Date.now=now;}
});

test('ready without a decoded frame never displays a cover',async()=>{
 initial='available';heldPrepare=Promise.resolve({...state('ready'),hasRenderedFirstFrame:false});
 const originalPlay=video.play;video.play=async()=>({...state('playing'),hasRenderedFirstFrame:false});current={...state('buffering'),hasRenderedFirstFrame:false};
 try{
  const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://video/late-frame',title:'late frame',posterUrl:'https://cover/late-frame'},width:233,height:233,active:true,offset:0,round:true});});
  await flush();expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
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
  const surface=gestures[0];surface.onPanStart({dy:-1});surface.onPanMove({dy:-110});surface.onPanEnd({vy:-2});await flush();
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

for(const code of ['restricted','decode_error'])test(`DYFIX immersive ${code} reaches queue recovery while ordinary playback stays local`,async()=>{
 nextError={code};const immersive=mount('available','https://fixture/rejected',true);await flush();expect(failures).toBe(1);expect(immersive.text()).toContain('重试');
 stops.splice(0).forEach(stop=>stop());nextError={code};mount('available','https://fixture/rejected',false);await flush();expect(failures).toBe(0);
});
test('DYFIX first-frame callback waits for a decoded frame after prepare and after source changes',async()=>{
 initial='available';const originalPlay=video.play;video.play=async()=>({...state('playing'),hasRenderedFirstFrame:false});heldPrepare=Promise.resolve({...state('ready'),hasRenderedFirstFrame:false});current={...state('buffering'),hasRenderedFirstFrame:false};
 let frames=0,setSource!:(source:any)=>void;
 try{
  createRoot(stop=>{stops.push(stop);const [source,set]=createSignal<any>({platform:'douyin',immersive:true,url:'https://fixture/a',title:'a'});setSource=set;return VideoPlayerScreen({get source(){return source();},width:233,height:233,active:true,offset:0,round:true,onFirstFrame:()=>frames++});});
  await flush();expect(frames).toBe(0);current={...state('playing'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();expect(frames).toBe(1);
  heldPrepare=Promise.resolve({...state('ready'),hasRenderedFirstFrame:false});current={...state('buffering'),hasRenderedFirstFrame:false};setSource({platform:'douyin',immersive:true,url:'https://fixture/b',title:'b'});await flush();expect(frames).toBe(1);
  current={...state('playing'),hasRenderedFirstFrame:true};ticks.splice(0).forEach(t=>t());await flush();expect(frames).toBe(2);
 }finally{video.play=originalPlay;}
});

test('DYFIX standby failures retain foreground sessions while capacity one degrades them',async()=>{
 for(const [code,limit] of [['decode_error',2],['video_decoder_limit',2],['video_decoder_limit',1],['resource_exhausted',2],['resource_exhausted',1]] as const){
  pressureLimit=limit;
  sessionsCapable=true;decoderLimit=2;sessionPrepareError={code};prepares=[];sessionReleases=0;current=state('ready');initial='available';
  createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,awemeId:'active',url:'https://fixture/active',title:'active'},width:233,height:233,active:true,offset:0,round:true,onPrepareAdjacent:async()=>({key:'next',source:{platform:'douyin',immersive:true,awemeId:'next',url:'https://fixture/next',title:'next'}})});});
  for(let i=0;i<6;i++)await flush();
  expect(prepares).toHaveLength(limit===1?1:0);expect(sessionReleases).toBeGreaterThan(0);
  stops.splice(0).forEach(stop=>stop());await flush();pressureLimit=undefined;
 }
});


// Production component with real reactive publication and a blocked persistence reply.
test('SWIPEFEED prewarmed handoff never prepares again while publication persistence is blocked',async()=>{
 sessionsCapable=true;decoderLimit=2;initial='available';gestures.length=0;sessionCalls.length=0;sessionStates.clear();ticks=[];
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const a={platform:'douyin' as const,immersive:true,awemeId:'a',url:'managed/a',posterUrl:'cover/a',title:'a'};
  const b={...a,awemeId:'b',url:'managed/b',posterUrl:'cover/b',title:'b'};
  let prepareRelease!:()=>void;replacementPrepareGate=new Promise<void>(r=>prepareRelease=r);
  let published=false,release!:()=>void;const persistence=new Promise<void>(r=>release=r);
  const root=createRoot(stop=>{stops.push(stop);const [source,setSource]=createSignal(a);return VideoPlayerScreen({get source(){return source();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrepareAdjacent:async()=>({key:'b',source:b}),onPromoteAdjacent:async prepared=>{published=true;setSource(prepared.source as typeof a);await persistence;return true;}});});
  await flush();const preparedBefore=sessionCalls.filter(c=>c.method==='prepare').length;const spinnerBefore=spinnerMounts;
  const g=gestures[0];g.onPanStart({dy:-1});g.onPanMove({dy:-1});await flush();
  expect(sessionCalls.filter(c=>c.method==='transition').at(-1)?.progress).toBeCloseTo(1/233);
  g.onPanMove({dy:-120});const releasedAt=time;g.onPanEnd({vy:-500});await flush();
  for(let i=0;i<20&&!published;i++){time+=16;ticks.splice(0).forEach(t=>t());await flush();}
  expect(published).toBe(true);
  const extra=sessionCalls.filter(c=>c.method==='prepare').length-preparedBefore;nodes(root);
  const extraSpinners=spinnerMounts-spinnerBefore;if(extra>0)time+=100;prepareRelease();await flush();
  console.log('SWIPEFEED_SESSION',JSON.stringify({extraPrepareAtSettle:extra,spinnerMountsAtSettle:extraSpinners,persistPending:true,simulatedPrepareMs:100,releaseToPlayedFrameMs:time-releasedAt,framesAt16ms:Math.ceil((time-releasedAt)/16)}));
  expect(extra).toBe(0);
  expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  release();await flush();
 }finally{Date.now=realNow;}
});

test('SWIPEFEED legacy settle retires outgoing before a contended route result',async()=>{
 initial='available';gestures.length=0;ticks=[];pauses=0;legacyStops=0;
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  let moved=false,release!:()=>void;const restore=new Promise<void>(r=>release=r);
  createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,awemeId:'a',url:'managed/a',posterUrl:'cover/a',title:'a'},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{moved=true;await restore;},onAdjacentPoster:()=> 'cover/b'});});
  await flush();const g=gestures[0];g.onPanStart({dy:-1});g.onPanMove({dy:-120});g.onPanEnd({vy:-500});await flush();
  for(let i=0;i<20&&!moved;i++){time+=16;ticks.splice(0).forEach(t=>t());await flush();}
  expect(moved).toBe(true);
  console.log('SWIPEFEED_LEGACY',JSON.stringify({outgoingPaused:retires>0,restorePending:true,elapsedMs:time-1000}));
  expect(retires).toBeGreaterThan(0);
  release();await flush();
 }finally{Date.now=realNow;}
});


test('SWIPEFEED spinner waits from settle and decoded frame event removes it without a state poll',async()=>{
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  initial='available';current={...state('buffering'),hasRenderedFirstFrame:false,bufferedMs:0,networkStalled:true};heldPrepare=new Promise(()=>{});
  const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'managed/late',posterUrl:'cover/late',title:'late'},width:233,height:233,active:true,offset:0,round:true});});
  await flush();const spinner=()=>nodes(root).filter(n=>n.kind==='Image'&&n.props.src?.includes('player-loading')).length;
  time+=999;frames.forEach(f=>f());expect(spinner()).toBe(0);
  time++;frames.forEach(f=>f());expect(spinner()).toBe(1);
  frameEvents.forEach(f=>f({...current,hasRenderedFirstFrame:true}));expect(spinner()).toBe(0);expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  console.log('SWIPEFEED_SPINNER',JSON.stringify({before1000ms:0,at1000ms:1,afterFrameEvent:0}));
 }finally{Date.now=realNow;}
});

test('SWIPEFEED cancelled session drag preserves both frames and two fast flings promote in place',async()=>{
 sessionsCapable=true;decoderLimit=2;initial='available';gestures.length=0;sessionCalls.length=0;sessionStates.clear();ticks=[];
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const source=(key:string)=>({platform:'douyin' as const,immersive:true,awemeId:key,url:'managed/'+key,posterUrl:'cover/'+key,title:key});let selected='a';
  createRoot(stop=>{stops.push(stop);const [current,setCurrent]=createSignal(source('a'));return VideoPlayerScreen({get source(){return current();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrepareAdjacent:async()=>{const key=selected==='a'?'b':'c';return {key,source:source(key)};},onPromoteAdjacent:async prepared=>{selected=prepared.key;setCurrent(prepared.source as ReturnType<typeof source>);return true;}});});
  await flush();const g=gestures[0];g.onPanStart({dy:-1});g.onPanMove({dy:-80});g.onCancel();await flush();for(let i=0;i<16;i++){time+=16;ticks.splice(0).forEach(f=>f());await flush();}
  expect(selected).toBe('a');expect(sessionCalls.filter(c=>c.method==='promote')).toHaveLength(0);expect(sessionCalls.filter(c=>c.method==='transition').at(-1)?.progress).toBe(0);
  for(const key of ['b','c']){g.onPanStart({dy:-1});g.onPanMove({dy:-2});g.onPanEnd({vy:-1000});await flush();for(let i=0;i<16&&selected!==key;i++){time+=16;ticks.splice(0).forEach(f=>f());await flush();}expect(selected).toBe(key);}
  expect(sessionCalls.filter(c=>c.method==='promote')).toHaveLength(2);expect(sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm)).toHaveLength(1);
 }finally{Date.now=realNow;}
});


test('SWIPEFEED DYBENCH action correlation reaches the native promotion without content fields',async()=>{
 const original=(globalThis as any).pod;const marks:any[]=[];let nextSeq=100;
 (globalThis as any).pod={benchmark:(line:string)=>{const event=JSON.parse(line);marks.push(event);return event.seq??++nextSeq;}};
 sessionsCapable=true;decoderLimit=2;initial='available';gestures.length=0;sessionCalls.length=0;sessionStates.clear();ticks=[];
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  let selected='a';const source=(key:string)=>({platform:'douyin' as const,immersive:true,awemeId:key,url:'managed/'+key,posterUrl:'cover/'+key,title:key});
  createRoot(stop=>{stops.push(stop);const [current,setCurrent]=createSignal(source('a'));return VideoPlayerScreen({get source(){return current();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrepareAdjacent:async()=>({key:'b',source:source('b')}),onPromoteAdjacent:async prepared=>{selected=prepared.key;setCurrent(prepared.source as ReturnType<typeof source>);return true;}});});
  await flush();const g=gestures[0];g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-500});await flush();
  for(let i=0;i<16&&selected==='a';i++){time+=16;ticks.splice(0).forEach(f=>f());await flush();}
  const begin=marks.find(e=>e.code==='gesture_down'),release=marks.find(e=>e.code==='gesture_release');expect(begin.direction).toBe('next');expect(release).toMatchObject({seq:marks.find(e=>e.code==='gesture_release').seq,direction:'next',prewarmed:true,generation:2});
  expect(sessionCalls.find(c=>c.method==='promote').benchmark).toMatchObject({seq:release.seq,generation:2});expect(marks.some(e=>e.code==='incoming_first_frame'||e.code==='previous_audio_stopped')).toBe(false);
  expect(JSON.stringify(marks)).not.toMatch(/managed|cover|awemeId|Cookie|mono_ms/);
 }finally{Date.now=realNow;(globalThis as any).pod=original;}
});


test('PREWARM production component resolves both neighbours, strips background preference, and promotes five forward/backward swipes without a prepare at settle',async()=>{
 sessionsCapable=true;decoderLimit=3;sessionCalls.length=0;sessionStates.clear();gestures.length=0;initial='available';ticks=[];
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const source=(id:number)=>({platform:'douyin' as const,immersive:true,backgroundPlayback:true,awemeId:String(id),url:'managed/'+id,posterUrl:'cover/'+id,title:String(id)});
  let selected=10;const requests:string[]=[];
  const root=createRoot(stop=>{stops.push(stop);const [current,setCurrent]=createSignal(source(selected));
   return VideoPlayerScreen({get source(){return current();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrevious:async()=>{},
    onPrepareAdjacent:async direction=>{const id=selected+(direction==='next'?1:-1);requests.push(String(id));return {key:String(id),source:source(id)};},
    onPromoteAdjacent:async target=>{selected=Number(target.key);setCurrent(target.source as ReturnType<typeof source>);return true;}});
  });await flush();await flush();
  expect(requests).toContain('9');expect(requests).toContain('11');
  expect(sessionCalls.filter(c=>c.method==='prepare')).toHaveLength(3);
  expect(sessionCalls.filter(c=>c.method==='prepare').every(c=>c.backgroundPlayback===undefined)).toBe(true);
  const gesture=gestures[0];
  for(const sign of [1,1,1,1,1,-1,-1,-1,-1,-1]){
   const from=selected,before=sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm).length;
   gesture.onPanStart({dy:-sign*12});gesture.onPanMove({dy:-sign*120});await flush();gesture.onPanEnd({vy:-sign*500});await flush();
   for(let i=0;i<20&&selected===from;i++){time+=16;ticks.splice(0).forEach(t=>t());await flush();}
   await flush();expect(selected).toBe(from+sign);expect(sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm)).toHaveLength(before);
   expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);
  }
  expect(selected).toBe(10);expect(sessionCalls.filter(c=>c.method==='promote')).toHaveLength(10);
 }finally{Date.now=realNow;}
});

test('PREWARM transient failure waits for the same-item candidate recovery before exposing an error page',async()=>{
 initial='available';current=state('idle');gestures.length=0;nextError={code:'cdn_error'};
 let recover!:()=>void,calls=0;const gate=new Promise<void>(r=>recover=r);
 const root=createRoot(stop=>{stops.push(stop);const [source,setSource]=createSignal({platform:'douyin' as const,immersive:true,awemeId:'same',url:'https://fixture/cdn-a',title:'same'});
  return VideoPlayerScreen({get source(){return source();},width:233,height:233,active:true,offset:0,round:true,onPlaybackFailure:async()=>{calls++;await gate;setSource({...source(),url:'https://fixture/cdn-b'});}});
 });await flush();expect(calls).toBe(1);expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join(' ')).not.toContain('播放失败');
 recover();await flush();expect(prepares.at(-1).url).toBe('https://fixture/cdn-b');expect(current.state).toBe('playing');
});

test('PREWARM no ring for CPU wait, unknown buffer, positive buffer, or healthy network',async()=>{
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  for(const [bufferedMs,networkStalled] of [[undefined,true],[1,true],[0,false],[0,true]] as const){
   initial='available';current={...state('buffering'),hasRenderedFirstFrame:false,bufferedMs,networkStalled};heldPrepare=new Promise(()=>{});ticks=[];
   const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://fixture/wait',title:'wait'},width:233,height:233,active:true,offset:0,round:true});});await flush();
   time+=1000;frames.forEach(f=>f());expect(nodes(root).filter(n=>n.kind==='Image'&&n.props.src?.includes('player-loading')).length).toBe(bufferedMs===0&&networkStalled?1:0);
   stops.pop()!();await flush();
  }
 }finally{Date.now=realNow;}
});

test('DYFIX one fast fling skips one item and prewarms both target neighbours',async()=>{
 const original=(globalThis as any).pod,marks:any[]=[];let seq=100;
 (globalThis as any).pod={benchmark:(line:string)=>{const e=JSON.parse(line);marks.push(e);return e.seq??++seq;}};
 sessionsCapable=true;decoderLimit=3;sessionCalls.length=0;sessionStates.clear();gestures.length=0;initial='available';ticks=[];
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const source=(id:number)=>({platform:'douyin' as const,immersive:true,awemeId:String(id),url:'managed/'+id,title:String(id)});
  let selected=10;const requests:number[]=[];
  createRoot(stop=>{stops.push(stop);const [current,setCurrent]=createSignal(source(selected));return VideoPlayerScreen({get source(){return current();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrevious:async()=>{},
   onPrepareAdjacent:async(direction,distance=1)=>{const id=selected+(direction==='next'?distance:-distance);requests.push(id);return {key:String(id),source:source(id)};},
   onPromoteAdjacent:async target=>{selected=Number(target.key);setCurrent(target.source as ReturnType<typeof source>);return true;}});});await flush();await flush();
  const g=gestures[0];g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-2400});await flush();
  for(let i=0;i<20&&selected===10;i++){time+=16;ticks.splice(0).forEach(f=>f());await flush();}
  await flush();expect(selected).toBe(12);expect(requests).toContain(11);expect(requests).toContain(13);
  expect(sessionCalls.filter(c=>c.method==='promote')).toHaveLength(1);
  expect(sessionCalls.find(c=>c.method==='promote').benchmark.delta).toBe(2);
  expect(marks.find(e=>e.code==='gesture_release')).toMatchObject({direction:'fling',delta:2});
  expect(sessionCalls.filter(c=>c.method==='prepare').map(c=>c.url)).toContain('managed/11');
  expect(sessionCalls.filter(c=>c.method==='prepare').map(c=>c.url)).toContain('managed/13');
 }finally{Date.now=realNow;(globalThis as any).pod=original;}
});

test('DYFIX slow two-item resolution includes the wait in release timing and stale exit cannot promote',async()=>{
 sessionsCapable=true;decoderLimit=3;sessionCalls.length=0;sessionStates.clear();gestures.length=0;initial='available';ticks=[];
 const original=(globalThis as any).pod,marks:any[]=[];let seq=100;
 (globalThis as any).pod={benchmark:(line:string)=>{const e=JSON.parse(line);marks.push(e);return e.seq??++seq;}};
 let resolve!:(v:any)=>void;const gate=new Promise<any>(r=>resolve=r);
 try{
  createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,awemeId:'a',url:'managed/a',title:'a'},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrepareAdjacent:async(_direction,distance=1)=>distance===2?gate:{key:'b',source:{platform:'douyin',immersive:true,awemeId:'b',url:'managed/b',title:'b'}}});});
  await flush();const g=gestures[0];g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-2400});await flush();
  expect(marks.find(e=>e.code==='gesture_release')).toMatchObject({direction:'fling',delta:2});
  stops.pop()!();resolve({key:'c',source:{platform:'douyin',immersive:true,awemeId:'c',url:'managed/c',title:'c'}});await flush();
  expect(sessionCalls.filter(c=>c.method==='promote')).toHaveLength(0);
 }finally{(globalThis as any).pod=original;}
});

// Runs the real component and pool with a frame clock and decoded-frame host
// acknowledgements. These counts are offline model evidence, not codec/PCM proof.
async function swipeClock(){
 sessionsCapable=true;decoderLimit=3;sessionCalls.length=0;sessionStates.clear();gestures.length=0;initial='available';ticks=[];
 const originalNow=Date.now,originalPort={...sessionPort};let time=1000,selected=100;
 Date.now=()=>time;
 const jobs:Array<{at:number;run:()=>void}>=[],stopsAt:Array<{id:string;at:number}>=[],presentations:Array<{key:string;decoded:boolean;at:number}>=[];
 let rings=0,posters=0;
 const source=(id:number)=>({platform:'douyin' as const,immersive:true,awemeId:String(id),url:'managed/'+id,posterUrl:'cover/'+id,title:String(id)});
 sessionPort.prepare=(options:any)=>{
  sessionCalls.push({method:'prepare',...options});let cancelled=false;
  const value={...state(options.prewarm?'prewarmed':'ready'),key:String(options.url).split('/').at(-1),sessionId:options.sessionId,hasRenderedFirstFrame:false,presented:!options.prewarm,bufferedMs:1500,networkStalled:false};
  sessionStates.set(options.sessionId,value);
  const result=new Promise<any>((resolve,reject)=>{const run=()=>{if(cancelled){reject(Error('cancelled'));return;}value.hasRenderedFirstFrame=true;resolve(value);};if(options.prewarm)jobs.push({at:time+32,run});else run();});
  return {result,cancel(){cancelled=true;}};
 };
 sessionPort.pause=async(id:string)=>{stopsAt.push({id,at:time});return originalPort.pause(id);};
 sessionPort.retire=async(id:string)=>{stopsAt.push({id,at:time});return originalPort.retire(id);};
 sessionPort.promote=async(id:string,options:any)=>{
  const value=sessionValue(id);presentations.push({key:String(value.key??''),decoded:value.hasRenderedFirstFrame===true,at:time});
  stopsAt.push({id:options.replaceSessionId,at:time});const valueAfter=await originalPort.promote(id,options);sessionStates.get(options.replaceSessionId).presented=false;return valueAfter;
 };
 sessionPort.release=async(id?:string)=>{if(id)sessionStates.delete(id);return {released:true};};
 let dispose!:()=>void;
 const root=createRoot(stop=>{dispose=stop;const [current,setCurrent]=createSignal(source(selected));return VideoPlayerScreen({get source(){return current();},width:233,height:233,active:true,offset:0,round:true,onNext:async()=>{},onPrevious:async()=>{},
  onPrepareAdjacent:async(direction,distance=1)=>{const id=selected+(direction==='next'?distance:-distance);return {key:String(id),source:source(id)};},
  onPromoteAdjacent:async target=>{selected=Number(target.key);setCurrent(target.source as ReturnType<typeof source>);return true;}});});
 const sample=()=>{const all=nodes(root);rings+=all.filter(n=>n.kind==='Image'&&n.props.src?.includes('player-loading')).length;posters+=all.filter(n=>n.kind==='Poster').length;};
 const advance=async(ms:number)=>{const end=time+ms;do{time=Math.min(end,time+16);for(const job of jobs.filter(j=>j.at<=time)){jobs.splice(jobs.indexOf(job),1);job.run();}ticks.splice(0).forEach(t=>t());await flush();frames.forEach(frame=>frame());await flush();sample();}while(time<end);};
 await flush();await advance(64);
 const release=async(sign:number,cancel=false,fling=false)=>{const g=gestures[0];g.onPanStart({dy:-sign*12});g.onPanMove({dy:-sign*116});await flush();const at=time;if(cancel)g.onCancel();else g.onPanEnd({vy:-sign*(fling?2400:500)});await flush();return at;};
 return {advance,release,stopsAt,presentations,get selected(){return selected;},get rings(){return rings;},get posters(){return posters;},get now(){return time;},close(){dispose();Date.now=originalNow;Object.assign(sessionPort,originalPort);}};
}

test('DYSWIPE old player stops within 100ms of release, before any settle animation completes',async()=>{
 const f=await swipeClock();try{const at=await f.release(1);await f.advance(100);expect(f.stopsAt.some(s=>s.at-at<=100)).toBe(true);}finally{f.close();}
});

for(const scenario of ['next','prev','rapid_forward','rapid_alternate','fling','cancel'] as const)test(`DYSWIPE deterministic ${scenario}: decoded surfaces, no cover/ring, correct anchor`,async()=>{
 const f=await swipeClock();const count=scenario==='fling'?10:scenario==='cancel'?15:30,interval=scenario.startsWith('rapid_')?200:320;
 try{
  let expected=100;const stopLatency:number[]=[];const before=sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm).length;
  for(let i=0;i<count;i++){
   const sign=scenario==='prev'?-1:scenario==='rapid_alternate'||scenario==='fling'?i%2===0?1:-1:1;
   const cancelled=scenario==='cancel',at=await f.release(sign,cancelled,scenario==='fling');
   await f.advance(interval);if(!cancelled)expected+=sign*(scenario==='fling'?2:1);
   expect(f.selected,`${scenario} sample ${i+1}`).toBe(expected);
   if(!cancelled){const latency=Math.min(...f.stopsAt.filter(s=>s.at>=at).map(s=>s.at-at));stopLatency.push(latency);expect(latency,`old stop ${i+1}`).toBeLessThanOrEqual(100);}
   const active=sessionCalls.filter(c=>c.method==='promote').at(-1)?.id??sessionCalls.find(c=>c.method==='prepare'&&!c.prewarm).sessionId;
   const neighbours=[...sessionStates.entries()].filter(([id])=>id!==active).map(([,v])=>v);
   expect(neighbours.map(v=>Number(v.key))).toContain(expected-1);expect(neighbours.map(v=>Number(v.key))).toContain(expected+1);
   expect(neighbours.every(v=>v.hasRenderedFirstFrame)).toBe(true);if(cancelled)expect(sessionStates.get(active).state).toBe('playing');
  }
  expect(f.rings).toBe(0);expect(f.posters).toBe(0);expect(f.presentations.every(p=>p.decoded)).toBe(true);
  expect(f.presentations.length).toBe(scenario==='cancel'?0:count);
  expect(sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm)).toHaveLength(before);
  if(scenario==='cancel')expect(f.stopsAt).toHaveLength(0);
  const active=sessionCalls.filter(c=>c.method==='promote').at(-1)?.id;
  const warm=[...sessionStates.entries()].filter(([id])=>id!==active).map(([,value])=>Number(value.key));
  expect(warm).toContain(f.selected-1);expect(warm).toContain(f.selected+1);
  console.log('DYSWIPE_MODEL '+JSON.stringify({scenario,attempts:count,committed:f.presentations.length,intervalMs:interval,ringSamples:f.rings,coverSamples:f.posters,decoded:f.presentations.filter(p=>p.decoded).length,maxOldStopMs:stopLatency.length?Math.max(...stopLatency):null,deviceProof:false}));
 }finally{f.close();}
},30000);

test('DYSWIPE loading ring requires empty buffer and measured network stall, never CPU/decoder wait',async()=>{
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const cases=[
   {name:'healthy_throughput',bufferedMs:0,networkStalled:false,throughputBps:5000000,ring:0},
   {name:'buffered_network_stall',bufferedMs:1000,networkStalled:true,throughputBps:0,ring:0},
   {name:'unknown_buffer',bufferedMs:undefined,networkStalled:true,throughputBps:0,ring:0},
   {name:'empty_network_stall',bufferedMs:0,networkStalled:true,throughputBps:0,ring:1},
  ];
  for(const c of cases){
   initial='available';current={...state('buffering'),hasRenderedFirstFrame:false,bufferedMs:c.bufferedMs,networkStalled:c.networkStalled,metrics:{throughputBps:c.throughputBps}};heldPrepare=new Promise(()=>{});ticks=[];
   const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://fixture/stall',title:'stall'},width:233,height:233,active:true,offset:0,round:true});});await flush();
   time+=1000;frames.forEach(f=>f());expect(nodes(root).filter(n=>n.kind==='Image'&&n.props.src?.includes('player-loading')).length,c.name).toBe(c.ring);
   console.log('DYSWIPE_STALL_MODEL '+JSON.stringify({scenario:c.name,ring:c.ring,bufferedMs:c.bufferedMs,throughputBps:c.throughputBps,networkStalled:c.networkStalled,deviceProof:false}));stops.pop()!();await flush();
  }
 }finally{Date.now=realNow;}
});

test('DYSWIPE3 pending publication retains a second swipe and a later cancellation exactly once',async()=>{
 sessionsCapable=false;initial='available';gestures.length=0;ticks=[];prepares=[];
 const realNow=Date.now,originalPod=(globalThis as any).pod;let time=1000,seq=1,selected=100,calls=0;Date.now=()=>time;
 const marks:any[]=[];(globalThis as any).pod={benchmark:(line:string)=>{const value=JSON.parse(line);marks.push(value);return value.seq??++seq;}};
 let publish!:()=>void;const gate=new Promise<void>(r=>publish=r);
 const source=(n:number)=>({platform:'douyin' as const,immersive:true,awemeId:String(n),url:'local/'+n,title:'fixture'});
 try{
  createRoot(stop=>{stops.push(stop);const [value,set]=createSignal(source(selected));return VideoPlayerScreen({get source(){return value();},width:233,height:233,active:true,offset:0,round:true,onPrepareAdjacent:async()=>undefined,onNext:async()=>{if(++calls===1)await gate;set(source(++selected));}});});await flush();
  const g=gestures[0],advance=async(ms:number)=>{for(let n=0;n<ms;n+=16){time+=16;ticks.splice(0).forEach(t=>t());await flush();}};
  g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-500});await advance(128);expect(calls).toBe(1);
  g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-500});await flush();
  g.onPanStart({dy:-12});g.onPanMove({dy:-10});g.onPanEnd({vy:0});await flush();
  publish();await advance(800);expect(selected).toBe(102);expect(calls).toBe(2);expect(marks.filter(v=>v.code==='gesture_release')).toHaveLength(3);expect(marks.filter(v=>v.code==='gesture_release'&&v.direction==='cancel')).toHaveLength(1);
 }finally{Date.now=realNow;(globalThis as any).pod=originalPod;}
});


test('DYINTENT 50 cold releases select immediately without decoder or publication backlog',async()=>{
 initial='available';sessionsCapable=false;current=state('idle');gestures.length=0;ticks=[];prepares=[];plays=0;
 const realNow=Date.now,originalPod=(globalThis as any).pod;let time=1000,seq=1,selected=100;Date.now=()=>time;
 const marks:any[]=[];(globalThis as any).pod={benchmark:(line:string)=>{const value=JSON.parse(line);marks.push(value);return value.seq??++seq;}};
 const pending:Array<(value:any)=>void>=[];
 const source=(n:number)=>({platform:'douyin' as const,immersive:true,awemeId:String(n),url:'local/'+n,posterUrl:'cover/'+n,title:'fixture'});
 const hold=()=>{heldPrepare=new Promise(resolve=>pending.push(resolve));};hold();
 try{
  const root=createRoot(stop=>{stops.push(stop);const [value,set]=createSignal(source(selected));return VideoPlayerScreen({get source(){return value();},width:233,height:233,active:true,offset:0,round:true,onNext:()=>{},onPrevious:()=>{},onSelectTarget:(direction,distance)=>{selected+=(direction==='next'?distance:-distance);hold();set(source(selected));}});});await flush();
  for(let n=0;n<50;n++){
   const g=gestures[0];g.onPanStart({dy:-12});g.onPanMove({dy:-120});g.onPanEnd({vy:-500});await flush();
   expect(selected).toBe(101+n);expect(prepares.at(-1).awemeId).toBe(String(selected));
   expect(nodes(root).filter(n=>n.kind==='Poster')).toHaveLength(0);time+=500;
  }
  expect(marks.filter(v=>v.code==='gesture_release')).toHaveLength(50);expect(marks.filter(v=>v.reason==='capacity')).toHaveLength(0);
  expect(prepares).toHaveLength(51);
  pending.slice(0,-1).forEach(resolve=>resolve(state('ready')));await flush();expect(plays).toBe(0);
  current=state('ready');pending.at(-1)!(current);await flush();expect(plays).toBe(1);expect(selected).toBe(150);
 }finally{Date.now=realNow;(globalThis as any).pod=originalPod;heldPrepare=undefined;}
});


test('DYINTENT a network prompt during a drag still records its cancelled release',async()=>{
 initial='available';sessionsCapable=false;gestures.length=0;current={...state('buffering'),hasRenderedFirstFrame:false};heldPrepare=new Promise(()=>{});ticks=[];
 const original=(globalThis as any).pod,marks:any[]=[];let seq=1;
 (globalThis as any).pod={benchmark:(line:string)=>{const value=JSON.parse(line);marks.push(value);return value.seq??++seq;}};
 try{
  createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'https://fixture/cold',title:'cold'},width:233,height:233,active:true,offset:0,round:true,onNext:()=>{},onSelectTarget:()=>{throw Error('cancelled drag cannot select');}});});await flush();
  const g=gestures[0];g.onPanStart({dy:-12});g.onPanMove({dy:-120});network('unavailable');await flush();g.onPanEnd({vy:-500});await flush();
  expect(marks.filter(v=>v.code==='gesture_down')).toHaveLength(1);expect(marks.filter(v=>v.code==='gesture_release')).toMatchObject([{direction:'cancel',delta:0}]);
 }finally{(globalThis as any).pod=original;heldPrepare=undefined;}
});

test('DYLOSS reverse boundary records each release and snaps back without retiring a cold source',async()=>{
 initial='available';sessionsCapable=false;gestures.length=0;ticks=[];prepares=[];retires=0;pauses=0;
 const realNow=Date.now,originalPod=(globalThis as any).pod;let time=1000,seq=1,selected=0;Date.now=()=>time;
 const marks:any[]=[];(globalThis as any).pod={benchmark:(line:string)=>{const value=JSON.parse(line);marks.push(value);return value.seq??++seq;}};
 heldPrepare=new Promise(()=>{});
 try{
  createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'local/0',title:'boundary'},width:233,height:233,active:true,offset:0,round:true,onNext:()=>{},onPrevious:()=>{},canSelectTarget:direction=>direction==='next'||selected>0,onSelectTarget:()=>{selected++;}});});await flush();
  const before=retires,g=gestures[0];
  for(let n=0;n<50;n++){
   g.onPanStart({dy:12});g.onPanMove({dy:100});g.onPanEnd({vy:500});
   for(let t=0;t<280;t+=16){time+=16;ticks.splice(0).forEach(f=>f());await flush();}
  }
  expect(selected).toBe(0);expect(pauses).toBe(0);expect(retires).toBe(before);expect(prepares).toHaveLength(1);
  const releases=marks.filter(v=>v.code==='gesture_release');expect(releases).toHaveLength(50);expect(releases.every(v=>v.direction==='cancel'&&v.delta===0&&v.reason==='boundary')).toBe(true);
 }finally{Date.now=realNow;(globalThis as any).pod=originalPod;heldPrepare=undefined;}
});

test('DYLOSS a new swipe interrupts boundary settling without losing either direction',async()=>{
 initial='available';sessionsCapable=false;gestures.length=0;ticks=[];prepares=[];
 const original=(globalThis as any).pod,marks:any[]=[];let seq=1,index=0;
 (globalThis as any).pod={benchmark:(line:string)=>{const v=JSON.parse(line);marks.push(v);return v.seq??++seq;}};
 const source=(n:number)=>({platform:'douyin' as const,immersive:true,url:'local/'+n,awemeId:String(n),title:'fixture'});
 try{
  createRoot(stop=>{stops.push(stop);const [value,set]=createSignal(source(index));return VideoPlayerScreen({get source(){return value();},width:233,height:233,active:true,offset:0,round:true,onNext:()=>{},onPrevious:()=>{},canSelectTarget:d=>d==='next'||index>0,onSelectTarget:(d,n)=>{index+=d==='next'?n:-n;set(source(index));}});});await flush();
  const g=gestures[0];g.onPanStart({dy:12});g.onPanMove({dy:100});g.onPanEnd({vy:500});await flush();
  // The boundary rebound is still in its first await. Neither following
  // selection may be swallowed by the obsolete settling guard.
  g.onPanStart({dy:-12});g.onPanMove({dy:-100});g.onPanEnd({vy:-500});await flush();
  g.onPanStart({dy:12});g.onPanMove({dy:100});g.onPanEnd({vy:500});await flush();
  expect(index).toBe(0);expect(marks.filter(v=>v.code==='gesture_release')).toMatchObject([{direction:'cancel',reason:'boundary'},{direction:'next',reason:'release'},{direction:'prev',reason:'release'}]);
 }finally{(globalThis as any).pod=original;}
});
