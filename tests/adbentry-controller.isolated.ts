import {afterEach,expect,mock,test} from 'bun:test';
import {createRoot,createSignal} from 'solid-js';
import { DouyinClient } from '../src/douyin/client.ts';
import type { DouyinItem } from '../src/douyin/types.ts';
import type { RouteEntry } from '../src/ui/routes/types.ts';
let readyOverride:undefined|(()=>Promise<any>);let client:DouyinClient;let optRecovery=false;let captureOverride:(()=>Promise<void>)|undefined;
let loginOptions:any,completeLogin:(value:{cookie:string;origin:string})=>void;
mock.module('../src/media/browser-auth.ts',()=>({authorizeInBrowser:(options:any)=>{loginOptions=options;return {result:new Promise(resolve=>completeLogin=resolve),cancel(){}};}}));
let paintRelease:(value:{committed:boolean})=>void;
mock.module('@podjs/framework/render',()=>({afterPaint:()=>({result:new Promise(resolve=>paintRelease=resolve),cancel(){}})}));
let preloadWindows:string[][]=[];let canonicalSource:DouyinItem|undefined;let restoredFrame:any;let prefetchHooks:any;
const localPaths=new Map<string,string>();const invalidated:string[]=[];let proxyOverride:undefined|((item:DouyinItem)=>Promise<string>);let lookupOverride:undefined|(()=>Promise<string|undefined>);
mock.module('../src/media-services.ts',()=>({douyinStock:{resume:async()=>{},suspend(){},consume(){}},douyinPreload:{readySource:async()=>readyOverride?.(),previewFrame:async()=>undefined,sourceFor:()=>canonicalSource,restoreFrame:async()=>restoredFrame,playback:async(item:DouyinItem)=>proxyOverride?proxyOverride(item):item.playUrl,lookup:async(id:string)=>lookupOverride?lookupOverride():localPaths.get(id),invalidate:async(id:string)=>{invalidated.push(id);localPaths.delete(id);},start(...args:any[]){prefetchHooks=args[4];preloadWindows.push(args[1].map((x:DouyinItem)=>x.awemeId));},stop(){},allowBluetooth(){}},douyinClient:new Proxy({}, {get:(_target,key)=>{const value=(client as any)[key];return typeof value==='function'?value.bind(client):value;}}),biliClient:{},biliPreviewCache:{lookup:async()=>undefined},loadLocalBiliDetail:async()=>undefined}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{playbackUrl:(_id:string,url:string)=>url,updateContext(){},tick:async()=>{}}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>key==='watchrss.video-opt.v1'&&optRecovery?{recovery:true,percent:100}:key==='watchrss.video-opt.bucket'?0:undefined,set(){}},lifecycle:()=> 'active'}));
mock.module('@podjs/framework/services',()=>({DOUYIN_AUTH_STATUS_SCRIPT:'test-status-script',video:{captureBackdrop:async()=>{await captureOverride?.();},stop:async()=>{}},videoSessions:{},browserAuth:{},hostOperation(){},secureStorage:{},onNetworkChange:()=>()=>{},delay:(ms:number)=>{let fire!:()=>void;const result=new Promise<void>(resolve=>fire=resolve);entryTimers.push({ms,fire});return {result,cancel(){}};}}));
const entryTimers:Array<{ms:number;fire:()=>void}>=[];
const {captureActivityNavigation,restoreActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
const stops:(()=>void)[]=[];afterEach(()=>stops.splice(0).forEach(stop=>stop()));
const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:'',authorName:id,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
function fixture(opt=false,initial?:any){
 entryTimers.length=0;optRecovery=opt;captureOverride=undefined;readyOverride=undefined;
 preloadWindows=[];canonicalSource=undefined;restoredFrame=undefined;prefetchHooks=undefined;localPaths.clear();invalidated.length=0;lookupOverride=undefined;proxyOverride=undefined;
 const values=new Map<string,string>();let requests=0;
 client=new DouyinClient({secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},transport:{request:async()=>{requests++;throw Error('offline');}}});
 let controller!:ReturnType<typeof createMediaRouteController>,stack!:()=>RouteEntry[],source:any,error!:()=>string;
 createRoot(stop=>{stops.push(stop);const [entries,setStack]=createSignal<RouteEntry[]>([{page:'home'},{page:'douyin',douyinRoute:{name:'history'}}]);stack=entries;
 const [busy,setBusy]=createSignal(false),[message,setError]=createSignal(''),[playing,setPlaying]=createSignal<any>();error=message;
 controller=createMediaRouteController({initialVideoBounds:initial?()=>({x:0,y:0,width:233,height:233}):undefined,createInitialVideoPool:initial?()=>typeof initial==='function'?initial():initial:undefined,current:()=>entries().at(-1)!,motion:{phase:'idle'},busy,setBusy,setError,settings:()=>({mediaVolumeControl:true,mediaVolumeGuard:false,playbackStartVolumeLimit:null}) as any,
 playingSource:playing,setPlayingSource:((v:any)=>{source=typeof v==='function'?v(playing()):v;return setPlaying(v);}) as any,
 channels:()=>[],setChannels:(()=>[]) as any,setOriginalModes:(()=>({})) as any,setStack,setPage:(page,data)=>setStack(rows=>[...rows,{page,...data}]),popPage:()=>{setStack(rows=>rows.slice(0,-1));return true;},services:{} as any});
 });
 return {controller,stack,source:()=>source,error,requests:()=>requests};
}

