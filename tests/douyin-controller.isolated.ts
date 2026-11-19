import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createRoot, createSignal, createComponent, createMemo, createRenderEffect, mergeProps } from 'solid-js';
const require=createRequire(import.meta.url);
plugin({name:'dyback-media-routes',setup(builder){builder.onLoad({filter:/\/ui\/routes\/media\.tsx$/},async args=>({contents:require('@babel/core').transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
let playerProps:any;
mock.module('../src/ui/VideoPlayerScreen.tsx',()=>({VideoPlayerScreen:(props:any)=>{playerProps=props;return null;}}));
mock.module('../src/ui/bili/index.tsx',()=>({BiliScreen:()=>null}));
mock.module('../src/ui/douyin/index.tsx',()=>({DouyinScreen:()=>null}));
mock.module('../src/ui/PlatformNotice.tsx',()=>({PendingDisclosure:()=>null}));
import { DouyinClient } from '../src/douyin/client.ts';
import type { DouyinStateStorage } from '../src/douyin/state-storage.ts';
import type { DouyinItem } from '../src/douyin/types.ts';
import type { PlaybackSource } from '../src/ui/VideoPlayerScreen.tsx';
import type { RouteEntry } from '../src/ui/routes/types.ts';
let readyOverride:undefined|(()=>Promise<any>);let client:DouyinClient;let optRecovery=false;let captureOverride:(()=>Promise<void>)|undefined;
let loginOptions:any,completeLogin:(value:{cookie:string;origin:string})=>void;
mock.module('../src/media/browser-auth.ts',()=>({authorizeInBrowser:(options:any)=>{loginOptions=options;return {result:new Promise(resolve=>completeLogin=resolve),cancel(){}};}}));
let paintRelease:(value:{committed:boolean})=>void;
mock.module('@podjs/framework/render',()=>({afterPaint:()=>({result:new Promise(resolve=>paintRelease=resolve),cancel(){}})}));
let preloadWindows:string[][]=[];let canonicalSource:DouyinItem|undefined;let restoredFrame:any;let adjacentPreview:((item:DouyinItem,uri:string)=>unknown)|undefined;let prefetchHooks:any;
const localPaths=new Map<string,string>();const invalidated:string[]=[];let proxyOverride:undefined|((item:DouyinItem,headers:Record<string,string>,intent?:string)=>Promise<string>);let lookupOverride:undefined|(()=>Promise<string|undefined>);
mock.module('../src/media-services.ts',()=>({douyinStock:{resume:async()=>{},suspend(){},consume(){}},douyinPreload:{readySource:async()=>readyOverride?.(),previewFrame:async(item:DouyinItem,uri:string)=>adjacentPreview?.(item,uri),sourceFor:()=>canonicalSource,restoreFrame:async()=>restoredFrame,playback:async(item:DouyinItem,headers:Record<string,string>,intent?:string)=>proxyOverride?proxyOverride(item,headers,intent):item.playUrl,playbackResolved:async(item:DouyinItem,headers:Record<string,string>,current:()=>boolean)=>{expect(current()).toBe(true);return proxyOverride?proxyOverride(item,headers):item.playUrl;},lookup:async(id:string)=>lookupOverride?lookupOverride():localPaths.get(id),invalidate:async(id:string)=>{invalidated.push(id);localPaths.delete(id);},forgetSource:(id:string)=>{localPaths.delete(id);},start(...args:any[]){prefetchHooks=args[4];preloadWindows.push(args[1].map((x:DouyinItem)=>x.awemeId));},stop(){},allowBluetooth(){}},douyinClient:new Proxy({}, {get:(_target,key)=>{const value=(client as any)[key];return typeof value==='function'?value.bind(client):value;}}),biliClient:{},biliPreviewCache:{lookup:async()=>undefined},loadLocalBiliDetail:async()=>undefined}));
let debugAllowed = false, debugTicks = 0;
const debugContexts: string[][] = [];
const frameObservers: {run: () => void; needsFrame: () => boolean}[] = [];
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{
 get allowed(){ return debugAllowed; },
 playbackUrl:(_id:string,url:string)=>url,
 updateContext(current:string,next:string){ debugContexts.push([current,next]); },
 tick:async()=>{ debugTicks++; }
}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(run:()=>void,needsFrame:()=>boolean){frameObservers.push({run,needsFrame});}}));
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>key==='watchrss.video-opt.v1'&&optRecovery?{recovery:true,percent:100}:key==='watchrss.video-opt.bucket'?0:undefined,set(){}},lifecycle:()=> 'active'}));
mock.module('@podjs/framework/services',()=>({DOUYIN_AUTH_STATUS_SCRIPT:'test-status-script',video:{captureBackdrop:async()=>{await captureOverride?.();},stop:async()=>{}},videoSessions:{},browserAuth:{},hostOperation(){},secureStorage:{},onNetworkChange:()=>()=>{},delay:(ms:number)=>{let fire!:()=>void;const result=new Promise<void>(resolve=>fire=resolve);entryTimers.push({ms,fire});return {result,cancel(){}};}}));
const entryTimers:Array<{ms:number;fire:()=>void}>=[];
const {captureActivityNavigation,restoreActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
const {MediaRoutes}=await import('../src/ui/routes/media.tsx');
const stops:(()=>void)[]=[];afterEach(()=>stops.splice(0).forEach(stop=>stop()));
const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:'',authorName:id,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
function fixture(opt=false,initial?:any,options?:{historyStorage?:DouyinStateStorage;publish?:(source:PlaybackSource|undefined)=>void}){
 frameObservers.length=0;debugContexts.length=0;debugTicks=0;
 entryTimers.length=0;optRecovery=opt;captureOverride=undefined;readyOverride=undefined;
 preloadWindows=[];canonicalSource=undefined;restoredFrame=undefined;adjacentPreview=undefined;prefetchHooks=undefined;localPaths.clear();invalidated.length=0;lookupOverride=undefined;proxyOverride=undefined;
 const values=new Map<string,string>();let requests=0;
 client=new DouyinClient({historyStorage:options?.historyStorage,secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},transport:{request:async()=>{requests++;throw Error('offline');}}});
 let controller!:ReturnType<typeof createMediaRouteController>,stack!:()=>RouteEntry[],source:any,error!:()=>string;
 createRoot(stop=>{stops.push(stop);const [entries,setStack]=createSignal<RouteEntry[]>([{page:'home'},{page:'douyin',douyinRoute:{name:'history'}}]);stack=entries;
 const [busy,setBusy]=createSignal(false),[message,setError]=createSignal(''),[playing,setPlaying]=createSignal<any>();error=message;
 controller=createMediaRouteController({initialVideoBounds:initial?()=>({x:0,y:0,width:233,height:233}):undefined,createInitialVideoPool:initial?()=>typeof initial==='function'?initial():initial:undefined,current:()=>entries().at(-1)!,motion:{phase:'idle'},busy,setBusy,setError,settings:()=>({mediaVolumeControl:true,mediaVolumeGuard:false,playbackStartVolumeLimit:null}) as any,
 playingSource:playing,setPlayingSource:((v:any)=>{source=typeof v==='function'?v(playing()):v;const result=setPlaying(v);options?.publish?.(source);return result;}) as any,
 channels:()=>[],setChannels:(()=>[]) as any,setOriginalModes:(()=>({})) as any,setStack,setPage:(page,data)=>setStack(rows=>[...rows,{page,...data}]),popPage:()=>{setStack(rows=>rows.slice(0,-1));return true;},services:{} as any});
 });
 return {controller,stack,source:()=>source,error,requests:()=>requests,render(){const entry=stack().at(-1)!;
 createRoot(stop=>{stops.push(stop);return MediaRoutes({entry,page:()=>entry.page,active:()=>true,playingSource:()=>source,backOffset:()=>0,width:233,height:233,round:true,douyinReady(){},changeDouyinVideo:controller.changeDouyinVideo,selectDouyinTarget:controller.selectDouyinTarget} as any);});return playerProps;
 }};
}
test('stock selection uses one validated URI/frame bundle and does not repeat slow native lookups',async()=>{
 const f=fixture(),a=item('a');let readyReads=0;
 client.buildPlaybackHeaders=async()=>{throw Error('redundant secure header read for restored capability');};
 const frame={available:true,kind:'actual_frame',path:'video-frames/fixture.jpg',width:320,height:320,positionMs:0,capturedAt:1,capturedGeneration:0};
 const cached={...a,playUrl:'https://fixture.invalid/cached-hevc',variants:[{playUrl:'https://fixture.invalid/cached-hevc',codec:'h265' as const,width:320,height:240,bitrate:100000}]};
 readyOverride=async()=>{readyReads++;return {item:cached,url:'podjs-media-cache://play/ready.mp4',previewFrame:{entryId:'a',frame}};};
 lookupOverride=async()=>{throw Error('duplicate native stock read');};
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 expect(f.stack().at(-1)?.page).toBe('video');expect(readyReads).toBe(1);expect(f.source().url).toBe('podjs-media-cache://play/ready.mp4');expect(f.source().previewFrame.frame).toEqual(frame);expect(f.source()).toMatchObject({videoMime:'video/hevc',videoWidth:320,videoHeight:240});
 expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe('a');expect(f.requests()).toBe(0);
});

