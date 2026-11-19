import { afterEach, afterAll, expect, mock, test, spyOn } from 'bun:test';
import { plugin } from 'bun';
import pocketConfig from '../src/pocket.config.ts';
import {parseClassLiteral} from '../node_modules/@pocketjs/framework/framework/compiler/tailwind.ts';
import {registerAnimationTheme,bakedTimelines} from '../node_modules/@pocketjs/framework/framework/compiler/animation.ts';
import {ENUMS,f32Bits,PROP} from '../node_modules/@pocketjs/framework/contracts/spec/spec.ts';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps, onCleanup } from 'solid-js';
import type { InternetStatus } from '../src/onboarding/state.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'d2-player-solid',setup(builder){builder.onLoad({filter:/\/ui\/(?:VideoPlayerScreen|PlayerLoadingIndicator)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const child=createMemo(()=>props.children);return {kind,props:mergeProps(props,{get children(){return child();}})};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
let spinnerMounts=0;mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>{if(p.src?.includes('player-loading'))spinnerMounts++;return element('Image',p);}}));
const gestures:any[]=[];
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);return {dispose(){}};}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>text.length*8})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
const frames:Array<()=>void>=[];const frameNeeds=new Map<()=>void,()=>boolean>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:()=>void,needs=()=>true){frames.push(fn);frameNeeds.set(fn,needs);onCleanup(()=>{const i=frames.indexOf(fn);if(i>=0)frames.splice(i,1);frameNeeds.delete(fn);});}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>element('Poster',props)}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
const frameEvents=new Set<(value:any)=>void>(),stateEvents=new Set<(value:any)=>void>();
let sessionPrepareError:unknown;
let pressureLimit:number|undefined;
let replacementPrepareGate:Promise<void>|undefined;
const sessionCalls:any[]=[];const sessionStates=new Map<string,any>();
const sessionValue=(id:string)=>sessionStates.get(id)??{...state("ready"),sessionId:id};
const sessionPort={
 prepare:(options:any)=>{expect(options.respectSilentMode).toBe(true);if(options.prewarm&&pressureLimit)decoderLimit=pressureLimit;sessionCalls.push({method:"prepare",...options});const value={...state(options.prewarm?"prewarmed":options.autoplay?"playing":"ready"),sessionId:options.sessionId,hasRenderedFirstFrame:true,presented:!options.prewarm};sessionStates.set(options.sessionId,value);return {result:options.prewarm&&sessionPrepareError?Promise.reject(sessionPrepareError):(!options.prewarm&&sessionCalls.filter(c=>c.method==="prepare"&&!c.prewarm).length>1&&replacementPrepareGate?replacementPrepareGate.then(()=>value):Promise.resolve(value)),cancel(){}};},
 play:async(id:string)=>{const v={...sessionValue(id),state:"playing"};sessionStates.set(id,v);return v;},
 retire:async(id:string)=>{const v={...sessionValue(id),state:"prewarmed",muted:true};sessionStates.set(id,v);return v;},
 pause:async(id:string)=>{const v={...sessionValue(id),state:"paused"};sessionStates.set(id,v);return v;},
 seek:async(id:string,positionMs:number)=>{const v={...sessionValue(id),positionMs};sessionStates.set(id,v);return v;},
 state:async(id:string)=>sessionValue(id),setTransform:async(id:string)=>sessionValue(id),setBounds:async(id:string)=>sessionValue(id),setLoop:async(id:string)=>sessionValue(id),
 promote:async(id:string,options:any)=>{sessionCalls.push({method:"promote",id,...options});const old=sessionValue(options.replaceSessionId);sessionStates.set(options.replaceSessionId,{...old,state:"prewarmed",muted:true});const v={...sessionValue(id),state:"playing",presented:true};sessionStates.set(id,v);return v;},
 transition:async(options:any)=>{sessionCalls.push({method:"transition",...options});return {...options,composited:true};},
 release:async()=>{sessionReleases++;return {released:true};}
};
const [hostLifecycle,setHostLifecycle]=createSignal('active');let sessionsCapable=false,decoderLimit=1,lifecycleState='active';const lifecycleListeners=new Set<(value:string)=>void>();
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}},hasCapability:()=>sessionsCapable,lifecycle:()=>hostLifecycle(),onLifecycleChange:(listener:(value:string)=>void)=>{lifecycleListeners.add(listener);return()=>lifecycleListeners.delete(listener);},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
let debugAllowed=false,diagnosticBindings=0,diagnosticDisposals=0,diagnosticReader:(()=>Promise<unknown>)|undefined;
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{get allowed(){return debugAllowed;},bindSessions(reader:()=>Promise<unknown>){diagnosticBindings++;diagnosticReader=reader;return ()=>{diagnosticDisposals++;};}}}));
let network:(s:InternetStatus)=>void,initial:InternetStatus='available';
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:typeof network)=>{network=fn;fn(initial);return()=>{};}}));
let nativeSequence=0;let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let heldPrepare:Promise<any>|undefined;
let retires=0;let pauses=0,legacyStops=0,sessionReleases=0;const boundsCalls:any[]=[];
const originalNow=Date.now;let fakeNow=originalNow();Date.now=()=>fakeNow;afterAll(()=>{Date.now=originalNow;});
const due=new Map<()=>void,number>();let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,sourceGeneration:nativeSequence,state:name,positionMs:321,durationMs:['idle','stopped'].includes(name)?0:1000,width:100,height:100,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={retire:async()=>{retires++;return current=state("paused");},prepare:(options:any)=>{expect(options.respectSilentMode).toBe(true);nativeSequence++;prepares.push(options);const error=nextError;nextError=undefined;const held=heldPrepare;heldPrepare=undefined;return {result:error?Promise.reject(error):held??Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current={...state('playing'),positionMs:current?.positionMs??0};},pause:async()=>{pauses++;return current=state('paused');},state:async()=>current,seek:async(positionMs:number)=>current={...current,positionMs},stop:async()=>{legacyStops++;current=state('stopped');},setBounds:async(b:any)=>{boundsCalls.push(b);},setTransform:async()=>{},setVolume:async()=>current,setLoop:async()=>current};
const sessionFacade=Object.fromEntries(Object.keys(sessionPort).map(method=>[method,(...args:any[])=>(sessionPort as any)[method](...args)]));
mock.module('@podjs/framework/services',()=>({video,onVideoStateChanged:(fn:any)=>{stateEvents.add(fn);return()=>stateEvents.delete(fn);},onVideoAudioChanged:()=>()=>{},onVideoFirstFrame:(fn:any)=>{frameEvents.add(fn);return()=>frameEvents.delete(fn);},videoSessions:sessionFacade,hostOperation:(method:string)=>{if(method==='runtime.afterPaint')return {result:Promise.resolve({committed:true}),cancel(){}};if(method!=='video.session.capabilities')throw Error('unexpected session operation');return {result:Promise.resolve({decoderLimit,maxSessions:decoderLimit,surfacePromotion:true,verticalTransition:true}),cancel(){}};},delay:(ms:number)=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);due.set(release,fakeNow+ms);return{result,cancel(){ticks=ticks.filter(t=>t!==release);due.delete(release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());nativeSequence=0;ticks=[];frames.length=0;sessionPrepareError=undefined;replacementPrepareGate=undefined;sessionsCapable=false;decoderLimit=1;lifecycleState='active';setHostLifecycle('active');due.clear();});
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return[];return[value,...nodes(value.props.children)];}
function mount(status:InternetStatus,url='https://video/current',immersive=false,platform:'douyin'|'bili'='douyin',recoveryDeadlineMs?:number){
 initial=status;prepares=[];plays=0;retries=0;failures=0;ticks=[];current=state('idle');
 const activeEvents:Array<{source:string|undefined;active:boolean}>=[];
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform,url,title:'current',immersive,recoveryDeadlineMs},width:233,height:233,active:true,offset:0,round:true,onRetry:async()=>{retries++;},onPlaybackFailure:()=>{failures++;},onPlaybackActiveChanged:(source,active)=>activeEvents.push({source,active})});});
 return {activeEvents,text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),press:(label:string)=>{const button=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children===label));expect(button).toBeDefined();button!.props.onPress();}};
}

