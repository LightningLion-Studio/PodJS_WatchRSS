import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { DouyinClient } from '../src/douyin/client.ts';
import type { DouyinItem } from '../src/douyin/types.ts';
import type { RouteEntry } from '../src/ui/routes/types.ts';
let client:DouyinClient;
const localPaths=new Map<string,string>();const invalidated:string[]=[];let proxyOverride:undefined|((item:DouyinItem)=>Promise<string>);let lookupOverride:undefined|(()=>Promise<string|undefined>);
mock.module('../src/media-services.ts',()=>({douyinPreload:{playback:async(item:DouyinItem)=>proxyOverride?proxyOverride(item):item.playUrl,lookup:async(id:string)=>lookupOverride?lookupOverride():localPaths.get(id),invalidate:async(id:string)=>{invalidated.push(id);localPaths.delete(id);},start(){},stop(){},allowBluetooth(){}},douyinClient:new Proxy({}, {get:(_target,key)=>{const value=(client as any)[key];return typeof value==='function'?value.bind(client):value;}}),biliClient:{},biliPreviewCache:{lookup:async()=>undefined}}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{playbackUrl:(_id:string,url:string)=>url,updateContext(){},tick:async()=>{}}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}},lifecycle:()=> 'active'}));
mock.module('@podjs/framework/services',()=>({video:{captureBackdrop:async()=>{},stop:async()=>{}},videoSessions:{},browserAuth:{},hostOperation(){},secureStorage:{}}));
const {captureActivityNavigation,restoreActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
const stops:(()=>void)[]=[];afterEach(()=>stops.splice(0).forEach(stop=>stop()));
const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:'',authorName:id,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
function fixture(){
 localPaths.clear();invalidated.length=0;lookupOverride=undefined;proxyOverride=undefined;
 const values=new Map<string,string>();let requests=0;
 client=new DouyinClient({secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},transport:{request:async()=>{requests++;throw Error('offline');}}});
 let controller!:ReturnType<typeof createMediaRouteController>,stack!:()=>RouteEntry[],source:any,error!:()=>string;
 createRoot(stop=>{stops.push(stop);const [entries,setStack]=createSignal<RouteEntry[]>([{page:'home'},{page:'douyin',douyinRoute:{name:'history'}}]);stack=entries;
 const [busy,setBusy]=createSignal(false),[message,setError]=createSignal(''),[playing,setPlaying]=createSignal<any>();error=message;
 controller=createMediaRouteController({current:()=>entries().at(-1)!,motion:{phase:'idle'},busy,setBusy,setError,settings:()=>({mediaVolumeControl:true,mediaVolumeGuard:false,playbackStartVolumeLimit:null}) as any,
 playingSource:playing,setPlayingSource:((v:any)=>{source=typeof v==='function'?v(playing()):v;return setPlaying(v);}) as any,
 channels:()=>[],setChannels:(()=>[]) as any,setOriginalModes:(()=>({})) as any,setStack,setPage:(page,data)=>setStack(rows=>[...rows,{page,...data}]),popPage:()=>{setStack(rows=>rows.slice(0,-1));return true;},services:{} as any});
 });
 return {controller,stack,source:()=>source,error,requests:()=>requests};
}
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
