import {expect,test} from "bun:test";
import {layoutContent,contentAnchorAt,offsetForContentAnchor} from "../../src/reader/content-layout.ts";
import {ReadingProgressStore} from "../../src/reader/progress.ts";
import type {ContentBlock} from "../../src/reader/content.ts";
import {defaultReaderPreset} from "../../src/reader/preset.ts";
import {createContentLayouter,readerColor} from "../../src/reader/content-layout.ts";
const blocks:ContentBlock[]=[{type:"text",style:"title",text:"heading"},{type:"image",url:"image"},{type:"text",style:"body",text:"body text that wraps over multiple lines"},{type:"video",url:"video"}];
const measure=(text:string)=>text.length*8;
test("preset changes update wrapping, role colors and line height without losing text anchors",()=>{
 const blocks:ContentBlock[]=[{type:"text",style:"title",text:"标题"},{type:"text",style:"body",text:"paragraph text ".repeat(40)},{type:"text",style:"subtitle",text:"subtitle"}];
 const layout=createContentLayouter(text=>text.length*7),dark=defaultReaderPreset("dark");
 const before=layout(blocks,180,14,{},dark);
 const light=defaultReaderPreset("light","light",false);
 light.body={...light.body,lineHeightEm:2,fontSizeSp:22,alignment:"CENTER",letterSpacingEm:.04};
 light.categoryTypographyEnabled=true;light.title={fontSizeSp:14,fontWeight:400,colorArgb:0xffaa1100};
 const after=layout(blocks,180,14,{},light);
 expect(after.height).toBeGreaterThan(before.height);
 expect(after.rows[0]).toMatchObject({kind:"text",lineHeight:28,color:"#aa1100ff",fontSlot:34});
 expect(after.rows.find(row=>row.kind==="text"&&row.blockIndex===1)).toMatchObject({lineHeight:44,color:"#221f1bff",textAlign:1,tracking:.88});
 const row=before.rows.find(row=>row.blockIndex===1)!;
 const anchor=contentAnchorAt(before,row.top+row.gap+3);
 const restored=contentAnchorAt(after,offsetForContentAnchor(after,anchor,after.height));
 expect(restored.character).toBe(anchor.character);expect(restored.fraction).toBeCloseTo(anchor.fraction);
 expect(readerColor(0xcb112233)).toBe("#112233cb");
 const recolored={...light,body:{...light.body,colorArgb:0xff334455}};
 const colored=layout(blocks,180,14,{},recolored);
 expect(colored.height).toBe(after.height);expect(colored.rows.find(row=>row.kind==="text"&&row.blockIndex===1)).toMatchObject({color:"#334455ff"});
});
test("content layout respects native role sizes, block gaps and image aspect",()=>{
 const layout=layoutContent(blocks,100,14,measure,{1:2});
 expect(layout.rows[0].height).toBeCloseTo(14*1.55*1.35);
 const image=layout.rows.find(r=>r.kind==="image")!;expect(image.height).toBe(56);
 expect(layout.rows.find(r=>r.kind==="video")!.height).toBe(62.25); // Native 16:9 placeholder plus 6 dp block gap.
 expect(layout.rows.every((row,i)=>i===0||Math.abs(row.top-layout.rows[i-1].top-layout.rows[i-1].height)<.0001)).toBe(true);
});
test("text anchor stays on its source text when image size and font change",()=>{
 const before=layoutContent(blocks,100,14,measure),after=layoutContent(blocks,90,18,measure,{1:.25});
 const row=before.rows.find(r=>r.kind==="text"&&r.blockIndex===2)!;
 const anchor=contentAnchorAt(before,row.top+row.gap+row.height*.3);
 const restored=offsetForContentAnchor(after,anchor,after.height);
 const actual=contentAnchorAt(after,restored);
 expect(actual.character).toBe(anchor.character);expect(actual.fraction).toBeCloseTo(anchor.fraction);
});
test("media anchors retain fractional position and roundtrip through storage",async()=>{
 const before=layoutContent(blocks,100,14,measure),after=layoutContent(blocks,100,14,measure,{1:.5});
 const image=before.rows.find(r=>r.kind==="image")!;
 const anchor=contentAnchorAt(before,image.top+image.gap+50);
 expect(anchor.mediaIndex).toBe(1);expect(anchor.fraction).toBe(.5);
 let stored="";const store=new ReadingProgressStore({get:async()=>stored,set:async(_k,value)=>{stored=value;}});
 await store.save(42,100,.2,anchor);const loaded=await store.load(42);
 expect(loaded.textAnchor).toEqual(anchor);
 const y=offsetForContentAnchor(after,loaded.textAnchor!,after.height);
 const resumed=contentAnchorAt(after,y);expect(resumed.mediaIndex).toBe(anchor.mediaIndex);expect(resumed.character).toBe(anchor.character);expect(resumed.fraction).toBeCloseTo(anchor.fraction);
});