function reloadMount(source:any={platform:'bili',url:'https://fixture/old',title:'fixture'},resolver?: (p:number,current:()=>boolean,mode?:string)=>Promise<void>,prepareAdjacent?:()=>Promise<undefined>){
 initial='available';prepares=[];legacyStops=0;plays=0;ticks=[];current=state('idle');retries=0;
 let publish!:(v:any)=>void,firstFrames=0,controls:any;
 const root=createRoot(stop=>{stops.push(stop);const [value,set]=createSignal(source);publish=set;return VideoPlayerScreen({get source(){return value();},width:233,height:233,active:true,offset:0,round:true,
 ref:(value:any)=>{controls=value;},onFirstFrame:()=>firstFrames++,onPrepareAdjacent:prepareAdjacent,onReload:async(p:number,current:()=>boolean,mode?:string)=>{retries++;if(resolver)await resolver(p,current,mode);else publish({...value(),url:'https://fixture/new',resumePositionMs:p});}
 } as any);});
 return {reloadAttempts:()=>controls.reloadAttempts?.(),diagnostics:()=>controls.shellState(),nodes:()=>nodes(root),publish,toggle:()=>{const button=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Image'&&/player-(?:pause|play)\.svg$/.test(c.props.src)));expect(button).toBeDefined();button!.props.onPress();},firstFrames:()=>firstFrames,images:()=>nodes(root).filter(n=>n.kind==='Image'&&n.props.src?.includes('video-loading')),text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),retry:()=>{const b=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children==='重试'));expect(b).toBeDefined();b!.props.onPress();}};
}
const lifecycleTo=(s:string)=>{lifecycleState=s;setHostLifecycle(s);lifecycleListeners.forEach(fn=>fn(s));};
const tick=async(ms=400)=>{fakeNow+=ms;const ready=ticks.filter(fn=>(due.get(fn)??Infinity)<=fakeNow);ticks=ticks.filter(fn=>!ready.includes(fn));ready.forEach(fn=>{due.delete(fn);fn();});await flush();stateEvents.forEach(fn=>fn(current));await flush();};
test('RELOAD manual failure forces new resolution, releases native state and restores position',async()=>{
 nextError={code:'restricted'};const f=reloadMount();await flush();f.retry();await flush();
 expect(retries).toBe(1);expect(legacyStops).toBeGreaterThan(0);expect(prepares.at(-1)).toMatchObject({url:'https://fixture/new',resumePositionMs:0,bypassCache:true});
});
test('RELOAD return after signed expiry resolves once and preserves position',async()=>{
 const f=reloadMount({platform:'bili',url:'https://fixture/old?deadline=1700000000',title:'fixture'});await flush();
 lifecycleTo('background');await flush();lifecycleTo('active');await flush();await tick();
 expect(retries).toBe(1);expect(prepares.at(-1)?.resumePositionMs).toBe(321);expect(current.positionMs).toBe(321);
});
test('RELOAD cancelled preparation restarts on foreground',async()=>{
 heldPrepare=new Promise(()=>{});reloadMount();await flush();lifecycleTo('background');await flush();lifecycleTo('active');await flush();
 expect(prepares.length).toBeGreaterThan(1);
});
test('RELOAD only two automatic attempts despite new source objects and first frames',async()=>{
 const f=reloadMount();await flush();
 for(let i=0;i<4;i++){current={...state('error'),errorCode:'source_expired'};await tick();await tick();}
 expect(retries).toBe(2);expect(f.text()).toContain('播放失败');const terminal=f.text();await tick(60_000);expect(retries).toBe(2);expect(f.text()).toBe(terminal);
});
test('RELOAD fetching spinner unsubscribes frames while hidden',async()=>{
 const f=reloadMount({platform:'bili',previewOnly:true,title:'fetching'});await flush();expect(f.text()).toContain('正在获取视频');
 lifecycleTo('background');await flush();expect(f.images()).toHaveLength(0);expect(frames.filter(fn=>frameNeeds.get(fn)?.())).toHaveLength(0);lifecycleTo('active');await flush();expect(f.images()).toHaveLength(2);
});

test('RELOAD reconnecting uses single flight and hides spinner on a resolver error',async()=>{
 let reject!:(e:unknown)=>void;
 nextError={code:'restricted'};
 const f=reloadMount(undefined,async()=>new Promise((_,no)=>reject=no));await flush();f.retry();await flush();
 expect(f.text()).toContain('正在重新连接');expect(f.images()).toHaveLength(2);expect(prepares).toHaveLength(1);
 // A second failure during resolution cannot start another request.
 current={...state('error'),errorCode:'source_expired'};await tick();expect(retries).toBe(1);
 reject({code:'timeout'});await flush();expect(f.images()).toHaveLength(0);expect(f.text()).toContain('播放器准备超时');
 expect(frames.filter(fn=>frameNeeds.get(fn)?.())).toHaveLength(0);
});
test('RELOAD buffering over three seconds shows slow text, readiness removes it',async()=>{
 const f=reloadMount();await flush();expect(f.images()).toHaveLength(0);
 current={...state('buffering'),hasRenderedFirstFrame:true};await tick();expect(f.images()).toHaveLength(2);expect(f.text()).not.toContain('网络较慢');
 await tick(3001);expect(f.text()).toContain('网络较慢');
 current=state('playing');await tick();expect(f.images()).toHaveLength(0);expect(f.text()).not.toContain('网络较慢');
 expect(frames.filter(fn=>frameNeeds.get(fn)?.())).toHaveLength(0);
});
test('RELOAD sessions release all slots before fresh resolution and preserve background position',async()=>{
 sessionsCapable=true;decoderLimit=3;sessionCalls.length=0;sessionReleases=0;
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'fixture',url:'https://fixture/old?x-expires=1700000000',title:'fixture'});await flush();
 lifecycleTo('background');await flush();lifecycleTo('active');await flush();await tick();
 expect(retries).toBe(1);expect(sessionReleases).toBeGreaterThan(0);
 expect(sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm).at(-1)).toMatchObject({url:'https://fixture/new',bypassCache:true});
});
test('RELOAD manual retry after midplay error seeks to last observed position',async()=>{
 const f=reloadMount();await flush();current={...state('playing'),positionMs:678};await tick();
 current={...state('error'),errorCode:'restricted'};await tick();f.retry();await flush();
 expect(prepares.at(-1)?.resumePositionMs).toBe(678);expect(current.positionMs).toBe(678);
});
test('RELOAD resolution timeout ends spinner and ignores a late source publication',async()=>{
 let complete!:()=>void,allow!:(()=>boolean);
 nextError={code:'restricted'};
 const f=reloadMount(undefined,async(_p,current)=>{allow=current;await new Promise<void>(yes=>complete=yes);if(current())f.publish({platform:'bili',url:'https://fixture/late',title:'fixture'});});
 await flush();f.retry();await flush();expect(f.text()).toContain('正在重新连接');
 await tick(20_001);expect(f.text()).toContain('播放器准备超时');expect(allow()).toBe(false);complete();await flush();
 expect(prepares).toHaveLength(1);expect(f.images()).toHaveLength(0);
});
test('RELOAD background cancels a pending resolver and no late prepare occurs',async()=>{
 let complete!:()=>void;
 nextError={code:'restricted'};
 const f=reloadMount(undefined,async(_p,current)=>{await new Promise<void>(yes=>complete=yes);if(current())f.publish({platform:'bili',title:'fixture',url:'https://fixture/late'});});
 await flush();f.retry();await flush();lifecycleTo('background');await flush();complete();await flush();
 expect(prepares).toHaveLength(1);expect(f.images()).toHaveLength(0);
});

