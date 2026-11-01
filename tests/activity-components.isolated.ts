import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solidRuntime from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup,Show} from 'solid-js';
import {createScrollerWith} from '/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/kinetics-core.ts';
import {captureActivityNavigation,restoreActivityNavigation,routeMemory,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
// Match production's single-Solid alias for the file-linked framework.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solidRuntime);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'activity-recreation-solid',setup(builder){builder.onLoad({filter:/\/ui\/(route-activity|ScrollEntries|AddRssScreen|VideoPlayerScreen|NoteInlineEditor|NotesScreen)\.tsx$|\/variable-list\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
// Keep the production Solid owner/effect graph and scroller state machine.
// Only native rendering and hardware registration are replaced at their boundaries.
type Node={kind:string;props:Record<string,any>};
const element=(kind:string)=>(props:Node['props']):Node=>{
 const children='children' in props?createMemo(()=>props.children):undefined;
 return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};
};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),gestures=new Set<any>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:any)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));return {dispose(){}};}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(opts:any)=>createScrollerWith(createSignal,opts),bindDpadScroll:()=>{}}));
mock.module('@pocketjs/framework/input',()=>({pressNode:()=>{},hitNode:()=>undefined}));
// Restoration fixtures below use rectangular display geometry. Round fitting
// is covered separately with a full display/viewport contract in U11.
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,shape:'rect',safeInsets:{left:0,right:0,top:0,bottom:0}}),hasCapability:()=>false,__onHostEvent:()=>()=>{},getFontMetrics:()=>undefined,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>n,kv:{get:()=>undefined,set(){},delete(){}}}));
const {RouteActivityProvider,restoredSignal,booleanState,stringState}=await import('../src/ui/route-activity.tsx');
const {ScrollEntries}=await import('../src/ui/ScrollEntries.tsx');
const {AddRssScreen}=await import('../src/ui/AddRssScreen.tsx');
const disposers:Array<()=>void>=[];
afterEach(()=>{for(const d of disposers.splice(0))d();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);});
const frame=()=>{for(const cb of [...frames])cb();};
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return [];return [value,...nodes(value.props.children)];}
function mount(entry:ActivityRoute,content:()=>unknown){
 const checkpoints=new Set<()=>void>(),scrollSlots=new Set<number>();let changed=0,dispose!:()=>void;
 const root=createRoot(stop=>{dispose=stop;disposers.push(stop);return createComponent(RouteActivityProvider,{entry,changed:()=>changed++,checkpoints,scrollSlots,get children(){return content();}} as never);});
 return {root,checkpoints,scrollSlots,dispose,changed:()=>changed,checkpoint:()=>{for(const cb of checkpoints)cb();},press:(label:string)=>nodes(root).find(n=>n.props.accessibilityLabel===label)!.props.onPress(),text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n')};
}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function recreate(entry:ActivityRoute,process=false){const captured=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},entry]);return restoreActivityNavigation(clone(process?{saved:captured.saved,retained:{}}:captured))!.at(-1)!;}

test('production Context restores saved signals for process loss and retained drafts for configuration only',()=>{
 const e:ActivityRoute={page:'add-rss'};let expanded:any,draft:any;
 const first=mount(e,()=>{expanded=restoredSignal('saved','expanded',false,booleanState);draft=restoredSignal('retained','draft','initial',stringState);return null;});
 expanded[1](true);draft[1]('unsubmitted draft');expect(first.changed()).toBe(2);first.dispose();
 mount(recreate(e),()=>{expanded=restoredSignal('saved','expanded',false,booleanState);draft=restoredSignal('retained','draft','initial',stringState);return null;});
 expect(expanded[0]()).toBe(true);expect(draft[0]()).toBe('unsubmitted draft');
 mount(recreate(e,true),()=>{expanded=restoredSignal('saved','expanded',false,booleanState);draft=restoredSignal('retained','draft','initial',stringState);return null;});
 expect(expanded[0]()).toBe(true);expect(draft[0]()).toBe('initial');
});

