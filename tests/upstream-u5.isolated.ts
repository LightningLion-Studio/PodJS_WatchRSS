import {afterEach, expect, mock, spyOn, test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {dirname} from "node:path";
import {realpathSync} from "node:fs";
import * as solid from "solid-js";
import {createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps, onCleanup} from "solid-js";
const require=createRequire(import.meta.url);
const {transformSync}=require("@babel/core");
plugin({name:"u5-solid",setup(builder){builder.onLoad({filter:/\/(SwipeCard|SwipeActionCard|DeleteConfirmDialog|WatchConfirmDialog)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require("babel-preset-solid"),{generate:"universal",moduleName:"@pocketjs/framework/renderer"}],[require("@babel/preset-typescript"),{isTSX:true,allExtensions:true}]]}).code,loader:"js"}));}});
type Element={props:Record<string,any>};
const element=(props:Element["props"]):Element=>{const p=Object.create(props);Object.defineProperty(p,"children",{value:props.children,enumerable:true});const result={props:p};props.ref?.(result);return result;};
const renderer={createComponent,mergeProps,memo:createMemo,effect:createRenderEffect};
const components={View:element,Text:element,Image:element};
let gestures:any[]=[];const frames=new Set<()=>void>();
const gesture={createGesture:(options:any)=>{gestures.push(options);onCleanup(()=>{gestures=gestures.filter(g=>g!==options);});}};
const lifecycle={onFrame:(callback:()=>void)=>{frames.add(callback);onCleanup(()=>frames.delete(callback));}};
mock.module("@pocketjs/framework/renderer",()=>renderer);
mock.module("@pocketjs/framework/components",()=>components);
mock.module("@pocketjs/framework/gesture",()=>gesture);
mock.module("@pocketjs/framework/lifecycle",()=>lifecycle);
mock.module("@pocketjs/framework/host",()=>({getOps:()=>({measureText:(text:string)=>Array.from(text).length*12})}));
const componentBase=dirname(realpathSync(Bun.resolveSync("@podjs/framework/watch-ui",import.meta.dir)));
mock.module(Bun.resolveSync("solid-js",componentBase),()=>solid);
for(const [name,impl] of Object.entries({renderer,components,gesture,lifecycle}))mock.module(Bun.resolveSync("@pocketjs/framework/"+name,componentBase),()=>impl);
const disposers:Array<()=>void>=[];
afterEach(()=>{while(disposers.length)disposers.pop()!();mock.restore();});
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function nodes(value:any):Element[]{if(typeof value==="function")return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=="object"||!("props" in value))return [];return [value,...nodes(value.props.children)];}
function snapshot(value:any):any{
 if(typeof value==="function")return snapshot(value());
 if(Array.isArray(value))return value.flatMap(v=>{const s=snapshot(v);return Array.isArray(s)?s:[s];});
 if(!value||typeof value!=="object")return value;
 if("props" in value){const p=value.props;const result:Record<string,any>={};for(const k in p)if(!["ref","onPress"].includes(k))result[k]=snapshot(p[k]);return result;}
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,snapshot(v)]));
}
const {SwipeCard}=await import("../src/ui/SwipeCard.tsx");
const {SwipeCard:BeforeSwipe}=await import("./fixtures/upstream-u5/SwipeCard.tsx");
const {DeleteConfirmDialog}=await import("../src/ui/DeleteConfirmDialog.tsx");
const {DeleteConfirmDialog:BeforeDialog}=await import("./fixtures/upstream-u5/DeleteConfirmDialog.tsx");

test("U5 dialog oracle: every node, style, label, busy guard and reactive measurement",async()=>{
 for(const [width,height] of [[233,233],[466,466],[192,240]]){
  const [message,setMessage]=createSignal("");const [busy,setBusy]=createSignal(false);const [title,setTitle]=createSignal("删除？");
  const events:string[][]=[[],[]];
  const mounted=[BeforeDialog,DeleteConfirmDialog].map((Component,i)=>createRoot(dispose=>{disposers.push(dispose);return Component({width,height,get title(){return title();},get message(){return message();},get busy(){return busy();},onConfirm:()=>events[i].push("confirm"),onCancel:()=>events[i].push("cancel")});}));
  for(const text of ["","短消息","长消息 👩‍💻 "+"中文 and English ".repeat(40),"a\nb\nc"]){
   setMessage(text);setTitle(text.slice(0,12));await settle();
   for(const locked of [false,true,false]){setBusy(locked);await settle();expect(snapshot(mounted[1])).toEqual(snapshot(mounted[0]));
    for(const root of mounted)for(const node of nodes(root))node.props.onPress?.();
    expect(events[1]).toEqual(events[0]);
   }
  }
  expect(events[1]).toHaveLength(16);
 }
});

test("U5 swipe oracle: frames, half-width threshold, cancel, edge forwarding, callbacks and enabled props",async()=>{
 let now=1000;spyOn(Date,"now").mockImplementation(()=>now);
 for(const initialOpen of [false,true]){
 const [open,setOpen]=createSignal(initialOpen),[enabled,setEnabled]=createSignal(true),[cardClass,setCardClass]=createSignal<string|undefined>();
 const events:string[][]=[[],[]];
 const start=gestures.length;
 const mounted=[BeforeSwipe,SwipeCard].map((Component,i)=>createRoot(dispose=>{disposers.push(dispose);return Component({get open(){return open();},get swipeEnabled(){return enabled();},get cardClass(){return cardClass();},onOpen:()=>events[i].push("open"),onFavorite:()=>events[i].push("favorite"),onWatchLater:()=>events[i].push("later"),onActions:()=>events[i].push("actions"),onStartSwipe:()=>events[i].push("start"),onOpenSwipe:()=>events[i].push("reveal"),onCloseSwipe:()=>events[i].push("close"),edgeSwipe:{startX:x=>x<12,onSwipe:dx=>events[i].push("edge:"+dx)},children:"content"});}));
 await settle();const pair=gestures.slice(start);
 const check=()=>{expect(snapshot(mounted[1])).toEqual(snapshot(mounted[0]));expect(events[1]).toEqual(events[0]);expect(!!pair[1].region.node()).toBe(!!pair[0].region.node());};
 const frame=(delta:number)=>{now+=delta;for(const f of frames)f();check();};
 const invoke=(name:string,c:any={})=>{for(const g of pair)g[name]?.(c);check();};
 expect(pair.map(g=>[g.axis,g.panSlop])).toEqual([["x",8],["x",8]]);
 for(const root of mounted)for(const node of nodes(root))node.props.onPress?.();invoke("onLongPress");
 for(const delta of [0,45,45,90,1000])frame(delta);
 for(const dx of [-81,-82,-200,40]){invoke("onPanStart",{x:100,dx:0});invoke("onPanMove",{dx});frame(20);invoke("onPanEnd",{dx});frame(90);frame(90);setOpen(false);await settle();frame(180);}
 invoke("onPanStart",{x:100,dx:0});invoke("onPanMove",{dx:-120});invoke("onCancel");frame(180);
 setOpen(false);await settle();frame(180);invoke("onPanStart",{x:5,dx:0});invoke("onPanMove",{dx:100});invoke("onPanEnd",{dx:100});
 invoke("onPanStart",{x:5,dx:0});invoke("onCancel");
 setOpen(true);await settle();frame(90);frame(90);setEnabled(false);await settle();frame(180);expect(pair[1].region.node()).toBeNull();
 setEnabled(true);setCardClass("custom-card");await settle();frame(180);check();
 }
 while(disposers.length)disposers.pop()!();expect(frames.size).toBe(0);expect(gestures).toHaveLength(0);
});