test('RELOAD spinner uses a native linear 900ms turn and stops requesting frames when hidden',async()=>{
 const f=reloadMount({platform:'bili',previewOnly:true,title:'fetching'});await flush();
 const arc=f.images().find(n=>n.props.src.includes('arc'))!;
 registerAnimationTheme(pocketConfig.theme);
 try {
   const animation=parseClassLiteral(arc.props.class)?.animation;
   expect(animation?.anims).toHaveLength(1);
   expect(bakedTimelines()[animation!.anims[0]!]).toMatchObject({
     periodFrames:54,iterations:0,delayFrames:0,
     tracks:[{prop:PROP.rotate,segments:[{t0:0,t1:54,from:f32Bits(0),to:f32Bits(360),easing:ENUMS.Easing.Linear}]}],
   });
 } finally {registerAnimationTheme(undefined);}
 expect(frames.filter(fn=>frameNeeds.get(fn)?.())).toHaveLength(0);
 lifecycleTo('background');await flush();expect(f.images()).toHaveLength(0);
});
test('RELOAD a visible loading phase change retains the rotating image and its native timeline',async()=>{
 const {PlayerLoadingIndicator}=await import('../src/ui/PlayerLoadingIndicator.tsx');
 const [phase,setPhase]=createSignal<'fetching'|'preparing'|'buffering'>('fetching');
 const root=createRoot(stop=>{stops.push(stop);return PlayerLoadingIndicator({visible:true,get phase(){return phase();},width:233,height:233});});
 const arc=()=>nodes(root).find(n=>n.props.src?.includes('video-loading-arc'))!;
 const mounted=arc();
 setPhase('preparing');expect(arc()).toBe(mounted);
 setPhase('buffering');expect(arc()).toBe(mounted);
 expect(arc().props.class).toContain('animate-spin');expect(frames).toHaveLength(0);
});
test('RELOAD a background-playing expired stream uses the current native position',async()=>{
 const f=reloadMount({platform:'bili',url:'https://fixture/old?deadline=1700000000',title:'fixture',backgroundPlayback:true});await flush();
 lifecycleTo('background');await flush();current={...state('playing'),positionMs:789};
 lifecycleTo('active');await flush();await tick();
 expect(retries).toBe(1);expect(prepares.at(-1)?.resumePositionMs).toBe(789);expect(current.positionMs).toBe(789);expect(current.state).toBe('playing');
});