test('production ScrollEntries restores late rows, yields to touch, and reuses its slot after conditional remount',()=>{
 const e:ActivityRoute={page:'notes'};routeMemory(e).saved['scroll:0']=300;
 const [rows,setRows]=createSignal<any[]>([]),[show,setShow]=createSignal(true);let scroller:any;
 const f=mount(e,()=>createComponent(Show,{get when(){return show();},get children(){return createComponent(ScrollEntries,{height:100,get entries(){return rows();},gap:0,padding:0,ref:v=>scroller=v.scroller});}} as never));
 frame();expect(scroller.offset()).toBe(0);f.checkpoint();expect(routeMemory(e).saved['scroll:0']).toMatchObject({version:1,offset:300});
 setRows([{height:180,render:()=>null}]);frame();expect(scroller.offset()).toBe(80);
 setRows([{height:700,render:()=>null}]);frame();expect(scroller.offset()).toBe(300);
 scroller.scrollTo(410,{immediate:true});f.checkpoint();expect(routeMemory(e).saved['scroll:0']).toMatchObject({version:1,offset:410});
 setShow(false);expect(f.scrollSlots.size).toBe(0);setShow(true);frame();expect(scroller.offset()).toBe(410);expect(f.scrollSlots.size).toBe(1);
 // A still-pending restoration must not override a new touch command.
 setShow(false);routeMemory(e).saved['scroll:0']=590;setRows([{height:200,render:()=>null}]);setShow(true);frame();expect(scroller.offset()).toBe(100);
 [...gestures][0].onDown();scroller.scrollTo(40,{immediate:true});setRows([{height:900,render:()=>null}]);frame();expect(scroller.offset()).toBe(40);
 f.dispose();expect(f.checkpoints.size).toBe(0);expect(f.scrollSlots.size).toBe(0);
 const restored=recreate(e,true);let next:any;
 mount(restored,()=>createComponent(ScrollEntries,{height:100,entries:[{height:900,render:()=>null}],gap:0,padding:0,ref:v=>next=v.scroller}));frame();expect(next.offset()).toBe(40);
});

test('production indexed ScrollEntries keeps a pending local image owner across layout publications and size reflow',()=>{
 const key={},scope={},[height,setHeight]=createSignal(260);let mounts=0,releases=0,observed=0;
 const Image=()=>{mounts++;onCleanup(()=>releases++);return element('Image')({get height(){observed=height();return observed;}});};
 const render=()=>createComponent(Image as any,{}),[rows,setRows]=createSignal([{key,top:0,height:260,render}]);
 const source=createMemo(()=>({entries:rows(),indices:new Map([[key,0]]),scope}));
 const f=mount({page:'note-detail'},()=>createComponent(ScrollEntries,{height:233,entries:[],get indexedEntries(){return source();},gap:0,padding:0}));
 for(let i=0;i<9;i++)setRows([{key,top:i,height:260,render}]);
 expect(mounts).toBe(1);expect(releases).toBe(0);
 setHeight(140);setRows([{key,top:9,height:140,render}]);
 const image=nodes(f.root).find(node=>node.kind==='Image')!;expect(image.props.height).toBe(140);expect(mounts).toBe(1);
 f.dispose();expect(releases).toBe(1);
});

test('production AddRss preserves inline draft across configuration and drops it after process loss',async()=>{
 const entry:ActivityRoute={page:'add-rss',addUrl:'intent URL'};let change!:(v:string)=>void,closed=0;
 const props={width:233,height:233,active:true,initialUrl:'intent URL',input:async()=>null,onAdded:()=>{},onExisting:()=>{},openInlineInput:async(_v:any,_b:any,onChange:any)=>{change=onChange;return {close:async()=>{closed++;}};}};
 const f=mount(entry,()=>createComponent(AddRssScreen,props));
 f.press('RSS订阅地址输入框，当前内容：intent URL');await turn();change('https://draft.example/feed');f.dispose();await turn();expect(closed).toBe(1);
 const config=mount(recreate(entry),()=>createComponent(AddRssScreen,props));expect(config.text()).toContain('https://draft.example/feed');
 const process=mount(recreate(entry,true),()=>createComponent(AddRssScreen,props));expect(process.text()).toContain('intent URL');expect(process.text()).not.toContain('https://draft.example/feed');
});

