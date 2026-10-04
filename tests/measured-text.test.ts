import { expect,test } from "bun:test";
import { measuredLines,normalizeWatchTitle,watchTitleLines } from "../src/reader/measured-text.ts";
import { imageFitRect } from "../src/ui/image-fit.ts";
const measure=(text:string)=>Array.from(text).reduce((sum,ch)=>sum+(ch==="i"?2:ch==="W"?9:5),0);

test("actual variable glyph widths determine wrapping and ellipsis",()=>{
  expect(measuredLines("iiiiWW",18,measure,2)).toEqual(["iiiiW","W"]);
  expect(measuredLines("WWWW",18,measure,1)).toEqual(["W…"]);
  expect(measuredLines("WWWW",18,measure,2,9)).toEqual(["W","W…"]);
});
test("watch titles keep ASCII word spacing while normalizing CJK and balancing the final character",()=>{
  expect(normalizeWatchTitle("中 文 阅 读 Hello World")).toBe("中 文 阅 读 Hello World");
  expect(normalizeWatchTitle("中 文 阅 读 测 试 AI Chat")).toBe("中文阅读测试AI Chat");
  expect(watchTitleLines("中文阅读测试新",100,measure,15,15)).toEqual(["中文阅","读测","试新"]);
  expect(watchTitleLines("😀😀😀",10,measure,10,10).join("")).toBe("😀😀😀");
});
test("image cover and contain preserve the original aspect ratio independently of texture dimensions",()=>{
  expect(imageFitRect(200,100,100,200,"cover")).toEqual({left:0,top:-150,width:200,height:400});
  expect(imageFitRect(200,100,400,100,"cover")).toEqual({left:-100,top:0,width:400,height:100});
  expect(imageFitRect(200,100,100,200,"contain")).toEqual({left:75,top:0,width:50,height:100});
  expect(imageFitRect(200,100,0,0,"cover")).toEqual({left:0,top:0,width:200,height:100});
});