test('RELOAD a queued frame from a retired legacy generation cannot complete the new source',async()=>{
 const f=reloadMount();await flush();current={...state('playing'),sourceGeneration:1};await tick();expect(f.firstFrames()).toBe(1);
 current={...state('error'),errorCode:'restricted',sourceGeneration:1};await tick();heldPrepare=new Promise(()=>{});f.retry();await flush();
 frameEvents.forEach(fn=>fn({...state('playing'),sourceGeneration:1,hasRenderedFirstFrame:true}));await flush();
 expect(f.firstFrames()).toBe(1);expect(f.images()).toHaveLength(2);
});
test('RELOAD inactive then background retains the original playback intent',async()=>{
 const f=reloadMount({platform:'bili',url:'https://fixture/old?deadline=1700000000',title:'fixture'});await flush();
 lifecycleTo('inactive');await flush();lifecycleTo('background');await flush();lifecycleTo('active');await flush();await tick();
 expect(retries).toBe(1);expect(current.state).toBe('playing');expect(current.positionMs).toBe(321);
});
test('RELOAD an address first published in background prepares when foreground returns',async()=>{
 const f=reloadMount({platform:'bili',previewOnly:true,title:'fetching'});await flush();lifecycleTo('background');await flush();
 f.publish({platform:'bili',url:'https://fixture/new',title:'fetching'});await flush();expect(prepares).toHaveLength(0);
 lifecycleTo('active');await flush();expect(prepares).toHaveLength(1);expect(current.state).toBe('playing');
});
test('RELOAD wake foreground bounce preserves intent while the first reconnect is cancelled',async()=>{
 const f=reloadMount({platform:'bili',url:'https://fixture/old?deadline=1700000000',title:'fixture'});await flush();
 lifecycleTo('inactive');await flush();lifecycleTo('background');await flush();
 lifecycleTo('active');await flush();lifecycleTo('inactive');await flush();lifecycleTo('background');await flush();
 lifecycleTo('active');await flush();await tick(800);
 expect(retries).toBe(1);expect(current.state).toBe('playing');expect(current.positionMs).toBe(321);
});

test('RELOAD explicit pause stays paused after an expired source reconnects',async()=>{
 const f=reloadMount({platform:'bili',url:'https://fixture/old?deadline=1700000000',title:'fixture'});await flush();f.toggle();await flush();expect(current.state).toBe('paused');
 lifecycleTo('inactive');await flush();lifecycleTo('background');await flush();lifecycleTo('active');await flush();await tick(800);
 expect(retries).toBe(1);expect(current.state).toBe('ready');expect(plays).toBe(1);
});

test('RELOAD preserves the HEVC decoder failure signal before resolving a replacement',async()=>{
 const {douyinCodecRuntimePolicy}=await import('../src/douyin/playback-selector.ts');
 const failure=spyOn(douyinCodecRuntimePolicy,'recordAutoHevcFailure');
 try{nextError={code:'decode_error'};reloadMount({platform:'douyin',url:'https://fixture/hevc',title:'fixture',videoMime:'video/hevc'});await flush();expect(failure).toHaveBeenCalledTimes(1);await tick();expect(retries).toBe(1);}finally{failure.mockRestore();}
});
test('RELOAD a cancelled resolver for the still-active video ends in retryable error',async()=>{
 nextError={code:'restricted'};const f=reloadMount(undefined,async()=>{throw {code:'CANCELLED'};});await flush();f.retry();await flush();
 expect(f.text()).toContain('播放失败');expect(f.images()).toHaveLength(0);
});

