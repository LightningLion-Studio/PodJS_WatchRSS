import {test,expect,mock} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
import {NetworkRecovery} from '../src/network/recovery.ts';
import {attachGesture,__runGestures,pushTouchBlock,type GestureOptions} from '@pocketjs/framework/gesture';
import {__packTouch,__setTouches} from '../node_modules/@pocketjs/framework/framework/src/touch.ts';
import {__advanceClock} from '../node_modules/@pocketjs/framework/framework/src/clock.ts';
import {BackMotion} from '@podjs/framework/navigation';
import {rightSwipeBack} from '../src/navigation/right-swipe-back.ts';
import {playerGesture} from '../src/ui/player-gestures.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'network-overlay',setup(builder){builder.onLoad({filter:/\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const element=(kind:string,props:any)=>{const children=createMemo(()=>props.children);return {kind,props:mergeProps(props,{get children(){return children();}})};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),FocusScope:(p:any)=>element('FocusScope',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>element('Image',p)}));
// Keep the real arena. Bind its handles and frame ticks to the same Solid
// runtime as the fixture renderer even when the framework has its own copy.
mock.module('@pocketjs/framework/gesture',()=>({attachGesture,__runGestures,pushTouchBlock,createGesture:(options:GestureOptions)=>{
 const handle=attachGesture(options);
 onCleanup(()=>handle.dispose());
 return handle;
}}));
const frameTicks=new Set<()=>void>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(tick:()=>void)=>{
 frameTicks.add(tick);
 onCleanup(()=>frameTicks.delete(tick));
}}));
import * as realInput from '@pocketjs/framework/input';
const inputExports={...realInput};
let hitTarget:any;
mock.module('@pocketjs/framework/input',()=>({
 ...inputExports,
 hitFocusable:(x:number,y:number)=>x===116&&y===195?hitTarget:null,
 pressNode:(node:any)=>node.props.onPress(),
}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(t:string,slot:number)=>t.length*(slot===19?9:12)})}));
mock.module('../src/ui/WatchProgressIndicator.tsx',()=>({WatchProgressIndicator:(p:any)=>element('Spinner',p)}));
type Snapshot = {active:boolean;internet:boolean;validated:boolean;wifi:boolean;cellular:boolean;bluetooth:boolean;snapshotSequence?:number};
type RouteChange={source:'default'|'wifi';reason:'available'|'lost'|'capabilities'};
let snapshot:()=>Promise<Snapshot>, changed:(change?:RouteChange)=>void;
const idleDelay=()=>({result:new Promise<void>(()=>{}),cancel:()=>{}});
let hostDelay:(ms:number)=>ReturnType<typeof idleDelay>=idleDelay;
mock.module('@podjs/framework/services',()=>({
 discovery:{networkSnapshot:()=>snapshot()},
 hostOperation:()=>({result:snapshot(),cancel:()=>{}}),
 onInternetAvailabilityChange:(listener:()=>void)=>{changed=listener;return()=>{};},
 delay:(ms:number)=>hostDelay(ms),
}));
const {networkMessages}=await import('../src/ui/OnboardingNetworkScreen.tsx');
const {NetworkUnavailableOverlay}=await import('../src/ui/NetworkUnavailableOverlay.tsx');
const {createHostNetworkRecovery,NetworkRecoveryProvider,NetworkRecoveryLayer}=await import('../src/ui/network-recovery.tsx');
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v?.props)return[];return[v,...nodes(v.props.children)];}
const text=(v:any)=>nodes(v).filter(n=>n.kind==='Text').map(n=>String(n.props.children)).join('\n').replaceAll('\n','');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
test('actual overlay renders four shared messages and disables only Checking retry',()=>{
 for(const status of ['checking','unavailable','bluetooth','available'] as const){
  let stop!:()=>void,calls=0;const root=createRoot(dispose=>{stop=dispose;return NetworkUnavailableOverlay({width:233,height:233,round:true,status,onAction:()=>calls++});});
  expect(text(root)).toContain('互联网可用状态');expect(text(root)).toContain(networkMessages[status].guidance);expect(text(root)).toContain(networkMessages[status].status);
  expect(nodes(root).some(n=>n.kind==='Spinner')).toBe(status==='checking');
  const button=nodes(root).find(n=>n.props.accessibilityRole==='button');button.props.onPress();expect(calls).toBe(status==='checking'?0:1);
  stop();
 }
});
test('actual route layer appears after failure, shows Checking on retry, disappears and retries once online',async()=>{
 let notify!:(s:any)=>void,checkResolve!:(s:any)=>void,delayCheck=false,calls=0,stop!:()=>void;
 const network=new NetworkRecovery({observe:fn=>{notify=fn;fn('unavailable');return()=>{};},check:()=>delayCheck?new Promise(resolve=>checkResolve=resolve):Promise.resolve('unavailable')});
 const root=createRoot(dispose=>{stop=dispose;return createComponent(NetworkRecoveryProvider,{network,active:()=>true,get children(){return createComponent(NetworkRecoveryLayer,{network,width:233,height:233,round:true});}});});
 expect(text(root)).toBe('');const result=network.run(async()=>{if(++calls===1)throw {code:'network_error'};return 'loaded';});await flush();
 expect(text(root)).toContain('未检测到可用互联网');delayCheck=true;const retry=network.retry();expect(text(root)).toContain('正在检测网络连接');checkResolve('unavailable');await retry;
 notify('available');expect(await result).toBe('loaded');await flush();expect(text(root)).toBe('');expect(calls).toBe(2);stop();
});
const viewport=()=>({x:0,y:0,w:233,h:233});
const gestureRegion={rect:viewport};
function touchFrame(x?:number,y=100){
 __advanceClock();
 __setTouches(x===undefined?[]:[__packTouch(1,x,y)]);
 __runGestures();
 for(const tick of frameTicks)tick();
}
function settleSwipe(){for(let i=0;i<14;i++)touchFrame();}
async function bluetoothLayer(rotation=0){
 let reportNetwork!:(status:'bluetooth'|'available')=>void;
 const network=new NetworkRecovery({observe:fn=>{reportNetwork=fn;fn('bluetooth');return()=>{};},check:async()=> 'bluetooth'});
 let tree:unknown;
 const dispose=createRoot(stop=>{
  tree=createComponent(NetworkRecoveryProvider,{network,active:()=>true,get children(){
   return createComponent(NetworkRecoveryLayer,{network,width:233,height:233,round:true,rotation});
  }});
  return stop;
 });
 await network.run(async()=>true);
 await flush();
 const page=()=>nodes(tree).find(node=>node.props.accessibilityLabel==='互联网');
 expect(page().props.class).toBe('absolute inset-0 bg-[#000000]');
 expect(text(tree)).toContain(networkMessages.bluetooth.guidance);
 expect(text(tree)).toContain(networkMessages.bluetooth.status);
 expect(nodes(tree).some(node=>node.props.style?.bgColor==='#ffa726')).toBe(true);
 return {network,dispose,page,reportNetwork};
}
for(const mode of ['page','immersive','rotated'] as const)test(`Bluetooth right swipe owns ${mode} input and next swipe returns`,async()=>{
 const motion=new BackMotion(233);
 let backStarts=0,competingPans=0;
 const start=(dx:number)=>{backStarts++;motion.begin(dx);};
 const end=(vx:number)=>motion.release(vx,0);
 const move=(dx:number)=>motion.move(dx);
 const cancel=()=>{if(motion.phase==='dragging')motion.release(0,0,true);};
 const rotation=mode==='rotated'?90:0;
 const page=attachGesture(playerGesture(mode==='immersive'
  ? rightSwipeBack(gestureRegion,{start,move,end,cancel})
  : {region:gestureRegion,axis:'x',panSlop:8,onPanStart:c=>start(c.dx),onPanMove:c=>move(c.dx),onPanEnd:c=>end(c.vx),onCancel:cancel},
  ()=>rotation,viewport));
 const layer=await bluetoothLayer(rotation);
 const competing=attachGesture({region:gestureRegion,axis:'x',panSlop:8,onPanStart(){competingPans++;}});
 try{
  touchFrame(46,46);
  touchFrame(rotation?46:166,rotation?166:46);
  expect(layer.page().props.style).toEqual({translateX:rotation?-0:120,translateY:rotation?120:0});
  for(let i=0;i<8;i++)touchFrame(rotation?46:166,rotation?166:46);
  expect(backStarts).toBe(0);
  expect(competingPans).toBe(0);
  expect(motion.offset).toBe(0);
  touchFrame();
  expect(layer.network.bluetooth).toBe(true);
  settleSwipe();
  expect(layer.page()).toBeUndefined();
  expect(layer.network.bluetooth).toBe(false);
  expect(backStarts).toBe(0);

  competing.dispose();
  if(rotation){touchFrame(46,46);touchFrame(46,176);}
  else {touchFrame(46,46);touchFrame(176,46);}
  touchFrame();
  expect(backStarts).toBe(1);
  expect(motion.tick(1000)).toBe('commit');
 }finally{touchFrame();competing.dispose();layer.dispose();page.dispose();}
});
test('two active Bluetooth layers display and dismiss only the top page per swipe',async()=>{
 const bottom=await bluetoothLayer();
 const top=await bluetoothLayer();
 try{
  touchFrame(46,46);touchFrame(166,46);
  const bottomOffset=bottom.page()?.props.style.translateX ?? 0;
  const visibleCount=[bottom.page(),top.page()].filter(Boolean).length;
  expect(top.page().props.style.translateX).toBe(120);
  touchFrame();settleSwipe();

  expect([bottomOffset,bottom.network.bluetooth,top.network.bluetooth]).toEqual([0,true,false]);
  expect(visibleCount).toBe(1);
  expect(top.page()).toBeUndefined();
  expect(bottom.page().props.style.translateX).toBe(0);

  touchFrame(46,46);touchFrame(166,46);touchFrame();settleSwipe();
  expect(bottom.network.bluetooth).toBe(false);
  expect(bottom.page()).toBeUndefined();
 }finally{touchFrame();top.dispose();bottom.dispose();}
});
test('Bluetooth layer changes during a drag never transfer the active contact',async()=>{
 const bottom=await bluetoothLayer();
 const top=await bluetoothLayer();
 try{
  bottom.reportNetwork('available');
  touchFrame(46,46);touchFrame(166,46);
  bottom.reportNetwork('bluetooth');
  expect(bottom.page()).toBeUndefined();
  expect(top.page().props.style.translateX).toBe(120);

  top.reportNetwork('available');
  expect(top.page()).toBeUndefined();
  touchFrame(200,46);touchFrame();settleSwipe();
  expect(bottom.network.bluetooth).toBe(true);
  expect(bottom.page().props.style.translateX).toBe(0);
 }finally{touchFrame();top.dispose();bottom.dispose();}
});
test('Slow short Bluetooth swipe returns to its origin and keeps the page',async()=>{
 const layer=await bluetoothLayer();
 try{
  touchFrame(55);touchFrame(75);
  expect(layer.page().props.style.translateX).toBe(20);
  for(let i=0;i<8;i++)touchFrame(75);
  touchFrame();
  const first=layer.page().props.style.translateX;
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThan(20);
  settleSwipe();
  expect(layer.page().props.style).toEqual({translateX:0,translateY:0});
  expect(layer.network.bluetooth).toBe(true);
 }finally{touchFrame();layer.dispose();}
});
test('Bluetooth page blocks the lower route and Continue dismisses it',async()=>{
 const inputs:string[]=[];
 const vertical=attachGesture({region:gestureRegion,axis:'y',panSlop:8,onPanStart:()=>inputs.push('scroll')});
 const layer=await bluetoothLayer();
 // Even recognizers registered after the overlay must be blocked.
 const horizontal=attachGesture({region:gestureRegion,axis:'x',panSlop:8,onPanStart:()=>inputs.push('horizontal')});
 const tap=attachGesture({region:gestureRegion,onDown:()=>inputs.push('down'),onTap:()=>inputs.push('tap')});
 try{
  for(const [x,y] of [[100,55],[100,155],[55,100]]){
   touchFrame(100,100);touchFrame(x,y);touchFrame();
   expect(layer.page().props.style).toEqual({translateX:0,translateY:0});
  }
  touchFrame(45,40);touchFrame();
  expect(inputs).toEqual([]);
  expect(layer.network.bluetooth).toBe(true);

  hitTarget=nodes(layer.page()).find(node=>node.props.accessibilityRole==='button');
  expect(hitTarget.props.accessibilityLabel).toBe('继续');
  touchFrame(116,195);touchFrame();
  expect(layer.page()).toBeUndefined();
  expect(layer.network.bluetooth).toBe(false);
  expect(inputs).toEqual([]);

  touchFrame(45,40);touchFrame();
  expect(inputs).toEqual(['down','tap']);
 }finally{hitTarget=undefined;touchFrame();layer.dispose();tap.dispose();horizontal.dispose();vertical.dispose();}
});