test("image reflow reuses text wrapping and measurement cache stays bounded",async()=>{
 const {createContentLayouter}=await import("../../src/reader/content-layout.ts");
 let calls=0;const measure=(s:string)=>{calls++;return s.length*7;};const layout=createContentLayouter(measure);
 const blocks:import("../../src/reader/content.ts").ContentBlock[]=[{type:"text",text:"重复正文".repeat(20000),style:"body"},{type:"image",url:"image"},{type:"text",text:"尾段",style:"body"}];
 const first=layout(blocks,205,14),initial=calls;expect(initial).toBeLessThan(150);
 const resized=layout(blocks,205,14,{1:2});expect(calls).toBe(initial);expect(resized).toEqual(layoutContent(blocks,205,14,s=>s.length*7,{1:2}));expect(resized.height).not.toBe(first.height);
 expect(layout(blocks,120,18,{1:2})).toEqual(layoutContent(blocks,120,18,s=>s.length*7,{1:2}));
 const many=Array.from({length:5000},(_,i)=>({type:"text" as const,text:String(i),style:"body" as const}));layout(many,205,14);const before=calls;layout([{type:"text",text:"0",style:"body"}],205,14);expect(calls).toBeGreaterThan(before);
});

test("native hard-wrap fast path preserves line output and avoids grapheme measurement loops",async()=>{
 const {createContentLayouter}=await import("../../src/reader/content-layout.ts");let wraps=0,measures=0;
 const measure=(s:string)=>Array.from(s).length*7;
 const layout=createContentLayouter(s=>{measures++;return measure(s);},(text,_slot,width)=>{wraps++;let used=0;const breaks:number[]=[];for(const cp of Array.from(text)){if(used&&used%Math.floor(width/7)===0)breaks.push(Array.from(text).slice(0,used).join("").length);used++;}return breaks;});
 const blocks:import("../../src/reader/content.ts").ContentBlock[]=[{type:"text",text:"中文𠮷".repeat(200),style:"body"}];
 expect(layout(blocks,98,14)).toEqual(layoutContent(blocks,98,14,measure));expect(wraps).toBe(1);expect(measures).toBe(0);
 for(const text of ["English words with spaces", "e\u0301".repeat(40),"👨‍👩‍👧‍👦".repeat(5)]){const before=wraps;const special:import("../../src/reader/content.ts").ContentBlock[]=[{type:"text",text,style:"body"}];expect(layout(special,98,14)).toEqual(layoutContent(special,98,14,measure));expect(wraps).toBe(before);}
});

test("an empty native hard-wrap result falls back to bounded visible lines",()=>{
 const measure=(value:string)=>Array.from(value).length*7;
 const text="字".repeat(2000);
 const block:import("../../src/reader/content.ts").ContentBlock={type:"text",text,style:"body"};
 const fallback=createContentLayouter(measure,()=>[])([block],205,14);
 expect(fallback).toEqual(layoutContent([block],205,14,measure));
 expect(fallback.rows.length).toBeGreaterThan(1);
 expect(Math.max(...fallback.rows.map(row=>row.kind==="text"?new TextEncoder().encode(row.text).length:0))).toBeLessThan(4096);
});