const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
test('RVADB-02: cancellation keeps the preview source closed to late success',async()=>{
 const f=fixture(),a=item('123');let release!:(v:any)=>void;let active=true;
 client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);
 readyOverride=()=>new Promise(resolve=>release=resolve);
 bindShellCommands({current:()=>f.stack().at(-1)!,client,navigate:f.controller.douyinNavigate,play:f.controller.douyinPlay,move:f.controller.changeDouyinVideo});
 const running=registeredHandlers['douyin.play']({index:0},{isActive:()=>active});
 await flush();expect(entryTimers.some(t=>t.ms===200)).toBe(true);
 entryTimers.find(t=>t.ms===200)!.fire();await flush();
 expect(f.source().previewOnly).toBe(true);
 active=false;entryTimers.find(t=>t.ms===50)!.fire();
 await expect(running).rejects.toMatchObject({code:'unavailable'});
 release({url:'podjs-media-cache://play/late.mp4'});await flush();
 console.log('LATE_SOURCE',JSON.stringify({cancelled:!active,handlerRejected:'unavailable',previewOnly:f.source().previewOnly,urlPublished:!!f.source().url,requests:f.requests()}));
 expect(f.source().previewOnly).toBe(true);expect(f.source().url).toBeUndefined();expect(f.requests()).toBe(0);
});
test('cancellation before next source publication restores queue and keeps active source',async()=>{
 const f=fixture(),items=[item('111'),item('222')];let active=true;let finish!:(v:any)=>void;
 f.controller.douyinPlay({item:items[0],playback:items[0],playlist:items,hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'111'});
 lookupOverride=()=>new Promise(resolve=>finish=resolve);
 const move=f.controller.changeDouyinVideo(f.stack().at(-1)!,'next',()=>active);await flush();active=false;lookupOverride=undefined;finish(undefined);
 await expect(move).rejects.toThrow('cancelled');
 expect(f.source().awemeId).toBe('111');expect(f.stack().at(-1)!.queue!.snapshot().item!.awemeId).toBe('111');expect(f.requests()).toBe(0);
 console.log('NEXT_CANCEL rollback=111 requests=0');
});
import {ShellCommandError} from '@podjs/framework/shell-error';
let registeredHandlers:any;
mock.module('@podjs/framework/shell',()=>({ShellCommandError,registerShellCommands:(handlers:any)=>{registeredHandlers=handlers;return()=>{};},shellDiagnostics:async()=>({pssKb:42,decoderInstances:1,decoderLeases:1,sql:{},videoSessions:{active:1,created:1,released:0}})}));
const {bindShellCommands}=await import('../src/debug/shell-host.ts');
test('RVADB-01: failed target preparation cannot succeed on the old playing source',async()=>{
 const f=fixture(),items=[item('111'),item('222')];
 f.controller.douyinPlay({item:items[0],playback:items[0],playlist:items,hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'111'});
 const original=f.stack().at(-1)!;
 original.player={shellState:async()=>({state:'playing',positionMs:1234}),shellPlaying:async()=>{}} as any;
 bindShellCommands({current:()=>f.stack().at(-1)!,client,navigate:f.controller.douyinNavigate,play:f.controller.douyinPlay,move:f.controller.changeDouyinVideo});
 readyOverride=async()=>{throw Error('synthetic source failure');};
 await expect(registeredHandlers['douyin.play']({index:1},{isActive:()=>true})).rejects.toMatchObject({code:'unavailable'});
 console.log('FALSE_PLAY_REJECTED requested=222 actual='+f.source().awemeId+' requests='+f.requests());
 expect(f.source().awemeId).toBe('111');expect(f.requests()).toBe(0);
});