test('unavailable network stays on the blocking Retry overlay after a right swipe',async()=>{
 const network=new NetworkRecovery({observe:fn=>{fn('unavailable');return()=>{};},check:async()=> 'unavailable'});
 let tree:unknown;
 const dispose=createRoot(stop=>{
  tree=createComponent(NetworkRecoveryProvider,{network,active:()=>true,get children(){
   return createComponent(NetworkRecoveryLayer,{network,width:233,height:233,round:true});
  }});
  return stop;
 });
 try{
  const pending=network.run(async()=>{throw {code:'network_error'};}).catch(error=>error);
  await flush();
  const overlay=()=>nodes(tree).find(node=>node.props.accessibilityLabel==='互联网');
  expect(overlay().props.class).toBe('absolute inset-0 bg-[#000000f0]');
  expect(overlay().props.onPress).toBeFunction();
  touchFrame(46,46);touchFrame(166,46);touchFrame();settleSwipe();
  expect(network.blocking).toBe(true);
  expect(overlay().props.style).toBeUndefined();
  expect(nodes(overlay()).find(node=>node.props.accessibilityRole==='button').props.accessibilityLabel).toBe('重试');
  network.setActive(false);
  await pending;
 }finally{touchFrame();dispose();}
});

test('failed manual snapshot re-enables the overlay Retry button',async()=>{
 let checks=0,requests=0,stop!:()=>void,rejectSnapshot!:(error:Error)=>void;
 const network=new NetworkRecovery({
  observe:fn=>{fn('unavailable');return()=>{};},
  check:async()=>{
   if(++checks===1)return 'unavailable';
   if(checks===2)return new Promise<never>((_,reject)=>rejectSnapshot=reject);
   return 'available';
  },
 });
 const root=createRoot(dispose=>{
  stop=dispose;
  return createComponent(NetworkRecoveryProvider,{network,active:()=>true,get children(){
   return createComponent(NetworkRecoveryLayer,{network,width:233,height:233,round:true});
  }});
 });
 const retryButton=()=>nodes(root).find(n=>n.props.accessibilityRole==='button');
 try{
  const result=network.run(async()=>{if(++requests===1)throw {code:'network_error'};return 'loaded';}).catch(e=>e);
  await flush();
  expect(retryButton().props.accessibilityState.disabled).toBe(false);
  retryButton().props.onPress();
  expect(retryButton().props.accessibilityState.disabled).toBe(true);
  rejectSnapshot(Error('system snapshot failed'));
  await flush();

  expect(network.blocking).toBe(true);
  expect(retryButton().props.accessibilityState.disabled).toBe(false);
  expect(requests).toBe(1);
  retryButton().props.onPress();
  await flush();
  expect(checks).toBe(3);
  expect(network.blocking).toBe(false);
  expect(await result).toBe('loaded');
  expect(requests).toBe(2);
 }finally{stop();}
});


