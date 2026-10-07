import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
import type { InternetStatus } from '../src/onboarding/state.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'d2-player-solid',setup(builder){builder.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>({kind,props});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>element('Image',p)}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>({dispose(){}})}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>text.length*8})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:()=>null}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{d(){},i(){},w(){},e(){}}}));
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>false,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>Math.sign(n)}));
let debugAllowed=false,diagnosticBindings=0,diagnosticDisposals=0,diagnosticReader:(()=>Promise<unknown>)|undefined;
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{get allowed(){return debugAllowed;},bindSessions(reader:()=>Promise<unknown>){diagnosticBindings++;diagnosticReader=reader;return ()=>{diagnosticDisposals++;};}}}));
let network:(s:InternetStatus)=>void,initial:InternetStatus='available';
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(fn:typeof network)=>{network=fn;fn(initial);return()=>{};}}));
let prepares:any[]=[],plays=0,retries=0,failures=0,nextError:unknown,current:any;
let ticks:(()=>void)[]=[];
const state=(name:string)=>({ok:true,state:name,positionMs:321,durationMs:1000,width:100,height:100,volume:.2,volumeMax:15});
const video={prepare:(options:any)=>{prepares.push(options);const error=nextError;nextError=undefined;return {result:error?Promise.reject(error):Promise.resolve(current=state('ready')),cancel(){}};},
 play:async()=>{plays++;return current=state('playing');},pause:async()=>current=state('paused'),state:async()=>current,seek:async()=>current,stop:async()=>{},setBounds:async()=>{},setTransform:async()=>{},setVolume:async()=>current};
mock.module('@podjs/framework/services',()=>({video,videoSessions:{},hostOperation:()=>{throw Error('unexpected session operation');},delay:()=>{let release!:()=>void;const result=new Promise<void>(resolve=>release=resolve);ticks.push(release);return{result,cancel(){ticks=ticks.filter(t=>t!==release);}};}}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());ticks=[];});
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return[];return[value,...nodes(value.props.children)];}
function mount(status:InternetStatus,url='https://video/current',immersive=false){
 initial=status;prepares=[];plays=0;retries=0;failures=0;ticks=[];current=state('idle');
 const root=createRoot(stop=>{stops.push(stop);return VideoPlayerScreen({source:{platform:'douyin',url,title:'current',immersive},width:233,height:233,active:true,offset:0,round:true,onRetry:async()=>{retries++;},onPlaybackFailure:()=>{failures++;}});});
 return {text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),press:(label:string)=>{const button=nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(c=>c.kind==='Text'&&c.props.children===label));expect(button).toBeDefined();button!.props.onPress();}};
}
test('D2 initial network gate clears on WiFi without fetching or replacing queue',async()=>{
 const f=mount('unavailable');await flush();expect(f.text()).toContain('未检测到可用互联网');expect(prepares).toHaveLength(0);
 network('available');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(retries).toBe(0);
 network('unavailable');await flush();expect(f.text()).not.toContain('未检测到可用互联网');expect(plays).toBe(1);
});
test('D2 Bluetooth continue prepares once and resumes existing ready player without route retry',async()=>{
 const f=mount('bluetooth');await flush();expect(prepares).toHaveLength(0);f.press('继续');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(retries).toBe(0);
 // A new page requires a fresh confirmation. Mount separately with an already prepared WiFi stream.
 stops.pop()!();const ready=mount('available');await flush();current=state('paused');ticks.shift()!();await flush();network('bluetooth');await flush();ready.press('继续');await flush();
 expect(prepares).toHaveLength(1);expect(plays).toBe(2);expect(retries).toBe(0);
});
test('D2 typed network prepare error on available WiFi shows native overlay and retries same source',async()=>{
 nextError={code:'network_error'};const f=mount('available');await flush();expect(f.text()).toContain('请连接 WiFi 或移动网络');expect(failures).toBe(0);
 f.press('重试');await flush();expect(prepares).toHaveLength(2);expect(prepares[1].url).toBe('https://video/current');expect(retries).toBe(0);expect(plays).toBe(1);
});
test('D2 actual terminal network state masks failure and keeps selected source',async()=>{
 const f=mount('available');await flush();current={...state('error'),errorCode:'network_error'};ticks.shift()!();await flush();expect(f.text()).toContain('未检测到可用互联网');expect(failures).toBe(0);
 f.press('重试');await flush();expect(prepares).toHaveLength(2);expect(retries).toBe(0);
});
test('D2 local video remains playable while offline',async()=>{
 const f=mount('unavailable','file:///cache/video.mp4');await flush();expect(prepares).toHaveLength(1);expect(plays).toBe(1);expect(f.text()).not.toContain('未检测到可用互联网');
});

test('D2 immersive paused rendered frame stays visible; buffering network pause resumes on recovery',async()=>{
 const f=mount('available','https://video/current',true);await flush();
 current={...state('paused'),hasRenderedFirstFrame:true};ticks.shift()!();await flush();network('unavailable');await flush();
 expect(f.text()).not.toContain('未检测到可用互联网');expect(plays).toBe(1);
 network('available');await flush();current={...state('buffering'),hasRenderedFirstFrame:true};ticks.shift()!();await flush();
 network('unavailable');await flush();expect(current.state).toBe('paused');expect(plays).toBe(1);
 network('available');await flush();expect(plays).toBe(2);expect(prepares).toHaveLength(1);expect(retries).toBe(0);
});

test('DBG2 slot diagnostics bind only active debug immersive ownership and dispose with the screen',async()=>{
 debugAllowed=false;diagnosticBindings=0;diagnosticDisposals=0;mount('available','https://video/current',true);await flush();expect(diagnosticBindings).toBe(0);stops.pop()!();
 debugAllowed=true;mount('available','https://video/current',false);await flush();expect(diagnosticBindings).toBe(0);stops.pop()!();
 mount('available','https://video/current',true);await flush();expect(diagnosticBindings).toBe(1);expect(await diagnosticReader!()).toBeUndefined();stops.pop()!();expect(diagnosticDisposals).toBe(1);debugAllowed=false;
});
