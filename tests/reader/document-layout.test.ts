import {expect,test} from "bun:test";
import {documentAnchorAt,offsetForDocumentAnchor} from "../../src/reader/document-layout.ts";
import {layoutContent,offsetForContentAnchor} from "../../src/reader/content-layout.ts";
import {ReadingProgressStore} from "../../src/reader/progress.ts";
import type {ContentBlock} from "../../src/reader/content.ts";

const blocks:ContentBlock[]=[{type:"text",text:"每一行正文都需要保持阅读位置。".repeat(40),style:"body"},{type:"image",url:"image.png",alt:"图片"}];
const measure=(text:string)=>Array.from(text).length*14;

test("old body anchors resume after the new scrolling header",()=>{
  const body=layoutContent(blocks,190,14,measure);
  const old={character:200,fraction:.4};
  expect(offsetForDocumentAnchor(body,old,96,10000)).toBe(96+offsetForContentAnchor(body,old,10000));
});

test("header and footer positions survive body reflow without entering text coordinates",()=>{
  const before=layoutContent(blocks,190,14,measure),after=layoutContent(blocks,130,18,measure);
  const header=documentAnchorAt(before,32,96);
  expect(header).toMatchObject({section:"header",sectionOffset:32,character:0});
  expect(offsetForDocumentAnchor(after,header,130,10000)).toBe(32);
  const footer=documentAnchorAt(before,96+before.height+12,96);
  expect(footer).toMatchObject({section:"footer",sectionOffset:12,character:before.textLength});
  expect(offsetForDocumentAnchor(after,footer,130,10000)).toBe(130+after.height+12);
});

test("text and media anchors retain their identity when the header changes size",()=>{
  const body=layoutContent(blocks,190,14,measure);
  const anchor=documentAnchorAt(body,96+body.rows[8].top+3,96);
  expect(anchor.section).toBeUndefined();
  expect(offsetForDocumentAnchor(body,anchor,140,10000)).toBeCloseTo(140+body.rows[8].top+3);
  const media=body.rows.at(-1)!;
  const imageAnchor=documentAnchorAt(body,96+media.top+media.gap+20,96);
  expect(imageAnchor.mediaIndex).toBe(1);
  expect(offsetForDocumentAnchor(body,imageAnchor,140,10000)).toBeCloseTo(140+media.top+media.gap+20);
});

test("document anchor persistence rejects malformed section offsets and clamps to the viewport",async()=>{
  let raw="";const store=new ReadingProgressStore({get:async()=>raw,set:async(_key,value)=>{raw=value;}});
  await store.save(1,30,0,{character:0,fraction:0,section:"header",sectionOffset:30});
  expect((await store.load(1)).textAnchor).toMatchObject({section:"header",sectionOffset:30});
  raw=JSON.stringify({textAnchor:{character:0,fraction:0,section:"footer",sectionOffset:-4}});
  expect((await store.load(1)).textAnchor).toEqual({character:0,fraction:0});
  const body=layoutContent(blocks,190,14,measure);
  expect(offsetForDocumentAnchor(body,{character:0,fraction:0,section:"footer",sectionOffset:99999},96,200)).toBe(200);
});