test('an older duplicate offline observation cannot discard the newer manual online snapshot',async()=>{
 const pending:((value:Snapshot)=>void)[]=[];
 snapshot=()=>new Promise(resolve=>pending.push(resolve));
 const sample=(validated:boolean,snapshotSequence:number):Snapshot=>({active:true,internet:true,validated,wifi:true,cellular:false,bluetooth:false,snapshotSequence});
 const network=createHostNetworkRecovery();
 network.setActive(true);
 let work=0;
 try{
  pending.shift()!(sample(false,1));
  await flush();
  const result=network.run(async()=>{if(++work===1)throw {code:'network_error'};return 'loaded';}).catch(error=>error);
  await flush();
  pending.shift()!(sample(false,2));
  await flush();
  expect(network.blocking).toBe(true);

  changed();
  const retry=network.retry();
  expect(pending).toHaveLength(2);
  pending.shift()!(sample(false,3));
  await flush();
  pending.shift()!(sample(true,4));
  await retry;
  await flush();
  expect({blocking:network.blocking,status:network.status,work}).toEqual({blocking:false,status:'available',work:2});
  expect(await result).toBe('loaded');
 }finally{network.dispose();}
});


test('observer-confirmed offline work waits through failed checks and retries once on recovery',async()=>{
 const pending:{resolve:(value:Snapshot)=>void;reject:(error:Error)=>void}[]=[];
 snapshot=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const sample=(validated:boolean,snapshotSequence:number):Snapshot=>({active:true,internet:true,validated,wifi:true,cellular:false,bluetooth:false,snapshotSequence});
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  pending.shift()!.resolve(sample(true,1));
  await flush();
  let work=0;
  const result=network.run(async()=>{if(++work===1)throw {code:'network_error'};return 'loaded';}).catch(error=>error);
  await flush();
  expect(pending).toHaveLength(1);
  const confirmation=pending.shift()!;
  changed();
  pending.shift()!.resolve(sample(false,2));
  await flush();
  expect(network.status).toBe('unavailable');

  confirmation.reject(Error('request confirmation failed'));
  await flush();
  expect({blocking:network.blocking,work}).toEqual({blocking:true,work:1});
  const retry=network.retry();
  pending.shift()!.reject(Error('manual confirmation failed'));
  await retry;
  expect({blocking:network.blocking,work}).toEqual({blocking:true,work:1});

  changed();
  pending.shift()!.resolve(sample(true,3));
  await flush();
  expect({blocking:network.blocking,status:network.status,work}).toEqual({blocking:false,status:'available',work:2});
  expect(await result).toBe('loaded');
  changed();
  pending.shift()!.resolve(sample(true,4));
  await flush();
  expect(work).toBe(2);
 }finally{network.dispose();}
});

