import {afterEach,expect,mock,test} from 'bun:test';
import {createMemo,createRenderEffect,createRoot,createSignal,onCleanup} from 'solid-js';
const frames:{fn:()=>void;needs:()=>boolean}[]=[],gestures:any[]=[],backs=new Set<()=>boolean>();
let measurements=0,time=1000;const clock=Date.now;Date.now=()=>time;
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>{const children=createMemo(()=>props.children);const node={kind,props:new Proxy(props,{get(target,key){return key==='children'?children():target[key];}})};props.ref?.(node);return node;}])));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);onCleanup(()=>gestures.splice(gestures.indexOf(options),1));return{dispose(){options.onCancel?.({id:1});}};}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:any,needs=()=>true){const entry={fn,needs};frames.push(entry);onCleanup(()=>frames.splice(frames.indexOf(entry),1));}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>{measurements++;return Array.from(text).length*12;}})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
mock.module('@podjs/framework/watch',()=>({onSystemBack:(fn:any)=>{backs.add(fn);return()=>backs.delete(fn);}}));
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(opts:any)=>createScrollerWith(createSignal,opts),bindDpadScroll:()=>{}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:()=>null}));
let columnLayouts=0;
const layout=await import('../src/ui/player-detail-layout.ts');
const originalColumnLayout=layout.columnLayout;
mock.module('../src/ui/player-detail-layout.ts',()=>({...layout,columnLayout:(...args:Parameters<typeof originalColumnLayout>)=>{columnLayouts++;return originalColumnLayout(...args);}}));
const {PlayerDetailPanel,createDetailSlide}=await import('../src/ui/PlayerDetailPanel.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());expect(frames).toHaveLength(0);expect(gestures).toHaveLength(0);expect(backs.size).toBe(0);Date.now=clock;});
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v?.props)return[];return[v,...nodes(v.props.children)];}
function mount(description='',supported=true,settle=true){Date.now=()=>time;let slide:any,handle:any,tree:any,canSeek=true,setSupported!:(value:boolean)=>void,setProgress!:(value:number)=>void,setSpeed!:(value:number)=>void;const seeks:number[]=[],volumes:any[]=[],speeds:number[]=[];
 createRoot(stop=>{stops.push(stop);const [hasSpeed,set]=createSignal(supported);setSupported=set;const [progress,nextProgress]=createSignal(1000),[speed,nextSpeed]=createSignal(1);setProgress=nextProgress;setSpeed=nextSpeed;slide=createDetailSlide(()=>233);tree=PlayerDetailPanel({width:233,height:233,slide,title:()=>'',author:()=>undefined,description:()=>description,cover:()=>undefined,positionMs:progress,durationMs:()=>10000,seekable:()=>canSeek,onSeek:d=>seeks.push(d),volumePercent:()=>20,muted:()=>false,onVolume:(...args)=>volumes.push(args),speed:()=>hasSpeed()?speed():undefined,onSpeed:s=>speeds.push(s),ref:h=>handle=h});});
 if(settle){slide.open();time+=300;frames.slice().forEach(f=>{if(f.needs())f.fn();});}
 const find=(name:string)=>nodes(tree).find(n=>n.props.debugName===name);
 return{slide,handle,find,setSupported,setProgress,setSpeed,seeks,volumes,speeds,disable:()=>canSeek=false,tick(){for(let i=0;i<90;i++){time+=17;frames.slice().forEach(f=>{if(f.needs())f.fn();});}nodes(tree);},offset:()=>-nodes(tree).find(n=>n.props.debugName==='PlayerDetailColumn').props.style.translateY,nodes:()=>nodes(tree)};
}
test('crown scrolls continuously until a pill is selected, and deselect or pan returns it to scrolling',()=>{
 const f=mount();f.handle.crown(10000);f.tick();const first=f.offset();expect(first).toBeCloseTo(40,0);f.handle.crown(3000);f.tick();expect(f.offset()).toBeCloseTo(52,0);
 f.find('PlayerDetail-progress-value').props.onPress();f.tick();const centred=f.offset();f.handle.crown(4000);f.tick();expect(f.seeks).toEqual([1000]);expect(f.offset()).toBe(centred);
 f.find('PlayerDetail-progress-value').props.onPress();f.handle.crown(5000);f.tick();expect(f.offset()).toBeGreaterThan(centred);
 f.find('PlayerDetail-volume-value').props.onPress();f.tick();f.handle.crown(1000);expect(f.volumes).toEqual([[1,true]]);
 const pager=gestures.find(g=>g.axis==='any');pager.onPanStart({id:1,dy:-10});pager.onPanMove({id:1,fdy:-30});pager.onPanEnd({id:1,vy:0});f.tick();f.handle.crown(5000);expect(f.volumes).toEqual([[1,true]]);
 f.find('PlayerDetail-speed-value').props.onPress();f.handle.crown(12000);expect(f.speeds).toEqual([1.25]);
});
test('cancelled dismiss stays open and system back restores the player',()=>{
 const f=mount(),dismiss=gestures.find(g=>g.axis==='any');dismiss.onPanStart({id:1,dx:100,dy:0});dismiss.onPanMove({id:1,dx:180});dismiss.onCancel({id:1});f.tick();expect(f.slide.x()).toBe(0);
 expect([...backs][0]()).toBe(true);f.tick();expect(f.slide.shown()).toBe(false);
});
test('cancelled open stays closed and a new open remains usable',()=>{
 Date.now=()=>time;let slide:any;createRoot(stop=>{stops.push(stop);slide=createDetailSlide(()=>233);});
 slide.begin();slide.move(-180);slide.cancel();time+=300;frames.forEach(f=>f.fn());expect(slide.shown()).toBe(false);slide.open();time+=300;frames.forEach(f=>f.fn());expect(slide.x()).toBe(0);
});
test('system Back dismisses a panel while the opening finger is still held',()=>{
 const f=mount();f.slide.reset();f.slide.begin();f.slide.move(-33);
 expect([...backs][0]()).toBe(true);
 f.slide.move(-120);f.slide.end(-500);f.tick();
 expect(f.slide.shown()).toBe(false);
 f.slide.open();f.tick();expect(f.slide.shown()).toBe(true);
});
test('a dismissing finger can bring the panel back from off-screen',()=>{
 const f=mount(),dismiss=gestures.find(g=>g.axis==='any');
 dismiss.onPanStart({id:1,dx:80,dy:0});
 dismiss.onPanMove({id:1,dx:233});
 expect(f.slide.x()).toBe(233);
 expect(f.slide.shown()).toBe(true);
 dismiss.onCancel({id:2});
 dismiss.onPanMove({id:1,dx:40});
 dismiss.onPanEnd({id:1,vx:0});
 f.tick();expect(f.slide.x()).toBe(0);
});
test('panel steppers repeat only until disabled or scope disposal',()=>{
 const f=mount();const plus=f.find('PlayerDetail-progress-plus'),hold=gestures.find(g=>g.region?.node?.()===plus);hold.onLongPress();frames.slice().forEach(f=>f.fn());expect(f.seeks).toEqual([4000]);f.disable();f.tick();expect(f.seeks).toEqual([4000]);stops.pop()!();expect(frames).toHaveLength(0);
});