test('entry predecodes verified stock once, and entering adopts that exact hidden pool',async()=>{
 let primed=0,released=0;const pool={prime:()=>{primed++;return {result:Promise.resolve({}),cancel(){}};},releaseAll:async()=>{released++;}};
 const f=fixture(false,pool),a=item('entry-first'),owner={};await f.controller.douyinNavigate({name:'entry'});const entry=f.stack().at(-1)!;
 readyOverride=async()=>({url:'podjs-media-cache://play/entry.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/entry.jpg'}}});
 await f.controller.primeDouyinEntry(entry,owner,[a],null,7);expect(primed).toBe(1);expect(entry.page).toBe('douyin');expect((await client.restorePlaybackQueue()).items).toEqual([]);
 await f.controller.primeDouyinEntry(entry,owner,[a],null,7);expect(primed).toBe(1);
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true,entrySeq:7});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 expect(primed).toBe(1);expect(f.stack().at(-1)?.initialVideoPool).toBe(pool as any);expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe(a.awemeId);
 f.controller.stopDouyinEntry(owner);expect(released).toBe(0);
});
test('stopping or leaving entry fences a late stock lookup before any decoder is allocated',async()=>{
 let primed=0,finish!:(value:any)=>void;const pool={prime:()=>{primed++;return {result:Promise.resolve({}),cancel(){}};},releaseAll:async()=>{}};
 const f=fixture(false,pool),a=item('late-entry'),owner={};await f.controller.douyinNavigate({name:'entry'});const entry=f.stack().at(-1)!;
 readyOverride=()=>new Promise(resolve=>finish=resolve);const warm=f.controller.primeDouyinEntry(entry,owner,[a],null,8);f.controller.stopDouyinEntry(owner);await f.controller.douyinNavigate({name:'history'});
 finish({url:'podjs-media-cache://play/late.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/late.jpg'}}});await warm;expect(primed).toBe(0);expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');
});
test('a changed cache capability or authorization cannot adopt the old entry decoder',async()=>{
 for(const change of ['capability','authorization']){
  let primed=0,released=0,version=1;const pools=Array.from({length:2},()=>({prime:()=>{primed++;return {result:Promise.resolve({}),cancel(){}};},releaseAll:async()=>{released++;}}));let created=0;
  const f=fixture(false,()=>pools[created++]),a=item('changed-'+change),owner={};client.playbackAuthorizationVersion=()=>version;await f.controller.douyinNavigate({name:'entry'});const entry=f.stack().at(-1)!;
  let uri='podjs-media-cache://play/original.mp4';readyOverride=async()=>({url:uri,previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/changed.jpg'}}});
  await f.controller.primeDouyinEntry(entry,owner,[a],null,9);if(change==='capability')uri='podjs-media-cache://play/replaced.mp4';else version++;
  f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true,entrySeq:9});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
  expect(primed).toBe(2);expect(released).toBe(1);expect(f.stack().at(-1)?.initialVideoPool).toBe(pools[1] as any);
 }
});
test('entry never allocates a decoder for remote content or a missing verified first frame',async()=>{
 let primed=0;const pool={prime:()=>{primed++;return {result:Promise.resolve({}),cancel(){}};},releaseAll:async()=>{}};
 const f=fixture(false,pool),a=item('uncached-entry'),owner={};await f.controller.douyinNavigate({name:'entry'});const entry=f.stack().at(-1)!;
 readyOverride=async()=>undefined;await f.controller.primeDouyinEntry(entry,owner,[a],null,10);f.controller.stopDouyinEntry(owner);
 readyOverride=async()=>({url:'https://fixture.invalid/video',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/no.jpg'}}});await f.controller.primeDouyinEntry(entry,owner,[a],null,10);expect(primed).toBe(0);
});
test('initial decoder starts while navigation persistence is pending, and the route receives the same pool',async()=>{
 let primed=0,released=0,finish!:()=>void;const pool={prime:()=>{primed++;return {result:Promise.resolve({}),cancel(){}};},releaseAll:async()=>{released++;}};
 const f=fixture(false,pool),a=item('prime');const save=client.savePlaybackQueue.bind(client);client.savePlaybackQueue=async(...args:any[])=>{await new Promise<void>(yes=>finish=yes);return save(...args as Parameters<typeof save>);};
 readyOverride=async()=>({url:'podjs-media-cache://play/prime.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/prime.jpg'}}});
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});const opened=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});while(!finish)await Promise.resolve();
 expect(primed).toBe(1);expect(f.stack().at(-1)?.page).toBe('douyin');finish();await opened;expect(f.stack().at(-1)?.initialVideoPool).toBe(pool as any);expect(released).toBe(0);
});
test('leaving an entry releases a pending decoder reservation without reopening its player',async()=>{
 let previewReleased=0,released=0,finish!:()=>void;const pool={prime:()=>({result:Promise.resolve({}),cancel(){}}),releaseAll:async()=>{released++;}};
 const f=fixture(false,pool),a=item('leave-prime');const save=client.savePlaybackQueue.bind(client);client.savePlaybackQueue=async(...args:any[])=>{await new Promise<void>(yes=>finish=yes);return save(...args as Parameters<typeof save>);};
 readyOverride=async()=>({url:'podjs-media-cache://play/prime.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/prime.jpg'}}});
 f.controller.douyinPlay({releaseStartupPreview:()=>{previewReleased++;},item:a,playback:a,playlist:[a],hasMore:false,immersive:true});const opened=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});while(!finish)await Promise.resolve();
 await f.controller.douyinNavigate({name:'history'});expect(released).toBeGreaterThan(0);finish();await opened;expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');expect(previewReleased).toBe(1);
});
test('D2 controller persists before opening and restores exact source and current page without detail request',async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];
 f.controller.douyinPlay({item:items[1]!,playback:{...items[1]!,playUrl:'https://fresh/b'},playlist:items,hasMore:false});
 await f.controller.douyinNavigate({name:'player',awemeId:'b'});
 expect(f.stack().at(-1)?.page).toBe('video');expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe('b');
 expect(f.source().url).toBe('https://fresh/b');
 await f.controller.changeDouyinVideo(f.stack().at(-1)!,'next');
 expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe('c');expect(f.requests()).toBe(0);
 expect(await f.controller.restoreDouyinVideo('c')).toBe(true);
 expect(f.stack().at(-1)?.queue?.snapshot().index).toBe(2);expect(f.source().url).toBe('https://video/c');expect(f.requests()).toBe(0);
 expect(await f.controller.restoreDouyinVideo('missing')).toBe(false);
});
test('D2 history single-item recovery failure preserves selection and manual success persists refreshed URL',async()=>{
 const f=fixture(),selected=item('history');
 f.controller.douyinPlay({item:selected,playback:selected,playlist:[selected],hasMore:false,detailPlayback:true});await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
 const entry=f.stack().at(-1)!;let resolutions=0;
 client.resolvePlayback=async()=>{resolutions++;return resolutions===1?{ok:false,code:'REQUEST_FAILED',message:'网络请求失败'}:{ok:true,data:{...selected,playUrl:'https://refreshed/history'}};};
 await f.controller.recoverDouyinVideo(entry);expect(f.error()).toContain('网络请求失败');expect(entry.queue?.snapshot().playlist).toEqual([selected]);
 await f.controller.recoverDouyinVideo(entry);expect(resolutions).toBe(1);
 await f.controller.recoverDouyinVideo(entry,true);expect(f.source().url).toBe('https://refreshed/history');expect(entry.queue?.snapshot().item?.awemeId).toBe('history');
 expect((await client.restorePlaybackQueue()).items[0]?.playUrl).toBe('https://refreshed/history');expect(f.error()).toBe('');
});

test('M1 activity memory and D2 secure queue restore together without leaking source credentials',async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];
 await client.savePlaybackQueue(items,'b','7',false);
 const snapshot=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'douyin',douyinRoute:{name:'history'}},{page:'video',videoTarget:{kind:'douyin',awemeId:'b',immersive:true,detailPlayback:true},memory:{id:'r999',saved:{'player-bluetooth':true,'player-scale':'expanded'},retained:{}},playback:{title:'b',platform:'douyin',awemeId:'b',url:'SIGNED_SECRET',headers:{Cookie:'SECRET'}}}]);
 expect(JSON.stringify(snapshot)).not.toContain('SECRET');
 const restored=restoreActivityNavigation({saved:snapshot.saved,retained:{}})!.at(-1)!;
 expect(restored.videoTarget).toEqual({kind:'douyin',awemeId:'b',immersive:true,detailPlayback:true});
 expect(await f.controller.restoreDouyinVideo('b',true,restored.memory,true)).toBe(true);
 expect(f.stack().map(e=>e.page)).toEqual(['home','douyin','video']);
 expect(f.stack().at(-1)!.memory).toBe(restored.memory);
 expect(f.stack().at(-1)!.memory!.saved['player-bluetooth']).toBe(true);
 expect(f.stack().at(-1)!.queue!.snapshot().index).toBe(1);
 expect(f.source()).toMatchObject({url:'https://video/b',detailPlayback:true,immersive:true});
 expect(f.requests()).toBe(0);
});
test('late credential lookup cannot reopen the restored player after navigation changes',async()=>{
 const f=fixture();await client.savePlaybackQueue([item('a')],'a','0',false);
 let release!:(headers:Record<string,string>)=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 client.buildPlaybackHeaders=()=>{entered();return new Promise(resolve=>{release=resolve;});};
 const pending=f.controller.restoreDouyinVideo('a');await started;
 await f.controller.douyinNavigate({name:'entry'});
 release({Cookie:'current'});
 expect(await pending).toBe(false);expect(f.stack().at(-1)!.page).toBe('douyin');expect(f.source()).toBeUndefined();
});

