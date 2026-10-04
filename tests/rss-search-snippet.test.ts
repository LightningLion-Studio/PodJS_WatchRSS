import {expect,test} from "bun:test";
import {searchHighlightLines,searchHighlightSegments,searchSnippet} from "../src/rss/search-snippet.ts";

test("search result highlights every case-insensitive match at measured glyph positions",()=>{
  const widths:Record<string,number>={甲:12,乙:13,A:7,b:8,C:9};
  const measure=(text:string)=>Array.from(text).reduce((sum,char)=>sum+(widths[char]??7),0);
  expect(searchHighlightSegments("甲AbC乙abc","aBc",measure)).toEqual([
    {text:"AbC",x:12,width:24},
    {text:"abc",x:49,width:22}
  ]);
  expect(searchHighlightSegments("甲AbC乙abc"," ",measure)).toEqual([]);
});

test("search snippet favors a matching description and preserves context around body matches",()=>{
  expect(searchSnippet("token","前文 TOKEN 后文","other token","summary token")).toBe("前文 TOKEN 后文");
  expect(searchSnippet("needle","unrelated","x".repeat(60)+"needle"+"y".repeat(120),null)).toContain("needle");
});

test("search highlights a match split by visual wrapping and clips an ellipsized last line",()=>{
  const measure=(value:string)=>Array.from(value).length*10;
  expect(searchHighlightLines("甲同步乙",["甲同","步乙"],"同步",measure)).toEqual([
    [{text:"同",x:10,width:10}],
    [{text:"步",x:0,width:10}]
  ]);
  expect(searchHighlightLines("同步同步乙",["同步","同…"],"同步",measure)).toEqual([
    [{text:"同步",x:0,width:20}],
    [{text:"同",x:0,width:10}]
  ]);
});