test('REVIEW error retry and its message form a centered group on the round viewport',async()=>{
 nextError={code:'restricted'};const f=reloadMount();await flush();
 const retry=f.nodes().find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children==='重试'))!;
 const group=f.nodes().find(n=>n.kind==='View'&&n!==retry&&nodes(n.props.children).includes(retry)&&n.props.class?.includes('rounded-[24]'))!;
 const px=(n:Node,style:string,css:string,fallback=0)=>n.props.style?.[style]??Number(n.props.class?.match(new RegExp(css+'-\\[(-?[0-9.]+)\\]'))?.[1]??fallback);
 const groupWidth=px(group,'width','w',233-px(group,'insetL','left')-px(group,'insetR','right'));
 const buttonLeft=px(group,'insetL','left')+px(retry,'insetL','left');
 expect(buttonLeft+px(retry,'width','w')/2).toBeCloseTo(233/2);
 const message=nodes(group.props.children).find(n=>n.kind==='Text'&&String(n.props.children).includes('视频播放失败'))!;
 const contentTop=px(group,'insetT','top')+px(message,'insetT','top');
 const contentBottom=px(group,'insetT','top')+px(retry,'insetT','top')+px(retry,'height','h');
 expect((contentTop+contentBottom)/2).toBeCloseTo(233/2);expect(groupWidth).toBeLessThan(233);
});
test('REVIEW unknown duration never mounts timeline or placeholder time during reconnect',async()=>{
 heldPrepare=new Promise(()=>{});const f=reloadMount();await flush();
 expect(f.text()).not.toContain('--:--');
 expect(f.nodes().filter(n=>n.kind==='View'&&n.props.class?.includes('bg-[#ff6700]')&&n.props.class?.includes('h-[4]'))).toHaveLength(0);
});
test('REVIEW cancelled reconnect resumes with fresh resolution instead of reusing the rejected URL',async()=>{
 nextError={code:'restricted'};let finish!:()=>void;let f:ReturnType<typeof reloadMount>;
 f=reloadMount(undefined,async(p,current)=>{if(retries===1)await new Promise<void>(yes=>finish=yes);if(current())f.publish({platform:'bili',title:'fixture',url:'https://fixture/fresh-'+retries,resumePositionMs:p});});await flush();f.retry();await flush();expect(retries).toBe(1);
 lifecycleTo('background');await flush();finish();await flush();lifecycleTo('active');await flush();await tick(800);
 expect(retries).toBe(2);expect(prepares.at(-1)?.url).toBe('https://fixture/fresh-2');
});

test('REVIEW retired first-frame events cannot complete a reconnect still resolving its address',async()=>{
 nextError={code:'restricted'};const f=reloadMount(undefined,()=>new Promise(()=>{}));await flush();f.retry();await flush();expect(f.firstFrames()).toBe(0);
 frameEvents.forEach(fn=>fn({...state('playing'),sourceGeneration:5,hasRenderedFirstFrame:true}));await flush();expect(f.firstFrames()).toBe(0);expect(f.images()).toHaveLength(2);
});
test('REVIEW slow preparation reports a stalled load without publishing transient READY state',async()=>{
 heldPrepare=new Promise(()=>{});const f=reloadMount();await flush();expect(f.text()).not.toContain('网络较慢');await tick(3001);
 expect(f.images()).toHaveLength(2);expect(f.text()).toContain('网络较慢');expect(f.firstFrames()).toBe(0);
});

test('REVIEW adopted buffering result keeps productive first-frame preparation alive',async()=>{
 const pending={...state('buffering'),sourceGeneration:1,positionMs:0,hasRenderedFirstFrame:false,playWhenReady:true,nativePlaybackState:2,loading:true,bufferedMs:0,metrics:{bytesLoaded:0}};
 heldPrepare=Promise.resolve(pending);
 const play=spyOn(video,'play').mockImplementation(async()=>current=pending);
 try{
  const f=reloadMount({platform:'douyin',immersive:true,awemeId:'pending-adoption',url:'https://fixture/pending.mp4',title:'fixture'});await flush();
  for(let second=1;second<=30;second++){
   current={...current,metrics:{bytesLoaded:second*50_000}};stateEvents.forEach(fn=>fn(current));await tick(1000);
  }
  expect(f.firstFrames()).toBe(0);expect(retries).toBe(0);expect(prepares).toHaveLength(1);
  // The same 20-second idle limit still applies once transport stops moving.
  await tick(19999);expect(retries).toBe(0);await tick(1);await tick(351);expect(retries).toBe(1);
 }finally{play.mockRestore();}
});

for(const suspension of [['inactive'],['inactive','background']] as const)test(`DYENTRY same Douyin session resumes after ${suspension.join(' then ')}`,async()=>{
 sessionsCapable=true;decoderLimit=3;
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'dyentry-current',url:'file:///fixture/current.mp4',title:'fixture'});await flush();
 const foreground=sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm).at(-1)!;
 expect(foreground.url).toBe('file:///fixture/current.mp4');
 const id=foreground.sessionId;expect(sessionValue(id).state).toBe('playing');
 current={...sessionValue(id),positionMs:678};sessionStates.set(id,current);await tick();
 const prepareCount=sessionCalls.filter(c=>c.method==='prepare').length;
 for(const state of suspension){lifecycleTo(state);await flush();}
 expect(sessionReleases).toBeGreaterThan(0);
 lifecycleTo('active');await flush();await tick();
 expect(retries).toBe(0);expect(sessionCalls.filter(c=>c.method==='prepare')).toHaveLength(prepareCount+1);
 const resumed=sessionCalls.filter(c=>c.method==='prepare'&&!c.prewarm).at(-1)!;
 expect(resumed.url).toBe(foreground.url);
 expect(sessionValue(resumed.sessionId)).toMatchObject({state:'playing',positionMs:678});
 expect(f.text()).not.toContain('播放失败');
});