test('immersive same-item recovery persists refreshed queue before activity checkpoint',async()=>{
 const f=fixture(),selected=item('recover');
 f.controller.douyinPlay({item:selected,playback:selected,playlist:[selected],hasMore:true,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
 client.resolvePlayback=async()=>({ok:true,data:{...selected,playUrl:'https://new/recover'}});
 await f.controller.recoverDouyinVideo(f.stack().at(-1)!);
 expect(f.source().url).toBe('https://new/recover');
 expect((await client.restorePlaybackQueue()).items[0]?.playUrl).toBe('https://new/recover');
});

test('whole-file playback failure invalidates the cached item and retries same selection over network',async()=>{
 const f=fixture(),a=item('cached');localPaths.set(a.awemeId,'managed-cache/douyin-preload/fixture.mp4');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 expect(f.source().url).toBe('managed-cache/douyin-preload/fixture.mp4');
 let refresh=false;client.resolvePlayback=async(id,options)=>{refresh=options?.forceRefresh===true;return {ok:true,data:{...a,playUrl:'https://refreshed/cached'}};};
 const entry=f.stack().at(-1)!;await f.controller.recoverDouyinVideo(entry);
 expect(refresh).toBe(true);expect(invalidated).toEqual(['cached']);expect(f.source().url).toBe('https://refreshed/cached');expect(entry.queue?.snapshot().item?.awemeId).toBe('cached');expect(entry.queue?.snapshot().playlist).toHaveLength(1);expect(entry.queue?.snapshot().item?.playUrl).toBe('https://refreshed/cached');
});

test('a late local-file lookup cannot reopen a restored player after leaving its route',async()=>{
 const f=fixture(),a=item('a');await client.savePlaybackQueue([a],'a',null,false);
 let release!:(path:string|undefined)=>void,entered!:()=>void;const queried=new Promise<void>(resolve=>entered=resolve);lookupOverride=()=>new Promise(resolve=>{release=resolve;entered();});
 const pending=f.controller.restoreDouyinVideo('a',true);
 await Promise.race([queried,pending.then(()=>{throw Error('restore completed before disk lookup');})]);
 await f.controller.douyinNavigate({name:'history'});release('managed-cache/douyin-preload/a.mp4');
 expect(await pending).toBe(false);expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');
});

test('late proxy registration cannot reopen a restored player or publish a departed adjacent source',async()=>{
 const f=fixture(),a=item('a');await client.savePlaybackQueue([a],'a',null,false);
 let release!:(uri:string)=>void,entered!:()=>void;const registered=new Promise<void>(resolve=>entered=resolve);proxyOverride=()=>new Promise(resolve=>{release=resolve;entered();});
 const pending=f.controller.restoreDouyinVideo('a',true);await registered;await f.controller.douyinNavigate({name:'history'});release('podjs-media-cache://play/a.mp4');expect(await pending).toBe(false);expect(f.source()).toBeUndefined();expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');
});

for(const direction of ['next','previous'] as const)test(`failed ${direction} resolution rejects the transition while preserving the playing anchor`,async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')],selected=items[1]!;
 f.controller.douyinPlay({item:selected,playback:selected,playlist:items,hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'b'});
 const entry=f.stack().at(-1)!,source=f.source();client.resolvePlayback=async()=>({ok:false,code:'REQUEST_FAILED',message:'HTTP 403'});
 await expect(f.controller.changeDouyinVideo(entry,direction)).rejects.toThrow('HTTP 403');
 expect(f.error()).toContain('403');expect(entry.queue!.snapshot().item?.awemeId).toBe('b');expect(f.source()).toBe(source);expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe('b');
});

test('failed proxy registration after successful selection rolls the anchor back; retry can select again',async()=>{
 const f=fixture(),a=item('a'),b=item('b');f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!,source=f.source();client.resolvePlayback=async id=>({ok:true,data:id==='a'?a:b});
 proxyOverride=async()=>{throw Error('HTTP 403');};
 await expect(f.controller.changeDouyinVideo(entry,'next')).rejects.toThrow('HTTP 403');
 expect(entry.queue!.snapshot().item?.awemeId).toBe('a');expect(f.source()).toBe(source);expect((await client.restorePlaybackQueue()).anchorAwemeId).toBe('a');
 proxyOverride=async()=> 'podjs-media-cache://play/b.mp4';await f.controller.changeDouyinVideo(entry,'next');expect(f.source().awemeId).toBe('b');expect(entry.queue!.snapshot().item?.awemeId).toBe('b');expect(f.error()).toBe('');
});


test('ready persists only after the paint barrier, and a departed route cannot write late history',async()=>{
 const f=fixture(),a=item('a');f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let writes=0;entry.queue!.settled=async()=>{writes++;};
 f.controller.douyinReady(entry);await Promise.resolve();expect(writes).toBe(0);paintRelease({committed:true});for(let i=0;i<20;i++)await Promise.resolve();expect(writes).toBe(1);
 f.controller.douyinReady(entry);await f.controller.douyinNavigate({name:'history'});paintRelease({committed:true});for(let i=0;i<20;i++)await Promise.resolve();expect(writes).toBe(1);
});

test('actual-frame restoration opens the player while offline resolution fails, without authorizing the saved URL',async()=>{
 const f=fixture(),a=item('a');await client.savePlaybackQueue([a],'a',null,false);
 restoredFrame={available:true,kind:'actual_frame',path:'video-frames/fixture.jpg',width:10,height:10,positionMs:42,capturedAt:1,capturedGeneration:7};
 proxyOverride=async()=>{throw Error('offline');};expect(await f.controller.restoreDouyinVideo('a',true)).toBe(true);
 for(let i=0;i<20;i++)await Promise.resolve();expect(f.source()).toMatchObject({awemeId:'a',previewOnly:true,previewFrame:{entryId:'a',frame:{kind:'actual_frame'}}});expect(f.error()).toContain('offline');
 client.resolvePlayback=async()=>({ok:true,data:{...a,playUrl:'https://fresh/a'}});proxyOverride=async()=> 'podjs-media-cache://play/fresh.mp4';await f.controller.recoverDouyinVideo(f.stack().at(-1)!,true);expect(f.source()).toMatchObject({previewOnly:false,url:'podjs-media-cache://play/fresh.mp4'});
});
test('slow validated playback leaves actual frame immediately visible and late resolution cannot replace a departed route',async()=>{
 const f=fixture(),a=item('a');await client.savePlaybackQueue([a],'a',null,false);restoredFrame={available:true,kind:'actual_frame',path:'video-frames/fixture.jpg',width:10,height:10,positionMs:0,capturedAt:1,capturedGeneration:1};
 let release!:(url:string)=>void;proxyOverride=()=>new Promise(resolve=>release=resolve);expect(await f.controller.restoreDouyinVideo('a',true)).toBe(true);expect(f.source().previewOnly).toBe(true);
 await f.controller.douyinNavigate({name:'history'});const source=f.source();release('proxy-new');for(let i=0;i<20;i++)await Promise.resolve();expect(f.source()).toBe(source);
});
test('prefetch hooks update current source only on exact URI and isolate neighbours without moving current anchor',async()=>{
 const f=fixture(),a=item('a'),b=item('b');f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});const entry=f.stack().at(-1)!;f.controller.douyinReady(entry);
 expect(await prefetchHooks.quarantine('a')).toBe(false);await prefetchHooks.sourceRefreshed('a','obsolete',a,'wrong',{});expect(f.source().url).toBe(a.playUrl);
 await prefetchHooks.sourceRefreshed('a',a.playUrl,{...a,playUrl:'fresh-raw'},'fresh-proxy',{});expect(f.source().url).toBe('fresh-proxy');expect(await prefetchHooks.quarantine('b')).toBe(true);expect(entry.queue!.snapshot()).toMatchObject({index:0,item:{awemeId:'a'}});expect(entry.queue!.snapshot().playlist).toHaveLength(1);
});

test('READY persists the actual registered source so a later exact-binding frame restore can find it',async()=>{
 const f=fixture(),a=item('a');f.controller.douyinPlay({item:a,playback:a,playlist:[a],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 canonicalSource={...a,playUrl:'https://refreshed/source'};const entry=f.stack().at(-1)!;f.controller.douyinReady(entry);paintRelease({committed:true});for(let i=0;i<100;i++)await Promise.resolve();await entry.queue!.persist();
 expect((await client.restorePlaybackQueue()).items[0]?.playUrl).toBe('https://refreshed/source');
});


test('VIDEO-OPT production controller switches same-track CDN before refresh and keeps position',async()=>{
 const f=fixture(true),a={...item('a'),variants:[{playUrl:'https://video/a',playUrls:['https://video/a','https://video/backup'],codec:'h264' as const,bitrate:100,width:640,height:360}]};
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let refreshes=0;client.resolvePlayback=async()=>{refreshes++;return {ok:false,code:'REQUEST_FAILED',message:'offline'};};
 await f.controller.recoverDouyinVideo(entry,false,12345,{code:'cdn_error'});
 expect(f.source()).toMatchObject({url:'https://video/backup',resumePositionMs:12345});expect(refreshes).toBe(0);expect(entry.queue!.snapshot().item?.awemeId).toBe('a');expect(f.error()).toBe('');
});

test('VIDEO-OPT rejects late same-item resolution after queue generation changes',async()=>{
 const f=fixture(true),a=item('a');f.controller.douyinPlay({item:a,playback:a,playlist:[a],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let finish!:(v:any)=>void;client.resolvePlayback=()=>new Promise(r=>finish=r);
 const before=f.source(),pending=f.controller.recoverDouyinVideo(entry,false,7000);entry.queue!.restoreSelection('a');finish({ok:true,data:{...a,playUrl:'https://video/fresh'}});await pending;
 expect(f.source()).toBe(before);expect(entry.queue!.snapshot().item?.playUrl).toBe(a.playUrl);
});


test('temporary API throttling never consumes the controller media-failure quarantine budget',async()=>{
 const f=fixture(),a=item('a');f.controller.douyinPlay({item:a,playback:a,playlist:[a],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 let calls=0;client.resolvePlayback=async()=>{calls++;return {ok:false,code:'RATE_LIMITED',message:'抖音暂时不可用，稍后自动重试',retryAfterMs:30000};};
 const entry=f.stack().at(-1)!;await f.controller.recoverDouyinVideo(entry);await f.controller.recoverDouyinVideo(entry,true);
 expect(entry.queue!.snapshot().item?.awemeId).toBe('a');expect(entry.queue!.snapshot().playlist).toHaveLength(1);expect(calls).toBe(2);expect(f.error()).toBe('抖音暂时不可用，稍后自动重试');
});

for(const opt of [false,true])test(`DYFIX three consecutive playback failures stop with retry, first frame resets budget (opt=${opt})`,async()=>{
 const f=fixture(opt),items=['a','b','c','d','e'].map(item);f.controller.douyinPlay({item:items[0]!,playback:items[0]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let resolutions=0;client.resolvePlayback=async(id)=>{resolutions++;return {ok:true,data:item(id)};};
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'decode_error'});expect(entry.queue!.snapshot().item?.awemeId).toBe('b');
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'decode_error'});expect(entry.queue!.snapshot().item?.awemeId).toBe('c');
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'decode_error'});expect(entry.queue!.snapshot().item?.awemeId).toBe('c');expect(resolutions).toBe(2);expect(f.error()).toBe('连续播放失败，请重试');
 f.controller.douyinReady(entry);await f.controller.recoverDouyinVideo(entry,false,0,{code:'decode_error'});expect(entry.queue!.snapshot().item?.awemeId).toBe('d');
 await f.controller.recoverDouyinVideo(entry,true);expect(f.error()).toBe('');
});
test('DYFIX restricted proxy foreground force-refreshes once then skips; network failure tries candidate and preserves queue',async()=>{
 const f=fixture(),a=item('a'),b=item('b');f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;entry.playback={...entry.playback!,url:'podjs-media-cache://play/a.mp4'};const calls:any[]=[];client.resolvePlayback=async(id,options)=>{calls.push([id,options?.forceRefresh]);return {ok:true,data:item(id)};};
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'network_error'});expect(calls).toEqual([]);expect(entry.queue!.snapshot().item?.awemeId).toBe('a');expect(f.error()).toBe('');expect(f.source().url).toBe(a.playUrl);
 entry.queue!.resetAutomaticFailures();
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'restricted'});expect(calls).toEqual([['a',true]]);expect(entry.queue!.snapshot().item?.awemeId).toBe('a');
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'restricted'});expect(calls).toEqual([['a',true],['b',false]]);expect(entry.queue!.snapshot().item?.awemeId).toBe('b');
});
test('DYFIX REQUEST_FAILED during forced recovery never discards or spends media quarantine',async()=>{
 const f=fixture(),a=item('a');f.controller.douyinPlay({item:a,playback:a,playlist:[a,item('b')],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;client.resolvePlayback=async()=>({ok:false,code:'REQUEST_FAILED',message:'网络请求失败'});
 await f.controller.recoverDouyinVideo(entry);await f.controller.recoverDouyinVideo(entry);expect(entry.queue!.snapshot().item?.awemeId).toBe('a');expect(entry.queue!.diagnostics().quarantinedAwemeIds).toEqual([]);expect(entry.douyinFailures?.size).toBe(0);
});

test('DYLOGIN route login dispatches before secure playback reads and captures Cookie only after completion',async()=>{
 const f=fixture();let reads=0;
 client.buildPlaybackHeaders=()=>{reads++;return new Promise(()=>{});};
 const pending=f.controller.douyinLogin();await Promise.resolve();
 expect(reads).toBe(0);expect(loginOptions).toMatchObject({url:'https://www.douyin.com/chat?isPopup=1',cookieOrigin:'https://www.douyin.com',requiredCookieNames:['sessionid'],qrExtractionScript:'test-status-script',completeOnLoginPanelHidden:true});
 expect(loginOptions.qrWait.message).toContain('正在加载');expect(typeof loginOptions.onStatus).toBe('function');
 expect(await client.readCookie()).toBeNull();
 completeLogin({cookie:'sessionid=fixture',origin:'https://www.douyin.com'});await pending;
 expect(await client.readCookie()).toBe('sessionid=fixture');expect(f.stack().at(-1)?.douyinRoute).toEqual({name:'entry'});
});

test('PREWARM production controller resolves next and previous concurrently and keeps the playing anchor',async()=>{
 const f=fixture(),a=item('a'),b=item('b'),c=item('c');f.controller.douyinPlay({item:b,playback:b,playlist:[a,b,c],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'b'});
 const entry=f.stack().at(-1)!,pending=new Map<string,(value:any)=>void>();client.resolvePlayback=(id:string)=>new Promise(resolve=>pending.set(id,resolve));
 const next=f.controller.prepareDouyinAdjacent(entry,'next'),previous=f.controller.prepareDouyinAdjacent(entry,'previous');
 for(let n=0;n<20;n++)await Promise.resolve();
 pending.get('a')!({ok:true,data:a});pending.get('c')!({ok:true,data:c});
 expect((await next)?.key).toBe('c');expect((await previous)?.key).toBe('a');expect(entry.queue!.snapshot().item?.awemeId).toBe('b');expect(f.source().awemeId).toBe('b');
});

for(const code of ['TEMPORARILY_UNAVAILABLE','REQUEST_FAILED'] as const)test(`DYERR foreground ${code} returns structured failure to the entry`,async()=>{
 const f=fixture(),selected=item('retry'),failures:any[]=[];
 proxyOverride=async()=>{throw Object.assign(Error('private upstream text'),{code,retryAfterMs:45000});};
 f.controller.douyinPlay({item:selected,playback:selected,immersive:true,onFailure:value=>failures.push(value)});
 await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
 expect(failures).toEqual([{code,retryAfterMs:45000}]);expect(f.error()).toBe('');expect(f.stack().at(-1)?.page).toBe('douyin');
 proxyOverride=async()=>selected.playUrl;f.controller.douyinPlay({item:selected,playback:selected,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});expect(f.stack().at(-1)?.page).toBe('video');
});

test('DYERR obsolete foreground failure cannot overwrite another route',async()=>{
 const f=fixture(),selected=item('stale'),failures:any[]=[];let reject!:(reason:any)=>void;
 proxyOverride=()=>new Promise((_resolve,no)=>reject=no);
 f.controller.douyinPlay({item:selected,playback:selected,immersive:true,onFailure:value=>failures.push(value)});
 const work=f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
 while(!reject)await Promise.resolve();await f.controller.douyinNavigate({name:'settings'});
 reject(Object.assign(Error('private'),{code:'REQUEST_FAILED'}));await work;
 expect(failures).toEqual([]);expect(f.error()).toBe('');expect(f.stack().at(-1)?.douyinRoute?.name).toBe('settings');
});

test('DYERR first card requests a native commit only after decoded frame and cancels after navigation',async()=>{
 const before=(globalThis as any).pod,events:any[]=[];(globalThis as any).pod={benchmark:(raw:string)=>{const e=JSON.parse(raw);events.push(e);return e.seq??900;}};
 try{
  const f=fixture(),selected=item('card');f.controller.douyinPlay({item:selected,playback:selected,immersive:true,entrySeq:899});
  await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});expect(events.some(e=>e.code==='first_card')).toBe(false);
  f.controller.douyinReady(f.stack().at(-1)!);expect(events.some(e=>e.code==='first_card'&&e.presented)).toBe(true);
  paintRelease({committed:true});for(let i=0;i<50;i++)await Promise.resolve();
  expect(events.filter(e=>e.code==='first_card'&&e.presented)).toEqual([{code:'first_card',seq:899,presented:true}]);
  await f.controller.douyinNavigate({name:'entry'});expect(events.some(e=>e.code==='first_card'&&e.cancel_presented&&e.seq===899)).toBe(true);
 }finally{(globalThis as any).pod=before;}
});


