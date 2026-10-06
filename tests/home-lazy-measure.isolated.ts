import {expect,mock,test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from "solid-js";
const require=createRequire(import.meta.url),{transformSync}=require("@babel/core");
plugin({name:"scroll-recycle-solid",setup(builder){builder.onLoad({filter:/\/HomeScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require("babel-preset-solid"),{generate:"universal",moduleName:"@pocketjs/framework/renderer"}],[require("@babel/preset-typescript"),{isTSX:true,allExtensions:true}]]}).code,loader:"js"}));}});
type Element={props:any};
mock.module("@pocketjs/framework/renderer",()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module("@pocketjs/framework/components",()=>({Text:(props:any)=>({props}),View:(props:any):Element=>{const children=createMemo(()=>props.children);return {props:{get children(){return children();},get style(){return props.style;}}};}}));
mock.module("@pocketjs/framework/gesture",()=>({createGesture:()=>{}}));
mock.module("@pocketjs/framework/kinetics",()=>({bindDpadScroll:()=>{},createScroller:()=>{throw new Error("unexpected internal scroller");}}));
mock.module("@pocketjs/framework/lifecycle",()=>({onFrame:()=>{}}));
mock.module("@pocketjs/framework/input",()=>({pressNode:()=>{},hitNode:()=>{}}));
mock.module("@pocketjs/framework/devtools",()=>({frameProfileStart:()=>0,frameProfileRecord:()=>{}}));

let scroll:any,measurements=0;
mock.module("@pocketjs/framework/host",()=>({getOps:()=>({measureText:(text:string)=>{measurements++;return Array.from(text).length*10;}})}));
mock.module("../src/ui/ScrollEntries.tsx",()=>({ScrollEntries:(props:any)=>{scroll=props;return null;}}));
mock.module("../src/ui/DeleteConfirmDialog.tsx",()=>({DeleteConfirmDialog:()=>null}));
const {default:HomeScreen}=await import("../src/ui/HomeScreen.tsx");
test("home measures mounted cards while retaining offscreen card heights and wrapping",()=>{
 let stop=()=>{};
 createRoot(dispose=>{
  stop=dispose;const noop=()=>{},done=async()=>{};
  HomeScreen({channels:Array.from({length:30},(_,i)=>({id:String(i),title:"频道标题"+i,url:"https://example.com/"+i,description:"相同摘要用于卡片文字测量",sortOrder:30-i})),notesPlacement:{sortOrder:-1,isPinned:false},width:233,height:233,refreshing:false,busy:false,platformLoginState:{bili:false,douyin:false},onProfile:noop,onNotes:noop,onRecommend:noop,onSpeech:noop,onAdd:noop,onChannel:noop,onBeian:noop,onRefresh:noop,onMoveChannelToTop:done,onToggleChannelPinned:done,onMarkChannelRead:done,onDeleteChannel:done,onClearChannel:done,onMoveNotesToTop:noop,onToggleNotesPinned:noop});
  const rows=scroll.entries;expect(rows.length).toBe(35);expect(measurements).toBe(0);
  expect(rows[1].height).toBe(82);const node=rows[1].render();expect(measurements).toBeGreaterThan(0);expect(measurements).toBeLessThan(40);
  const children=node.props.children,plain=(x:any):any=>typeof x==="function"?plain(x()):Array.isArray(x)?x.map(plain):x;
  const texts=plain(children).filter((x:any)=>x?.props?.children);
  expect(plain(texts[0].props.children)).toBe("频道标题0");
 });stop();
});