test('production AddRss revalidates a retained preview rather than reviving a stale confirm token',async()=>{
 const entry:ActivityRoute={page:'add-rss',addUrl:'https://feed.example/rss'};let calls=0;
 const props={width:233,height:600,active:true,initialUrl:entry.addUrl!,input:async()=>null,onAdded:()=>{},onExisting:()=>{},preview:async()=>{calls++;return {kind:'ready' as const,token:'private-preview-'+calls,title:'Verified feed '+calls,description:'real fixture response',url:entry.addUrl!,format:'rss' as const};}};
 const f=mount(entry,()=>createComponent(AddRssScreen,props));f.press('添加订阅按钮');await turn();expect(f.text()).toContain('Verified feed 1');f.dispose();
 const state=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},entry]);expect(JSON.stringify(state)).not.toContain('private-preview');
 const config=mount(recreate(entry),()=>createComponent(AddRssScreen,props));await turn();expect(calls).toBe(2);expect(config.text()).toContain('Verified feed 2');
 mount(recreate(entry,true),()=>createComponent(AddRssScreen,props));await turn();expect(calls).toBe(2);
});


test('production list keeps the visible item when earlier row heights change after recreation',()=>{
 const entry:ActivityRoute={page:'settings'};let scroll:any;
 const initial=[{height:100,render:()=>null},{height:200,render:()=>null},{height:800,render:()=>null}];
 const first=mount(entry,()=>createComponent(ScrollEntries,{height:100,entries:initial,gap:0,padding:18,ref:v=>scroll=v.scroller}));
 scroll.scrollTo(140,{immediate:true});first.checkpoint();first.dispose();
 expect(routeMemory(entry).saved['scroll:0']).toMatchObject({anchor:{index:1,offset:40}});
 const [rows,setRows]=createSignal(initial),restored=recreate(entry,true);
 const next=mount(restored,()=>createComponent(ScrollEntries,{height:100,get entries(){return rows();},gap:0,padding:18,ref:v=>scroll=v.scroller}));
 frame();expect(scroll.offset()).toBe(140);
 setRows([{height:180,render:()=>null},...initial.slice(1)]);frame();expect(scroll.offset()).toBe(220);
 [...gestures][0].onDown();scroll.scrollTo(250,{immediate:true});setRows([{height:200,render:()=>null},...initial.slice(1)]);frame();expect(scroll.offset()).toBe(250);next.checkpoint();
 expect(routeMemory(restored).saved['scroll:0']).toMatchObject({anchor:{index:1,offset:50}});
});