test('DYERR expired entry action cannot open after backdrop capture completes',async()=>{
 const f=fixture(),selected=item('late');let complete!:()=>void,current=true;
 captureOverride=()=>new Promise<void>(resolve=>complete=resolve);
 f.controller.douyinPlay({item:selected,playback:selected,immersive:true,isCurrent:()=>current});
 const pending=f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
 for(let i=0;i<100&&!complete;i++)await new Promise(resolve=>setTimeout(resolve,0));expect(complete).toBeFunction();current=false;complete();await pending;
 expect(f.stack().at(-1)?.page).toBe('douyin');expect(f.source()).toBeUndefined();
});

test('unclassified foreground prepare failure uses playback copy and does not become a network retry',async()=>{
 const f=fixture(),selected=item('prepare'),failures:any[]=[];
 proxyOverride=async()=>{throw Object.assign(Error('unknown_video_session PRIVATE'),{name:'HostServiceError',code:'invalid_argument'});};
 f.controller.douyinPlay({item:selected,playback:selected,immersive:true,onFailure:value=>failures.push(value)});
 await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});expect(failures).toEqual([{code:'PLAYBACK_FAILED'}]);expect(f.stack().at(-1)?.page).toBe('douyin');
});

test('DYSWIPE3 neighbours reuse playing headers and coalesce a fresh read after authorization changes',async()=>{
 const f=fixture(),a=item('a'),b=item('b'),c=item('c');f.controller.douyinPlay({item:b,playback:b,playlist:[a,b,c],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'b'});
 const entry=f.stack().at(-1)!;let reads=0,authorization=0;
 client.resolvePlayback=async id=>({ok:true,data:[a,b,c].find(v=>v.awemeId===id)!});
 client.playbackAuthorizationVersion=()=>authorization;
 client.buildPlaybackHeaders=async()=>{reads++;return {'X-Fixture':'fresh'};};
 await Promise.all([f.controller.prepareDouyinAdjacent(entry,'next'),f.controller.prepareDouyinAdjacent(entry,'previous')]);expect(reads).toBe(0);
 authorization++;
 const sources=await Promise.all([f.controller.prepareDouyinAdjacent(entry,'next'),f.controller.prepareDouyinAdjacent(entry,'previous')]);expect(reads).toBe(1);expect(sources.every(v=>v?.source.headers?.['X-Fixture']==='fresh')).toBe(true);
});

test('stock playback prewarms adjacent sources with public headers and preserved rendition metadata',async()=>{
 const f=fixture(),a=item('stock'),b=item('adjacent');
 const variant={playUrl:'https://fixture.invalid/360',codec:'h264' as const,width:360,height:640,bitrate:100};
 const cached={...b,playUrl:variant.playUrl,variants:[variant]};
 readyOverride=async()=>({item:a,url:'podjs-media-cache://play/stock.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true}}});
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});
 await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;
 expect(f.source().headers).toEqual({});
 let reads=0;
 const headers={'User-Agent':'fixture-public'};
 client.buildPlaybackHeaders=async()=>{reads++;return headers;};
 let options:unknown;
 proxyOverride=async(_item,actual,mode)=>{options={actual,mode};return 'podjs-media-cache://play/adjacent.mp4';};
 canonicalSource=cached;
 const prepared=await f.controller.prepareDouyinAdjacent(entry,'next');
 expect(reads).toBe(1);
 expect(options).toEqual({actual:headers,mode:'prewarm'});
 expect(prepared?.source).toMatchObject({videoMime:'video/avc',videoWidth:360,videoHeight:640});
 expect(prepared?.attemptedUrl).toBe(variant.playUrl);
 expect(prepared?.source.previewFrame).toBeUndefined();
 const local='file:///fixture/adjacent.mp4';
 localPaths.set(b.awemeId,local);
 const preview={entryId:b.awemeId,frame:{available:true as const,kind:'actual_frame' as const,path:'video-frames/adjacent.jpg',
  width:360,height:640,positionMs:0,capturedAt:0,capturedGeneration:1}};
 adjacentPreview=(item,uri)=>{expect(item.awemeId).toBe(b.awemeId);expect(uri).toBe(local);return preview;};
 const localPrepared=await f.controller.prepareDouyinAdjacent(entry,'next');
 expect(localPrepared?.source.previewFrame).toEqual(preview);
 expect(f.requests()).toBe(0);
});

test('T1202 cold paging reuses the route headers while secure storage is busy',async()=>{
 const f=fixture(),a=item('a'),b=item('b');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let reads=0;
 client.buildPlaybackHeaders=()=>{reads++;return new Promise(()=>{});};
 const result=await Promise.race([f.controller.changeDouyinVideo(entry,'next').then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
 expect(result).toBe(true);expect(reads).toBe(0);expect(f.source().awemeId).toBe('b');
});
test('T1202 cold paging refreshes shared headers once when authorization changes',async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];
 f.controller.douyinPlay({item:items[0]!,playback:items[0]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let reads=0,authorization=0;
 client.playbackAuthorizationVersion=()=>authorization;
 client.buildPlaybackHeaders=async()=>{reads++;return {'X-Fixture':'changed'};};
 await f.controller.changeDouyinVideo(entry,'next');expect(reads).toBe(0);
 authorization++;
 await f.controller.changeDouyinVideo(entry,'next');expect(reads).toBe(1);expect(f.source().headers['X-Fixture']).toBe('changed');
});

test('DYINTENT selects through delayed URL registration and rejects every stale publication',async()=>{
 const f=fixture(),items=Array.from({length:60},(_,i)=>item(String(i)));
 f.controller.douyinPlay({item:items[0]!,playback:items[0]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'0'});
 const entry=f.stack().at(-1)!,pending=new Map<string,(url:string)=>void>();
 proxyOverride=async value=>new Promise(resolve=>pending.set(value.awemeId,resolve));
 for(let n=1;n<=50;n++){
  f.controller.selectDouyinTarget(entry,'next',1);
  expect(entry.queue!.snapshot().index).toBe(n);expect(f.source()).toMatchObject({awemeId:String(n),previewOnly:true,url:undefined,previewFrame:undefined});
  for(let k=0;k<20;k++)await Promise.resolve();
 }
 expect(pending.size).toBe(50);
 for(const [id,finish] of pending)if(id!=='50')finish('https://local/'+id);
 for(let k=0;k<30;k++)await Promise.resolve();expect(f.source()).toMatchObject({awemeId:'50',previewOnly:true,url:undefined});
 pending.get('50')!('https://local/50');for(let k=0;k<30;k++)await Promise.resolve();expect(f.source()).toMatchObject({awemeId:'50',previewOnly:false,url:'https://local/50'});expect(f.requests()).toBe(0);
});

for(const path of ['intent','legacy'] as const)test(`DYBACK ${path} reverse boundary exits once to the cover`,async()=>{
 const f=fixture(),a=item('a'),b=item('b');await f.controller.douyinNavigate({name:'entry'});
 const cover=f.stack().at(-1)!;
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!,depth=f.stack().length;
 for(let n=0;n<50;n++){
  if(path==='intent')f.controller.selectDouyinTarget(entry,'previous',1);
  else await f.controller.changeDouyinVideo(entry,'previous');
 }
 expect(f.stack()).toHaveLength(depth-1);expect(f.stack().at(-1)).toBe(cover);expect(cover.douyinRoute?.name).toBe('entry');expect(f.requests()).toBe(0);
});

for(const path of ['intent','legacy'] as const)test(`DYBACK ${path} restored queue traverses earlier history before exiting`,async()=>{
 const f=fixture(),items=[item('older'),item('anchor'),item('later')];await f.controller.douyinNavigate({name:'entry'});
 const cover=f.stack().at(-1)!;
 await client.savePlaybackQueue(items,'anchor','0',false);
 expect(await f.controller.restoreDouyinVideo('anchor',true)).toBe(true);
 const entry=f.stack().at(-1)!;expect(entry.queue!.snapshot().index).toBe(1);
 const previous=async()=>{if(path==='intent'){f.controller.selectDouyinTarget(entry,'previous',1);for(let n=0;n<50;n++)await Promise.resolve();}else await f.controller.changeDouyinVideo(entry,'previous');};
 await previous();expect(f.stack().at(-1)).toBe(entry);expect(entry.queue!.snapshot().item?.awemeId).toBe('older');expect(f.source().awemeId).toBe('older');
 await previous();expect(f.stack().at(-1)).toBe(cover);expect(f.requests()).toBe(0);
});

test('DYBACK index zero of a restored truncated queue exits without inventing older history',async()=>{
 const f=fixture(),a=item('restored-first');await f.controller.douyinNavigate({name:'entry'});const cover=f.stack().at(-1)!;
 await client.savePlaybackQueue([a,item('later')],a.awemeId,'12',false);
 expect(await f.controller.restoreDouyinVideo(a.awemeId,true)).toBe(true);
 const entry=f.stack().at(-1)!;f.controller.selectDouyinTarget(entry,'previous',2);
 expect(f.stack().at(-1)).toBe(cover);expect(f.requests()).toBe(0);
});

test('DYBACK two-item reverse fling clamps to the earliest item before the next gesture exits',async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];await f.controller.douyinNavigate({name:'entry'});const cover=f.stack().at(-1)!;
 f.controller.douyinPlay({item:items[1]!,playback:items[1]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'b'});
 const entry=f.stack().at(-1)!;f.controller.selectDouyinTarget(entry,'previous',2);
 expect(f.stack().at(-1)).toBe(entry);expect(entry.queue!.snapshot().item?.awemeId).toBe('a');
 f.controller.selectDouyinTarget(entry,'previous',1);expect(f.stack().at(-1)).toBe(cover);
});

