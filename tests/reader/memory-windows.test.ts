import {expect,test} from 'bun:test';
import {readerTextChunks,requestReaderLayoutBatched,validateParagraphLines} from '../../src/reader/platform-layout';
test('reader windows preserve all text and UTF16 boundaries without a length rejection',()=>{
 const text=('段落😀 '.repeat(1000)+'\n').repeat(20),chunks=[...readerTextChunks(text)];
 expect(chunks.length).toBeGreaterThan(10);expect(chunks.map(p=>p.text).join('')).toBe(text);
 for(const part of chunks){expect(part.text.length).toBeLessThanOrEqual(8192);expect(/[\uD800-\uDBFF]$/.test(part.text)).toBe(false);expect(text.slice(part.offset,part.offset+part.text.length)).toBe(part.text);}
});
test('large paragraph shaping retains original source offsets and chunk-local raster identity',async()=>{
 const block={type:'text' as const,style:'body' as const,text:'文😀 '.repeat(10000)};
 const requests:string[]=[];let result:any;
 const task=requestReaderLayoutBatched([block],180,18,2,undefined,args=>{
  expect(args).toHaveLength(1);const text=args[0]!.text;requests.push(text);expect(text.length).toBeLessThanOrEqual(8192);
  return {cancel(){},result:Promise.resolve({results:[{lines:[{start:0,end:text.length,visibleEnd:text.length,topPx:0,bottomPx:40,baselinePx:30}]}]})};
 },value=>result=value,error=>{throw error});
 await task.done;expect(requests.join('')).toBe(block.text);const lines=result.get(block);validateParagraphLines(block.text,lines);
 expect(lines.length).toBe(requests.length);for(let i=0;i<lines.length;i++){expect(lines[i].paragraph.text).toBe(requests[i]);expect(lines[i].paragraph.lineIndex).toBe(0);expect(JSON.parse(JSON.stringify(lines[i].paragraph))).toMatchObject({text:requests[i],lineIndex:0,widthPx:360,fontWeight:400});expect(lines[i].height).toBe(20);}
});

import {ImportedReaderDocument} from '../../src/reader/imported-document';
import {layoutContent} from '../../src/reader/content-layout';
test('imported text releases old windows while retaining geometry and reloading exact content',async()=>{
 const handle={marker:'watchrss-watch-content:memory.txt',chunkCount:80,chunkBytes:16384,byteLength:80*16384};
 const reads:number[]=[];const text=(i:number)=>`chunk ${i} `+'正文😀'.repeat(1000);
 const doc=new ImportedReaderDocument(handle,async i=>{reads.push(i);return text(i)},async block=>layoutContent([block],180,14,s=>s.length*7),()=>{});
 for(let i=0;i<80;i++){await doc.ensure(i);expect(doc.blocks().filter(b=>b.type==='text'&&b.text.length>0).length).toBeLessThanOrEqual(3);}
 const before=doc.layout().height;expect(doc.text(0)).toBeUndefined();await doc.ensure(0);
 expect(doc.text(0)).toBe(text(0));expect(doc.layout().height).toBe(before);expect(reads.filter(i=>i===0)).toHaveLength(2);
 doc.close();expect(doc.text(0)).toBeUndefined();
});