// Native video/network/logging are service boundaries; the production player's
// prepare/effect path and Activity Context stay real.
const transforms:any[]=[],volumes:number[]=[];
let internet='wifi';
let playerLifecycle='active';const playerLifecycleListeners=new Set<(state:string)=>void>();
let nativeVideoSample:Record<string,unknown>={};
const videoState=()=>({state:'playing',positionMs:0,durationMs:100000,width:466,height:466,volume:.8,...nativeVideoSample});
const frameCaptures:any[]=[];
const loopCalls:boolean[]=[],prepareLoops:boolean[]=[],loopKv=new Map<string,unknown>();
const videoTimers=new Set<{milliseconds:number;fire:()=>void}>();
const fireVideoPoll=()=>{for(const timer of [...videoTimers])if(timer.milliseconds===400){videoTimers.delete(timer);timer.fire();}};
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({physicalWidth:466,logicalWidth:233,logicalHeight:233,shape:'round',density:2,safeInsets:{left:0,right:0,top:0,bottom:0}}),hasCapability:()=>false,lifecycle:()=>playerLifecycle,onLifecycleChange:(fn:(state:string)=>void)=>{playerLifecycleListeners.add(fn);return ()=>playerLifecycleListeners.delete(fn);},normalizedRelativeAxisStep:(n:number)=>n,kv:{get:(key:string)=>loopKv.get(key),set(key:string,value:unknown){loopKv.set(key,value);},delete(key:string){loopKv.delete(key);}}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(t:string)=>t.length*6})}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:element('RemoteImage')}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(listener:any)=>{listener(internet);return ()=>{};}}));
mock.module('../src/logs/app-logger.ts',()=>({createLogConsole:()=>({warn(){},error(){}}),appLogger:{d(){},i(){},w(){},e(){}}}));
let inlineCalls=0;
mock.module('@podjs/framework/services',()=>({onVideoFirstFrame:()=>()=>{},textInput:{openInline:async()=>{inlineCalls++;throw Error('fixture inline unavailable');}},textLayout:{},video:{
 captureFrame:async(options:any)=>{frameCaptures.push(options);return {available:true,kind:"actual_frame",path:"video-frames/test.jpg"};},captureBackdrop:async()=>{},prepare:(options:any)=>{prepareLoops.push(options.loop);return {result:Promise.resolve(videoState()),cancel(){}};},setLoop:async(loop:boolean)=>{loopCalls.push(loop);return videoState();},
 retire:async()=>({...videoState(),state:'paused'}),play:async()=>videoState(),pause:async()=>({...videoState(),state:'paused'}),stop:async()=>{},state:async()=>videoState(),seek:async()=>videoState(),
 setBounds:async()=>{},setTransform:async(value:any)=>{transforms.push(value);},setVolume:async(value:number)=>{volumes.push(value);return {...videoState(),volume:value};},
},videoSessions:{},hostOperation:()=>{throw Error('unexpected native operation');},delay:(milliseconds:number)=>{let fire!:()=>void;const result=new Promise<void>(r=>fire=r),timer={milliseconds,fire};videoTimers.add(timer);return {result,cancel(){videoTimers.delete(timer);}};}}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{playbackUrl:(_id:string,url:string)=>url,updateContext(){},tick:async()=>{}}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');

test('production immersive player keeps restored mode through prepare and next source; consumed volume guard does not repeat',async()=>{
 transforms.length=0;volumes.length=0;internet='bluetooth';
 const entry:ActivityRoute={page:'video',videoTarget:{kind:'douyin',awemeId:'fixture-a',immersive:true}};
 Object.assign(routeMemory(entry).saved,{'player-controls':false,'player-scale':'expanded','player-bluetooth':true,'player-start-limit-consumed':true});
 const [source,setSource]=createSignal({title:'A',url:'fixture stream',platform:'douyin' as const,immersive:true,startVolumeLimit:10});
 const f=mount(entry,()=>createComponent(VideoPlayerScreen,{get source(){return source();},width:233,height:233,active:true,offset:0,round:true}));
 await turn();expect(transforms.length).toBeGreaterThan(0);expect(transforms.at(-1).scaleMode).toBe('expanded');expect(volumes).toEqual([]);expect(f.text()).not.toContain('当前为蓝牙网络');
 expect(nodes(f.root).filter(n=>n.kind==='Image')).toHaveLength(0);
 setSource({...source(),title:'B',url:'new fixture stream'});await turn();expect(transforms.at(-1).scaleMode).toBe('expanded');expect(routeMemory(entry).saved['player-scale']).toBe('expanded');expect(volumes).toEqual([]);
 f.dispose();
 // Bili controls are native ordinary remember, so foreign saved player fields
 // cannot force an immersive mode or skip its initial volume enforcement.
 transforms.length=0;volumes.length=0;
 const bili:ActivityRoute={page:'video',videoTarget:{kind:'bili',aid:1,cid:2},memory:{id:'r999',saved:{'player-scale':'expanded','player-controls':false,'player-start-limit-consumed':true},retained:{}}};
 const b=mount(bili,()=>createComponent(VideoPlayerScreen,{source:{title:'Bili',url:'fixture',platform:'bili',startVolumeLimit:10},width:233,height:233,active:true,offset:0,round:true}));
 await turn();expect(transforms.at(-1).scaleMode).toBe('standard');expect(volumes).toEqual([.1]);expect(nodes(b.root).filter(n=>n.kind==='Image').length).toBeGreaterThan(0);b.dispose();
});


test('production player exposes persistent loop controls, changes the running host and checkpoints repeats once',async()=>{
 loopKv.clear();loopCalls.length=0;prepareLoops.length=0;nativeVideoSample={};internet='wifi';
 let handle:any;const checkpoints:string[]=[],progress:number[]=[];
 const f=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{source:{title:'Bili',url:'bili-loop',platform:'bili'},width:233,height:233,active:true,offset:0,round:true,ref:v=>handle=v,onCheckpoint:kind=>checkpoints.push(kind),onProgress:position=>progress.push(position)}));
 await turn();expect(handle.loopMode()).toBe('off');expect(handle.availableLoopModes()).toEqual(['off','single']);
 handle.cycleLoopMode();await turn();expect(handle.loopMode()).toBe('single');expect(loopCalls.at(-1)).toBe(true);expect(prepareLoops).toEqual([false]);
 nativeVideoSample={completedLoops:3,positionMs:25};fireVideoPoll();await turn();
 nativeVideoSample={completedLoops:4,positionMs:10};fireVideoPoll();await turn();
 expect(checkpoints.filter(c=>c==='ready')).toHaveLength(1);expect(checkpoints.filter(c=>c==='ended')).toHaveLength(1);expect(progress).toEqual([0]);
 f.dispose();nativeVideoSample={};
 const b=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{source:{title:'Bili',url:'bili-again',platform:'bili'},width:233,height:233,active:true,offset:0,round:true,ref:v=>handle=v}));
 await turn();expect(handle.loopMode()).toBe('single');expect(prepareLoops.at(-1)).toBe(true);handle.cycleLoopMode();await turn();expect(loopCalls.at(-1)).toBe(false);b.dispose();loopKv.clear();
});

