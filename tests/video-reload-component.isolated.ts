import { afterEach, afterAll, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
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
const frameEvents=new Set<(value:any)=>void>();
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
let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let heldPrepare:Promise<any>|undefined;
let retires=0;let pauses=0,legacyStops=0,sessionReleases=0;const boundsCalls:any[]=[];
const originalNow=Date.now;let fakeNow=originalNow();Date.now=()=>fakeNow;afterAll(()=>{Date.now=originalNow;});
const due=new Map<()=>void,number>();let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,state:name,positionMs:321,durationMs:1000,width:100,height:100,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={retire:async()=>{retires++;return current=state("paused");},prepare:(options:any)=>{expect(options.respectSilentMode).toBe(true);prepares.push(options);const error=nextError;nextError=undefined;const held=heldPrepare;heldPrepare=undefined;return {result:error?Promise.reject(error):held??Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current={...state('playing'),positionMs:current?.positionMs??0};},pause:async()=>{pauses++;return current=state('paused');},state:async()=>current,seek:async(positionMs:number)=>current={...current,positionMs},stop:async()=>{legacyStops++;current=state('stopped');},setBounds:async(b:any)=>{boundsCalls.push(b);},setTransform:async()=>{},setVolume:async()=>current,setLoop:async()=>current};
const sessionFacade=Object.fromEntries(Object.keys(sessionPort).map(method=>[method,(...args:any[])=>(sessionPort as any)[method](...args)]));
mock.module('@podjs/framework/services',()=>({video,onVideoAudioChanged:()=>()=>{},onVideoFirstFrame:(fn:any)=>{frameEvents.add(fn);return()=>frameEvents.delete(fn);},videoSessions:sessionFacade,hostOperation:(method:string)=>{if(method==='runtime.afterPaint')return {result:Promise.resolve({committed:true}),cancel(){}};if(method!=='video.session.capabilities')throw Error('unexpected session operation');return {result:Promise.resolve({decoderLimit,maxSessions:decoderLimit,surfacePromotion:true,verticalTransition:true}),cancel(){}};},delay:(ms:number)=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);due.set(release,fakeNow+ms);return{result,cancel(){ticks=ticks.filter(t=>t!==release);due.delete(release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());ticks=[];frames.length=0;sessionPrepareError=undefined;replacementPrepareGate=undefined;sessionsCapable=false;decoderLimit=1;lifecycleState='active';setHostLifecycle('active');due.clear();});
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return[];return[value,...nodes(value.props.children)];}
function mount(status:InternetStatus,url='https://video/current',immersive=false,platform:'douyin'|'bili'='douyin',recoveryDeadlineMs?:number){
 initial=status;prepares=[];plays=0;retries=0;failures=0;ticks=[];current=state('idle');
 const activeEvents:Array<{source:string|undefined;active:boolean}>=[];
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform,url,title:'current',immersive,recoveryDeadlineMs},width:233,height:233,active:true,offset:0,round:true,onRetry:async()=>{retries++;},onPlaybackFailure:()=>{failures++;},onPlaybackActiveChanged:(source,active)=>activeEvents.push({source,active})});});
 return {activeEvents,text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),press:(label:string)=>{const button=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children===label));expect(button).toBeDefined();button!.props.onPress();}};
}

function reloadMount(source:any={platform:'bili',url:'https://fixture/old',title:'fixture'},resolver?: (p:number,current:()=>boolean)=>Promise<void>){
 initial='available';prepares=[];legacyStops=0;plays=0;ticks=[];current=state('idle');retries=0;
 let publish!:(v:any)=>void;
 const root=createRoot(stop=>{stops.push(stop);const [value,set]=createSignal(source);publish=set;return VideoPlayerScreen({get source(){return value();},width:233,height:233,active:true,offset:0,round:true,
 onReload:async(p:number,current:()=>boolean)=>{retries++;if(resolver)await resolver(p,current);else publish({...value(),url:'https://fixture/new',resumePositionMs:p});}
 } as any);});
 return {publish,images:()=>nodes(root).filter(n=>n.kind==='Image'&&n.props.src?.includes('video-loading')),text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),retry:()=>{const b=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children==='重试'));expect(b).toBeDefined();b!.props.onPress();}};
}
const lifecycleTo=(s:string)=>{lifecycleState=s;setHostLifecycle(s);lifecycleListeners.forEach(fn=>fn(s));};
const tick=async(ms=400)=>{fakeNow+=ms;const ready=ticks.filter(fn=>(due.get(fn)??Infinity)<=fakeNow);ticks=ticks.filter(fn=>!ready.includes(fn));ready.forEach(fn=>{due.delete(fn);fn();});await flush();};
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

test('RELOAD spinner makes a uniform 900ms turn and owns no visible frames after suspension',async()=>{
 const f=reloadMount({platform:'bili',previewOnly:true,title:'fetching'});await flush();
 const rotation=()=>f.images().find(n=>n.props.src.includes('arc'))!.props.style.rotate;
 fakeNow+=225;frames.filter(fn=>frameNeeds.get(fn)?.()).forEach(fn=>fn());expect(rotation()).toBe(90);
 fakeNow+=675;frames.filter(fn=>frameNeeds.get(fn)?.()).forEach(fn=>fn());expect(rotation()).toBe(0);
 lifecycleTo('background');await flush();expect(frames.filter(fn=>frameNeeds.get(fn)?.())).toHaveLength(0);
});