test('DYBACK nonimmersive single detail keeps its route at the previous boundary',async()=>{
 const f=fixture(),a=item('detail');f.controller.douyinPlay({item:a,playback:a,playlist:[a],immersive:false,hasMore:false,detailPlayback:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;f.controller.selectDouyinTarget(entry,'previous',1);expect(f.stack().at(-1)).toBe(entry);
});

test('DYSWAP selecting a decoded neighbour publishes its authorized source synchronously',async()=>{
 const f=fixture(),a=item('a'),b=item('b');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!,prepared=await f.controller.prepareDouyinAdjacent(entry,'next');expect(prepared).toBeDefined();
 lookupOverride=()=>new Promise(()=>{});proxyOverride=()=>new Promise(()=>{});
 (f.controller.selectDouyinTarget as any)(entry,'next',1,prepared);
 expect(entry.queue!.snapshot().index).toBe(1);expect(f.source()).toBe(prepared!.source);
 expect(f.source().previewOnly).not.toBe(true);expect(f.requests()).toBe(0);
 lookupOverride=undefined;proxyOverride=undefined;
});

test('DYSWAP changed authorization rejects the retained neighbour source',async()=>{
 const f=fixture(),a=item('a'),b=item('b');let authorization=0;client.playbackAuthorizationVersion=()=>authorization;
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!,prepared=await f.controller.prepareDouyinAdjacent(entry,'next');authorization++;
 lookupOverride=()=>new Promise(()=>{});
 f.controller.selectDouyinTarget(entry,'next',1,prepared);
 expect(entry.queue!.snapshot().index).toBe(1);expect(f.source()).not.toBe(prepared!.source);expect(f.source().previewOnly).toBe(true);
 lookupOverride=undefined;
});

test('DYHIT a refill index shift keeps the same adjacent source during a slow native lookup',async()=>{
 const f=fixture(),a=item('a'),b=item('b'),z=item('z');
 f.controller.douyinPlay({item:a,playback:a,playlist:[z,a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const {DouyinPlaybackQueue}=await import('../src/douyin/playback-queue.ts');
 const entry=f.stack().at(-1)!;entry.queue=new DouyinPlaybackQueue(client,{items:[z,a,b],selectedAwemeId:'a',hasMore:true,limit:3});
 client.fetchFeedPage=async()=>({ok:true,data:{items:[item('c')],nextCursor:'c1',hasMore:true}});
 let release!:(uri:string)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);lookupOverride=()=>new Promise(resolve=>{release=resolve;entered();});
 const pending=f.controller.prepareDouyinAdjacent(entry,'next');await started;await entry.queue.fillAhead();
 expect(entry.queue.snapshot().index).toBe(0);release('podjs-media-cache://fixture/b');const prepared=await pending;
 expect(prepared?.key).toBe('b');expect(prepared?.queueIndex).toBe(1);expect(prepared?.anchorIndex).toBe(0);lookupOverride=undefined;
});


test('DYMEM2 a full 80-item pager publishes refilled neighbours without another gesture',async()=>{
 const f=fixture(),items=Array.from({length:80},(_,i)=>item(String(i)));let release!:(value:any)=>void,requests=0;
 client.fetchFeedPage=async()=>{requests++;return new Promise(resolve=>release=resolve);};
 f.controller.douyinPlay({item:items[70]!,playback:items[70]!,playlist:items,immersive:true,hasMore:true});
 await f.controller.douyinNavigate({name:'player',awemeId:'70'});const entry=f.stack().at(-1)!;
 f.controller.douyinReady(entry);expect(preloadWindows.at(-1)?.at(-1)).toBe('79');
 release({ok:true,data:{items:Array.from({length:12},(_,i)=>item(String(80+i))),nextCursor:'92',hasMore:false}});
 for(let i=0;i<30;i++)await Promise.resolve();
 expect(entry.queue!.snapshot().playlist).toHaveLength(80);expect(entry.queue!.snapshot().item?.awemeId).toBe('70');
 expect(preloadWindows.at(-1)).toHaveLength(80);expect(preloadWindows.at(-1)?.at(-1)).toBe('91');expect(requests).toBe(1);
});


test('DYBACK production MediaRoutes admits a cover exit only for an immersive boundary',async()=>{
 const f=fixture(),a=item('route');await f.controller.douyinNavigate({name:'entry'});const cover=f.stack().at(-1)!;
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,item('next')],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!,props=f.render();expect(props.canSelectTarget('previous')).toBe(true);
 expect(props.onAdjacentKey('previous')).toBeUndefined();expect(props.onAdjacentKey('next')).toBe('next');
 entry.playback={...entry.playback!,immersive:false};expect(props.canSelectTarget('previous')).toBe(false);
 entry.playback={...entry.playback!,immersive:true};props.onSelectTarget('previous',1);expect(f.stack().at(-1)).toBe(cover);
});

test('DYWAIT verified offline entry opens while playback persistence is held by storage',async()=>{
 const f=fixture(),a=item('offline-entry'),original=client.savePlaybackQueue.bind(client);let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);client.savePlaybackQueue=async(...args)=>{await gate;return original(...args);};
 readyOverride=async()=>({item:{...a,playUrl:'file:///verified/offline.mp4'},url:'file:///verified/offline.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/offline.jpg'}}});
 try{
  f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});const opening=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
  for(let i=0;i<40;i++)await new Promise(r=>setTimeout(r,0));
  expect(f.stack().at(-1)?.page).toBe('video');expect(f.source().url).toBe('file:///verified/offline.mp4');
  release();await opening;
 }finally{release();client.savePlaybackQueue=original;}
});


for(const leave of [false,true])test(`DYWAIT cached queue enters while cookie headers are blocked; leave=${leave}`,async()=>{
 const f=fixture(),a=item('cached-cookie');let finish!:(v:Record<string,string>)=>void;
 client.buildPlaybackHeaders=()=>new Promise(resolve=>finish=resolve);
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});const opening=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 for(let i=0;i<10;i++)await Promise.resolve();const timer=entryTimers.find(t=>t.ms===200);expect(timer).toBeDefined();timer!.fire();await opening;
 const entry=f.stack().at(-1)!;expect(entry.page).toBe('video');expect(f.source()).toMatchObject({previewOnly:true,awemeId:a.awemeId});expect(f.source().url).toBeUndefined();
 if(leave)await f.controller.douyinNavigate({name:'history'});finish({});for(let i=0;i<30;i++)await Promise.resolve();
 if(leave)expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');else {expect(f.stack().at(-1)).toBe(entry);expect(f.source()).toMatchObject({awemeId:a.awemeId,previewOnly:false,url:a.playUrl});}
});

for(const leave of [false,true])test(`DYWAIT-B late cookie failure belongs only to its selected player; leave=${leave}`,async()=>{
 const f=fixture(),a=item('late-cookie');let reject!:(error:unknown)=>void,covers=0;
 client.buildPlaybackHeaders=()=>new Promise((_resolve,no)=>reject=no);
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true,onFailure:()=>{covers++;}});const opening=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 for(let i=0;i<10;i++)await Promise.resolve();entryTimers.find(t=>t.ms===200)!.fire();await opening;const entry=f.stack().at(-1)!;
 if(leave)await f.controller.douyinNavigate({name:'history'});reject({code:'network_error'});for(let i=0;i<30;i++)await Promise.resolve();
 expect(covers).toBe(0);expect(f.error()).toBe('');
 if(leave){expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');expect(entry.playback?.preparationError).toBeUndefined();}
 else {expect(f.stack().at(-1)).toBe(entry);expect(f.source().preparationError).toMatchObject({code:'network_error'});}
});

for(const late of [false,true])test(`R08 cold selected target exposes a terminal failure; stale=${late}`,async()=>{
 const f=fixture(),items=[item('one'),item('two'),item('three')];
 f.controller.douyinPlay({item:items[0],playback:items[0],playlist:items,hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'one'});
 let reject!:(error:any)=>void;proxyOverride=async i=>i.awemeId==='two'?new Promise((_resolve,fail)=>reject=fail):i.playUrl;
 const entry=f.stack().at(-1)!;f.controller.selectDouyinTarget(entry,'next',1);
 for(let n=0;!reject&&n<100;n++)await Promise.resolve();expect(reject).toBeDefined();expect(f.source()).toMatchObject({awemeId:'two',previewOnly:true});
 if(late){f.controller.selectDouyinTarget(entry,'next',1);for(let n=0;n<100;n++)await Promise.resolve();}
 reject(Object.assign(Error('offline fixture'),{code:'network_error'}));for(let n=0;n<100;n++)await Promise.resolve();
 if(late){expect(f.source().awemeId).toBe('three');expect(f.source().preparationError).toBeUndefined();}
 else {expect(f.source()).toMatchObject({awemeId:'two',previewOnly:true,preparationError:{code:'network_error'}});expect(entry.playback).toBe(f.source());}
});