test('production auto-next reuses adjacent preview and next action, then stops at the tail',async()=>{
 loopKv.clear();loopKv.set('watchrss.douyin.loop-mode','next');nativeVideoSample={};internet='wifi';
 const [source,setSource]=createSignal({title:'A',awemeId:'auto-a',url:'auto-a',platform:'douyin' as const,immersive:true});
 let nextCalls=0,previewCalls=0;const ready:string[]=[];
 const f=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{get source(){return source();},width:233,height:233,active:true,offset:0,round:true,
  onPrepareAdjacent:async()=>{previewCalls++;return source().awemeId==='auto-a'?{key:'auto-b',source:{...source(),awemeId:'auto-b',url:'auto-b'}}:undefined;},
  onNext:async()=>{nextCalls++;nativeVideoSample={};setSource({...source(),awemeId:'auto-b',url:'auto-b'});},onCheckpoint:kind=>{if(kind==='ready')ready.push(source().awemeId);}}));
 await turn();nativeVideoSample={state:'ended',positionMs:100000};fireVideoPoll();await turn();await turn();
 expect(nextCalls).toBe(1);expect(source().awemeId).toBe('auto-b');expect(ready).toEqual(['auto-a','auto-b']);
 nativeVideoSample={state:'ended',positionMs:100000};fireVideoPoll();await turn();fireVideoPoll();await turn();
 expect(nextCalls).toBe(1);expect(previewCalls).toBe(2);f.dispose();nativeVideoSample={};loopKv.clear();
});


test('production mode change and background invalidate auto-next while adjacent resolution is pending',async()=>{
 for(const cause of ['mode','background','inactive','dispose']){
  loopKv.clear();loopKv.set('watchrss.douyin.loop-mode','next');nativeVideoSample={};internet='wifi';playerLifecycle='active';
  let finish!:(value:any)=>void,handle:any,nextCalls=0;
  const [active,setActive]=createSignal(true);
  const source={title:'A',awemeId:'late-a',url:'late-a',platform:'douyin' as const,immersive:true};
  const f=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{source,width:233,height:233,get active(){return active();},offset:0,round:true,ref:v=>handle=v,
   onPrepareAdjacent:()=>new Promise(r=>finish=r),onNext:async()=>{nextCalls++;}}));
  await turn();nativeVideoSample={state:'ended',positionMs:100000};fireVideoPoll();await turn();expect(finish).toBeDefined();
  if(cause==='mode')handle.cycleLoopMode();
  else if(cause==='background'){playerLifecycle='background';for(const fn of playerLifecycleListeners)fn('background');}
  else if(cause==='inactive')setActive(false);
  else f.dispose();
  finish({key:'late-b',source:{...source,awemeId:'late-b',url:'late-b'}});await turn();expect(nextCalls).toBe(0);
  f.dispose();playerLifecycle='active';nativeVideoSample={};loopKv.clear();
 }
});


