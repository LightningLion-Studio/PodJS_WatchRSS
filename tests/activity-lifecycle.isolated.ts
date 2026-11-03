import {bindPocketModules} from '@podjs/framework/testing/bun-runtime';
import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solidRuntime from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
import {captureActivityNavigation,routeMemory,writeNavigationCheckpoint,readNavigationCheckpoint,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
// Match production's single-Solid alias for the file-linked framework.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solidRuntime);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'activity-recreation-solid',setup(builder){builder.onLoad({filter:/\/ui\/(route-activity|ScrollEntries)\.tsx$|\/variable-list\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
// Keep the production Solid owner/effect graph and scroller state machine.
// Only native rendering and hardware registration are replaced at their boundaries.
type Node={kind:string;props:Record<string,any>};
const element=(kind:string)=>(props:Node['props']):Node=>{
 const children='children' in props?createMemo(()=>props.children):undefined;
 return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};
};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),gestures=new Set<any>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:any)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));return {dispose(){}};},cancelActiveTouches(){}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(opts:any)=>createScrollerWith(createSignal,opts),bindDpadScroll:()=>{}}));
mock.module('@pocketjs/framework/input',()=>({pressNode:()=>{},hitNode:()=>undefined,dispatchAccessibilityAction(){}}));
// Match the compiler's single PocketJS runtime through file-linked source paths.
await bindPocketModules(import.meta.dir,Bun.resolveSync('@podjs/framework/variable-list',import.meta.dir),[
 '@pocketjs/framework/renderer','@pocketjs/framework/components','@pocketjs/framework/lifecycle',
 '@pocketjs/framework/gesture','@pocketjs/framework/kinetics','@pocketjs/framework/input'
]);
const {RouteActivityProvider}=await import('../src/ui/route-activity.tsx');
const {ScrollEntries}=await import('../src/ui/ScrollEntries.tsx');
const disposers:Array<()=>void>=[];
afterEach(()=>{for(const d of disposers.splice(0))d();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);});
const frame=()=>{for(const cb of [...frames])cb();};
function mount(entry:ActivityRoute,content:()=>unknown){
 const checkpoints=new Set<()=>void>(),scrollSlots=new Set<number>();let changed=0,dispose!:()=>void;
 const root=createRoot(stop=>{dispose=stop;disposers.push(stop);return createComponent(RouteActivityProvider,{entry,changed:()=>changed++,checkpoints,scrollSlots,get children(){return content();}} as never);});
 return {root,checkpoints,scrollSlots,dispose,changed:()=>changed,checkpoint:()=>{for(const cb of checkpoints)cb();}};
}
test('lifecycle background synchronously checkpoints a live list and cold restores saved scroll only',async()=>{
 const api=await import('@podjs/framework/watch'),prior=(globalThis as any).pod;
 const wire=new Map<string,string>(),events:any[]=[];
 (globalThis as any).pod={takeEvents:()=>JSON.stringify(events.splice(0)),emit(){},capabilities:()=> '[]',kvGet:(key:string)=>wire.get(key),kvSet:(key:string,value:string)=>{wire.set(key,value);return 0;},kvDelete:(key:string)=>{wire.delete(key);return 0;},kvKeys:()=>JSON.stringify([...wire.keys()])};
 const entry:ActivityRoute={page:'articles',channelId:'feed'};
 routeMemory(entry).retained.query='unsubmitted draft';let scroll:any;
 const first=mount(entry,()=>createComponent(ScrollEntries,{height:100,entries:[{height:900,render:()=>null}],gap:0,padding:0,ref:v=>scroll=v.scroller}));frame();
 const remove=api.onLifecycleCheckpoint(()=>{first.checkpoint();writeNavigationCheckpoint(api.kv,captureActivityNavigation({saved:{consentDraft:'do not persist'},retained:{}},[{page:'home'},entry]));});
 try {
  scroll.scrollTo(419,{immediate:true});
  events.push({t:'lifecycle',state:'background'});api.__pumpPodEvents();
  // No idle frame/cleanup/Promise continuation has run since the latest move.
  const durable=new Map(wire);remove();first.dispose();wire.clear();for(const [k,v]of durable)wire.set(k,v);
  const restored=readNavigationCheckpoint(api.kv)!.at(-1)!;expect(restored.memory!.retained).toEqual({});
  expect([...wire.values()].join('')).not.toContain('unsubmitted draft');expect([...wire.values()].join('')).not.toContain('consentDraft');
  let cold:any;mount(restored,()=>createComponent(ScrollEntries,{height:100,entries:[{height:900,render:()=>null}],gap:0,padding:0,ref:v=>cold=v.scroller}));frame();expect(cold.offset()).toBe(419);
 }finally {remove();(globalThis as any).pod=prior;}
});