for(const direction of ['next','previous'] as const)for(const distance of [1,2] as const)for(const stage of ['headers','lookup','registration'] as const)test(`DECAP R08 ${direction} ${distance} ${stage} failure belongs to the cold selected source`,async()=>{
 const f=fixture(),items=Array.from({length:5},(_,i)=>item(String(i))),failure={code:'network_error'};
 f.controller.douyinPlay({item:items[2]!,playback:items[2]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'2'});
 const entry=f.stack().at(-1)!;
 if(stage==='headers'){await f.controller.prepareDouyinAdjacent(entry,'next');const version=client.playbackAuthorizationVersion();client.playbackAuthorizationVersion=()=>version+1;client.buildPlaybackHeaders=async()=>{throw failure;};}
 if(stage==='lookup')lookupOverride=async()=>{throw failure;};
 if(stage==='registration')proxyOverride=async()=>{throw failure;};
 f.controller.selectDouyinTarget(entry,direction,distance);for(let i=0;i<40;i++)await Promise.resolve();
 const key=String(2+(direction==='next'?distance:-distance));
 expect(f.stack().at(-1)).toBe(entry);expect(f.source()).toMatchObject({awemeId:key,previewOnly:true,preparationError:failure});expect(f.source().url).toBeUndefined();expect(f.requests()).toBe(0);
});
for(const stale of ['new-selection','route-exit','queue-replaced'] as const)test(`DECAP R08 stale failure cannot overwrite ${stale}`,async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];
 f.controller.douyinPlay({item:items[0]!,playback:items[0]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;let reject!:(v:unknown)=>void;proxyOverride=async()=>new Promise((_yes,no)=>reject=no);
 f.controller.selectDouyinTarget(entry,'next',1);for(let i=0;i<30;i++)await Promise.resolve();expect(reject).toBeDefined();
 if(stale==='new-selection'){proxyOverride=async value=>value.playUrl;f.controller.selectDouyinTarget(entry,'next',1);for(let i=0;i<30;i++)await Promise.resolve();}
 else if(stale==='route-exit')await f.controller.douyinNavigate({name:'history'});
 else entry.queue={snapshot:()=>({item:items[1]})} as any;
 const selected=f.source();reject({code:'network_error'});for(let i=0;i<40;i++)await Promise.resolve();
 expect(f.source()).toBe(selected);expect(f.source()?.preparationError).toBeUndefined();expect(f.error()).toBe('');expect(f.requests()).toBe(0);
});
test('DECAP R08 retry replaces the failed cold source and a subsequent selection clears its error',async()=>{
 const f=fixture(),items=[item('a'),item('b'),item('c')];
 f.controller.douyinPlay({item:items[0]!,playback:items[0]!,playlist:items,immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!;proxyOverride=async()=>{throw {code:'network_error'};};
 f.controller.selectDouyinTarget(entry,'next',1);for(let i=0;i<40;i++)await Promise.resolve();expect(f.source().preparationError).toBeDefined();
 client.resolvePlayback=async()=>({ok:true,data:items[1]!});proxyOverride=async value=>value.playUrl;
 await f.controller.recoverDouyinVideo(entry,true);expect(f.source()).toMatchObject({awemeId:'b',previewOnly:false,url:items[1]!.playUrl});
 f.controller.selectDouyinTarget(entry,'next',1);expect(f.source()).toMatchObject({awemeId:'c',previewOnly:true});expect(f.source().preparationError).toBeUndefined();
 for(let i=0;i<40;i++)await Promise.resolve();expect(f.source()).toMatchObject({awemeId:'c',previewOnly:false});expect(f.requests()).toBe(0);
});

test('native resolution rejection supersedes an in-flight mirror refresh and advances the queue',async()=>{
 const f=fixture(true),a=item('over-limit'),b=item('next-safe');
 const save=client.savePlaybackQueue.bind(client);let savedForNext:string[]|undefined;
 client.savePlaybackQueue=async(items,anchor,cursor,more)=>{
  if(anchor===b.awemeId)savedForNext=items.map(value=>value.awemeId);
  return save(items,anchor,cursor,more);
 };
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;
 let release!:()=>void;
 client.resolvePlayback=async id=>{
  if(id===a.awemeId){
   await new Promise<void>(resolve=>{release=resolve;});
   return {ok:true,data:{...a,playUrl:'https://fixture.invalid/late-mirror'}};
  }
  return {ok:true,data:b};
 };
 const refreshing=f.controller.recoverDouyinVideo(entry,false,0,{status:410});
 for(let i=0;!release&&i<100;i++)await Promise.resolve();
 expect(release).toBeDefined();
 await f.controller.recoverDouyinVideo(entry,false,0,{code:'resolution_limit'});
 expect(f.source()).toMatchObject({awemeId:b.awemeId,url:b.playUrl,maxVideoShortEdge:720});
 expect(entry.queue?.diagnostics().quarantinedAwemeIds).toContain(a.awemeId);
 release();await refreshing;
 expect(f.source().url).toBe(b.playUrl);
 expect(savedForNext).toEqual([b.awemeId]);
});


test('RVRESCAP-04 restored preview skips a native resolution rejection',async()=>{
  const f=fixture(),a=item('bad-restored'),b=item('next-restored');
  const save=client.savePlaybackQueue.bind(client);
  let savedNext!:()=>void;
  const saved=new Promise<void>(resolve=>savedNext=resolve);
  client.savePlaybackQueue=async(items,anchor,cursor,more)=>{
    await save(items,anchor,cursor,more);
    if(anchor===b.awemeId)savedNext();
  };
  const resolve=client.resolvePlayback.bind(client);
  client.resolvePlayback=(id,options)=>id===b.awemeId?Promise.resolve({ok:true,data:b}):resolve(id,options);
  await client.savePlaybackQueue([a,b],a.awemeId,null,false);
  restoredFrame={available:true,kind:'actual_frame',path:'video-frames/review.jpg'};
  let reject!:(error:unknown)=>void;
  proxyOverride=(selected)=>selected.awemeId===a.awemeId
    ? new Promise((_resolve,fail)=>{reject=fail;})
    : Promise.resolve(selected.playUrl);
  expect(await f.controller.restoreDouyinVideo(a.awemeId,true)).toBe(true);
  const entry=f.stack().at(-1)!;
  expect(f.source()).toMatchObject({awemeId:a.awemeId,previewOnly:true});
  reject(Object.assign(Error('native size 1080x1920'),{code:'resolution_limit'}));
  for(let n=0;n<100&&f.source()?.awemeId===a.awemeId;n++)await new Promise(resolve=>setTimeout(resolve,1));
  expect(entry.queue?.snapshot().item?.awemeId).toBe(b.awemeId);
  expect(entry.queue?.snapshot().playlist.map(x=>x.awemeId)).toEqual([b.awemeId]);
  expect(f.source()).toMatchObject({awemeId:b.awemeId,url:b.playUrl,previewOnly:false});
  await saved;
  expect(f.requests()).toBe(0);
});

test('RVRESCAP-01 RSS direct Douyin CDN carries the short-edge cap',async()=>{
  const f=fixture(),cdn='https://v3-dy-o.zjcdn.com/fixture-1080.mp4';
  await f.controller.openRssVideo({id:'review',link:'https://rss.invalid/post',title:'fixture'} as any,cdn);
  expect(f.source()).toMatchObject({platform:'rss',url:cdn});
  expect(f.source().maxVideoShortEdge).toBe(720);
  expect(f.requests()).toBe(0);
});

test('RVRESCAP-01 normalized protocol-relative Douyin address keeps the cap',async()=>{
  const f=fixture(),common={id:'review',link:'https://rss.invalid/post',title:'fixture'} as any;
  const url='https://www.douyin.com/fixture-1080.mp4';
  await f.controller.openRssVideo(common,url);
  expect(f.source()).toMatchObject({url,maxVideoShortEdge:720});
  await f.controller.openRssVideo(common,url.slice('https:'.length));
  expect(f.source()).toMatchObject({url,platform:'rss'});
  expect(f.source().maxVideoShortEdge).toBe(720);
  expect(f.requests()).toBe(0);
});

test('RVRESCAP-04 immediate cold-start rejection opens the next item',async()=>{
 const f=fixture(),a=item('fast-rejected'),b=item('fast-safe');
 client.resolvePlayback=async()=>({ok:true,data:b});
 proxyOverride=async selected=>{
  if(selected.awemeId===a.awemeId)throw Object.assign(new Error('fixture oversized'),{code:'resolution_limit'});
  return selected.playUrl;
 };
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 expect(f.source()).toMatchObject({awemeId:b.awemeId,url:b.playUrl,previewOnly:false});
 expect(f.stack().at(-1)?.queue?.snapshot().playlist.map(item=>item.awemeId)).toEqual([b.awemeId]);
 expect(f.requests()).toBe(0);
});

test('RVRESCAP3-07 rejecting a 480-labeled adjacent source preserves its compliant 360 alternative',async()=>{
  const f=fixture(),a=item('start-review'),b=item('adjacent-review');
  const bad={playUrl:b.playUrl,codec:'h264' as const,width:480,height:854,bitrate:150};
  const safe={playUrl:'https://review.invalid/360',codec:'h264' as const,width:360,height:640,bitrate:170};
  const next={...b,variants:[bad,safe]};
  f.controller.douyinPlay({item:a,playback:a,playlist:[a,next],hasMore:false,immersive:true});
  await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
  const entry=f.stack().at(-1)!;
  expect(entry.queue?.snapshot().playlist.map(x=>x.awemeId)).toEqual([a.awemeId,b.awemeId]);
  expect(f.controller.rejectDouyinAdjacent(entry,b.awemeId,'podjs-media-cache://play/old.mp4',bad.playUrl)).toBe(true);
  expect(entry.queue?.snapshot().playlist.map(x=>x.awemeId)).toEqual([a.awemeId,b.awemeId]);
  expect(entry.queue?.snapshot().playlist[1]).toMatchObject({playUrl:safe.playUrl,variants:[safe]});
  expect(f.controller.rejectDouyinAdjacent(entry,b.awemeId,'podjs-media-cache://play/old.mp4',bad.playUrl)).toBe(false);
  expect(entry.queue?.snapshot().playlist[1]?.playUrl).toBe(safe.playUrl);
});
test('RVRESCAP4-03 native rejection persistently clears the non-immersive singleton',async()=>{
  const results=[];
  for(const count of [0,198,199,200,201,207,256]){
    const f=fixture(),base=item('legacy-too-large-'+count);
    const bad=count===0?base:{...base,variants:[{width:0,height:0,bitrate:100,codec:'h264' as const,playUrl:base.playUrl,
      playUrls:Array.from({length:count},(_,i)=>'https://review.invalid/legacy-'+count+'-mirror-'+i)}]};
    f.controller.douyinPlay({item:bad,playback:bad,playlist:[bad],hasMore:false,detailPlayback:true});
    await f.controller.douyinNavigate({name:'player',awemeId:bad.awemeId});
    const entry=f.stack().at(-1)!;
    await entry.queue!.persist();
    await client.savePlaybackQueue([bad],bad.awemeId,null,false);
    const before=await client.restorePlaybackQueue();
    expect(before.anchorAwemeId).toBe(bad.awemeId);
    expect(before.items.map(v=>v.playUrl)).toEqual([bad.playUrl]);
    expect(entry.playback?.immersive ?? false).toBe(false);
    await f.controller.recoverDouyinVideo(entry,false,0,{code:'resolution_limit'});
    expect(entry.queue?.snapshot().playlist).toEqual([]);
    const restored=await client.restorePlaybackQueue();
    expect(restored.anchorAwemeId).toBeNull();
    results.push({count,anchor:restored.anchorAwemeId,urls:restored.items.map(v=>v.playUrl),retained:restored.items.some(v=>v.playUrl===bad.playUrl)});
  }
  console.log(JSON.stringify(results));
  expect(results.filter(v=>v.retained)).toEqual([]);
});

test('RVRESCAP4-04 a rejected raced mirror does not remove a genuinely compliant primary',async()=>{
  const f=fixture(),a=item('anchor-mirror-review'),b=item('mirror-review');
  const good={playUrl:b.playUrl,playUrls:['https://review.invalid/bad-mirror'],codec:'h264' as const,width:480,height:854,bitrate:150};
  const next={...b,variants:[good]};
  f.controller.douyinPlay({item:a,playback:a,playlist:[a,next],hasMore:false,immersive:true});
  await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
  const entry=f.stack().at(-1)!;
  expect(entry.queue?.snapshot().playlist.map(x=>x.awemeId)).toEqual([a.awemeId,b.awemeId]);
  await entry.queue!.persist();
  expect(f.controller.rejectDouyinAdjacent(entry,b.awemeId,'podjs-media-cache://play/fixture.mp4',good.playUrls[0])).toBe(true);
  const remaining=entry.queue?.snapshot().playlist.map(x=>x.awemeId);
  console.log(JSON.stringify({remaining,goodPrimary:good.playUrl}));
  expect(remaining).toEqual([a.awemeId,b.awemeId]);
  expect(entry.queue?.snapshot().playlist[1]?.variants[0]?.playUrls).toEqual([]);
  await entry.queue!.persist();
  const restored=await client.restorePlaybackQueue();
  expect(restored.items.find(v=>v.awemeId===b.awemeId)?.variants[0]?.playUrls).toEqual([]);
  expect(restored.items.find(v=>v.awemeId===b.awemeId)?.playUrl).toBe(good.playUrl);
});

test('RVRESCAP5-01 a failed snapshot rewrite must not strand the foreground on a rejected source',async()=>{
 const f=fixture(),bad=item('storage-reject-current'),safe=item('storage-reject-next');
 f.controller.douyinPlay({item:bad,playback:bad,playlist:[bad,safe],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:bad.awemeId});
 const entry=f.stack().at(-1)!;
 await entry.queue!.persist();
 expect(f.source()).toMatchObject({awemeId:bad.awemeId,url:bad.playUrl});
 const {playbackItemKey}=await import('../src/douyin/feed-store.ts');
 const {appLogger}=await import('../src/logs/app-logger.ts');
 const store=(client as any).feedStore.storage;
 let errors=0;
 store.apply=async(changes:Array<{key:string,value:string|null}>)=>{
  if(!errors&&changes.some(change=>change.key===playbackItemKey(bad.awemeId)&&change.value===null)){
   errors++;
   throw new Error('fixture SQL transaction failed once');
  }
  for(const {key,value} of changes)if(value===null)await store.remove(key);else await store.set(key,value);
 };
 const originalWarn=appLogger.w,warn=mock(originalWarn);
 appLogger.w=warn;
 try{await f.controller.recoverDouyinVideo(entry,false,0,{code:'resolution_limit'});}
 finally{appLogger.w=originalWarn;}
 expect(errors).toBe(1);
 const result={selected:entry.queue?.snapshot().item?.awemeId,playing:f.source()?.awemeId,url:f.source()?.url,error:f.error(),errors};
 expect(result.selected).toBe(safe.awemeId);
 expect(result.playing).toBe(safe.awemeId);
 expect(result.url).toBe(safe.playUrl);
 expect(result.error).toBe('');
 expect(warn).toHaveBeenCalledWith('DouyinPlayer','Rejected source snapshot cleanup failed');
});

test('RVRESCAP5-01 releases the replacement at the snapshot cleanup deadline',async()=>{
 const bad=item('slow-storage-current'),safe=item('slow-storage-next');
 let onPublish!:(source:PlaybackSource)=>void;
 const published=new Promise<PlaybackSource>(resolve=>{onPublish=resolve;});
 const f=fixture(false,undefined,{publish:source=>{if(source?.awemeId===safe.awemeId)onPublish(source);}});
 f.controller.douyinPlay({item:bad,playback:bad,playlist:[bad,safe],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:bad.awemeId});
 const entry=f.stack().at(-1)!;
 await entry.queue!.persist();
 const {playbackItemKey}=await import('../src/douyin/feed-store.ts');
 const {appLogger}=await import('../src/logs/app-logger.ts');
 const store=(client as any).feedStore.storage;
 let notify!:()=>void,release!:()=>void;
 const writeStarted=new Promise<void>(resolve=>notify=resolve),writeGate=new Promise<void>(resolve=>release=resolve);
 const originalWarn=appLogger.w,warn=mock(originalWarn);
 appLogger.w=warn;
 let blocked=false;
 store.apply=async(changes:Array<{key:string,value:string|null}>)=>{
  if(!blocked&&changes.some(change=>change.key===playbackItemKey(bad.awemeId)&&change.value===null)){
   blocked=true;
   notify();
   await writeGate;
   throw Error('fixture storage unavailable');
  }
  for(const {key,value} of changes)if(value===null)await store.remove(key);else await store.set(key,value);
 };
 const recovery=f.controller.recoverDouyinVideo(entry,false,0,{code:'resolution_limit'});
 try{
  await writeStarted;
  expect(f.source()?.url).toBe(bad.playUrl);
  const deadline=entryTimers.find(timer=>timer.ms===2000);
  expect(deadline).toBeDefined();
  deadline!.fire();
  expect((await published)?.url).toBe(safe.playUrl);
  expect(f.error()).toBe('');
  expect(warn).toHaveBeenCalledWith('DouyinPlayer','Rejected source snapshot cleanup timed out');
 }finally{
  release();
  await recovery;
  await client.restorePlaybackQueue();
  appLogger.w=originalWarn;
 }
 expect(warn).toHaveBeenCalledTimes(1);
});

function resolutionChain(id:string,widths:number[]){
 const base=item(id);
 const variants=widths.map((width)=>({playUrl:`${base.playUrl}/${width}`,codec:'h264' as const,
  width,height:Math.round(width*16/9),bitrate:200}));
 return {...base,playUrl:variants[0]!.playUrl,variants};
}

for(const path of ['bound','foreground'])test(`RVRESCAP7-01 retries 480→360→540 during replacement writeback (${path})`,async()=>{
 const chain=resolutionChain('same-item-chain',[480,360,540]);
 const [firstUrl,secondUrl,safeUrl]=chain.variants.map(variant=>variant.playUrl);
 const f=fixture();
 f.controller.douyinPlay({item:chain,playback:chain,playlist:[chain],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:chain.awemeId});
 const entry=f.stack().at(-1)!;
 await entry.queue!.persist();
 expect(f.source()?.url).toBe(firstUrl);
 let release!:()=>void,markStarted!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const started=new Promise<void>(resolve=>{markStarted=resolve;});
 const save=client.savePlaybackQueue.bind(client);
 let saveHeld=false;
 client.savePlaybackQueue=async(items,id,cursor,hasMore)=>{
  if(!saveHeld&&items.find(it=>it.awemeId===id)?.playUrl===secondUrl){
   saveHeld=true;
   markStarted();
   await gate;
  }
  return save(items,id,cursor,hasMore);
 };
 const failure={code:'resolution_limit'};
 const first=f.controller.recoverDouyinVideo(entry,false,0,failure,chain.awemeId,{url:firstUrl!,uri:firstUrl!});
 let second:Promise<void>|undefined;
 try{
  await started;
  expect(f.source()?.url).toBe(secondUrl);
  second=path==='bound'
    ?f.controller.recoverDouyinVideo(entry,false,0,failure,chain.awemeId,{url:secondUrl!,uri:secondUrl!})
    :f.controller.recoverDouyinVideo(entry,false,0,failure);
 }finally{
  release();
  await Promise.all([first,second]);
 }
 const restored=await client.restorePlaybackQueue();
 expect(f.requests()).toBe(0);
 expect(f.source()?.url).toBe(safeUrl);
 expect(entry.queue?.snapshot().item?.playUrl).toBe(safeUrl);
 expect(restored.items[0]?.variants.map(v=>v.playUrl)).toEqual([safeUrl]);
});

test('RVRESCAP7-01 three consecutive source rejections survive generated writeback schedules',async()=>{
 let seed=0x720804;
 const random=(limit:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed>>>8)%limit;};
 const phases=['publish','during','after'] as const;
 const covered=new Set<string>();
 for(let trial=0;trial<32;trial++){
  const chain=resolutionChain(`three-rejections-${trial}`,[480,360,540,720]);
  const urls=chain.variants.map(variant=>variant.playUrl);
  const timing=urls.slice(0,3).map(()=>phases[random(phases.length)]!);
  const bound=timing.map(()=>random(2)===0);
  const duplicate=timing.map(()=>random(2)===0);
  const published:string[]=[],removed:string[]=[],requests:Promise<void>[]=[];
  const triggered=new Set<number>();
  let entry:RouteEntry|undefined;
  const reject=(index:number)=>{
   const url=urls[index]!;
   if(!entry||triggered.has(index)||f.source()?.url!==url)return;
   triggered.add(index);
   const fail=(explicit:boolean)=>explicit
    ?f.controller.recoverDouyinVideo(entry!,false,0,{code:'resolution_limit'},chain.awemeId,{uri:url,url})
    :f.controller.recoverDouyinVideo(entry!,false,0,{code:'resolution_limit'});
   requests.push(fail(bound[index]!));
   if(duplicate[index])requests.push(fail(!bound[index]));
  };
  const f=fixture(false,undefined,{publish:source=>{
   if(!source?.url)return;
   published.push(source.url);
   const index=urls.indexOf(source.url);
   if(timing[index]==='publish')reject(index);
  }});
  f.controller.douyinPlay({item:chain,playback:chain,playlist:[chain],hasMore:false,immersive:true});
  await f.controller.douyinNavigate({name:'player',awemeId:chain.awemeId});
  entry=f.stack().at(-1)!;
  const queue=entry.queue!;
  await queue.persist();
  const remove=queue.persistSourceRemoval.bind(queue);
  queue.persistSourceRemoval=(id,url)=>{removed.push(url);return remove(id,url);};
  const save=client.savePlaybackQueue.bind(client);
  client.savePlaybackQueue=async(items,id,cursor,hasMore)=>{
   const index=urls.indexOf(items.find(row=>row.awemeId===id)?.playUrl??'');
   if(timing[index]==='during'){
    await Promise.resolve();
    reject(index);
    await Promise.resolve();
   }
   return save(items,id,cursor,hasMore);
  };
  reject(0);
  let completed=0;
  for(let index=1;index<=2;index++){
   covered.add(timing[index]!);
   if(timing[index]!=='after')continue;
   while(completed<requests.length)await requests[completed++];
   reject(index);
  }
  while(completed<requests.length)await requests[completed++];
  const label=`case ${trial} ${timing.slice(1).join('→')}`;
  const restored=await client.restorePlaybackQueue();
  expect(published,label).toEqual(urls);
  expect(removed,label).toEqual(urls.slice(0,3));
  expect(f.error(),label).toBe('');
  expect(f.requests(),label).toBe(0);
  expect(queue.snapshot().item?.playUrl,label).toBe(urls[3]);
  expect(restored.anchorAwemeId,label).toBe(chain.awemeId);
  expect(restored.items[0]?.variants.map(variant=>variant.playUrl),label).toEqual([urls[3]]);
 }
 expect([...covered].sort()).toEqual([...phases].sort());
},10000);

const restartDb=process.env.DOUYIN_RESTART_DB;
test.skipIf(!restartDb)('RVRESCAP6-01 subprocess',async()=>{
 const {Database}=await import('bun:sqlite');
 const {writeSync}=await import('node:fs');
 const {DouyinSqlStateStorage}=await import('../src/douyin/state-storage.ts');
 const {playbackItemKey}=await import('../src/douyin/feed-store.ts');
 const phase=process.env.DOUYIN_RESTART_PHASE;
 const rejected=item('restart-rejected'),safeBase=item('restart-compliant');
 const safe={...safeBase,variants:[{playUrl:safeBase.playUrl,codec:'h264' as const,width:480,height:854,bitrate:123}]};
 const database=new Database(restartDb!,{create:phase!=='restore'});
 database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 let deletionCommitted=false,initialRouteReady=false;
 const storage=new DouyinSqlStateStorage(async()=>({
  query:async(sql,params=[])=>database.query(sql).all(...params as any[]) as Record<string,unknown>[],
  execute:async(sql,params=[])=>{database.query(sql).run(...params as any[]);},
  transaction:async statements=>{
   database.transaction(()=>{for(const {sql,params=[]} of statements)database.query(sql).run(...params as any[]);})();
   if(statements.some(({sql,params})=>sql.startsWith('DELETE')&&params?.[0]===playbackItemKey(rejected.awemeId)))deletionCommitted=true;
  },
 }),{get:async()=>null,set:async()=>{},remove:async()=>{}});
 const interrupt=(boundary:string):never=>{
  writeSync(1,JSON.stringify({boundary,deletionCommitted})+'\n');
  process.kill(process.pid,'SIGKILL');
  throw Error('SIGKILL did not stop the subprocess');
 };
 const f=fixture(false,undefined,{historyStorage:storage,publish:source=>{
  if(phase==='publish'&&initialRouteReady&&source?.url===safe.playUrl)interrupt('publish');
 }});
 try{
  if(phase==='restore'){
   const snapshot=client.freshPlaybackSnapshot(await client.restorePlaybackQueue());
   const resumedRejected=await f.controller.restoreDouyinVideo(rejected.awemeId,true);
   expect(f.requests()).toBe(0);
   expect(resumedRejected).toBe(false);
   expect(f.source()?.url).toBeUndefined();
   expect(snapshot.items.map(row=>row.awemeId)).toEqual([safe.awemeId]);
   expect(snapshot.items[0]?.playUrl).toBe(safe.playUrl);
   return;
  }
  const now=Date.now(),items=[rejected,safe];
  client.freshPlaybackSnapshot({items,anchorAwemeId:rejected.awemeId,savedAtMillis:now,hasMore:false,cursor:null,
   resolved:{[rejected.awemeId]:now,[safe.awemeId]:now}});
  f.controller.douyinPlay({item:rejected,playback:rejected,playlist:items,hasMore:false,immersive:true});
  await f.controller.douyinNavigate({name:'player',awemeId:rejected.awemeId});
  const entry=f.stack().at(-1)!;
  await entry.queue!.persist();
  const before=client.freshPlaybackSnapshot(await client.restorePlaybackQueue());
  expect(before.anchorAwemeId).toBe(rejected.awemeId);
  expect(before.items.map(row=>row.awemeId)).toEqual(items.map(row=>row.awemeId));
  expect(f.source()?.url).toBe(rejected.playUrl);
  initialRouteReady=true;
  if(phase==='prepare')proxyOverride=async selected=>selected.awemeId===safe.awemeId?interrupt('prepare'):selected.playUrl;
  await f.controller.recoverDouyinVideo(entry,false,0,{code:'resolution_limit'});
  throw Error(`Recovery did not reach the ${phase} boundary`);
 }finally{database.close();}

});
test('NOPLAY reload publishes its own refreshed queue generation and preserves the selected target',async()=>{
 const f=fixture(),a=item('111');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'111'});
 const entry=f.stack().at(-1)!,before=f.source();let requests=0;
 client.resolvePlayback=async(id,options)=>{requests++;expect(id).toBe('111');expect(options).toMatchObject({forceRefresh:true,allowDetail:false,freshRequest:true});return {ok:true,data:{...a,playUrl:'https://video/refreshed'}};};
 await f.controller.reloadVideo(entry,321,()=>true);
 expect(requests).toBe(1);expect(f.source()).not.toBe(before);expect(f.source()).toMatchObject({awemeId:'111',url:'https://video/refreshed',resumePositionMs:321});
});
test('NOPLAY reload still rejects a later queue mutation during persistence',async()=>{
 const f=fixture(),a=item('111');f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:'111'});
 const entry=f.stack().at(-1)!,before=f.source();let release!:()=>void;
 client.resolvePlayback=async()=>({ok:true,data:{...a,playUrl:'https://video/refreshed'}});
 entry.queue!.persist=()=>new Promise<void>(resolve=>release=resolve);
 const running=f.controller.reloadVideo(entry,321,()=>true);for(let n=0;n<80;n++)await Promise.resolve();expect(release).toBeDefined();
 entry.queue!.refreshPrefetchItem('111',{...a,playUrl:'https://video/newer'});release();await running;
 expect(f.source()).toBe(before);
});