let resolveCurrent!:(id:string)=>Promise<any>,queueSnapshot:any;
mock.module('../src/media-services.ts',()=>({douyinPreload:{lookup:async()=>undefined,invalidate:async()=>{},start(){},stop(){},allowBluetooth(){}},biliClient:{},biliPreviewCache:{lookup:async()=>undefined},douyinClient:{resolvePlayback:(id:string)=>resolveCurrent(id),restorePlaybackQueue:async()=>await queueSnapshot,savePlaybackQueue:async()=>{},buildPlaybackHeaders:async()=>({Cookie:'CURRENT-CREDENTIAL'}),isLoggedIn:async()=>true}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('../src/media/browser-auth.ts',()=>({authorizeInBrowser:()=>{throw Error('unexpected login');}}));
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
function mediaController(){
 let entry:ActivityRoute={page:'home'};const navigations:any[]=[],errors:any[]=[];
 const controller=createRoot(stop=>{disposers.push(stop);return createMediaRouteController({services:{} as never,current:()=>entry,motion:{phase:'idle'},busy:()=>false,setBusy:()=>false,setError:(v:any)=>{errors.push(v);return v;},settings:()=>({}) as never,playingSource:()=>undefined,setPlayingSource:(v:any)=>v,channels:()=>[],setChannels:(v:any)=>v,setOriginalModes:(v:any)=>v,setStack:(v:any)=>v,setPage:(page:ActivityRoute['page'],data?:Partial<ActivityRoute>)=>{entry={page,...data};navigations.push(entry);},popPage:()=>false} as never);});
 return {controller,navigations,errors,navigate:()=>{entry={page:'settings'};}};
}
const item=(id:string)=>({awemeId:id,description:'fixture '+id,playUrl:'CURRENT-STREAM-'+id,authorId:'author',authorName:'fixture',createdAtSeconds:1,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:100000,variants:[]});

test('production media restoration cancels late resolution after new navigation and gives memory only to its own video',async()=>{
 let release!:(value:any)=>void;resolveCurrent=async()=>{throw Error('restore must not fetch detail');};queueSnapshot=new Promise(resolve=>release=resolve);
 const cancelled=mediaController(),memory={id:'r500',saved:{'player-scale':'expanded'},retained:{}};
 const pending=cancelled.controller.restoreDouyinVideo('fixture-a',true,memory);cancelled.navigate();release({anchorAwemeId:'fixture-a',items:[item('fixture-a')],cursor:null,hasMore:false});await pending;
 expect(cancelled.navigations).toEqual([]);expect(cancelled.errors).toEqual([]);
 queueSnapshot={anchorAwemeId:'fixture-a',items:[item('fixture-a'),item('fixture-b')],cursor:'actual fixture cursor',hasMore:true};
 const restored=mediaController();await restored.controller.restoreDouyinVideo('fixture-a',true,memory);
 const video=restored.navigations[0];expect(video.memory).toBe(memory);expect(video.videoTarget).toEqual({kind:'douyin',awemeId:'fixture-a',immersive:true});expect(video.playback.url).toBe('CURRENT-STREAM-fixture-a');expect(video.queue.snapshot().playlist).toHaveLength(2);
 const state=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},video]);expect(JSON.stringify(state)).not.toContain('CURRENT-STREAM');expect(JSON.stringify(state)).not.toContain('CURRENT-CREDENTIAL');
 // A subsequent ordinary user video receives no restoration bag.
 restored.controller.douyinPlay({item:item('fixture-c'),playback:item('fixture-c'),immersive:true});await restored.controller.douyinNavigate({name:'player',awemeId:'fixture-c'});
 expect(restored.navigations[1].memory).toBeUndefined();expect(restored.errors.filter(Boolean)).toEqual([]);
});


