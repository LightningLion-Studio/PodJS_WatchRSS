import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'player-lifecycle-test',setup(b){b.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>({kind,props})])));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>({dispose(){}})}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:()=>20})}));
mock.module('@pocketjs/framework/input',()=>({hitNode(){},pressNode(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>props}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{allowed:false}}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(set:any)=>{set('online');return()=>{};}}));
mock.module('../src/ui/route-activity.tsx',()=>({restoredSignal:(_kind:any,_key:any,value:any)=>createSignal(value),booleanState:(v:any)=>typeof v==='boolean'}));
let phase='active',listener:(phase:string)=>void=()=>{},prepared=0,stateCalls=0,rejectOld!:(e:unknown)=>void,oldPending=false;
mock.module('@podjs/framework/watch',()=>({kv:{get(){},set(){}},hasCapability:()=>true,lifecycle:()=>phase,onLifecycleChange:(fn:any)=>{listener=fn;return()=>{};},normalizedRelativeAxisStep:()=>0}));
const value=(id='active')=>({ok:true,sessionId:id,state:'playing',positionMs:0,durationMs:10000,width:540,height:960,volume:1,hasRenderedFirstFrame:true,sourceGeneration:prepared,presented:true});
const port:any={prepare:(p:any)=>{prepared++;return {result:Promise.resolve(value(p.sessionId)),cancel(){}};},state:(id:string)=>{stateCalls++;if(stateCalls===2){oldPending=true;return new Promise((_yes,no)=>rejectOld=no);}return Promise.resolve(value(id));},release:async()=>({released:true}),captureFrame:async()=>({available:false})};
for(const method of ['play','pause','retire','seek','stop','setBounds','setTransform','setVolume','setLoop','promote','transition'])port[method]=async(id:string)=>value(id);
mock.module('@podjs/framework/services',()=>({videoSessions:port,video:port,hostOperation:()=>({result:Promise.resolve({decoderLimit:3,maxSessions:3,surfacePromotion:true,verticalTransition:true}),cancel(){}}),onVideoAudioChanged:()=>()=>{},onVideoFirstFrame:()=>()=>{},delay:()=>({result:new Promise(()=>{}),cancel(){}})}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
let dispose:undefined|(()=>void);afterEach(()=>{dispose?.();dispose=undefined;});
test('a state reply rejected after lifecycle release cannot fail the newly prepared player',async()=>{
 phase='active';prepared=0;stateCalls=0;oldPending=false;const events:any[]=[],failures:any[]=[],recoveries:any[]=[];const prior=(globalThis as any).pod;let seq=10;
 (globalThis as any).pod={benchmark:(line:string)=>{const e=JSON.parse(line);events.push(e);return e.seq??++seq;}};
 try{
  createRoot(stop=>{dispose=stop;VideoPlayerScreen({source:{platform:'douyin',immersive:true,awemeId:'fixture',url:'https://fixture.invalid/video',title:'fixture'},width:233,height:233,offset:0,round:true,active:true,onError:e=>{if(e)failures.push(e);},onPlaybackFailure:async(...args:any[])=>{recoveries.push(args);}});});
  await flush();expect(oldPending).toBe(true);expect(prepared).toBe(1);
  phase='inactive';listener(phase);await flush();phase='active';listener(phase);await flush();expect(prepared).toBe(2);
  rejectOld(Object.assign(Error('unknown_video_session PRIVATE'),{name:'HostServiceError',code:'invalid_argument'}));await flush();
  expect(failures).toEqual([]);expect(recoveries).toEqual([]);expect(events.filter(e=>e.code==='error_page'||e.code==='error')).toEqual([]);expect(prepared).toBe(2);
 }finally{dispose?.();dispose=undefined;(globalThis as any).pod=prior;}
});
