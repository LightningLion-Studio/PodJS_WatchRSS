import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import type {RouteEntry} from '../src/ui/routes/types.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'bili-native-recovery',setup(builder){builder.onLoad({filter:/\/ui\/(?:VideoPlayerScreen|routes\/media)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
const element=(kind:string,props:any)=>({kind,props});
mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>element('Image',p)}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>({dispose(){}})}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>s.length*8})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(p:any)=>element('Image',p)}));
mock.module('../src/ui/bili/index.tsx',()=>({BiliScreen:()=>null}));
mock.module('../src/ui/douyin/index.tsx',()=>({DouyinScreen:()=>null}));
mock.module('../src/ui/PlatformNotice.tsx',()=>({PendingDisclosure:()=>null}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{allowed:false}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{}}));
const values=new Map<string,any>();
mock.module('@podjs/framework/watch',()=>({kv:{get:(k:string)=>values.get(k),set:(k:string,v:any)=>values.set(k,v),delete:(k:string)=>values.delete(k)},hasCapability:()=>false,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:any)=>{fn('available');return()=>{};}}));
let ticks:(()=>void)[]=[],prepares:any[]=[],seeks:number[]=[],plays=0,nativeErrors:unknown[]=[],stateError:unknown,current:any;
const nativeState=(name:string,positionMs=12345)=>({ok:true,state:name,positionMs,durationMs:600000,width:640,height:360,volume:.2,volumeMax:15,hasRenderedFirstFrame:name==='ready'||name==='playing'});
const video={prepare:(options:any)=>{prepares.push(options);const error=nativeErrors.shift();return{result:error?Promise.reject(error):Promise.resolve(current=nativeState('ready',0)),cancel(){}};},
 play:async()=>{plays++;return current={...current,state:'playing'};},seek:async(position:number)=>{seeks.push(position);return current={...current,positionMs:position};},state:async()=>{const error=stateError;stateError=undefined;if(error)throw error;return current;},
 pause:async()=>current={...current,state:'paused'},stop:async()=>current=nativeState('stopped'),setBounds:async()=>{},setTransform:async()=>{},setVolume:async()=>current,setLoop:async()=>current,captureBackdrop:async()=>{}};