test('a recovery notice invalidates an old outage even if both new reads fail',async()=>{
 const offline:Snapshot={active:true,internet:true,validated:false,wifi:true,cellular:false,bluetooth:false,snapshotSequence:1};
 let reads=0;
 snapshot=async()=>{if(++reads===1)return offline;throw Error('system snapshot failed');};
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  await flush();
  expect(network.status).toBe('unavailable');
  changed({source:'default',reason:'available'});
  const statusOnNotice=network.status;
  await flush();

  let work=0,settled=false;
  const error={code:'network_error'};
  const result=network.run(async()=>{work++;throw error;}).catch(failure=>{settled=true;return failure;});
  await flush();
  expect({statusOnNotice,status:network.status,blocking:network.blocking,settled,work,reads})
   .toEqual({statusOnNotice:'checking',status:'checking',blocking:false,settled:true,work:1,reads:3});
  expect(await result).toBe(error);
 }finally{network.dispose();}
});

test('an offline read started before a recovery notice cannot rearm the outage',async()=>{
 const pending:{resolve:(value:Snapshot)=>void;reject:(error:Error)=>void}[]=[];
 snapshot=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const wifi:Snapshot={active:true,internet:true,validated:true,wifi:true,cellular:false,bluetooth:false,snapshotSequence:1};
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  pending.shift()!.resolve(wifi);
  await flush();
  const error={code:'network_error'};
  let calls=0,settled=false;
  const result=network.run(async()=>{if(++calls===1)throw error;return 'loaded';}).catch(failure=>failure).finally(()=>{settled=true;});
  await flush();
  const beforeNotice=pending.shift()!;
  changed({source:'default',reason:'available'});
  pending.shift()!.reject(Error('recovery snapshot failed'));
  await flush();
  beforeNotice.resolve({...wifi,validated:false,snapshotSequence:2});
  await flush();
  expect({status:network.status,blocking:network.blocking,settled}).toEqual({status:'checking',blocking:false,settled:false});
  changed();
  pending.shift()!.resolve({...wifi,snapshotSequence:3});
  expect(await result).toBe('loaded');
  expect(calls).toBe(2);
 }finally{network.dispose();}
});

