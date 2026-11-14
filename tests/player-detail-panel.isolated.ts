import {afterEach,expect,mock,test} from 'bun:test';
import {createMemo,createRenderEffect,createRoot,createSignal,onCleanup} from 'solid-js';
const frames:{fn:()=>void;needs:()=>boolean}[]=[],gestures:any[]=[],backs=new Set<()=>boolean>();
let time=1000;const clock=Date.now;Date.now=()=>time;
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>{const children=createMemo(()=>props.children);const node={kind,props:new Proxy(props,{get(target,key){return key==='children'?children():target[key];}})};props.ref?.(node);return node;}])));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gestures.push(options);onCleanup(()=>gestures.splice(gestures.indexOf(options),1));return{dispose(){options.onCancel?.();}};}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:any,needs=()=>true){const entry={fn,needs};frames.push(entry);onCleanup(()=>frames.splice(frames.indexOf(entry),1));}}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>Array.from(text).length*12})}));
mock.module('@pocketjs/framework/input',()=>({hitNode:()=>null,pressNode(){}}));
mock.module('@podjs/framework/watch',()=>({onSystemBack:(fn:any)=>{backs.add(fn);return()=>backs.delete(fn);}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:()=>null}));
const {PlayerDetailPanel,createDetailSlide}=await import('../src/ui/PlayerDetailPanel.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{stops.splice(0).forEach(stop=>stop());expect(frames).toHaveLength(0);expect(gestures).toHaveLength(0);expect(backs.size).toBe(0);Date.now=clock;});
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v?.props)return[];return[v,...nodes(v.props.children)];}
function mount(description='',supported=true){Date.now=()=>time;let slide:any,handle:any,tree:any,canSeek=true,setSupported!:(value:boolean)=>void;const seeks:number[]=[],volumes:any[]=[],speeds:number[]=[];
 createRoot(stop=>{stops.push(stop);const [hasSpeed,set]=createSignal(supported);setSupported=set;slide=createDetailSlide(()=>233);tree=PlayerDetailPanel({width:233,height:233,slide,title:()=>'',author:()=>undefined,description:()=>description,cover:()=>undefined,positionMs:()=>1000,durationMs:()=>10000,seekable:()=>canSeek,onSeek:d=>seeks.push(d),volumePercent:()=>20,muted:()=>false,onVolume:(...args)=>volumes.push(args),speed:()=>hasSpeed()?1:undefined,onSpeed:s=>speeds.push(s),ref:h=>handle=h});});
 slide.open();time+=300;frames.slice().forEach(f=>f.fn());
 const find=(name:string)=>nodes(tree).find(n=>n.props.debugName===name);
 return{slide,handle,find,setSupported,seeks,volumes,speeds,disable:()=>canSeek=false,tick(){time+=300;frames.slice().forEach(f=>f.fn());nodes(tree);},nodes:()=>nodes(tree)};
}
test('crown selection returns to paging on deselect and vertical pan',()=>{
 const f=mount();f.handle.crown(15000);f.tick();f.find('PlayerDetail-progress-value').props.onPress();f.handle.crown(4000);expect(f.seeks).toEqual([1000]);
 f.find('PlayerDetail-progress-value').props.onPress();f.handle.crown(15000);f.tick();expect(f.find('PlayerDetail-volume-value')).toBeDefined();
 f.find('PlayerDetail-volume-value').props.onPress();f.handle.crown(1000);expect(f.volumes).toEqual([[1,true]]);
 const pager=gestures.find(g=>g.axis==='y');pager.onPanStart({dy:-80});pager.onPanEnd({vy:0});f.tick();expect(f.find('PlayerDetail-speed-value')).toBeDefined();
 f.find('PlayerDetail-speed-value').props.onPress();f.handle.crown(12000);expect(f.speeds).toEqual([1.25]);
});
test('cancelled dismiss stays open and system back restores the player',()=>{
 const f=mount(),dismiss=gestures.find(g=>g.axis==='x');dismiss.onPanStart({dx:100});dismiss.onPanMove({dx:180});dismiss.onCancel();f.tick();expect(f.slide.x()).toBe(0);
 expect([...backs][0]()).toBe(true);f.tick();expect(f.slide.shown()).toBe(false);
});
test('cancelled open stays closed and a new open remains usable',()=>{
 Date.now=()=>time;let slide:any;createRoot(stop=>{stops.push(stop);slide=createDetailSlide(()=>233);});
 slide.begin();slide.move(-180);slide.cancel();time+=300;frames.forEach(f=>f.fn());expect(slide.shown()).toBe(false);slide.open();time+=300;frames.forEach(f=>f.fn());expect(slide.x()).toBe(0);
});
test('panel steppers repeat only until disabled or scope disposal',()=>{
 const f=mount();f.handle.crown(15000);f.tick();const plus=f.find('PlayerDetail-progress-plus'),hold=gestures.find(g=>g.region?.node?.()===plus);hold.onLongPress();frames.slice().forEach(f=>f.fn());expect(f.seeks).toEqual([4000]);f.disable();f.tick();expect(f.seeks).toEqual([4000]);stops.pop()!();expect(frames).toHaveLength(0);
});

test('all description continuation pages precede the controls',()=>{
 const description='完整简介内容'.repeat(100)+'最终末尾',f=mount(description);let read='';
 for(let i=0;i<100;i++){f.handle.crown(15000);f.tick();const page=f.nodes().find(n=>n.props.debugName?.startsWith('PlayerDetailPage-about:'));if(!page)break;read+=nodes(page).filter(n=>n.kind==='Text'&&n.props.children!=='简介').map(n=>n.props.children).join('');}
 expect(read).toBe(description);expect(f.find('PlayerDetail-progress-value')).toBeDefined();expect(frames.length).toBeLessThanOrEqual(6);
});
test('losing speed support returns the crown to an existing page',()=>{
 const f=mount();for(let i=0;i<3;i++){f.handle.crown(15000);f.tick();}f.find('PlayerDetail-speed-value').props.onPress();f.setSupported(false);f.tick();expect(f.find('PlayerDetail-volume-value')).toBeDefined();f.handle.crown(-15000);f.tick();expect(f.find('PlayerDetail-progress-value')).toBeDefined();
});

test('disposing a dragged panel cannot reopen its surviving parent slide',()=>{
 Date.now=()=>time;let slide:any,stopPanel!:()=>void;
 createRoot(stop=>{stops.push(stop);slide=createDetailSlide(()=>233);});slide.open();time+=300;frames.slice().forEach(f=>f.fn());
 createRoot(stop=>{stopPanel=stop;PlayerDetailPanel({width:233,height:233,slide,title:()=>'',author:()=>undefined,description:()=>undefined,cover:()=>undefined,positionMs:()=>0,durationMs:()=>1000,seekable:()=>true,onSeek(){},volumePercent:()=>20,muted:()=>false,onVolume(){},speed:()=>1,onSpeed(){}});});
 const dismiss=gestures.find(g=>g.axis==='x');dismiss.onPanStart({dx:100});slide.reset();stopPanel();time+=300;frames.slice().forEach(f=>f.fn());expect(slide.shown()).toBe(false);
});
test('settled detail panels unregister animation callbacks',()=>{
 const f=mount();expect(frames).toHaveLength(0);f.handle.crown(15000);expect(frames.length).toBeGreaterThan(0);f.tick();expect(frames).toHaveLength(0);
});
