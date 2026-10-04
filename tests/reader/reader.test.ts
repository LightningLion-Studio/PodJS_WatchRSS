import { expect, test } from "bun:test";
import { AutoScrollController, DEFAULT_READER_PRESET, layoutText, ReadingProgressStore } from "../../src/reader";

test("layout is codepoint and combining safe, including empty lines", () => {
  const input="A😀e\u0301BC\n\n中文段落"; const lines=layoutText(input,{width:3,measure:s=>Array.from(s).length});
  expect(lines.join("\n")).toContain("😀"); expect(lines.join("\n")).toContain("é"); expect(lines.filter(x=>x==="").length).toBe(1);
});
test("layout wraps long paragraphs without dropping source graphemes", () => { const text="word ".repeat(1000)+"尾"; const lines=layoutText(text,{width:8,measure:s=>Array.from(s).length}); expect(lines.join("")).toBe(text); });
test("defaults match reader baseline",()=>{expect(DEFAULT_READER_PRESET).toMatchObject({fontSizeSp:14,lineHeightEm:1.35,theme:"system"});});
test("progress resumes from persistent key value storage",async()=>{const m=new Map<string,string>(); const s=new ReadingProgressStore({get:async k=>m.get(k)??null,set:async(k,v)=>{m.set(k,v)}}); await s.save(3,42,.7); expect(await s.load(3)).toMatchObject({offset:42,progress:.7});});
test("autoscroll pauses in background and preserves offset",()=>{const seen:number[]=[]; const c=new AutoScrollController(2,x=>seen.push(x)); c.setOffset(5); c.start(); c.tick(500); expect(c.getOffset()).toBe(6); c.setBackground(true); c.tick(1000); expect(c.getOffset()).toBe(6); c.setBackground(false); c.tick(500); expect(c.getOffset()).toBe(7); expect(seen.at(-1)).toBe(7);});