test('NOPLAY current reload survives an unrelated neighbour source refresh',async()=>{
 const f=fixture(),a=item('111'),b=item('222');f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;let finish!:(value:any)=>void;
 client.resolvePlayback=()=>new Promise(resolve=>finish=resolve);
 const running=f.controller.reloadVideo(entry,321,()=>true);for(let n=0;n<80;n++)await Promise.resolve();expect(finish).toBeDefined();
 entry.queue!.refreshPrefetchItem(b.awemeId,{...b,playUrl:'https://video/neighbour-new'});finish({ok:true,data:{...a,playUrl:'https://video/current-new'}});await running;
 expect(f.source()).toMatchObject({awemeId:a.awemeId,url:'https://video/current-new',resumePositionMs:321});
});
test('NOPLAY current reload survives neighbour quarantine during its persistence',async()=>{
 const f=fixture(),a=item('111'),b=item('222');f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;let finish!:()=>void;
 client.resolvePlayback=async()=>({ok:true,data:{...a,playUrl:'https://video/current-new'}});entry.queue!.persist=()=>new Promise(resolve=>finish=resolve);
 const running=f.controller.reloadVideo(entry,321,()=>true);for(let n=0;n<80;n++)await Promise.resolve();expect(finish).toBeDefined();
 expect(entry.queue!.quarantinePrefetch(b.awemeId)).toBe(true);finish();await running;
 expect(f.source()).toMatchObject({awemeId:a.awemeId,url:'https://video/current-new',resumePositionMs:321});
});
test('NOPLAY explicit queue cancellation still rejects an unchanged selected reload',async()=>{
 const f=fixture(),a=item('111');f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!,before=f.source();let finish!:(value:any)=>void;client.resolvePlayback=()=>new Promise(resolve=>finish=resolve);
 const running=f.controller.reloadVideo(entry,321,()=>true);for(let n=0;n<80;n++)await Promise.resolve();expect(finish).toBeDefined();
 entry.queue!.cancel();finish({ok:true,data:{...a,playUrl:'https://video/current-new'}});await running;expect(f.source()).toBe(before);
});

