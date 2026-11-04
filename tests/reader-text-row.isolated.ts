import {expect,mock,test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from "solid-js";
const require=createRequire(import.meta.url),{transformSync}=require("@babel/core");
plugin({name:"reader-text-row-test",setup(builder){builder.onLoad({filter:/\/ReaderTextRow\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require("babel-preset-solid"),{generate:"universal",moduleName:"@pocketjs/framework/renderer"}],[require("@babel/preset-typescript"),{isTSX:true,allExtensions:true}]]}).code,loader:"js"}));}});
let displayReads=0,capReads=0,fontReads=0;
const metrics={cellWidth:16,cellHeight:18,baseline:14,lineHeight:18,rasterDensity:2};
mock.module("@pocketjs/framework/renderer",()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module("@pocketjs/framework/components",()=>({View:(props:any)=>({kind:"view",props}),Text:(props:any)=>({kind:"text",props})}));
mock.module("@pocketjs/framework/host",()=>({getOps:()=>({measureText:()=>40})}));
mock.module("@podjs/framework/watch",()=>({getDisplayMetrics:()=>{displayReads++;return{physicalWidth:466,logicalWidth:233};},hasCapability:()=>{capReads++;return true;},getFontMetrics:()=>{fontReads++;return metrics;}}));
mock.module("@podjs/framework/text",()=>({SystemTextLine:(props:any)=>({kind:"raster",props})}));
const {ReaderTextRow,createReaderTextEnvironment}=await import("../src/ui/ReaderTextRow.tsx");
const {defaultReaderPreset}=await import("../src/reader/preset.ts");
function raster(value:any):any {if(typeof value==="function")return raster(value());if(Array.isArray(value))return value.map(raster).find(Boolean);if(value?.kind==="raster")return value;return raster(value?.props?.children??[]);}
const row={kind:"text",text:"正常密度阅读😀",fontSlot:35,scale:1,lineHeight:18,height:18,gap:0,top:0,blockIndex:0,color:"#221f1bff"} as any;
test("production default row preserves raster geometry and reacts to row/configuration changes",()=>{
 createRoot(dispose=>{const [size,setSize]=createSignal(16),[value,setValue]=createSignal(row);
 const tree=ReaderTextRow({get row(){return value();},style:"body",get fontSize(){return size();},width:205});
 const line=raster(tree);expect(line.props.pixelScale).toBe(2);const options=line.props.options;expect(options).toMatchObject({text:row.text,widthPx:410,heightPx:36});expect(line.props.options).toBe(options);
 setSize(20);expect(line.props.options.fontSizePx).toBe(40);setValue({...row,text:"新行😀",fontSlot:34});expect(line.props.options.text).toBe("新行😀");dispose();});
});
test("reader environment shares immutable queries across lines without sharing raster options",()=>{
 displayReads=capReads=fontReads=0;
 createRoot(dispose=>{const env=createReaderTextEnvironment(),preset=defaultReaderPreset("paper","纸张",false,16);
 const lines=Array.from({length:8},(_,i)=>raster(ReaderTextRow({row:{...row,text:`第${i}行`},style:"body",fontSize:16,width:205,preset,environment:env})));
 for(const [i,line] of lines.entries()){expect(line.props.options.text).toBe(`第${i}行`);expect(line.props.options.widthPx).toBe(410);expect(line.props.options).toBe(line.props.options);}
 expect(displayReads).toBe(1);expect(capReads).toBe(1);expect(fontReads).toBe(1);dispose();});
});


test('caret callbacks retain the source row that owned their raster request',()=>{
 createRoot(dispose=>{
  const [value,setValue]=createSignal(row),events:{owner:any;positions:any}[]=[];
  const tree=ReaderTextRow({get row(){return value();},style:'body',fontSize:16,width:205,onCarets:(positions,owner)=>events.push({positions,owner})});
  const line=raster(tree),old=line.props.onCarets;const replacement={...row,text:'另一行😀'};setValue(replacement);const next=line.props.onCarets;
  old(undefined);next([0,1]);expect(events[0].owner).toBe(row);expect(events[1].owner).toBe(replacement);dispose();
 });
});
