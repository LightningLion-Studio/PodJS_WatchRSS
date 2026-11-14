import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'player-detail-review-test',setup(b){b.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>({kind,props})])));
const gestures:any[]=[];mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);return {dispose(){options.onCancel?.();}};}}));
const frames:{fn:()=>void;needs?:()=>boolean}[]=[];mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:()=>void,needs?:()=>boolean){const item={fn,needs};frames.push(item);onCleanup(()=>frames.splice(frames.indexOf(item),1));}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:()=>20})}));
mock.module('@pocketjs/framework/input',()=>({hitNode(){},pressNode(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:(props:any)=>props}));
mock.module('../src/debug/douyin-host.ts',()=>({douyinDebug:{allowed:false}}));
mock.module('../src/onboarding/network-host.ts',()=>({observeHostInternet:(set:any)=>{set('online');return()=>{};}}));
mock.module('../src/ui/route-activity.tsx',()=>({restoredSignal:(_kind:any,_key:any,value:any)=>createSignal(value),booleanState:(v:any)=>typeof v==='boolean'}));
let panelProps:any;
mock.module('../src/ui/PlayerDetailPanel.tsx',()=>({
 PlayerDetailArrow:()=>null,
 PlayerDetailPanel:(props:any)=>{panelProps=props;props.ref?.({crown(){}});return null;},
 createDetailSlide:()=>{const [shown,set]=createSignal(false);return {shown,x:()=>shown()?0:233,begin(){},move(){set(true);},end(){},reset(){set(false);},open(){set(true);},close(){set(false);}};},
}));
let phase='active',listener:(phase:string)=>void=()=>{},prepared=0,stateCalls=0,rejectOld!:(e:unknown)=>void,oldPending=false;
mock.module('@podjs/framework/watch',()=>({kv:{get(){},set(){}},hasCapability:()=>true,lifecycle:()=>phase,onLifecycleChange:(fn:any)=>{listener=fn;return()=>{};},normalizedRelativeAxisStep:(delta:number)=>Math.sign(delta)}));
let audioChanged:(v:any)=>void=()=>{};let actual=.5;const writes:number[]=[],polls:(()=>void)[]=[];
let sourceGeneration=1,sourcePosition=0,speed=1,speedGate:Promise<void>|undefined;const speeds:number[]=[];
const value=()=>({speed,ok:true,state:'playing',positionMs:sourcePosition,durationMs:10000,width:540,height:960,volume:actual,volumeMax:16,hasRenderedFirstFrame:true,sourceGeneration,presented:true});
const port:any={prepare:()=>{prepared++;speed=1;sourcePosition=prepared*1000;return {result:Promise.resolve(value()),cancel(){}};},state:async()=>value(),setVolume:async(v:number)=>{writes.push(v);actual=Math.round(v*16)/16;return value();}};
for(const method of ['play','pause','retire','seek','stop','setBounds','setTransform','setLoop'])port[method]=async()=>value();
mock.module('@podjs/framework/services',()=>({videoSessions:port,video:port,hostOperation:()=>({result:Promise.resolve({decoderLimit:1,maxSessions:1,surfacePromotion:false,verticalTransition:false}),cancel(){}}),onVideoAudioChanged:(fn:any)=>{audioChanged=fn;return()=>{};},onVideoFirstFrame:()=>()=>{},delay:(ms:number)=>({result:new Promise<void>(yes=>{if(ms===400)polls.push(yes);}),cancel(){}})}));
port.setSpeed=async(v:number)=>{speeds.push(v);const reply={...value(),speed:v};const wait=speedGate;speedGate=undefined;await wait;speed=v;return reply;};
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
let dispose:undefined|(()=>void);afterEach(()=>{dispose?.();dispose=undefined;prepared=0;speeds.length=0;polls.length=0;speedGate=undefined;gestures.length=0;});
function mount(){let handle:any,setSource:any;const tree=createRoot(stop=>{dispose=stop;const [source,set]=createSignal({url:'file:///a.mp4',title:'a',startVolumeLimit:0,digitalCrownVolume:true});setSource=set;return VideoPlayerScreen({get source(){return source();},width:233,height:233,offset:0,round:true,active:true,ref:v=>handle=v});});function visit(v:any):void{if(typeof v==='function'){visit(v());return;}if(Array.isArray(v)){v.forEach(visit);return;}if(v?.props)visit(v.props.children);}const open=()=>{handle.sideSwipe.begin();handle.sideSwipe.move(-100);visit(tree);};return{open,handle,visit:()=>visit(tree),replace:()=>setSource({url:`file:///${prepared+1}.mp4`,title:'new',startVolumeLimit:0,digitalCrownVolume:true})};}

test('speed follows successive source replacements with the same native generation',async()=>{
 const f=mount();await flush();f.open();panelProps.onSpeed(1.5);await flush();
 expect(speeds.at(-1)).toBe(1.5);
 f.replace();await flush();expect(speeds.at(-1)).toBe(1.5);const count=speeds.length;
 f.replace();await flush();expect(speeds.length).toBeGreaterThan(count);
});
test('late speed reply cannot replace the new source position',async()=>{
 const f=mount();await flush();f.open();let release!:()=>void;speedGate=new Promise<void>(r=>release=r);panelProps.onSpeed(1.5);await flush();
 f.replace();await flush();const position=sourcePosition;release();await flush();f.visit();
 expect(panelProps.positionMs()).toBe(position);expect(speeds.length).toBeGreaterThanOrEqual(2);
});