test('NETOVERLAY actual native failure waits for offline recovery and prepares exactly once after online',async()=>{
 const {NetworkRecovery}=await import('../src/network/recovery.ts');
 const {NetworkRecoveryContext}=await import('../src/network/context.ts');
 let changed!:(s:any)=>void;
 const scope=new NetworkRecovery({observe:fn=>{changed=fn;fn('unavailable');return()=>{};},check:async()=> 'unavailable'});scope.setActive(true);
 initial='unavailable';prepares=[];plays=0;nextError={code:'network_error'};current=state('idle');
 createRoot(stop=>{stops.push(stop);return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return VideoPlayerScreen({source:{platform:'rss',url:'https://fixture.invalid/current',title:'fixture'},width:233,height:233,active:true,offset:0,round:true});}});});
 await flush();expect(scope.blocking).toBe(true);expect(prepares).toHaveLength(1);
 changed('available');await flush();expect(scope.blocking).toBe(false);expect(prepares).toHaveLength(2);expect(plays).toBe(1);
 changed('unavailable');changed('available');await flush();expect(prepares).toHaveLength(2);scope.dispose();
});
test('NETOVERLAY cached native prefix keeps playing while offline without a request failure',async()=>{
 const {NetworkRecovery}=await import('../src/network/recovery.ts');const {NetworkRecoveryContext}=await import('../src/network/context.ts');
 const scope=new NetworkRecovery({observe:fn=>{fn('unavailable');return()=>{};},check:async()=> 'unavailable'});scope.setActive(true);
 prepares=[];plays=0;nextError=undefined;current=state('idle');
 createRoot(stop=>{stops.push(stop);return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return VideoPlayerScreen({source:{platform:'douyin',immersive:true,url:'podjs-media-cache://fixture',title:'fixture'},width:233,height:233,active:true,offset:0,round:true});}});});
 await flush();expect(scope.blocking).toBe(false);expect(prepares).toHaveLength(1);expect(plays).toBe(1);scope.dispose();
});

test('NETOVERLAY second native prepare failure keeps its original error without rearming offline recovery',async()=>{
 const {NetworkRecovery}=await import('../src/network/recovery.ts');const {NetworkRecoveryContext}=await import('../src/network/context.ts');
 let changed!:(s:any)=>void;
 const scope=new NetworkRecovery({observe:fn=>{changed=fn;fn('unavailable');return()=>{};},check:async()=> 'unavailable'});scope.setActive(true);
 prepares=[];plays=0;nextError={code:'network_error'};current=state('idle');
 const root=createRoot(stop=>{stops.push(stop);return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return VideoPlayerScreen({source:{platform:'rss',url:'https://fixture.invalid/current',title:'fixture'},width:233,height:233,active:true,offset:0,round:true});}});});
 await flush();expect(scope.blocking).toBe(true);nextError={code:'network_error'};
 changed('available');await flush();expect(scope.blocking).toBe(false);expect(prepares).toHaveLength(2);expect(plays).toBe(0);
 expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('')).toContain('播放失败');
 changed('unavailable');changed('available');await flush();expect(prepares).toHaveLength(2);scope.dispose();
});

test('NETOVERLAY re-resolved native source shares the one automatic network retry budget',async()=>{
 const {NetworkRecovery}=await import('../src/network/recovery.ts');const {NetworkRecoveryContext}=await import('../src/network/context.ts');
 let changed!:(s:any)=>void,checks=0,resolutions=0;
 const scope=new NetworkRecovery({observe:fn=>{changed=fn;fn('unavailable');return()=>{};},check:async()=>{checks++;return 'unavailable';}});scope.setActive(true);
 prepares=[];plays=0;nextError={code:'network_error'};current=state('idle');
 const root=createRoot(stop=>{stops.push(stop);const [source,setSource]=createSignal({platform:'rss' as const,url:'https://fixture.invalid/current',title:'fixture'});return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return createComponent(VideoPlayerScreen,{get source(){return source();},width:233,height:233,active:true,offset:0,round:true,onReload:async()=>{resolutions++;setSource({...source(),url:'https://fixture.invalid/refreshed'});}});}});});
 await flush();expect(scope.blocking).toBe(true);nextError={code:'network_error'};
 changed('available');await flush();expect(scope.blocking).toBe(false);expect(prepares).toHaveLength(2);expect(resolutions).toBe(1);expect(checks).toBe(1);
 expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('')).toContain('网络连接失败，请检查网络后重试');scope.dispose();
});

test('NETOVERLAY direct Bluetooth media loading shows an advisory without blocking cached playback',async()=>{
 const {NetworkRecovery}=await import('../src/network/recovery.ts');const {NetworkRecoveryContext}=await import('../src/network/context.ts');
 const scope=new NetworkRecovery({observe:fn=>{fn('bluetooth');return()=>{};},check:async()=> 'bluetooth'});scope.setActive(true);stops.push(()=>scope.dispose());
 prepares=[];plays=0;nextError=undefined;current=state('idle');
 createRoot(stop=>{stops.push(stop);return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return createComponent(VideoPlayerScreen,{source:{platform:'douyin',immersive:true,url:'podjs-media-cache://fixture',title:'fixture'},width:233,height:233,active:true,offset:0,round:true});}});});
 await flush();expect(plays).toBe(1);expect(prepares).toHaveLength(1);expect(scope.blocking).toBe(false);expect(scope.bluetooth).toBe(true);
});
test('NOPLAY a rendered but nonloading buffered player gets a bounded normal reload',async()=>{
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'buffered-stall',url:'file:///fixture/stall.mp4',title:'fixture'});await flush();
 current={...state('paused'),positionMs:1,durationMs:571745,hasRenderedFirstFrame:true,playWhenReady:true,nativePlaybackState:2,isBuffering:true,loading:false,bufferedMs:4156};
 stateEvents.forEach(fn=>fn(current));await flush();await tick(19999);expect(retries).toBe(0);
 await tick(1);await tick(351);expect(retries).toBe(1);expect(prepares.at(-1)).toMatchObject({bypassCache:true,resumePositionMs:1});
});
test('NOPLAY a fresh native progress read cancels a stale buffered stall observation',async()=>{
 reloadMount({platform:'douyin',immersive:true,awemeId:'fresh-progress',url:'file:///fixture/stall.mp4',title:'fixture'});await flush();
 current={...state('paused'),positionMs:1,durationMs:571745,hasRenderedFirstFrame:true,playWhenReady:true,nativePlaybackState:2,isBuffering:true,loading:false,bufferedMs:4156};
 stateEvents.forEach(fn=>fn(current));await flush();
 // The native player progresses even if an intermediate push is coalesced.
 current={...current,state:'playing',nativePlaybackState:3,positionMs:2000};await tick(20000);await tick(351);expect(retries).toBe(0);
});

