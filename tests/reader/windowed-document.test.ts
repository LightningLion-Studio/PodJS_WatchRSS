import {expect,test} from 'bun:test';
import {WindowedReaderDocument,type ReaderWindowPart} from '../../src/reader/windowed-document';
import {layoutContent,contentAnchorAt,offsetForContentAnchor} from '../../src/reader/content-layout';
import type {ContentBlock} from '../../src/reader/content';
const measured=async(parts:readonly ReaderWindowPart[])=>parts.map(part=>layoutContent([part.block],180,14,s=>s.length*7));
test('large RSS retains three line windows, preserves geometry and restores evicted source anchors',async()=>{
 const blocks:ContentBlock[]=Array.from({length:160},(_,i)=>({type:'text',style:i%7?'body':'title',text:`第${i}段 中文😀正文。`.repeat(5)}));
 blocks.splice(19,0,{type:'image',url:'local-image',width:240,height:160});
 const doc=new WindowedReaderDocument(blocks,measured,()=>{});
 for(let i=0;i<doc.windowCount;i++){await doc.ensure(i);expect(doc.retainedWindows).toBeLessThanOrEqual(3);}
 const oracle=layoutContent(blocks,180,14,s=>s.length*7);expect(doc.layout().height).toBeCloseTo(oracle.height,6);expect(doc.layout().textLength).toBe(oracle.textLength);
 const height=doc.layout().height;doc.trimMemory({character:doc.layout().textLength,fraction:0},3);expect(doc.retainedWindows).toBe(2);expect(doc.layout().height).toBeCloseTo(height,6);doc.trimMemory({character:0,fraction:0},0);
 const target=oracle.rows.find(r=>r.blockIndex===2&&r.sourceStart!>0)!;
 const anchor=contentAnchorAt(oracle,target.top+target.gap+3);await doc.ensureAnchor(anchor);
 expect(offsetForContentAnchor(doc.layout(),anchor,Infinity)).toBeCloseTo(offsetForContentAnchor(oracle,anchor,Infinity),6);
 for(const row of doc.layout().rows.filter(r=>r.kind!=='text'||r.color!=='#00000000')){
  const expected=oracle.rows.find(r=>r.kind===row.kind&&r.blockIndex===row.blockIndex&&r.sourceStart===row.sourceStart)!;
  expect(row.character).toBe(expected.character);expect(row.top).toBeCloseTo(expected.top,6);expect(row.height).toBeCloseTo(expected.height,6);
 }
 doc.close();expect(doc.retainedWindows).toBe(0);
});
test('long individual blocks use complete UTF16 windows without splitting surrogate or CRLF boundaries',async()=>{
 const text=('文😀 '.repeat(900)+'\r\n').repeat(20),parts:ReaderWindowPart[]=[];
 const doc=new WindowedReaderDocument([{type:'text',style:'body',text}],async values=>{parts.push(...values);return measured(values)},()=>{});
 for(let i=0;i<doc.windowCount;i++)await doc.ensure(i);
 expect(parts.map(p=>p.block.type==='text'?p.block.text:'').join('')).toBe(text);
 for(const part of parts){if(part.block.type!=='text')continue;expect(part.block.text.length).toBeLessThanOrEqual(2048);expect(/[\uD800-\uDBFF]$/.test(part.block.text)).toBe(false);expect(part.block.text.endsWith('\r')&&text[part.sourceStart+part.block.text.length]==='\n').toBe(false);}
 expect(doc.retainedWindows).toBeLessThanOrEqual(3);doc.close();
});
test('ten thousand paragraphs do not retain full document line data',async()=>{
 const blocks:ContentBlock[]=Array.from({length:10000},(_,i)=>({type:'text',style:'body',text:`${i} 中文长文。`.repeat(8)}));
 const doc=new WindowedReaderDocument(blocks,measured,()=>{});
 for(let i=0;i<doc.windowCount;i++)await doc.ensure(i);
 expect(doc.retainedWindows).toBe(3);expect(doc.layout().rows.filter(r=>r.kind==='text'&&r.text.length>0).length).toBeLessThan(400);doc.close();
});
test('closed windows discard late shaping and preserve no rows',async()=>{
 let resolve!:(value:any)=>void,updates=0;
 const doc=new WindowedReaderDocument([{type:'text',style:'body',text:'中文'}],()=>new Promise(yes=>{resolve=yes}),()=>updates++);
 const pending=doc.ensure(0);doc.close();resolve([layoutContent([{type:'text',style:'body',text:'中文'}],180,14,s=>s.length*7)]);await pending;
 expect(updates).toBe(0);expect(doc.retainedWindows).toBe(0);
});