test('the full description scrolls by line and the controls follow it',()=>{
 const description='完整简介内容'.repeat(100)+'最终末尾',f=mount(description),read=new Map<number,string>();
 for(let i=0;i<200;i++){for(const n of f.nodes().filter(n=>n.props.debugName==='PlayerDetailAboutLine'))read.set(n.props.style.insetT,n.props.children);f.handle.crown(15000);f.tick();}
 expect([...read.entries()].sort((a,b)=>a[0]-b[0]).map(e=>e[1]).join('')).toBe(description);
 expect(f.find('PlayerDetail-speed-value')).toBeDefined();
 // Only lines near the viewport are mounted.
 expect(f.nodes().filter(n=>n.props.debugName==='PlayerDetailAboutLine').length).toBeLessThan(14);
});
test('losing speed support clears its selection and keeps the offset in range',()=>{
 const f=mount();for(let i=0;i<6;i++){f.handle.crown(30000);f.tick();}f.find('PlayerDetail-speed-value').props.onPress();f.tick();const before=f.offset();f.setSupported(false);f.tick();
 expect(f.offset()).toBeLessThan(before);f.handle.crown(5000);f.tick();expect(f.speeds).toEqual([]);expect(f.find('PlayerDetail-speed-value')).toBeUndefined();
});

