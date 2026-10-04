import { expect,test } from "bun:test";
import { articlePreview } from "../src/core/preview.ts";
import { resolveUrl } from "../src/core/parser.ts";

test("RSS preview matches native content precedence and 60 character summary",()=>{
  expect(articlePreview("<p>正文 <b>优先</b></p><p>下一段</p>","摘要",null,null)).toEqual({summary:"正文 优先 下一段",imageUrl:null});
  expect(articlePreview("<p>"+"文".repeat(80)+"</p>",null,null,null).summary).toBe("文".repeat(60)+"...");
  expect(articlePreview(" ","<p>摘要</p>",null,null).summary).toBe("摘要");
});

test("RSS previews resolve first body image and prefer explicit enclosure",()=>{
  expect(articlePreview('<script><img src="wrong.png"></script><img src="../cover.png?a=1&amp;b=2">',null,null,"https://example.test/news/item").imageUrl).toBe("https://example.test/cover.png?a=1&b=2");
  expect(articlePreview("<img src='body.png'>",null,"https://img.test/enclosure.png","https://example.test/news/").imageUrl).toBe("https://img.test/enclosure.png");
  expect(articlePreview('<img src="//img.test/a.png">',null,null,"https://example.test/a").imageUrl).toBe("https://img.test/a.png");
  expect(resolveUrl("//img.test/a.png","http://example.test/a")).toBe("http://img.test/a.png");
  expect(resolveUrl("//img.test/a.png")).toBe("https://img.test/a.png");
});

test("preview excludes deferred image attributes and non-HTTP image sources",()=>{
  expect(articlePreview('<img data-src="deferred.png"><img src="real.png">',null,null,"https://example.test/").imageUrl).toBe("https://example.test/real.png");
  expect(articlePreview('<img src="data:image/png;base64,AA==">',null,null,"https://example.test/").imageUrl).toBeNull();
});