function bind(f:ReturnType<typeof fixture>){bindShellCommands({current:()=>f.stack().at(-1)!,client,navigate:f.controller.douyinNavigate,play:f.controller.douyinPlay,move:f.controller.changeDouyinVideo});}
const timer=(ms:number)=>entryTimers.filter(t=>t.ms===ms).at(-1)!;
const playing=()=>({shellState:async()=>({state:'playing',positionMs:1234}),shellPlaying:async()=>{}} as any);
for(const queued of [false,true])test(`shell play preserves ${queued?'the existing terminal queue':'restored feed continuation'}`,async()=>{
 const f=fixture(),a=item('123');let restores=0,request:any;
 client.restoreFeed=async()=>{restores++;return {items:[a],cursor:'40',hasMore:true,resolved:{[a.awemeId]:Date.now()}} as any;};
 const origin:RouteEntry={page:'douyin',douyinRoute:{name:'entry'}};
 if(queued)origin.queue={snapshot:()=>({playlist:[a],cursor:null,hasMore:false})} as any;
 let entry=origin;
 bindShellCommands({current:()=>entry,client,move:async()=>{},
  play:value=>{request=value;value.onSourcePublished?.({platform:'douyin',awemeId:a.awemeId,url:a.playUrl} as any);},
  navigate:async()=>{entry={page:'video',playback:{platform:'douyin',awemeId:a.awemeId,url:a.playUrl} as any,player:playing()};request.onSourcePublished?.(entry.playback);},
 });
 expect((await registeredHandlers['douyin.play']({index:0},{isActive:()=>true})).playbackState).toBe('playing');
 expect(request.playlist).toEqual([a]);expect(request.cursor).toBe(queued?undefined:'40');expect(request.hasMore).toBe(!queued);expect(restores).toBe(queued?0:1);
});
test('RVADB-01: a failed replay of the same aweme cannot reuse its old player',async()=>{
 const f=fixture(),a=item('111');f.controller.douyinPlay({item:a,playback:a,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 f.stack().at(-1)!.player=playing();bind(f);readyOverride=async()=>{throw Error('synthetic replay failure');};
 await expect(registeredHandlers['douyin.play']({index:0},{isActive:()=>true})).rejects.toMatchObject({code:'unavailable'});expect(f.requests()).toBe(0);
});
test('RVADB-01: a state reply from a replaced source with the same aweme is stale',async()=>{
 const f=fixture(),a=item('111');client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);bind(f);
 const running=registeredHandlers['douyin.play']({index:0},{isActive:()=>true});const outcome=running.catch((error:any)=>error);await flush();
 const entry=f.stack().at(-1)!;let complete!:(v:any)=>void;entry.player={...playing(),shellState:()=>new Promise(resolve=>complete=resolve)};
 timer(50).fire();await flush();expect(complete).toBeDefined();entry.playback={...entry.playback!};complete({state:'playing'});
 expect(await outcome).toMatchObject({code:'unavailable'});expect(f.requests()).toBe(0);
});
test('RVADB-02: a cancelled preview also ignores a late preparation error',async()=>{
 const f=fixture(),a=item('123');let fail!:(e:Error)=>void,active=true;client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);readyOverride=()=>new Promise((_,reject)=>fail=reject);bind(f);
 const outcome=registeredHandlers['douyin.play']({index:0},{isActive:()=>active}).catch((error:any)=>error);await flush();timer(200).fire();await flush();
 const source=f.source();active=false;timer(50).fire();expect(await outcome).toMatchObject({code:'unavailable'});
 fail(Error('late synthetic failure'));await flush();expect(f.source()).toBe(source);expect(f.source().preparationError).toBeUndefined();expect(f.requests()).toBe(0);
});
test('a selected preview reports source failure to shell without reopening the cover',async()=>{
 const f=fixture(),a=item('123');let fail!:(error:Error)=>void;client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);readyOverride=()=>new Promise((_,reject)=>fail=reject);bind(f);
 const outcome=registeredHandlers['douyin.play']({index:0},{isActive:()=>true}).catch((error:any)=>error);await flush();timer(200).fire();await flush();
 const entry=f.stack().at(-1)!;fail(Error('selected source failure'));await flush();timer(50).fire();
 expect(await outcome).toMatchObject({code:'unavailable'});expect(f.stack().at(-1)).toBe(entry);expect(f.source().preparationError).toBeDefined();expect(f.requests()).toBe(0);
});
test('RVADB-02: the shell wait deadline closes publication even before Binder cancellation',async()=>{
 const f=fixture(),a=item('123');let release!:(v:any)=>void;client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);readyOverride=()=>new Promise(resolve=>release=resolve);bind(f);
 const outcome=registeredHandlers['douyin.play']({index:0},{isActive:()=>true}).catch((error:any)=>error);await flush();timer(200).fire();await flush();
 for(let n=0;n<200;n++){timer(50).fire();await flush();}
 expect(await outcome).toMatchObject({code:'not_ready'});const source=f.source();release({url:'podjs-media-cache://play/too-late.mp4'});await flush();
 expect(f.source()).toBe(source);expect(f.source().url).toBeUndefined();expect(f.requests()).toBe(0);
});
test('the request can adopt its own preview replacement and reach playing',async()=>{
 const f=fixture(),a=item('123');let release!:(v:any)=>void;client.restoreFeed=async()=>({items:[a],resolved:{[a.awemeId]:Date.now()}} as any);readyOverride=()=>new Promise(resolve=>release=resolve);bind(f);
 const running=registeredHandlers['douyin.play']({index:0},{isActive:()=>true});await flush();timer(200).fire();await flush();f.stack().at(-1)!.player=playing();
 release({url:'podjs-media-cache://play/owned.mp4'});await flush();timer(50).fire();
 expect((await running).playbackState).toBe('playing');expect(f.source().url).toBe('podjs-media-cache://play/owned.mp4');expect(f.requests()).toBe(0);
});
test('NOPLAY shell rejects expired restored URLs and fetches a normal feed before playing',async()=>{
 const f=fixture(),old=item('111'),fresh=item('222');let feeds=0;
 client.restoreFeed=async()=>({items:[old],resolved:{[old.awemeId]:Date.now()-3600000}} as any);
 client.fetchFeedPage=async()=>{feeds++;return {ok:true,data:{items:[fresh],nextCursor:null,hasMore:false}};};
 bind(f);const running=registeredHandlers['douyin.play']({index:0},{isActive:()=>true});await flush();
 f.stack().at(-1)!.player=playing();timer(50).fire();
 const state=await running;expect(feeds).toBe(1);expect(f.source().awemeId).toBe('222');expect(state.targetOrdinal).toBe(1);expect(f.requests()).toBe(0);
});
test('NOPLAY diagnostic target ordinal survives reload and changes only on a different selection',async()=>{
 const f=fixture(),a=item('111');f.controller.douyinPlay({item:a,playback:a,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 f.stack().at(-1)!.player=playing();bind(f);const state=()=>registeredHandlers['douyin.state']({},{isActive:()=>true});
 expect((await state()).targetOrdinal).toBe(1);
 const entry=f.stack().at(-1)!;entry.playback={...entry.playback!};expect((await state()).targetOrdinal).toBe(1);
 entry.playback={...entry.playback!,awemeId:'222'};expect((await state()).targetOrdinal).toBe(2);
});