test('disposing a dragged panel cannot reopen its surviving parent slide',()=>{
 Date.now=()=>time;let slide:any,stopPanel!:()=>void;
 createRoot(stop=>{stops.push(stop);slide=createDetailSlide(()=>233);});slide.open();time+=300;frames.slice().forEach(f=>f.fn());
 createRoot(stop=>{stopPanel=stop;PlayerDetailPanel({width:233,height:233,slide,title:()=>'',author:()=>undefined,description:()=>undefined,cover:()=>undefined,positionMs:()=>0,durationMs:()=>1000,seekable:()=>true,onSeek(){},volumePercent:()=>20,muted:()=>false,onVolume(){},speed:()=>1,onSpeed(){}});});
 const dismiss=gestures.find(g=>g.axis==='any');dismiss.onPanStart({id:1,dx:100,dy:0});dismiss.onPanMove({id:1,dx:180});stopPanel();
 expect(slide.begin()).toBe(true);slide.cancel();slide.close();
 time+=300;frames.slice().forEach(f=>f.fn());expect(slide.shown()).toBe(false);
});
test('settled detail panels request no frames',()=>{
 const f=mount();expect(frames.some(e=>e.needs())).toBe(false);f.handle.crown(15000);expect(frames.some(e=>e.needs())).toBe(true);f.tick();expect(frames.some(e=>e.needs())).toBe(false);
});
test('losing speed support mid-centring never leaves the offset past the new end',()=>{
 const f=mount();f.handle.crown(60000);f.tick();f.find('PlayerDetail-speed-value').props.onPress();f.setSupported(false);f.tick();
 expect(f.offset()).toBeLessThanOrEqual(281.5);
});
test('a tap during the edge spring still returns the column to its range',()=>{
 const f=mount(),pager=gestures.find(g=>g.axis==='any');pager.onPanStart({id:1,dx:0,dy:-10});pager.onPanMove({id:1,fdy:100});pager.onPanEnd({id:1,vy:0});expect(f.offset()).toBeLessThan(0);
 pager.onDown();pager.onTap({x:116,y:116});f.tick();expect(f.offset()).toBeGreaterThanOrEqual(0);expect(frames.some(e=>e.needs())).toBe(false);
});
test('another contact cannot move or end the active scroll',()=>{
 const f=mount(),pager=gestures.find(g=>g.axis==='any');
 pager.onPanStart({id:1,dx:0,dy:-10});
 pager.onPanMove({id:1,fdy:-36});
 pager.onPanStart({id:2,dx:0,dy:-10});
 pager.onPanMove({id:2,fdy:-60});
 pager.onPanEnd({id:2,vy:-2000});
 pager.onCancel({id:2});
 expect(f.offset()).toBe(36);
 pager.onPanMove({id:1,fdy:-24});
 pager.onPanEnd({id:1,vy:0});
 f.tick();
 expect(f.offset()).toBe(60);
 expect(frames.some(e=>e.needs())).toBe(false);
});

test('cold summary waits until the slide settles',()=>{
 measurements=0;const f=mount('长简介'.repeat(200),true,false);
 expect(measurements).toBe(0);f.slide.open();
 for(let i=0;i<10;i++){time+=16;frames.slice().forEach(frame=>{if(frame.needs())frame.fn();});}
 expect(measurements).toBe(0);f.tick();expect(measurements).toBeGreaterThan(0);
});
test('progress and speed value updates preserve the layout and the held stepper',()=>{
 const f=mount();f.handle.crown(75000);f.tick();
 const row=f.find('PlayerDetail-speed-minus'),layoutCount=columnLayouts;
 const hold=gestures.find(g=>g.region?.node?.()===row);hold.onLongPress();
 for(let i=0;i<10;i++){f.setProgress(i*100);f.setSpeed(i%2?1.25:1);}
 expect(f.find('PlayerDetail-speed-minus')).toBe(row);
 expect(columnLayouts).toBe(layoutCount);
 f.tick();expect(f.speeds.length).toBeGreaterThan(1);
});
test('a pure left move stays unclaimed and a left-diagonal move scrolls',()=>{
 const f=mount(),gesture=gestures.find(g=>g.axis==='any');
 gesture.onDown();gesture.onMove({dx:-12,dy:-3});expect(gesture.panSlop).toBe(Infinity);
 gesture.onMove({id:1,dx:-12,dy:-10});expect(gesture.panSlop).toBe(8);
 gesture.onPanStart({id:1,dx:-12,dy:-10});
 gesture.onPanMove({id:1,fdx:0,fdy:-70});gesture.onPanEnd({id:1,vy:0});
 expect(f.offset()).toBe(70);expect(f.slide.x()).toBe(0);
});
