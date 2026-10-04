import {expect,test} from "bun:test";
import {requestReaderLayout,requestReaderLayoutBatched,validateParagraphLines,type ParagraphOperation} from "../src/reader/platform-layout.ts";
import {createContentLayouter,type NativeBlockLayouts} from "../src/reader/content-layout.ts";
import type {ContentBlock} from "../src/reader/content.ts";
const block=(text:string):ContentBlock=>({type:"text",text,style:"body"});
test("native source indices survive CRLF, trimmed spaces and repeated text",()=>{
 const b=block("甲乙  \r\n甲乙\n"),map:NativeBlockLayouts=new Map([[b,[{start:0,end:5,visibleEnd:2},{start:5,end:8,visibleEnd:7},{start:8,end:8,visibleEnd:8}]]]);
 const layout=createContentLayouter(text=>text.length*7);
 const before=layout([b],100,14),after=layout([b],100,14,{},undefined,map);
 expect(after).not.toBe(before);
 expect(after.rows.map(row=>[row.sourceStart,row.character,row.kind==="text"?row.text:""])).toEqual([[0,0,"甲乙"],[6,5,"甲乙"],[9,8,""]]);
});
test("cancelled paragraph reply cannot update or start the next block",async()=>{
 let resolve!:(result:{lines:{start:number;end:number;visibleEnd:number}[]})=>void,cancelled=0,requests=0,updates=0;
 const op:ParagraphOperation={result:new Promise(r=>resolve=r),cancel(){cancelled++;}};
 const task=requestReaderLayout([block("甲"),block("乙")],100,14,2,undefined,()=>{requests++;return op;},()=>updates++,()=>{});
 task.cancel();resolve({lines:[{start:0,end:1,visibleEnd:1}]});await task.done;
 expect([requests,cancelled,updates]).toEqual([1,1,0]);
});
test("long preview publishes the first screen and bounded later batches",async()=>{
 const blocks=Array.from({length:37},(_,index)=>block(`段落 ${index}`));
 const updates:NativeBlockLayouts[]=[];
 const task=requestReaderLayout(blocks,200,14,2,undefined,args=>({
  result:Promise.resolve({lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]}),cancel(){}
 }),layouts=>updates.push(layouts),error=>{throw error;},undefined,'compose',{firstBlocks:4,batchBlocks:16});
 await task.done;
 expect(updates.map(layouts=>layouts.size)).toEqual([4,20,36,37]);
 expect(updates[0].has(blocks[36])).toBe(false);
 expect(updates[3].has(blocks[36])).toBe(true);
});
test("batched native layout keeps first-screen publication and valid neighbors of one failed paragraph",async()=>{
 const blocks=Array.from({length:22},(_,index)=>block(`段落 ${index}`)),calls:number[]=[],updates:NativeBlockLayouts[]=[],errors:unknown[]=[];
 const task=requestReaderLayoutBatched(blocks,200,14,2,undefined,args=>{
  calls.push(args.length);
  return {result:Promise.resolve({results:args.map((value,index)=>index===1&&calls.length===2?{error:'invalid paragraph'}:{lines:[{start:0,end:value.text.length,visibleEnd:value.text.length}]})}),cancel(){}};
 },value=>updates.push(value),error=>errors.push(error));
 await task.done;
 expect(calls).toEqual([4,16,2]);
 expect(updates.map(value=>value.size)).toEqual([4,19,21]);
 expect(updates[0].has(blocks[4])).toBe(false);
 expect(updates[2].has(blocks[5])).toBe(false);
 expect(errors).toHaveLength(1);
});
test("cancelled native batch does not publish late replies or begin another batch",async()=>{
 let resolve!:(value:{results:{lines:{start:number;end:number;visibleEnd:number}[]}[]})=>void,requests=0,cancels=0,updates=0;
 const task=requestReaderLayoutBatched([block('甲'),block('乙'),block('丙'),block('丁'),block('戊')],200,14,2,undefined,()=>{
  requests++;return {result:new Promise(r=>resolve=r),cancel(){cancels++;}};
 },()=>updates++,()=>{});
 task.cancel();resolve({results:Array.from({length:4},()=>({lines:[{start:0,end:1,visibleEnd:1}]}))});await task.done;
 expect([requests,cancels,updates]).toEqual([1,1,0]);
});
test("batched layout splits very long paragraphs within the host text limit",async()=>{
 const blocks=[block('甲'.repeat(150000)),block('乙'.repeat(150000)),block('丙')],calls:number[]=[];
 const task=requestReaderLayoutBatched(blocks,200,14,2,undefined,args=>{
  calls.push(args.length);
  expect(args.reduce((sum,value)=>sum+value.text.length,0)).toBeLessThanOrEqual(262144);
  return {result:Promise.resolve({results:args.map(value=>({lines:[{start:0,end:value.text.length,visibleEnd:value.text.length}]}))}),cancel(){}};
 },()=>{},error=>{throw error;});
 await task.done;expect(calls).toEqual([1,2]);
});
test("paragraph failures preserve other results; source omissions are rejected",async()=>{
 const errors:unknown[]=[],updates:NativeBlockLayouts[]=[],blocks=[block("甲乙"),block("丙丁")];let calls=0;
 const task=requestReaderLayout(blocks,205,14,2,undefined,args=>{
  expect(args.widthPx).toBe(410);expect(args.fontSizePx).toBe(28);expect(args.lineBreak).toBe("paragraph");
  calls++;return {result:Promise.resolve({lines:[{start:0,end:calls===1?1:2,visibleEnd:calls===1?1:2}]}),cancel(){}};
 },value=>updates.push(value),error=>errors.push(error));await task.done;
 expect(errors).toHaveLength(1);expect(updates).toHaveLength(1);expect(updates[0].has(blocks[1])).toBe(true);expect(updates[0].has(blocks[0])).toBe(false);
 expect(()=>validateParagraphLines("甲乙",[{start:1,end:2,visibleEnd:2}])).toThrow();
});