test('NOPLAY buffered-stall recovery keeps the two-attempt budget and an explicit reload counter',async()=>{
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'bounded-stall',url:'file:///fixture/stall.mp4',title:'fixture'});await flush();
 for(let i=0;i<3;i++){
  current={...state('paused'),positionMs:1,durationMs:571745,hasRenderedFirstFrame:true,playWhenReady:true,nativePlaybackState:2,isBuffering:true,loading:false,bufferedMs:4156};stateEvents.forEach(fn=>fn(current));await flush();
  await tick(20000);await tick(701);
  expect(retries).toBe(Math.min(i+1,2));
  if(i<2)expect((await f.diagnostics()).reloadCount).toBe(i+1);
 }
 expect(f.text()).toContain('播放失败');await tick(60000);expect(retries).toBe(2);
});

test('NOPLAY an automatic Douyin resolution timeout uses the remaining bounded retry',async()=>{
 nextError={code:'prepare_failed'};let f:ReturnType<typeof reloadMount>;
 f=reloadMount({platform:'douyin',immersive:true,awemeId:'resolve-timeout',url:'https://fixture/current',title:'fixture'},async(position,current)=>{
  if(retries===1)await new Promise<void>(()=>{});
  if(current())f.publish({platform:'douyin',immersive:true,awemeId:'resolve-timeout',url:'https://fixture/fresh',title:'fixture',resumePositionMs:position});
 });
 await flush();await tick(351);expect(retries).toBe(1);await tick(20001);await tick(701);
 expect(retries).toBe(2);expect(prepares.at(-1)?.url).toBe('https://fixture/fresh');expect(f.text()).not.toContain('播放失败');
});
test('NOPLAY repeated automatic resolver timeouts exhaust exactly two attempts',async()=>{
 nextError={code:'prepare_failed'};
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'resolve-bounded',url:'https://fixture/current',title:'fixture'},()=>new Promise(()=>{}));
 await flush();await tick(351);expect(retries).toBe(1);await tick(20001);await tick(701);expect(retries).toBe(2);
 await tick(20001);expect(f.text()).toContain('播放器准备超时');await tick(60000);expect(retries).toBe(2);
});

test('NOPLAY reload attempts remain readable while the resolver has no native state',async()=>{
 nextError={code:'prepare_failed'};
 const f=reloadMount({platform:'douyin',immersive:true,awemeId:'resolve-count',url:'https://fixture/current',title:'fixture'},()=>new Promise(()=>{}));
 await flush();await tick(351);expect(f.reloadAttempts()).toBe(1);await tick(20001);await tick(701);expect(f.reloadAttempts()).toBe(2);
});

test('NOPLAY only an automatic unexpired Douyin timeout may retry the current source',async()=>{
 for(const [expiry,reuse]of [[4102444800,true],[1000000000,false]]as const){
  nextError={code:'timeout'};let f:ReturnType<typeof reloadMount>;const flags:unknown[]=[];
  f=reloadMount({platform:'douyin',immersive:true,awemeId:'retry-current-'+expiry,url:'https://fixture/current?x-expires='+expiry,title:'fixture'},async(position,current,retryCurrent)=>{flags.push(retryCurrent);if(current())f.publish({platform:'douyin',immersive:true,awemeId:'retry-current-'+expiry,url:'https://fixture/valid',title:'fixture',resumePositionMs:position});});
  await flush();await tick(351);expect(flags).toEqual([reuse?'current':'feed']);
 }
});

test('foreground resource failure page retries the same video until the decoder recovers',async()=>{
 const source={platform:'douyin',immersive:true,awemeId:'resource',url:'file:///fixture/resource.mp4',title:'fixture'};
 nextError={code:'decoder_admission_deferred'};
 const player=reloadMount(source);
 await flush();
 expect(player.text()).toContain('播放器资源不足');
 expect(prepares).toHaveLength(1);
 expect(retries).toBe(0);

 nextError={code:'decoder_admission_deferred'};
 await tick(1000);
 expect(player.text()).toContain('播放器资源不足');
 expect(prepares).toHaveLength(2);
 await tick(1999);expect(prepares).toHaveLength(2);
 await tick(1);
 expect(player.text()).not.toContain('播放器资源不足');
 expect(current.state).toBe('playing');
 expect(prepares.map(value=>value.url)).toEqual([source.url,source.url,source.url]);
 expect(retries).toBe(0);
 await tick(30_000);expect(prepares).toHaveLength(3);
});

test('changing sources cancels the pending decoder retry',async()=>{
 const source={platform:'douyin',immersive:true,awemeId:'old-resource',url:'file:///fixture/old.mp4',title:'fixture'};
 nextError={code:'decoder_admission_deferred'};
 const player=reloadMount(source);
 await flush();
 player.publish({...source,awemeId:'new-resource',url:'file:///fixture/new.mp4'});
 await flush();
 await tick(30_000);
 expect(prepares.map(value=>value.url)).toEqual([source.url,'file:///fixture/new.mp4']);
 expect(retries).toBe(0);
});

test('a deferred decoder at the prepare deadline retries without resolving a new source',async()=>{
 const source={platform:'douyin',immersive:true,awemeId:'deadline-resource',url:'file:///fixture/deadline.mp4',title:'fixture'};
 heldPrepare=new Promise(()=>{});
 const player=reloadMount(source);
 await flush();
 current={...state('preparing'),decoderAdmissionDeferred:true};
 stateEvents.forEach(listener=>listener(current));
 await flush();
 await tick(20_000);
 expect(player.text()).toContain('播放器资源不足');
 expect(retries).toBe(0);
 await tick(1000);
 expect(prepares.map(value=>value.url)).toEqual([source.url,source.url]);
 expect(current.state).toBe('playing');
 expect(player.text()).not.toContain('播放器资源不足');
});