mock.module('@podjs/framework/services',()=>({video,videoSessions:{},browserAuth:{},secureStorage:{},hostOperation(){throw Error('Unexpected host call');},delay:()=>{let release!:()=>void;const result=new Promise<void>(yes=>release=yes);ticks.push(release);return{result,cancel(){ticks=ticks.filter(t=>t!==release);}};}}));
let client:any;
mock.module('../src/media-services.ts',()=>({biliClient:{getSession:()=>client.getSession(),resolvePlayback:(x:any)=>client.resolvePlayback(x),watchApiEnabled:()=>client.watchApiEnabled(),reportHistory:async()=>{}},biliPreviewCache:{lookup:async()=>undefined},douyinClient:{},douyinPreload:{lookup:async()=>undefined,invalidate:async()=>{},start(){},stop(){},allowBluetooth(){}},loadLocalBiliDetail:async()=>undefined}));
const {createBiliClient}=await import('../src/bili/client.ts');
const {createMediaRouteController}=await import('../src/ui/routes/media-controller.ts');
const {MediaRoutes}=await import('../src/ui/routes/media.tsx');
const stops:(()=>void)[]=[];
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
afterEach(async()=>{stops.splice(0).forEach(stop=>stop());await flush();values.clear();ticks=[];});
async function fixture(errors:unknown[],webAuthFailure=false){
 prepares=[];seeks=[];plays=0;ticks=[];nativeErrors=[...errors];stateError=undefined;current=nativeState('idle');
 values.set('watchrss.bili.playback-progress.v1',JSON.stringify([{aid:7,cid:8,positionMs:12345,durationMs:600000,updatedAt:1}]));
 const secure=new Map<string,string>([['watchrss.bili.session.v1',JSON.stringify({cookies:{SESSDATA:'synthetic-session'},updatedAt:1})],['watchrss.bili.session.v1.wbi',JSON.stringify({imgKey:'a'.repeat(32),subKey:'b'.repeat(32)})]]);
 const requests:any[]=[];
 client=createBiliClient({transport:{async request(r){requests.push(r);const watch=new URL(r.url).hostname==='app.bilibili.com';return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({code:!watch&&webAuthFailure?-101:0,data:{quality:16,video_codecid:7,durl:[{url:watch?'https://fixture.invalid/watch.mp4':'https://fixture.invalid/web.mp4',backup_url:[]}]}}))};}},secureStore:{get:async k=>secure.get(k)??null,set:async(k,v)=>{secure.set(k,v);},delete:async k=>{secure.delete(k);}},watchApi:()=>({appkey:'fixture-client',mobiApp:'fixture',platform:'fixture',device:'watch',build:'1',webCookieVerified:true})});
 let entry:RouteEntry={page:'home'};const [playing,setPlaying]=createSignal<any>();const reported:string[]=[];
 const controller=createRoot(stop=>{stops.push(stop);return createMediaRouteController({services:{} as never,current:()=>entry,motion:{phase:'idle'},busy:()=>false,setBusy:()=>false,setError:(s:string)=>{reported.push(s);return s;},settings:()=>({}),playingSource:playing,setPlayingSource:setPlaying,channels:()=>[],setChannels:(v:any)=>v,setOriginalModes:(v:any)=>v,setStack:(v:any)=>v,popPage:()=>false,setPage:(page:any,data:any)=>{entry={page,...data};}} as never);});
 await controller.biliNavigate({name:'player',aid:7,cid:8,title:'fixture'});
 const owning=entry;
 const root=createRoot(stop=>{stops.push(stop);return MediaRoutes({entry:owning,page:()=> 'video',active:()=>true,width:233,height:233,round:true,backOffset:()=>0,playingSource:playing,setError:(s:string)=>reported.push(s),douyinReady(){}} as never);});
 await flush();
 return{requests,reported,root,secure,get entry(){return entry;},navigate(){entry={page:'settings'};}};
}
// PodVideoAnalytics maps both native HTTP 401 and 403 to restricted, and 410 to source_expired.
for(const [status,code] of [[401,'restricted'],[403,'restricted'],[410,'source_expired']] as const)test(`native prepare HTTP ${status} automatically resolves Web once, seeks and plays without a retry click`,async()=>{
 const f=await fixture([{code}]);
 expect(f.requests.map(r=>new URL(r.url).pathname)).toEqual(['/x/watch/player/playurl','/x/player/wbi/playurl']);
 expect(prepares.map(p=>p.url)).toEqual(['https://fixture.invalid/watch.mp4','https://fixture.invalid/web.mp4']);
 expect(f.entry.playback).toMatchObject({biliApiSource:'web',resumePositionMs:12345});expect(seeks).toEqual([12345]);expect(plays).toBe(1);
 expect(prepares[0].headers).not.toHaveProperty('Referer');expect(prepares[0].headers).not.toHaveProperty('Cookie');expect(prepares[1].headers).toMatchObject({Referer:'https://www.bilibili.com/',Cookie:'SESSDATA=synthetic-session'});
 expect(JSON.parse(values.get('watchrss.bili.playback-progress.v1'))[0].positionMs).toBe(12345);
});
test('native terminal HTTP error after playback retains last known position even when native error state reports zero',async()=>{
 const f=await fixture([]);current=nativeState('playing',45678);ticks.shift()!();await flush();
 current={...nativeState('error',0),errorCode:'restricted'};ticks.shift()!();await flush();
 expect(f.requests.map(r=>new URL(r.url).pathname)).toEqual(['/x/watch/player/playurl','/x/player/wbi/playurl']);
 expect(f.entry.playback?.resumePositionMs).toBe(45678);expect(seeks.at(-1)).toBe(45678);expect(plays).toBe(2);
});
test('Web source rejection does not restart watch or resolve Web repeatedly',async()=>{
 const f=await fixture([{code:'restricted'},{code:'restricted'}]);
 expect(f.requests).toHaveLength(2);expect(prepares).toHaveLength(2);expect(plays).toBe(0);
 ticks.splice(0).forEach(t=>t());await flush();expect(f.requests).toHaveLength(2);expect(prepares).toHaveLength(2);
});
test('an actual network failure does not consume the one-shot watch-to-Web fallback',async()=>{
 const f=await fixture([{code:'network_error'}]);expect(f.requests).toHaveLength(1);expect(prepares).toHaveLength(1);expect(plays).toBe(0);
});

test('native state operation rejection reaches the same one-shot recovery path',async()=>{
 const f=await fixture([]);stateError={code:'restricted'};ticks.shift()!();await flush();
 expect(f.requests).toHaveLength(2);expect(prepares).toHaveLength(2);expect(f.entry.playback).toMatchObject({biliApiSource:'web',resumePositionMs:12345});expect(plays).toBe(2);
});

test('failed Web API authorization after a native state error stops polling and never changes login credentials',async()=>{
 const f=await fixture([],true),session=f.secure.get('watchrss.bili.session.v1');
 stateError={code:'restricted'};ticks.shift()!();await flush();
 expect(f.requests).toHaveLength(2);expect(prepares).toHaveLength(1);expect(ticks).toHaveLength(0);expect(f.secure.get('watchrss.bili.session.v1')).toBe(session);
});