test('the displayed overlay polls every five seconds and recovers without a notification',async()=>{
 const pending:{ms:number;tick:()=>void}[]=[];
 let cancelled=0;
 hostDelay=ms=>{
  let tick!:()=>void;
  const result=new Promise<void>(resolve=>tick=resolve);
  const timer={ms,tick};
  pending.push(timer);
  return {result,cancel:()=>{
   const index=pending.indexOf(timer);
   if(index!==-1)pending.splice(index,1);
   if(ms===5000)cancelled++;
  }};
 };
 const offline:Snapshot={active:true,internet:true,validated:false,wifi:true,cellular:false,bluetooth:false};
 let reads=0,work=0,onlineAt=5;
 snapshot=async()=>{
  reads++;
  if(reads===3)throw Error('poll failed');
  return {...offline,validated:reads>=onlineAt,snapshotSequence:reads};
 };
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  await flush();
  expect(pending).toHaveLength(0);
  const result=network.run(async()=>{if(++work===1)throw {code:'network_error'};return 'loaded';}).catch(error=>error);
  await flush();
  expect(network.blocking).toBe(true);
  for(const expectedReads of [3,4,5]){
   expect(pending).toHaveLength(1);
   const timer=pending.shift()!;
   expect(timer.ms).toBe(5000);
   timer.tick();
   await flush();
   expect(reads).toBe(expectedReads);
   expect(network.blocking).toBe(expectedReads<5);
  }
  expect(await result).toBe('loaded');
  expect({work,cancelled,remainingTimers:pending.length}).toEqual({work:2,cancelled:1,remainingTimers:0});

  onlineAt=Infinity;
  const later=network.run(async()=>{throw {code:'network_error'};}).catch(error=>error);
  await flush();
  expect(network.blocking).toBe(true);
  const timer=pending[0]!;
  network.setActive(false);
  timer.tick();
  await flush();
  expect((await later).networkRecoveryCancelled).toBe(true);
  expect({reads,cancelled,remainingTimers:pending.length}).toEqual({reads:6,cancelled:2,remainingTimers:0});
 }finally{
  network.dispose();
  hostDelay=idleDelay;
 }
});