test('NOPLAY an automatic player timeout can reprepare its still-authorized selected source',async()=>{
 const f=fixture(),a=item('111');f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!,before=f.source();let calls=0;
 client.resolvePlayback=async(id,options)=>{calls++;expect(options).toMatchObject({forceRefresh:false,freshRequest:false,allowDetail:false,feedItem:a});return {ok:true,data:a};};
 await f.controller.reloadVideo(entry,321,()=>true,'current');expect(calls).toBe(1);expect(f.source()).not.toBe(before);expect(f.source()).toMatchObject({awemeId:a.awemeId,url:a.playUrl,resumePositionMs:321});
});

test('manual reload publishes fresh detail in a new managed source at the current position',async()=>{
 const f=fixture(),a=item('111'),b=item('222');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 const entry=f.stack().at(-1)!;const url='https://video/fresh-detail';let details=0,registrations=0;
 client.resolvePlayback=async(id,options)=>{
  expect(id).toBe(a.awemeId);
  expect(options).toEqual({forceRefresh:true,freshRequest:true,allowDetail:true});
  details++;
  return {ok:true,data:{...a,playUrl:url}};
 };
 proxyOverride=async resolved=>{expect(resolved.playUrl).toBe(url);registrations++;return 'podjs-media-cache://play/fresh';};
 await f.controller.reloadVideo(entry,321,()=>true,'detail');
 expect(details).toBe(1);expect(registrations).toBe(1);
 expect(entry.queue!.snapshot().item?.awemeId).toBe(a.awemeId);
 expect(f.source()).toMatchObject({awemeId:a.awemeId,url:'podjs-media-cache://play/fresh',resumePositionMs:321,bypassCache:false});
});

test('idle release video requests no guest frames and debug playback still sees the current and next items', async()=>{
 for (const enabled of [false,true]) {
  debugAllowed=enabled;
  try {
   const f=fixture();
   const playlist=Array.from({length:40},(_,index)=>item(String(index)));
   const selected=playlist[2]!;
   f.controller.douyinPlay({item:selected,playback:selected,playlist,hasMore:false,immersive:true});
   await f.controller.douyinNavigate({name:'player',awemeId:selected.awemeId});
   const queue=f.stack().at(-1)!.queue!;
   const original=queue.snapshot.bind(queue);
   let copies=0, requests=0;
   queue.snapshot=()=>{copies++;return original();};
   for(let frame=0;frame<600;frame++) {
    if(frameObservers.some(observer=>observer.needsFrame()))requests++;
    for(const observer of frameObservers)observer.run();
   }
   const expected = enabled ? 600 : 0;
   expect({requests,copies,debugTicks}).toEqual({requests:expected,copies:0,debugTicks:expected});
   if(enabled)expect(debugContexts.at(-1)).toEqual(['2','3']);
   else expect(debugContexts).toHaveLength(0);
  } finally {debugAllowed=false;}
 }
});

test('PERFVIDEO foreground publishes while an optional entry probe is still blocked',async()=>{
 const f=fixture(false,()=>({prime:()=>{throw Error('unexpected prime');},releaseAll:async()=>{}})),a=item('slow-prime');
 await f.controller.douyinNavigate({name:'entry'});
 let release!:()=>void,calls=0,now=0,publishedAt:number|undefined;
 readyOverride=()=>++calls===1?new Promise(resolve=>release=()=>resolve(undefined)):Promise.resolve(undefined);
 const warm=f.controller.primeDouyinEntry(f.stack().at(-1)!,{},[a],null,41);
 client.buildPlaybackHeaders=async()=>({});
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true,entrySeq:41,onSourcePublished:()=>{publishedAt=now;}});
 const opening=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});
 for(let i=0;i<80;i++)await Promise.resolve();
 const publishedBeforeRelease=publishedAt;
 now=1500;release();await warm;await opening;
 console.info('PERFVIDEO entry source publication fixture ms',publishedAt);
 expect(publishedBeforeRelease).toBe(0);
 expect(f.source().url).toBe(a.playUrl);
 expect(f.requests()).toBe(0);
});

test('PERFVIDEO reverse paging uses a verified bundle while the redundant preview read is blocked',async()=>{
 const f=fixture(),a=item('reverse-a'),b=item('reverse-b');
 const url='file:///mock/a.mp4';
 f.controller.douyinPlay({item:b,playback:b,playlist:[a,b],hasMore:false,immersive:true});
 await f.controller.douyinNavigate({name:'player',awemeId:b.awemeId});
 const entry=f.stack().at(-1)!;
 const frame={available:true,kind:'actual_frame',path:'video-frames/reverse.jpg',width:320,height:180};
 readyOverride=async()=>({item:a,url,previewFrame:{entryId:a.awemeId,frame}});
 localPaths.set(a.awemeId,url);
 let release:undefined|((value:unknown)=>void),now=0,preparedAt:number|undefined;
 adjacentPreview=()=>new Promise(resolve=>release=resolve);
 const warming=f.controller.prepareDouyinAdjacent(entry,'previous').then(result=>{preparedAt=now;return result;});
 for(let n=0;n<80;n++)await Promise.resolve();
 const before=preparedAt;now=600;release?.({entryId:a.awemeId,frame});
 const prepared=await warming;
 console.info('PERFVIDEO reverse prepared fixture ms',preparedAt);
 expect(before).toBe(0);
 expect(prepared?.source).toMatchObject({url,previewFrame:{entryId:a.awemeId,frame}});
 expect(f.requests()).toBe(0);
});
