import {expect,mock,spyOn,test} from 'bun:test';
import * as solid from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
import {oracle} from './upstream-u9-loader.ts';
const fw=Bun.resolveSync('@podjs/framework/startup',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',fw),()=>solid);
let trace:any[]=[],frames=new Set<()=>void>(),state:any={};
const element=(kind:string)=>(props:any)=>{const p=Object.create(props);Object.defineProperty(p,'children',{value:props.children,enumerable:true});return {kind,props:p};};
const implementations={renderer:{createComponent,mergeProps,memo:createMemo,effect:createRenderEffect},components:{View:element('View'),Image:element('Image'),Text:element('Text')},lifecycle:{onFrame:(fn:()=>void)=>{frames.add(fn);onCleanup(()=>frames.delete(fn));}}};
for(const [name,impl] of Object.entries(implementations))for(const path of ['@pocketjs/framework/'+name,Bun.resolveSync('@pocketjs/framework/'+name,fw)])mock.module(path,()=>impl);
const realWatch=await import('@podjs/framework/watch');
const watch={...realWatch,getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233}),setNavigationState:(value:any)=>{state={...state,...value};trace.push(['navigation',structuredClone(state)]);},navigationStateSnapshot:()=>state};
for(const path of ['@podjs/framework/watch',Bun.resolveSync('@podjs/framework/watch',fw)])mock.module(path,()=>watch);
mock.module(Bun.resolveSync('../src/core/startup-trace.ts',import.meta.dir),()=>({startupMark:(label:string)=>trace.push(['mark',label])}));
const old=await oracle('ui/StartupGate.tsx');
const current=await import('../src/ui/StartupGate.tsx') as any;
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
function snapshot(v:any):any{
 if(typeof v==='function')return snapshot(v());
 if(Array.isArray(v))return v.flatMap(x=>{const s=snapshot(x);return Array.isArray(s)?s:[s];}).filter(x=>x!==undefined);
 if(!v||typeof v!=='object')return v;
 if('props'in v){const result:any={kind:v.kind};for(const k in v.props)result[k]=k==='onPress'?'[callback]':snapshot(v.props[k]);return result;}
 return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,snapshot(x)]));
}
test('overlay full tree, content mount, timing, restart and cleanup match frozen oracle with default clock',async()=>{
 async function run(C:any,contentChanges:boolean){trace=[];frames=new Set();state={canGoBack:true,rootSwipeEnabled:true};let now=100,dispose!:()=>void,mounts=0;
  const clock=spyOn(globalThis.performance,'now').mockImplementation(()=>now);
  const [ready,setReady]=createSignal(false),[exit,setExit]=createSignal(false);
  try{
   const tree=createRoot(d=>{dispose=d;return createComponent(C,{ready,exit,render:()=>{mounts++;trace.push(['mount']);if(contentChanges)watch.setNavigationState({canGoBack:true,rootSwipeEnabled:true});onCleanup(()=>trace.push(['unmount']));return {kind:'Content',props:{children:'destination'}};}});});
   await tick();const shots:any[]=[snapshot(tree)];
   const frame=async(time:number)=>{now=time;for(const cb of [...frames])cb();await tick();shots.push(snapshot(tree));};
   await frame(50);setReady(true);await tick();shots.push(snapshot(tree));setExit(true);await tick();await frame(120);await frame(250);
   setExit(false);await tick();shots.push(snapshot(tree));await frame(350);setExit(true);await tick();await frame(649);await frame(650);await frame(900);
   setExit(false);await tick();shots.push(snapshot(tree));setReady(false);await tick();setExit(true);await tick();await frame(1000);await frame(1200);
   dispose();return {trace,shots,mounts,state,frames:frames.size};
  }finally{dispose?.();clock.mockRestore();}
 }
 for(const contentChanges of [false,true])expect(await run(current.StartupTransition,contentChanges)).toEqual(await run(old.StartupTransition,contentChanges));
});
test('early unmount drops frame subscriptions and only restores its own navigation publisher',async()=>{
 async function run(C:any,replaced:boolean){trace=[];frames=new Set();state={canGoBack:true,rootSwipeEnabled:true};let dispose!:()=>void;
  createRoot(d=>{dispose=d;return createComponent(C,{exitElapsedMs:0});});if(replaced)watch.setNavigationState({canGoBack:true,rootSwipeEnabled:true});dispose();return {trace,state,frames:frames.size};
 }
 for(const replaced of [false,true])expect(await run(current.StartupLoading,replaced)).toEqual(await run(old.StartupLoading,replaced));
});
