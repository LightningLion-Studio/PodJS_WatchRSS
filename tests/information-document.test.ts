import { expect, test } from "bun:test";
import { buildInformationBlocks, informationSemanticLabel } from "../src/ui/information-document.ts";

test("information lines stay separate across single, blank and repeated newlines", () => {
  const expected: ReturnType<typeof buildInformationBlocks> = [
    { type: "text", text: "第一行", style: "body" },
    { type: "text", text: "第二行", style: "body" },
    { type: "text", text: "第三行", style: "body" },
  ];
  for (const separator of ["\n", "\n\n", "\n \t\n\n"]) {
    expect(buildInformationBlocks([" 第一行 ", "第二行", " 第三行 "].join(separator))).toEqual(expected);
  }
});

test("information lines recognize CRLF, LF and lone CR", () => {
  expect(buildInformationBlocks("\r\n一\r\n二\r三\n\r\n四\r\r")).toEqual([
    { type: "text", text: "一", style: "body" },
    { type: "text", text: "二", style: "body" },
    { type: "text", text: "三", style: "body" },
    { type: "text", text: "四", style: "body" },
  ]);
});

test("information content retains HTML, entities and Markdown literally", () => {
  expect(buildInformationBlocks('<h1>标题 &amp; 内容</h1>\n# 标题\n**正文**\n[链接](https://example.com)\n<img src="cover.png">')).toEqual([
    { type: "text", text: "<h1>标题 &amp; 内容</h1>", style: "body" },
    { type: "text", text: "# 标题", style: "body" },
    { type: "text", text: "**正文**", style: "body" },
    { type: "text", text: "[链接](https://example.com)", style: "body" },
    { type: "text", text: '<img src="cover.png">', style: "body" },
  ]);
});

test("only lowercase HTTP prefixes and a leading bullet change the information style", () => {
  expect(buildInformationBlocks(" https://example.com \nhttp://\nHTTP://example.com\nHttps://example.com\n文字 https://example.com\n • https://example.com\n•条目\n- 条目\n> 引用")).toEqual([
    { type: "text", text: "https://example.com", style: "code" },
    { type: "text", text: "http://", style: "code" },
    { type: "text", text: "HTTP://example.com", style: "body" },
    { type: "text", text: "Https://example.com", style: "body" },
    { type: "text", text: "文字 https://example.com", style: "body" },
    { type: "text", text: "• https://example.com", style: "quote" },
    { type: "text", text: "•条目", style: "quote" },
    { type: "text", text: "- 条目", style: "body" },
    { type: "text", text: "> 引用", style: "body" },
  ]);
});

test("Android Kotlin trimming includes control separators, Unicode spaces and U+180E", () => {
  const whitespace = "\t\u000b\f\u001c\u001d\u001e\u001f \u00a0\u1680\u180e\u2000\u2007\u200a\u2028\u2029\u202f\u205f\u3000";
  expect(buildInformationBlocks(`${whitespace}http://example.com${whitespace}\n${whitespace}• 条目${whitespace}`)).toEqual([
    { type: "text", text: "http://example.com", style: "code" },
    { type: "text", text: "• 条目", style: "quote" },
  ]);
  expect(buildInformationBlocks(whitespace)).toEqual([]);
});

test("BOM remains literal even between blank lines and prevents URL prefix classification", () => {
  expect(buildInformationBlocks("\ufeffhttps://example.com\ufeff\n\n\ufeff\n\n尾段")).toEqual([
    { type: "text", text: "\ufeffhttps://example.com\ufeff", style: "body" },
    { type: "text", text: "\ufeff", style: "body" },
    { type: "text", text: "尾段", style: "body" },
  ]);
});

test("Android paragraph regex consumes NEL between LFs but Kotlin trim preserves it otherwise", () => {
  expect(buildInformationBlocks("首段\n\u0085\n尾段")).toEqual([
    { type: "text", text: "首段", style: "body" },
    { type: "text", text: "尾段", style: "body" },
  ]);
  expect(buildInformationBlocks("\u0085http://example.com\u0085")).toEqual([
    { type: "text", text: "\u0085http://example.com\u0085", style: "body" },
  ]);
});

test("internal whitespace and Unicode line separators remain inside their source line", () => {
  expect(buildInformationBlocks(" 甲  \t乙\u2028丙\u2029丁\u180e戊 ")).toEqual([
    { type: "text", text: "甲  \t乙\u2028丙\u2029丁\u180e戊", style: "body" },
  ]);
});

test("empty information stays empty for the component fallback", () => {
  for (const content of ["", "\n\n", " \r\n\t\r \n"]) {
    expect(buildInformationBlocks(content)).toEqual([]);
  }
});

test("long information lines are neither chunked nor merged", () => {
  const text = "正文".repeat(2501);
  expect(buildInformationBlocks(`${text}\n下一行`)).toEqual([
    { type: "text", text, style: "body" },
    { type: "text", text: "下一行", style: "body" },
  ]);
});

test("information semantic labels preserve ASCII through 4096 UTF-8 bytes", () => {
  for (const text of ["", "重新加载", "a".repeat(4094), "a".repeat(4096)]) {
    expect(informationSemanticLabel(text)).toBe(text);
  }
  const label = informationSemanticLabel("a".repeat(4097));
  expect(label).toBe(`${"a".repeat(4093)}…`);
  expect(new TextEncoder().encode(label)).toHaveLength(4096);
});

test("information semantic labels count Chinese characters as three UTF-8 bytes", () => {
  const exactLimit = `${"中".repeat(1365)}a`;
  expect(informationSemanticLabel(exactLimit)).toBe(exactLimit);
  const label = informationSemanticLabel(`${exactLimit}b`);
  expect(label).toBe(`${"中".repeat(1364)}…`);
  expect(new TextEncoder().encode(label)).toHaveLength(4095);
});

test("information semantic labels preserve surrogate pairs at the byte boundary", () => {
  const exactLimit = "😀".repeat(1024);
  expect(informationSemanticLabel(exactLimit)).toBe(exactLimit);
  expect(informationSemanticLabel(`${exactLimit}a`)).toBe(`${"😀".repeat(1023)}…`);
  const label = informationSemanticLabel(`${"a".repeat(4092)}😀b`);
  expect(label).toBe(`${"a".repeat(4092)}…`);
  expect(new TextEncoder().encode(label)).toHaveLength(4095);
});

test("accessibility truncation leaves the visual information block complete", () => {
  const text = `https://${"a".repeat(4096)}`;
  const [block] = buildInformationBlocks(text);
  expect(informationSemanticLabel(block.text)).toBe(`${text.slice(0, 4093)}…`);
  expect(block).toEqual({ type: "text", text, style: "code" });
});
