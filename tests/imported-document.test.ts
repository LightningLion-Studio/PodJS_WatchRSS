import {expect,test} from "bun:test";
import {ImportedReaderDocument,importedBytesBefore,importedCharForByte,importedByteTarget} from "../src/reader/imported-document.ts";
import {layoutContent} from "../src/reader/content-layout.ts";
import {ReadingProgressStore} from "../src/reader/progress.ts";
import type {ContentBlock} from "../src/reader/content.ts";
const handle={marker:"watchrss-watch-content:test.txt",byteLength:50000,chunkBytes:16384,chunkCount:4};
const measure=async(block:ContentBlock)=>layoutContent([block],80,14,text=>text.length*7);
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
test("visible chunks load one at a time without preloading the remaining file",async()=>{
 const reads:number[]=[];let updates=0;
 const doc=new ImportedReaderDocument(handle,async index=>{reads.push(index);return index===0?"正文".repeat(800):"其他段落";},measure,()=>updates++);
 expect(reads).toEqual([]);expect(doc.layout().height).toBe(19);
 await doc.visible(0,233);expect(reads).toEqual([0]);expect(updates).toBe(1);expect(doc.layout().height).toBeGreaterThan(2000);
 await doc.visible(0,233);expect(reads).toEqual([0]);
 await doc.visible(doc.layout().height-15,233);expect(reads).toEqual([0,1]);
 doc.close();await doc.visible(0,233);expect(reads).toEqual([0,1]);
});
test("blank chunks disappear while later chunks keep raw CRLF and surrogate source offsets",async()=>{
 const doc=new ImportedReaderDocument(handle,async index=>index===0?" \t\u2007":"第一行\r\n汉😀第二行。",measure,()=>{});
 await doc.ensure(0);expect(doc.layout().rows[0]?.blockIndex).toBe(1);
 await doc.ensure(1);const rows=doc.layout().rows.filter(row=>row.blockIndex===1);
 expect(rows[0]?.gap).toBe(6);expect(rows[1]?.sourceStart).toBe(5);
 const selected=rows[1]!,anchor=doc.anchor(40+selected.top+selected.gap+2,40)!;
 expect(anchor).toMatchObject({chunkIndex:1,charOffset:5});expect(doc.offset(anchor,40,10000)).toBeCloseTo(40+selected.top+selected.gap+2);
 expect(doc.progress(anchor)).toBe(Math.fround((16384+importedBytesBefore(doc.text(1)!,5))/50000));
});
test("progress jumps straight to a target chunk and preserves the same raw character after reflow",async()=>{
 const reads:number[]=[];let width=100;
 const doc=new ImportedReaderDocument(handle,async i=>{reads.push(i);return "正文甲乙丙丁戊己庚辛壬癸".repeat(100);},async block=>layoutContent([block],width,14,text=>text.length*7),()=>{});
 const target=importedByteTarget(handle,.8);expect(target.chunkIndex).toBe(2);await doc.ensure(target.chunkIndex);expect(reads).toEqual([2]);
 const row=doc.layout().rows.filter(r=>r.blockIndex===2)[20]!,anchor=doc.anchor(row.top+1,0)!;
 width=60;await doc.relayout();const restored=doc.offset(anchor,0,100000),after=doc.anchor(restored,0)!;
 expect(after.chunkIndex).toBe(2);expect(after.charOffset).toBeLessThanOrEqual(anchor.charOffset);expect(anchor.charOffset-after.charOffset).toBeLessThan(9);expect(reads).toEqual([2]);
});
test("closed documents discard asynchronous file and layout results",async()=>{
 const read=deferred<string|null>();let updates=0;
 const doc=new ImportedReaderDocument(handle,()=>read.promise,measure,()=>updates++);
 const pending=doc.ensure(0);doc.close();read.resolve("过期正文");await pending;expect(updates).toBe(0);expect(doc.text(0)).toBeUndefined();
});
test("UTF-8 positions follow native code point counting, including offsets inside a surrogate pair",()=>{
 const text="A汉😀B";expect([0,1,2,3,4,5].map(i=>importedBytesBefore(text,i))).toEqual([0,1,4,8,8,9]);
 expect(Array.from({length:10},(_,i)=>importedCharForByte(text,i))).toEqual([0,1,1,1,2,2,2,2,4,5]);
 expect(importedByteTarget(handle,1)).toEqual({chunkIndex:3,byteOffset:847});
});
test("imported reading coordinates survive storage and malformed coordinates are rejected",async()=>{
 const kv=new Map<string,string>(),store=new ReadingProgressStore({get:async key=>kv.get(key)??null,set:async(key,value)=>{kv.set(key,value);}});
 const anchor={marker:handle.marker,chunkIndex:2,charOffset:40,fraction:.5};await store.save(1,123,.6,undefined,anchor);
 expect((await store.load(1)).importedAnchor).toEqual(anchor);
 kv.set("watchrss.reader.progress.1",JSON.stringify({importedAnchor:{...anchor,chunkIndex:-1}}));expect((await store.load(1)).importedAnchor).toBeUndefined();
});
test("byte restore targets and every character offset match unchanged native functions",async()=>{
 const native=(await import("./fixtures/imported-reader-native.json")).default;
 for(const row of native.texts){expect(row.bytesFromMinusOne.map((_,i)=>importedBytesBefore(row.text,i-1))).toEqual(row.bytesFromMinusOne);expect(row.charsFromMinusOne.map((_,i)=>importedCharForByte(row.text,i-1))).toEqual(row.charsFromMinusOne);}
 for(const {input,chunkIndex,byteOffset} of native.targets)expect(importedByteTarget({...handle,...input},input.progress)).toEqual({chunkIndex,byteOffset});
});

test('missing chunks fail explicitly and retry the same coordinate instead of caching an empty body',async()=>{
 let available=false;const reads:number[]=[];
 const doc=new ImportedReaderDocument(handle,async index=>{reads.push(index);return available?'恢复正文':null;},measure,()=>{});
 await expect(doc.ensure(0)).rejects.toThrow('加载失败可重试');expect(doc.text(0)).toBeUndefined();
 available=true;await doc.ensure(0);expect(doc.text(0)).toBe('恢复正文');expect(reads).toEqual([0,0]);
});