test("native line boxes and baseline positions use logical units without stretching atlas metrics",async()=>{
 const blocks=[block("AB CD")];let completed:NativeBlockLayouts=new Map();
 const task=requestReaderLayout(blocks,205,14,2,undefined,args=>{
  expect(args.lineHeightPx).toBeCloseTo(37.8);
  return {result:Promise.resolve({lines:[{start:0,end:3,visibleEnd:2,topPx:0,bottomPx:35,baselinePx:26},{start:3,end:5,visibleEnd:5,topPx:35,bottomPx:71,baselinePx:64}]}),cancel(){}};
 },value=>completed=value,error=>{throw error;});await task.done;
 const layout=createContentLayouter(text=>text.length*7,undefined,()=>({cellHeight:20,baseline:16}));
 const rows=layout(blocks,205,14,{},undefined,completed).rows;
 expect(rows.map(row=>[row.top,row.height])).toEqual([[0,17.5],[17.5,18]]);
 for(const [index,row] of rows.entries()) {
  if(row.kind!=="text")throw new Error("expected text");
  const baseline=row.top+(row.textOffsetY??0)+(row.lineHeight-20)/2+16;
  expect(baseline).toBe([13,32][index]);
 }
});

test("automatic hyphenation retains full paragraph context without inserting generated glyphs into source anchors",async()=>{
 const {defaultReaderPreset}=await import('../src/reader/preset.ts'),{systemTextOptions}=await import('../src/reader/system-text.ts');
 const p=defaultReaderPreset();p.body.hyphenation='AUTO';p.body.alignment='JUSTIFY';const text='extraordinary words',b=block(text);let published:NativeBlockLayouts=new Map();
 const task=requestReaderLayout([b],128,14,2,p,args=>{
  expect(args.hyphenation).toBe('full');expect(args.justify).toBe(true);expect(args.textMotion).toBe('static');
  return {result:Promise.resolve({lines:[{start:0,end:5,visibleEnd:5,topPx:0,bottomPx:38,baselinePx:30},{start:5,end:text.length,visibleEnd:text.length,topPx:38,bottomPx:76,baselinePx:68}]}),cancel(){}};
 },value=>published=value,error=>{throw error;});await task.done;
 const rows=createContentLayouter(s=>s.length*7)([b],128,14,{},p,published).rows;
 expect(rows.map(row=>row.character)).toEqual([0,5]);expect(rows.map(row=>row.kind==='text'?row.text:'')).toEqual(['extra','ordinary words']);
 const row=rows[1];if(row.kind!=='text')throw Error('Missing text line');const options=systemTextOptions(row,'body',14,128,2,p);
 expect(options.paragraph).toMatchObject({text,widthPx:256,lineIndex:1,hyphenation:'full',justify:true});expect(options.text).toBe('ordinary words');
});

test("preview preserves native subpixel policy while Compose follows static or animated text motion",async()=>{
 const {defaultReaderPreset}=await import('../src/reader/preset.ts');const p=defaultReaderPreset();p.body.renderMode='LINEAR_SMOOTH';
 for(const profile of ['compose','preview'] as const){let seen=false;await requestReaderLayout([block('text')],128,14,2,p,args=>{seen=true;expect(args.textMotion).toBe(profile==='preview'?'subpixel':'animated');expect(args.lineBreak).toBe(profile==='preview'?'balanced':'paragraph');return {result:Promise.resolve({lines:[{start:0,end:4,visibleEnd:4}]}),cancel(){}};},()=>{},error=>{throw error;},undefined,profile).done;expect(seen).toBe(true);}
});
