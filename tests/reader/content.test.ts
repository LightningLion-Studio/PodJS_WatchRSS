import {expect,test} from "bun:test";
import {parseContent,parseContentAsync,contentText} from "../../src/reader/content.ts";
test("native block order and styles survive mixed HTML",()=>{
 const result=parseContent('<h1>Title</h1><p>Hello <b>world</b><img src="a>b.png" width="20" style="height: 10.5px" alt="A &amp; B">after</p><ol><li>First<li>Second</ol><blockquote><ul><li>Quoted</li></ul></blockquote><pre>code</pre><video poster="p"><source src="movie.mp4"></video>');
 expect(result).toEqual([{type:"text",style:"title",text:"Title"},{type:"text",style:"body",text:"Hello world"},{type:"image",url:"a>b.png",alt:"A & B",width:20,height:11},{type:"text",style:"body",text:"after\n1. First\n2. Second"},{type:"text",style:"quote",text:"- Quoted"},{type:"text",style:"code",text:"code"},{type:"video",url:"movie.mp4",poster:"p"}]);
});
test("preferred article root excludes surrounding and hidden content",()=>{
 const blocks=parseContent('<div>outside</div><article>fallback</article><div class="entry-content"><header>header</header><p>body</p><div aria-hidden="true">hidden</div><aside>ad</aside><script>if(a<b) bad()</script><p>end</p></div>');
 expect(contentText(blocks)).toBe("body\nend");
});
test("plain text is not entity-decoded, bounded blocks retain Unicode",()=>{
 const value="😀".repeat(2500);const blocks=parseContent(value+"\n&copy; literal");
 expect(blocks.every(b=>b.type==="text"&&b.text.length<=4000)).toBe(true);
 expect(contentText(blocks).replaceAll("\n","")).toBe(value+"&copy; literal");
});
test("deep nesting and media-only roots remain parseable",()=>{
 expect(contentText(parseContent("<div>".repeat(5000)+"body"+"</div>".repeat(5000)))).toBe("body");
 expect(parseContent('<p>outside</p><article><img src="image"></article>')).toEqual([{type:"image",url:"image",alt:undefined,width:undefined,height:undefined}]);
});

test("Jsoup text semantics retain pre indentation and separate blockquote paragraphs",()=>{
 expect(parseContent('<pre>a\n  b</pre>')).toEqual([{type:"text",style:"code",text:"a\n  b"}]);
 expect(parseContent('<blockquote><p>first</p><p>second</p></blockquote>')).toEqual([{type:"text",style:"quote",text:"first second"}]);
});

import nativeFixtures from "./native-content-fixtures.json";
test("matches captured production Kotlin parser fixtures",()=>{
 const normalize=(value:unknown):unknown=>JSON.parse(JSON.stringify(value,(_key,v)=>v===null?undefined:v));
 for(const fixture of nativeFixtures)expect(normalize(parseContent(fixture.raw))).toEqual(normalize(fixture.blocks));
});

test('async production default keeps legacy blocks and rejects pre-cancelled input',async()=>{
 expect(await parseContentAsync('<p>one<img src="a">two</p>')).toEqual(parseContent('<p>one<img src="a">two</p>'));
 const abort=new AbortController();abort.abort();
 await expect(parseContentAsync('plain text',abort.signal)).rejects.toThrow('HTML parse cancelled');
});
