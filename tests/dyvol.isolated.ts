import {afterEach,beforeEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'dyvol-test',setup(b){b.onLoad({filter:/\/ui\/VideoPlayerScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
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
let prepared=0,tick=0;const realNow=Date.now;
mock.module('@podjs/framework/watch',()=>({kv:{get(){},set(){}},hasCapability:()=>true,lifecycle:()=>'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(delta:number)=>Math.sign(delta)}));
let audioChanged:(v:any)=>void=()=>{};let actual=.5;let muted=false;const writes:number[]=[],polls:(()=>void)[]=[];
const value=()=>({ok:true,state:'playing',positionMs:0,durationMs:10000,width:540,height:960,volume:muted?0:actual,volumeIndex:muted?0:Math.round(actual*16),muted:muted||actual===0,volumeMax:16,hasRenderedFirstFrame:true,sourceGeneration:prepared,presented:true});
const port:any={prepare:()=>{prepared++;return {result:Promise.resolve(value()),cancel(){}};},state:async()=>value(),setMuted:async(v:boolean)=>{muted=v;return value();},setVolume:async(v:number)=>{writes.push(v);actual=Math.round(v*16)/16;return value();}};
for(const method of ['play','pause','retire','seek','stop','setBounds','setTransform','setLoop'])port[method]=async()=>value();
mock.module('@podjs/framework/services',()=>({videoSessions:port,video:port,hostOperation:()=>({result:Promise.resolve({decoderLimit:1,maxSessions:1,surfacePromotion:false,verticalTransition:false}),cancel(){}}),onVideoAudioChanged:(fn:any)=>{audioChanged=fn;return()=>{};},onVideoFirstFrame:()=>()=>{},delay:(ms:number)=>({result:new Promise<void>(yes=>{if(ms===400)polls.push(yes);}),cancel(){}})}));
const {VideoPlayerScreen}=await import('../src/ui/VideoPlayerScreen.tsx');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
let dispose:undefined|(()=>void);beforeEach(()=>{tick=0;Date.now=()=>tick;actual=.5;muted=false;prepared=0;writes.length=0;polls.length=0;});afterEach(()=>{dispose?.();dispose=undefined;Date.now=realNow;});
test('slow player detents survive quantized native replies and intervening polls',async()=>{
 let handle:any;
 createRoot(stop=>{dispose=stop;VideoPlayerScreen({source:{url:'https://fixture.invalid/video',title:'fixture',startVolumeLimit:0,digitalCrownVolume:true},width:233,height:233,offset:0,round:true,active:true,ref:value=>handle=value});});
 await flush();expect(prepared).toBe(1);expect(actual).toBe(.5);expect(writes).toEqual([]);
 for(let i=0;i<3;i++){tick+=1000;expect(handle.onCrown(1)).toBe(true);await flush();const poll=polls.shift();expect(poll).toBeDefined();poll!();await flush();}
 expect(writes).toHaveLength(3);expect(writes[0]).toBeCloseTo(.5+1/48);expect(writes[2]).toBeCloseTo(.5+1/16);expect(actual).toBe(.5625);
 actual=.25;audioChanged(value());await flush();handle.onCrown(1);await flush();expect(writes.at(-1)).toBeCloseTo(.25+1/48);
});

const text=(v:any):string=>typeof v==='function'?text(v()):Array.isArray(v)?v.map(text).join(''):String(v??'');
const walk=(node:any):any[]=>{if(!node)return [];if(Array.isArray(node))return node.flatMap(walk);if(typeof node==='function')return walk(node());return [node,...walk(node.props?.children)];};
test('external changes push the overlay without a poll or swipe and ignore stale generations',async()=>{
 let tree:any;
 createRoot(stop=>{dispose=stop;tree=VideoPlayerScreen({source:{url:'https://fixture.invalid/video',title:'fixture',platform:'douyin',digitalCrownVolume:true},width:233,height:233,offset:0,round:true,active:true});});
 await flush();
 for(const index of [0,16,2,9,1,15,8,4,12,7]){actual=index/16;audioChanged(value());await flush();expect(walk(tree).some(n=>n.kind==='Text'&&text(n.props.children)===`${Math.round(index/16*100)}%`)).toBe(true);}
 actual=.25;audioChanged(value());await flush();
 expect(walk(tree).some(n=>n.kind==='Text'&&text(n.props.children)==='25%')).toBe(true);
 muted=true;audioChanged(value());await flush();
 expect(walk(tree).some(n=>n.props?.accessibilityLabel==='取消系统静音')).toBe(true);
 actual=.75;audioChanged({...value(),sourceGeneration:prepared-1});await flush();
 expect(walk(tree).some(n=>n.kind==='Text'&&text(n.props.children)==='0%')).toBe(true);
});
test('20 separated crown detents preserve fractions and each changes at most one system index',async()=>{
 let handle:any;createRoot(stop=>{dispose=stop;VideoPlayerScreen({source:{url:'https://fixture.invalid/video',title:'fixture',digitalCrownVolume:true},width:233,height:233,offset:0,round:true,active:true,ref:v=>handle=v});});
 await flush();actual=4/16;audioChanged(value());await flush();
 for(const direction of [1,-1]){
  const start=actual;
  for(let i=0;i<10;i++){tick+=1000;const previous=actual;handle.onCrown(direction*(i%2?1000:1));await flush();expect(Math.abs(actual-previous)*16).toBeLessThanOrEqual(1);polls.shift()?.();await flush();}
  expect(actual).toBeCloseTo(start+direction*3/16);
 }
 expect(actual).toBe(4/16);
});

test('20 UI mute pairs act on the current system stream and restart reads system state',async()=>{
 let tree:any;const mount=()=>createRoot(stop=>{dispose=stop;tree=VideoPlayerScreen({source:{url:'https://fixture.invalid/video',title:'fixture',platform:'douyin',digitalCrownVolume:true},width:233,height:233,offset:0,round:true,active:true});});
 mount();await flush();
 for(let pair=0;pair<20;pair++)for(const expected of [true,false]){
  const button=walk(tree).find(n=>n.props?.accessibilityLabel===(muted?'取消系统静音':'系统静音'));
  expect(button).toBeDefined();button.props.onPress();await flush();expect(muted).toBe(expected);expect(actual).toBe(.5);expect(walk(tree).some(n=>n.kind==='Text'&&text(n.props.children)===(expected?'0%':'50%'))).toBe(true);
 }
 muted=true;dispose!();mount();await flush();expect(walk(tree).some(n=>n.props?.accessibilityLabel==='取消系统静音')).toBe(true);expect(muted).toBe(true);
});


test('DYENTRY in-app mute toggles the current system snapshot before a queued external push',async()=>{
 let tree:any;createRoot(stop=>{dispose=stop;tree=VideoPlayerScreen({source:{url:'https://fixture.invalid/video',title:'fixture',platform:'douyin'},width:233,height:233,offset:0,round:true,active:true});});
 await flush();muted=true; // External change; its JS observer has not run yet.
 walk(tree).find(n=>n.props?.accessibilityLabel==='系统静音').props.onPress();await flush();
 expect(muted).toBe(false);expect(walk(tree).some(n=>n.props?.accessibilityLabel==='系统静音')).toBe(true);
 muted=false;audioChanged(value());await flush();muted=true;audioChanged(value());await flush();
 muted=false; // The inverse race must also use fresh readback.
 walk(tree).find(n=>n.props?.accessibilityLabel==='取消系统静音').props.onPress();await flush();expect(muted).toBe(true);
});
