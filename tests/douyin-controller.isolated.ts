import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { DouyinClient } from '../src/douyin/client.ts';
import type { DouyinItem } from '../src/douyin/types.ts';
import type { RouteEntry } from '../src/ui/routes/types.ts';
let readyOverride:undefined|(()=>Promise<any>);let client:DouyinClient;let optRecovery=false;let captureOverride:(()=>Promise<void>)|undefined;
let loginOptions:any,completeLogin:(value:{cookie:string;origin:string})=>void;
mock.module('../src/media/browser-auth.ts',()=>({authorizeInBrowser:(options:any)=>{loginOptions=options;return {result:new Promise(resolve=>completeLogin=resolve),cancel(){}};}}));
let paintRelease:(value:{committed:boolean})=>void;
mock.module('@podjs/framework/render',()=>({afterPaint:()=>({result:new Promise(resolve=>paintRelease=resolve),cancel(){}})}));
let canonicalSource:DouyinItem|undefined;let restoredFrame:any;let prefetchHooks:any;
const localPaths=new Map<string,string>();const invalidated:string[]=[];let proxyOverride:undefined|((item:DouyinItem)=>Promise<string>);let lookupOverride:undefined|(()=>Promise<string|undefined>);
mock.module('../src/media-services.ts',()=>({douyinStock:{resume:async()=>{},suspend(){},consume(){}},douyinPreload:{readySource:async()=>readyOverride?.(),previewFrame:async()=>undefined,sourceFor:()=>canonicalSource,restoreFrame:async()=>restoredFrame,playback:async(item:DouyinItem)=>proxyOverride?proxyOverride(item):item.playUrl,lookup:async(id:string)=>lookupOverride?lookupOverride():localPaths.get(id),invalidate:async(id:string)=>{invalidated.push(id);localPaths.delete(id);},start(...args:any[]){prefetchHooks=args[4];},stop(){},allowBluetooth(){}},douyinClient:new Proxy({}, {get:(_target,key)=>{const value=(client as any)[key];return typeof value==='function'?value.bind(client):value;}}),biliClient:{},biliPreviewCache:{lookup:async()=>undefined}}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{playbackUrl:(_id:string,url:string)=>url,updateContext(){},tick:async()=>{}}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>key==='watchrss.video-opt.v1'&&optRecovery?{recovery:true,percent:100}:key==='watchrss.video-opt.bucket'?0:undefined,set(){}},lifecycle:()=> 'active'}));
mock.module('@podjs/framework/services',()=>({DOUYIN_AUTH_STATUS_SCRIPT:'test-status-script',video:{captureBackdrop:async()=>{await captureOverride?.();},stop:async()=>{}},videoSessions:{},browserAuth:{},hostOperation(){},secureStorage:{},onNetworkChange:()=>()=>{},delay:()=>({result:new Promise(()=>{}),cancel(){}})}));
const {captureActivityNavigation,restoreActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
const stops:(()=>void)[]=[];afterEach(()=>stops.splice(0).forEach(stop=>stop()));
const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:'',authorName:id,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
function fixture(opt=false,initial?:any){
 optRecovery=opt;captureOverride=undefined;readyOverride=undefined;
 canonicalSource=undefined;restoredFrame=undefined;prefetchHooks=undefined;localPaths.clear();invalidated.length=0;lookupOverride=undefined;proxyOverride=undefined;
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
 let released=0,finish!:()=>void;const pool={prime:()=>({result:Promise.resolve({}),cancel(){}}),releaseAll:async()=>{released++;}};
 const f=fixture(false,pool),a=item('leave-prime');const save=client.savePlaybackQueue.bind(client);client.savePlaybackQueue=async(...args:any[])=>{await new Promise<void>(yes=>finish=yes);return save(...args as Parameters<typeof save>);};
 readyOverride=async()=>({url:'podjs-media-cache://play/prime.mp4',previewFrame:{entryId:a.awemeId,frame:{available:true,kind:'actual_frame',path:'video-frames/prime.jpg'}}});
 f.controller.douyinPlay({item:a,playback:a,playlist:[a],hasMore:false,immersive:true});const opened=f.controller.douyinNavigate({name:'player',awemeId:a.awemeId});while(!finish)await Promise.resolve();
 await f.controller.douyinNavigate({name:'history'});expect(released).toBeGreaterThan(0);finish();await opened;expect(f.stack().at(-1)?.douyinRoute?.name).toBe('history');
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

test('DYLOSS reverse boundary keeps the immersive route and its selected source',async()=>{
 const f=fixture(),a=item('a'),b=item('b');
 f.controller.douyinPlay({item:a,playback:a,playlist:[a,b],immersive:true,hasMore:false});await f.controller.douyinNavigate({name:'player',awemeId:'a'});
 const entry=f.stack().at(-1)!,source=f.source(),depth=f.stack().length;
 for(let n=0;n<50;n++)f.controller.selectDouyinTarget(entry,'previous',1);
 expect(f.stack()).toHaveLength(depth);expect(f.stack().at(-1)).toBe(entry);expect(f.source()).toBe(source);expect(entry.queue!.snapshot().index).toBe(0);expect(f.requests()).toBe(0);
 await f.controller.changeDouyinVideo(entry,'previous');expect(f.stack().at(-1)).toBe(entry);
});
