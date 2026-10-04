import {test,expect} from "bun:test";
import {watchUiLines} from "../src/ui/text-layout.ts";
const measure=(s:string)=>Array.from(s).reduce((n,c)=>n+(/[A-Za-z0-9 ]/.test(c)?6:12),0);
test("native UI line wrapping keeps closing Chinese punctuation with the previous character",()=>{
 const lines=watchUiLines("请提取以下文章的关键信息，以要点形式列出，不超过5条。",{width:151,measure});
 expect(lines[0]).toBe("请提取以下文章的关键信");expect(lines[1]).toBe("息，以要点形式列出，不超");expect(lines.every(l=>!/^，|^。/.test(l))).toBe(true);expect(lines.join("")).toBe("请提取以下文章的关键信息，以要点形式列出，不超过5条。");
});
test("UI labels retain Latin words and explicit blank lines, while long words still make progress",()=>{
 expect(watchUiLines("本次 token 数量",{width:54,measure})).toEqual(["本次","token 数","量"]);
 expect(watchUiLines("a\n\nb",{width:30,measure})).toEqual(["a","","b"]);
 expect(watchUiLines("abcdefghij",{width:24,measure})).toEqual(["abcd","efgh","ij"]);
 expect(watchUiLines("文",{width:0,measure})).toEqual(["文"]);
});
