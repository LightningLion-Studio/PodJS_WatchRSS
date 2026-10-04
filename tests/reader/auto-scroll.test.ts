import { expect,test } from "bun:test";
import {AutoScrollController,ReadingProgressStore,layoutText} from "../../src/reader/index.ts";
import {anchorAtOffset,lineStarts,offsetForAnchor} from "../../src/reader/text-anchor.ts";
test("auto scroll clamps at the end and will not start an unscrollable document",()=>{
 const c=new AutoScrollController(40);c.setBounds(100);c.start();c.tick(4000);expect(c.getOffset()).toBe(100);expect(c.isRunning()).toBe(false);c.start();expect(c.isRunning()).toBe(false);c.setOffset(20);c.start();c.tick(500);expect(c.getOffset()).toBe(40);
});
test("speed changes and paused/background frames cannot create a jump",()=>{
 const c=new AutoScrollController(40);c.setBounds(1000);c.start();c.tick(500);c.setSpeed(80);c.tick(500);expect(c.getOffset()).toBe(60);c.pause();c.tick(5000);expect(c.getOffset()).toBe(60);c.start();c.setBackground(true);c.tick(9000);expect(c.getOffset()).toBe(60);c.setBackground(false);c.tick(500);expect(c.getOffset()).toBe(100);c.tick(NaN);expect(c.getOffset()).toBe(100);
});
test("anchors survive empty paragraphs and changed wrapping without losing the source position",()=>{
 const text="ABCD\r\n\r\nEFGHIJKLMN\n你好世界😀长文章";
 const narrow=layoutText(text,{width:4,measure:t=>t.length}),wide=layoutText(text,{width:7,measure:t=>t.length});
 const from=lineStarts(text,narrow),to=lineStarts(text,wide);
 expect(from.slice(0,4)).toEqual([0,5,6,10]);
 const anchor=anchorAtOffset(61,20,from);expect(anchor.character).toBe(10);
 const restored=offsetForAnchor(anchor,30,to,1000),restoredAnchor=anchorAtOffset(restored,30,to);
 expect(restoredAnchor.character).toBeLessThanOrEqual(anchor.character);
 const index=Math.floor(restored/30);expect(to[index+1]??Infinity).toBeGreaterThan(anchor.character);
 expect(offsetForAnchor(anchor,30,to,10)).toBe(10);
});
test("reading progress keeps text anchors and sanitizes corrupt stored values",async()=>{
 let data="{\"offset\":1e999,\"progress\":5,\"textAnchor\":{\"character\":-2,\"fraction\":0}}";
 const s=new ReadingProgressStore({get:async()=>data,set:async(_key,value)=>{data=value;}});
 expect(await s.load(1)).toMatchObject({offset:0,progress:1});expect((await s.load(1)).textAnchor).toBeUndefined();
 await s.save(1,77,.4,{character:124,fraction:.3});expect((await s.load(1)).textAnchor).toEqual({character:124,fraction:.3});
});