test('decoder retry pauses in the background and resumes in the foreground',async()=>{
 const source={platform:'douyin',immersive:true,awemeId:'suspend-resource',url:'file:///fixture/suspend.mp4',title:'fixture'};
 nextError={code:'decoder_admission_deferred'};
 const player=reloadMount(source);
 await flush();
 lifecycleTo('background');
 await tick(30_000);
 expect(prepares).toHaveLength(1);
 lifecycleTo('active');
 await tick(999);
 expect(prepares).toHaveLength(1);
 await tick(1);
 expect(prepares).toHaveLength(2);
 expect(current.state).toBe('playing');
 expect(player.text()).not.toContain('播放器资源不足');
 expect(retries).toBe(0);
});

test('session decoder admission recovery keeps the session backend and same source',async()=>{
 const source={platform:'douyin',immersive:true,awemeId:'session-resource',url:'file:///fixture/session.mp4',title:'fixture'};
 sessionsCapable=true;decoderLimit=2;sessionCalls.length=0;sessionStates.clear();
 const original=sessionPort.prepare;
 let deny=true;
 sessionPort.prepare=(options:any)=>{
  const result=original(options);
  return deny&&!options.prewarm ? {...result,result:Promise.reject({code:'resource_exhausted'})} : result;
 };
 try{
  const player=reloadMount(source);
  await flush();
  expect(player.text()).toContain('播放器资源不足');
  expect(prepares).toHaveLength(0);
  deny=false;
  await tick(1000);
  expect(sessionCalls.filter(call=>call.method==='prepare'&&!call.prewarm).map(call=>call.url)).toEqual([source.url,source.url]);
  expect((await player.diagnostics()).state).toBe('playing');
  expect(player.text()).not.toContain('播放器资源不足');
  expect(prepares).toHaveLength(0);
  expect(retries).toBe(0);
 }finally{sessionPort.prepare=original;}
});

test('manual Douyin retry selects detail resolution',async()=>{
 nextError={code:'restricted'};
 const source={platform:'douyin',immersive:true,awemeId:'manual',url:'https://fixture.invalid/old',title:'fixture'};
 const modes:unknown[]=[];
 const player=reloadMount(source,async(_position,_current,mode)=>{modes.push(mode);throw {code:'RATE_LIMITED'};});
 await flush();player.retry();await flush();
 expect(modes).toEqual(['detail']);
});
test('manual local resource retry keeps the selected source and requests cache-only native preparation',async()=>{
 for(const cause of [{code:'video_decoder_limit'},{name:'ByteAdmissionDenied'},{code:'resource_exhausted'}]){
  nextError=cause;
  const source={platform:'douyin',immersive:true,awemeId:'manual-resource',url:'podjs-media-cache://play/fixture',title:'fixture',bypassCache:true};
  let adjacent=0;const player=reloadMount(source,undefined,async()=>{adjacent++;return undefined;});
  await flush();expect(player.text()).toContain('播放器资源不足');
  player.retry();await flush();
  expect(prepares).toHaveLength(2);
  expect(prepares[1]).toMatchObject({url:source.url,cacheOnlyPrepare:true,bypassCache:false});
  expect(retries).toBe(0);
  await tick(1000);expect(prepares).toHaveLength(2);expect(adjacent).toBe(0);
 }
});

test('resource cache miss stays on the same video without scheduling a feed or detail request',async()=>{
 nextError={code:'video_retry_cache_miss'};
 const source={platform:'douyin',immersive:true,awemeId:'cache-miss',url:'https://fixture.invalid/clip',title:'fixture'};
 const player=reloadMount(source);
 await flush();expect(player.text()).toContain('当前视频缓存不足');
 await tick(20_000);expect(retries).toBe(0);expect(prepares).toHaveLength(1);
 nextError={code:'video_retry_cache_miss'};
 player.retry();await flush();
 expect(prepares[1]).toMatchObject({url:source.url,cacheOnlyPrepare:true,bypassCache:false});
 expect(retries).toBe(0);expect(player.text()).toContain('当前视频缓存不足');
});
test('a failed fresh manual detail prepare does not fall through to the recommendation feed',async()=>{
 nextError={code:'restricted'};
 const source={platform:'douyin',immersive:true,awemeId:'manual-failed',url:'https://fixture.invalid/old',title:'fixture'};
 const modes:unknown[]=[];
 const player=reloadMount(source,async(_position,current,mode)=>{
  modes.push(mode);
  nextError={code:'source_expired'};
  if(current())player.publish({...source,url:'https://fixture.invalid/fresh'});
 });
 await flush();player.retry();await flush();await tick(3000);
 expect(modes).toEqual(['detail']);
 expect(player.text()).toContain('重试');
});

test('PERFVIDEO repeated resource denial exhausts the finite cache-only retry budget',async()=>{
 nextError={code:'resource_exhausted'};
 const source={platform:'douyin',immersive:true,awemeId:'retry-budget',url:'file:///fixture.mp4',title:'fixture'};
 const player=reloadMount(source);
 await flush();
 for(const ms of [1000,2000,4000,8000,8000,8000]){
  nextError={code:'resource_exhausted'};
  await tick(ms);
 }
 console.info('PERFVIDEO permanent resource denial native prepares',prepares.length);
 expect(prepares).toHaveLength(3);
 expect(prepares.slice(1).every(options=>options.cacheOnlyPrepare===true)).toBe(true);
 expect(player.text()).toContain('重试');
 expect(retries).toBe(0);
 nextError=undefined;
});
