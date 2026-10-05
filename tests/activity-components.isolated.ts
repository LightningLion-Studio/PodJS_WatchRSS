import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup,Show} from 'solid-js';
import {createScrollerWith} from '/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/kinetics-core.ts';
import {captureActivityNavigation,restoreActivityNavigation,routeMemory,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'activity-recreation-solid',setup(builder){builder.onLoad({filter:/\/ui\/(route-activity|ScrollEntries|AddRssScreen|VideoPlayerScreen)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
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
const videoState=()=>({state:'playing',positionMs:0,durationMs:100000,width:466,height:466,volume:.8});
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>false,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>n,kv:{get:()=>undefined,set(){},delete(){}}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(t:string)=>t.length*6})}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:element('RemoteImage')}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(listener:any)=>{listener(internet);return ()=>{};}}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
mock.module('@podjs/framework/services',()=>({video:{
 captureBackdrop:async()=>{},prepare:()=>({result:Promise.resolve(videoState()),cancel(){}}),
 play:async()=>videoState(),pause:async()=>({...videoState(),state:'paused'}),stop:async()=>{},state:async()=>videoState(),seek:async()=>videoState(),
 setBounds:async()=>{},setTransform:async(value:any)=>{transforms.push(value);},setVolume:async(value:number)=>{volumes.push(value);return {...videoState(),volume:value};},
},videoSessions:{},hostOperation:()=>{throw Error('unexpected native operation');},delay:()=>({result:new Promise<void>(()=>{}),cancel(){}})}));
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


let resolveCurrent!:(id:string)=>Promise<any>,queueSnapshot:any;
mock.module('../src/media-services.ts',()=>({biliClient:{},douyinClient:{resolvePlayback:(id:string)=>resolveCurrent(id),restorePlaybackQueue:async()=>await queueSnapshot,savePlaybackQueue:async()=>{},buildPlaybackHeaders:async()=>({Cookie:'CURRENT-CREDENTIAL'}),isLoggedIn:async()=>true}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('../src/media/browser-auth.ts',()=>({authorizeInBrowser:()=>{throw Error('unexpected login');}}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{playbackUrl:(_id:string,url:string)=>url,updateContext(){},tick:async()=>{}}}));
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
