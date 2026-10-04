import {expect,test} from "bun:test";
import {extractReadableHtml,parseContent} from "../../src/reader/content.ts";
import fixtures from "./native-readable-fixtures.json";
test("readable HTML matches captured native candidate selection and sanitization",()=>{
 for(const fixture of fixtures)expect(extractReadableHtml(fixture.html,fixture.baseUrl)).toBe(fixture.expected);
});
test("readable output escapes literal content and preserves lazy media in deep containers",()=>{
 const html='<div>'.repeat(5000)+'<article><p>&lt;b&gt; literal &amp; text</p><img data-lazy-src="../a.jpg" alt="&quot;图片&quot;"></article>'+'</div>'.repeat(5000);
 const result=extractReadableHtml(html,'https://example.test/news/item')!;
 expect(parseContent(result)).toEqual([{type:'text',text:'<b> literal & text',style:'body'},{type:'image',url:'https://example.test/a.jpg',alt:'"图片"',width:undefined,height:undefined}]);
});