const {useModalInput}=await import('../src/ui/modal-input.ts');
test('unconfirmed modal rebinds its new owner; late replies, process reset and route changes cannot submit',async()=>{
 type Pending={key:string;text:string;title:string};
 function host(restored?:Pending){
  let current:Pending|undefined=restored,settle:((value:string|null)=>void)|undefined;
  const calls:Pending[]=[],dismissed:string[]=[];
  return {calls,dismissed,edit:(text:string)=>{current!.text=text;},snapshot:()=>current?clone(current):undefined,
   input:async(title:string,value='',options?:{restorationKey:string})=>{const key=options?.restorationKey||'fresh';current=current?.key===key?current:{key,title,text:value};calls.push(clone(current));return new Promise<string|null>(resolve=>settle=resolve);},
   recovery:{pending:async(key:string)=>current?.key===key,dismiss:async(key:string)=>{dismissed.push(key);if(current?.key===key){current=undefined;settle?.(null);}}},
   confirm:(value:string)=>{current=undefined;settle?.(value);},late:(value:string)=>settle?.(value),
  };
 }
 const submitted:string[]=[],errors:unknown[]=[],entry:ActivityRoute={page:'bili',biliRoute:{name:'search'}};
 const original=host();let open!:()=>Promise<void>;
 const first=mount(entry,()=>{open=useModalInput({key:'search',title:'search',value:()=>'',input:original.input,recovery:original.recovery,active:()=>true,onValue:v=>{submitted.push(v);},onError:e=>errors.push(e)});return null;});
 const oldRequest=open();await turn();original.edit('未确认 draft🙂');const snapshot=original.snapshot(),route=recreate(entry);first.dispose();await oldRequest;
 const restored=host(snapshot);
 mount(route,()=>{open=useModalInput({key:'search',title:'search',value:()=>'',input:restored.input,recovery:restored.recovery,active:()=>true,onValue:v=>{submitted.push(v);},onError:e=>errors.push(e)});return null;});
 await turn();expect(restored.calls).toHaveLength(1);expect(restored.calls[0]!.text).toBe('未确认 draft🙂');expect(submitted).toEqual([]);
 original.late('old reply');restored.confirm('confirmed once');await turn();expect(submitted).toEqual(['confirmed once']);expect(errors).toEqual([]);
 const process=host();mount(recreate(entry,true),()=>{useModalInput({key:'search',title:'search',value:()=>'',input:process.input,recovery:process.recovery,active:()=>true,onValue:v=>{submitted.push(v);},onError:e=>errors.push(e)});return null;});await turn();expect(process.calls).toHaveLength(0);
 const other=host(snapshot);mount({page:'bili',biliRoute:{name:'search'}},()=>{useModalInput({key:'search',title:'search',value:()=>'',input:other.input,recovery:other.recovery,active:()=>true,onValue:v=>{submitted.push(v);},onError:e=>errors.push(e)});return null;});await turn();expect(other.calls).toHaveLength(0);
});
test('inactive page invalidates a delayed recovery probe and ordinary unsupported host input stays usable',async()=>{
 const [active,setActive]=createSignal(true),values:string[]=[];let probe!:(v:boolean)=>void,asked=0,dismissed=0,open!:()=>Promise<void>;
 const f=mount({page:'search',channelId:'1'},()=>{open=useModalInput({key:'search',title:'search',value:()=>'',active,input:async()=>{asked++;return 'query';},recovery:{pending:()=>new Promise<boolean>(r=>probe=r),dismiss:async()=>{dismissed++;}},onValue:v=>{values.push(v);},onError:()=>{}});return null;});
 setActive(false);probe(true);await turn();expect(asked).toBe(0);expect(dismissed).toBe(1);f.dispose();
 mount({page:'search',channelId:'1'},()=>{open=useModalInput({key:'search',title:'search',value:()=>'',active:()=>true,input:async(_title,_value,opts)=>{expect(opts).toBeUndefined();return 'query';},onValue:v=>{values.push(v);},onError:()=>{}});return null;});await open();expect(values).toEqual(['query']);
});


mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:element('Download')}));
mock.module('../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:element('Delete')}));
mock.module('../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:element('Background')}));
mock.module('../src/ui/NotePreview.tsx',()=>({notePreviewEntries:()=>[],notePreviewEntrySteps:function*(){}}));
mock.module('../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
mock.module('@podjs/framework/text',()=>({SystemTextLine:element('SystemText')}));
const {NoteDetailScreen}=await import('../src/ui/NotesScreen.tsx');
const memo=()=>({noteId:'note-fixture',folderId:null,title:'persisted title',markdown:'persisted body',plainText:'persisted body',contentHash:'hash',baseContentHash:'hash',baseMarkdown:'persisted body',pinned:false,createdAt:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0});
test('real note reader remount enters its pending body modal, saves only on confirmation and skips prior title step',async()=>{
 inlineCalls=0;const entry:ActivityRoute={page:'note-detail',noteId:'note-fixture'},key=`watchrss:${routeMemory(entry).id}:note:body`;
 const [active,setActive]=createSignal(true);const calls:any[]=[],saves:any[]=[],errors:string[]=[];let confirm!:(v:string|null)=>void,closed=0,saved=memo();
 const f=mount(entry,()=>createComponent(NoteDetailScreen,{width:233,height:233,noteId:'note-fixture',get active(){return active();},repository:{get:async()=>saved,save:async(input:any)=>{saves.push(input);saved={...saved,title:input.title,markdown:input.markdown};return saved;}} as never,
  input:async(title,value,opts)=>{calls.push({title,value,opts});return new Promise<string|null>(r=>confirm=r);},inputRecovery:{pending:async requested=>requested===key,dismiss:async()=>{}},onBack:()=>closed++,onError:e=>errors.push(e)}));
 await turn();await turn();expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({title:'备忘录正文',value:'persisted body',opts:{restorationKey:key}});expect(inlineCalls).toBe(0);expect(saves).toEqual([]);
 confirm('confirmed body');await turn();expect(saves).toHaveLength(1);expect(saves[0]).toMatchObject({noteId:'note-fixture',title:'persisted title',markdown:'confirmed body'});expect(closed).toBe(0);expect(errors).toEqual([]);
 f.dispose();
});
test('destroyed pending note editor never opens its next modal or writes a late title result',async()=>{
 inlineCalls=0;const entry:ActivityRoute={page:'note-detail',noteId:'note-fixture'},key=`watchrss:${routeMemory(entry).id}:note:title`;
 const calls:string[]=[],saves:any[]=[],dismissed:string[]=[];let settle!:(value:string|null)=>void;
 const f=mount(entry,()=>createComponent(NoteDetailScreen,{width:233,height:233,noteId:'note-fixture',active:true,repository:{get:async()=>memo(),save:async(input:any)=>{saves.push(input);return memo();}} as never,input:async(title)=>{calls.push(title);return new Promise<string|null>(r=>settle=r);},inputRecovery:{pending:async requested=>requested===key,dismiss:async requested=>{dismissed.push(requested);}},onBack:()=>{},onError:()=>{}}));
 await turn();await turn();expect(calls).toEqual(['备忘录标题']);f.dispose();settle('late title');await turn();expect(calls).toEqual(['备忘录标题']);expect(saves).toEqual([]);expect(dismissed).toContain(key);
});

test('configuration recovery of a newly created note keeps its original close destination after identity autosave',async()=>{
 const original:ActivityRoute={page:'note-detail',noteId:'note-fixture'};routeMemory(original).retained['note-create-mode']=true;
 const entry=recreate(original),key=`watchrss:${routeMemory(entry).id}:note:body`;let finish!:(value:string|null)=>void,closed=0;
 const current=memo();
 mount(entry,()=>createComponent(NoteDetailScreen,{width:233,height:233,noteId:'note-fixture',active:true,repository:{get:async()=>current,save:async(input:any)=>({...current,title:input.title,markdown:input.markdown})} as never,input:async()=>new Promise<string|null>(r=>finish=r),inputRecovery:{pending:async requested=>requested===key,dismiss:async()=>{}},onBack:()=>closed++,onError:()=>{}}));
 await turn();await turn();finish('confirmed');await turn();expect(closed).toBe(1);
 const process=recreate(original,true);expect(routeMemory(process).retained['note-create-mode']).toBeUndefined();expect(process.noteId).toBe('note-fixture');
});

test('player captures an actual rendered Douyin frame with entry source and native generation on exit',async()=>{
 nativeVideoSample={hasRenderedFirstFrame:true,sourceGeneration:17};frameCaptures.length=0;internet='wifi';const [active,setActive]=createSignal(true);
 const source={title:'a',platform:'douyin' as const,awemeId:'frame-a',url:'podjs-media-cache://play/bound.mp4',headers:{Cookie:'fixture'},immersive:true};
 const f=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{source,width:233,height:233,get active(){return active();},offset:0,round:true}));await turn();setActive(false);await turn();
 expect(frameCaptures.at(-1)).toEqual({key:'douyin:frame-a',source:{url:source.url,videoUrl:undefined,audioUrl:undefined,headers:{Cookie:'fixture'}},sourceGeneration:17});f.dispose();nativeVideoSample={};
});
test('a restored actual-frame placeholder never prepares an unvalidated saved video URL',async()=>{
 const before=prepareLoops.length;let handle:any,retries=0;const source={title:'a',platform:'douyin' as const,awemeId:'a',url:'https://expired.invalid/video',previewOnly:true,immersive:true,previewFrame:{entryId:'a',frame:{available:true as const,kind:'actual_frame' as const,path:'video-frames/fixture.jpg',width:10,height:10,positionMs:0,capturedAt:1,capturedGeneration:3}}};
 const f=mount({page:'video'},()=>createComponent(VideoPlayerScreen,{source,width:233,height:233,active:true,offset:0,round:true,ref:value=>handle=value,onRetry:()=>{retries++;}}));await turn();expect(prepareLoops.length).toBe(before);expect(handle.previewKind()).toBe('actual_frame');f.dispose();expect(retries).toBe(0);
});