test('host capture order wins when an earlier observer request samples later',async()=>{
 const pending:((value:Snapshot)=>void)[]=[];
 snapshot=()=>new Promise(resolve=>pending.push(resolve));
 const sample=(validated:boolean,snapshotSequence:number):Snapshot=>({active:true,internet:true,validated,wifi:true,cellular:false,bluetooth:false,snapshotSequence});
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  pending.shift()!(sample(false,1));
  await flush();
  let work=0;
  const result=network.run(async()=>{if(++work===1)throw {code:'network_error'};return work;}).catch(error=>error);
  await flush();
  pending.shift()!(sample(false,2));
  await flush();
  expect(network.blocking).toBe(true);

  // Both reads follow the notice. The earlier dispatch captures the newer sample.
  changed();
  const retry=network.retry();
  const observer=pending.shift()!, manual=pending.shift()!;
  manual(sample(false,3));
  await retry;
  expect(network.blocking).toBe(true);
  observer(sample(true,4));
  expect(await result).toBe(2);
  expect(network.status).toBe('available');
  expect(network.blocking).toBe(false);
 }finally{network.dispose();}
});

test('older hosts order observation and manual snapshots at dispatch',async()=>{
 const pending:((value:Snapshot)=>void)[]=[];
 snapshot=()=>new Promise(resolve=>pending.push(resolve));
 const sample=(validated:boolean):Snapshot=>({active:true,internet:true,validated,wifi:true,cellular:false,bluetooth:false});
 const network=createHostNetworkRecovery();
 network.setActive(true);
 try{
  pending.shift()!(sample(false));
  await flush();
  let work=0;
  const result=network.run(async()=>{if(++work===1)throw {code:'network_error'};return work;}).catch(error=>error);
  await flush();
  pending.shift()!(sample(false));
  await flush();
  expect(network.blocking).toBe(true);

  changed();
  const retry=network.retry();
  const observer=pending.shift()!, manual=pending.shift()!;
  manual(sample(true));
  await retry;
  observer(sample(false));
  await flush();
  expect(network.status).toBe('available');
  expect(network.blocking).toBe(false);
  expect(await result).toBe(2);
 }finally{network.dispose();}
});
