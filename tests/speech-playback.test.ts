import { expect, test } from "bun:test";
import type { Article } from "../src/ui/service.ts";
import { SpeechPlayback, speechPlaybackStatus, type SpeechPlaybackPort } from "../src/reader/speech-playback.ts";
import { articleSpeechSegments, speechSegmentSlices, speechSourceOffset, visibleSpeechAnchor, pressedSpeechAnchor, pressedSpeechCharOffset, boundarySpeechCharOffset } from "../src/reader/speech-segments.ts";
import anchorNative from "./fixtures/speech-anchors-native.json";
import native from "./fixtures/speech-segments-native.json";
import { layoutContent } from "../src/reader/content-layout.ts";

const article = (id: string, text = "正文"): Article => ({ id, channelId: "channel", title: id, content: text });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("44 cases match actual Kotlin segmentation text and every source coordinate", () => {
  for (const { input, segments } of native.cases) expect(speechSegmentSlices(input.text, input.base, input.limit)).toEqual(segments);
});
test("visible reader anchor skips media and maps wrapped CRLF text back to source", () => {
  const blocks: import("../src/reader/content.ts").ContentBlock[] = [{ type: "image", url: "i" }, { type: "text", style: "body", text: "前行\r\n次行" }];
  const layout = layoutContent(blocks, 100, 14, text => text.length * 7);
  expect(visibleSpeechAnchor(layout, blocks, 5, 50)).toEqual({ contentBlockIndex: 1, contentCharOffset: 0 });
  expect(visibleSpeechAnchor(layout, blocks, 51, 50)).toEqual({ contentBlockIndex: 1, contentCharOffset: 0 });
  const last = layout.rows.at(-1)!;
  expect(visibleSpeechAnchor(layout, blocks, 50 + last.top, 50)).toEqual({ contentBlockIndex: 1, contentCharOffset: 4 });
});
function harness(overrides: Partial<SpeechPlaybackPort> = {}, prepareNewSession?: (isCurrent:()=>boolean)=>Promise<void>) {
  const spoken: { text: string; rate: number; done: ReturnType<typeof deferred<void>> }[] = [];
  let stops = 0;
  const controller = new SpeechPlayback({
    listArticles: async () => [article("a"), article("b")], getArticle: async id => article(id), getOriginalArticle: async id => article(id, "原文"),
    speak: async (text, rate, started) => { const done = deferred<void>(); spoken.push({ text, rate, done }); started?.(); return done.promise; },
    stopSpeech: async () => { stops++; }, ...overrides,
  }, () => {}, undefined, prepareNewSession);
  return { controller, spoken, stops: () => stops };
}

test("sentence normalization retains source offsets, title punctuation and media block indices", () => {
  const segments = articleSpeechSegments({ ...article("a"), title: "  标题  ", contentBlocks: [{ type: "image", url: "image" }, { type: "text", style: "body", text: "  一\t\t二。三！ " }, { type: "video", url: "video" }] });
  expect(segments.map(s => s.text)).toEqual(["标题。", "一 二。 三！"]);
  expect(segments[0]!.sourceOffsets).toEqual([2, 3, 4]);
  expect(segments[1]!.sourceOffsets).toEqual([2, 3, 5, 6, 6, 7, 8]);
  expect(segments[1]!.contentBlockIndex).toBe(1);
  expect(speechSourceOffset(segments[1]!, 999)).toBe(9);
  expect(speechSourceOffset(segments[1]!, -1)).toBe(2);
});
test("anchor starts inside a content block without repeating the title or earlier blocks", () => {
  const segments = articleSpeechSegments({ ...article("a"), contentBlocks: [{ type: "text", style: "body", text: "先前" }, { type: "text", style: "body", text: "跳过  从这里" }] }, { contentBlockIndex: 1, contentCharOffset: 2 });
  expect(segments).toEqual([{ text: "从这里", sourceOffsets: [4, 5, 6], isTitle: false, contentBlockIndex: 1 }]);
});
test("240-unit hard splits preserve emoji and normalized source coordinates", () => {
  const source = "文".repeat(239) + "😀" + "字".repeat(245);
  const segments = speechSegmentSlices(source);
  expect(segments.map(s => s.text).join("")).toBe(source);
  expect(segments.every(s => s.text.length <= 240 && !/[\ud800-\udbff]$/.test(s.text))).toBe(true);
  expect(segments.flatMap(s => s.sourceOffsets)).toEqual(Array.from({ length: source.length }, (_, i) => i));
  expect(() => speechSegmentSlices("x", 0, 1)).toThrow();
});
test("queue uses the current snapshot and automatically finishes both articles", async () => {
  const h = harness(), pending = h.controller.start(article("a", "新正文")); await settle();
  expect(h.controller.state.queueSize).toBe(2); expect(h.spoken[0]!.text).toBe("a。");
  h.spoken[0]!.done.resolve(); await settle(); expect(h.spoken[1]!.text).toBe("新正文");
  h.spoken[1]!.done.resolve(); await settle(); expect(h.spoken[2]!.text).toBe("b。");
  h.spoken[2]!.done.resolve(); await settle(); h.spoken[3]!.done.resolve(); await pending;
  expect(h.controller.state.phase).toBe("idle"); expect(h.controller.state.queueSize).toBe(0);
});
test("pause and resume replay the current segment; an old completion cannot advance", async () => {
  const h = harness(); const pending = h.controller.start(article("a")); await settle();
  await h.controller.toggle(); expect(h.controller.state.playing).toBe(false);
  const resume = h.controller.toggle(); await settle(); expect(h.spoken.map(s => s.text)).toEqual(["a。", "a。"]);
  h.spoken[0]!.done.resolve(); await pending; expect(h.spoken.length).toBe(2);
  h.spoken[1]!.done.resolve(); await settle(); expect(h.spoken[2]!.text).toBe("正文");
  await h.controller.stop(); h.spoken[2]!.done.resolve(); await resume;
});
test("auto advance off stays at article end and next still selects the next article", async () => {
  const h = harness(); h.controller.toggleAutoAdvance(); const pending = h.controller.start(article("a")); await settle();
  h.spoken[0]!.done.resolve(); await settle(); h.spoken[1]!.done.resolve(); await pending;
  expect(h.controller.state.article?.id).toBe("a"); expect(h.controller.state.playing).toBe(false);
  await h.controller.toggle(); expect(h.spoken.length).toBe(2);
  const next = h.controller.next(); await settle(); expect(h.controller.state.article?.id).toBe("b");
  expect(h.controller.state.autoAdvance).toBe(false);
  await h.controller.stop(); h.spoken[2]!.done.resolve(); await next;
});
test("switching while original content is resolving ignores its stale result", async () => {
  const original = deferred<Article>();
  const h = harness({ getArticle: async id => ({ ...article(id), useOriginalContent: true }), getOriginalArticle: () => original.promise });
  const first = h.controller.start(article("a")); await settle(); const next = h.controller.next(); await settle();
  expect(h.controller.state.phase).toBe("resolving");
  await h.controller.stop(); original.resolve(article("b", "迟到的原文")); h.spoken[0]!.done.resolve(); await Promise.all([first, next]);
  expect(h.spoken.length).toBe(1); expect(h.controller.state.phase).toBe("idle");
});
test("rate follows native discrete options and restarts the active segment", async () => {
  const h = harness(); const first = h.controller.start(article("a")); await settle();
  const change = h.controller.changeRate(1); await settle(); expect(h.spoken[1]!.rate).toBe(1.15); expect(h.spoken[1]!.text).toBe("a。");
  h.spoken[0]!.done.reject(new Error("cancelled")); await first; expect(h.controller.state.phase).toBe("ready");
  expect(speechPlaybackStatus(h.controller.state)).toBe("播放中 · 第 1/2 篇 · 第 1/2 段");
  await h.controller.stop(); h.spoken[1]!.done.resolve(); await change;
});
test("start cancellation and delayed stop serialize before the replacement engine starts", async () => {
  const wait = deferred<void>(); let stop = 0;
  const h = harness({ stopSpeech: async () => { if (++stop === 1) await wait.promise; } });
  const first = h.controller.start(article("a")); const second = h.controller.start(article("b")); await settle(); expect(h.spoken).toHaveLength(0);
  wait.resolve(); await settle(); expect(h.spoken.map(s => s.text)).toEqual(["b。"]);
  await h.controller.stop(); h.spoken[0]!.done.resolve(); await Promise.all([first, second]);
});
test("queue load failure exposes error and a new start can recover", async () => {
  let fail = true;
  const h = harness({ listArticles: async () => { if (fail) throw new Error("数据库不可用"); return [article("a")]; } });
  await h.controller.start(article("a")); expect(h.controller.state.error).toBe("数据库不可用");
  fail = false; const next = h.controller.start(article("a")); await settle(); expect(h.controller.state.error).toBeUndefined();
  await h.controller.stop(); h.spoken[0]!.done.resolve(); await next;
});
test("playback rate and auto advance choices survive stop and a new session", async () => {
  const h=harness();await h.controller.changeRate(1);h.controller.toggleAutoAdvance();await h.controller.stop();
  const pending=h.controller.start(article("a"));await settle();
  expect(h.spoken[0]!.rate).toBe(1.15);expect(h.controller.state.autoAdvance).toBe(false);
  await h.controller.stop();h.spoken[0]!.done.resolve();await pending;
});

test("pressed and visible offsets match unchanged Kotlin functions at every fixture offset", () => {
  for (const {input, pressed, visible} of anchorNative.cases) {
    expect(pressedSpeechCharOffset(input.text, input.offset)).toBe(pressed);
    expect(boundarySpeechCharOffset(input.text, input.offset)).toBe(visible);
  }
});
test("body touch uses character under finger even while title is visible, title touch starts over", () => {
  const blocks = [{type:"text" as const, style:"body" as const, text:"甲乙 丙丁。下一句"}];
  const measure = (text:string) => Array.from(text).length * 10;
  const layout = layoutContent(blocks, 150, 14, measure);
  const touch = (x:number,y:number) => pressedSpeechAnchor(layout,blocks,x,y,0,50,178,measure);
  expect(touch(14,20)).toBeUndefined();
  expect(touch(34,55)).toEqual({contentBlockIndex:0,contentCharOffset:3});
  expect(touch(54,55)).toEqual({contentBlockIndex:0,contentCharOffset:4});
  expect(visibleSpeechAnchor(layout,blocks,0,50)).toEqual({contentBlockIndex:0,contentCharOffset:6});
});
test("touch coordinates account for scrolling, media blocks, CRLF, center alignment and scale", () => {
  const blocks = [{type:"image" as const,url:"image"},{type:"text" as const,style:"body" as const,text:"甲乙\r\n丙😀丁"}];
  const measure = (text:string) => Array.from(text).length * 10;
  const layout = layoutContent(blocks,150,14,measure);
  const row = layout.rows.at(-1)!;
  if (row.kind !== "text") throw new Error("Expected text");
  row.scale = 2; row.tracking = 2; row.textAlign = 1;
  // 64px centered row: left=57; nearest caret at 22px is before emoji.
  expect(pressedSpeechAnchor(layout,blocks,79,10,50+row.top-10,50,178,measure)).toEqual({contentBlockIndex:1,contentCharOffset:5});
  expect(pressedSpeechAnchor(layout,blocks,102,10,50+row.top-10,50,178,measure)).toEqual({contentBlockIndex:1,contentCharOffset:7});
  expect(pressedSpeechAnchor(layout,blocks,0,10,50+row.top-10,50,178,measure)).toEqual({contentBlockIndex:1,contentCharOffset:4});
  expect(pressedSpeechAnchor(layout,blocks,178,10,50+row.top-10,50,178,measure)).toEqual({contentBlockIndex:1,contentCharOffset:8});
});

test("queue retains touched start across an engine error retry and next/previous, clears it on stop", async () => {
  const anchored = {...article("a"), contentBlocks:[{type:"text" as const,style:"body" as const,text:"跳过 从这里"}]};
  const h=harness({getArticle: async id => id === "a" ? anchored : article(id)});
  const first=h.controller.start(anchored,1,{contentBlockIndex:0,contentCharOffset:3});await settle();
  expect(h.spoken[0]!.text).toBe("从这里");
  h.spoken[0]!.done.reject(new Error("engine failure"));await first;
  const retry=h.controller.toggle();await settle();expect(h.spoken[1]!.text).toBe("从这里");
  const next=h.controller.next();await settle();expect(h.spoken[2]!.text).toBe("b。");
  const previous=h.controller.previous();await settle();expect(h.spoken[3]!.text).toBe("从这里");
  await h.controller.stop();for (const spoken of h.spoken) spoken.done.resolve();await Promise.all([retry,next,previous]);
  const fresh=h.controller.start(anchored);await settle();expect(h.spoken[4]!.text).toBe("a。");
  await h.controller.stop();h.spoken[4]!.done.resolve();await fresh;
});


test("start volume preparation precedes speech and does not repeat on resume or next article", async () => {
  let preparations=0;
  const volume=deferred<void>();
  const h=harness({},async()=>{preparations++;await volume.promise;});
  const first=h.controller.start(article("a"));await settle();
  expect(preparations).toBe(1);expect(h.spoken).toHaveLength(0);
  volume.resolve();await settle();expect(h.spoken).toHaveLength(1);
  await h.controller.toggle();h.spoken[0]!.done.resolve();await first;
  const resumed=h.controller.toggle();await settle();expect(preparations).toBe(1);
  const next=h.controller.next();await settle();expect(preparations).toBe(1);expect(h.controller.state.article?.id).toBe("b");
  h.spoken[1]!.done.resolve();await resumed;
  await h.controller.stop();h.spoken[2]!.done.resolve();await next;
  const newer=h.controller.start(article("a"));await settle();expect(preparations).toBe(2);
  await h.controller.stop();h.spoken[3]!.done.resolve();await newer;
});
test("stopping while start volume is being read prevents stale preparation from speaking", async () => {
  const volume=deferred<void>();let current:(()=>boolean)|undefined;
  const h=harness({},async check=>{current=check;await volume.promise;});
  const pending=h.controller.start(article("a"));await settle();expect(current?.()).toBe(true);
  await h.controller.stop();expect(current?.()).toBe(false);volume.resolve();await pending;
  expect(h.spoken).toHaveLength(0);expect(h.controller.state.phase).toBe("idle");
});
test("a failed volume service does not prevent native-compatible speech startup", async () => {
  const h=harness({},async()=>{throw new Error("volume unavailable");});
  const pending=h.controller.start(article("a"));await settle();
  expect(h.spoken).toHaveLength(1);expect(h.controller.state.phase).toBe("ready");
  await h.controller.stop();h.spoken[0]!.done.resolve();await pending;
});

test("pause during a delayed imported chunk retains that chunk for resume", async()=>{
  const {ImportedSpeechSegmentSource}=await import("../src/reader/speech-source.ts");
  const chunk=deferred<string|null>(),reads:number[]=[];
  const h=harness({getSpeechSource:async a=>new ImportedSpeechSegmentSource(a.title,1,index=>{reads.push(index);return chunk.promise;})});
  const first=h.controller.start(article("a"));await settle();
  h.spoken[0]!.done.resolve();await settle();expect(reads).toEqual([0]);
  expect(h.controller.state.phase).toBe("preparing");await h.controller.toggle();
  expect(h.controller.state.phase).toBe("ready");expect(h.controller.state.playing).toBe(false);
  chunk.resolve("迟到正文");await first;expect(h.spoken).toHaveLength(1);
  const resume=h.controller.toggle();await settle();expect(h.spoken[1]!.text).toBe("迟到正文");
  expect(speechPlaybackStatus(h.controller.state)).toBe("播放中 · 第 1/2 篇 · 第 2 段");
  await h.controller.stop();h.spoken[1]!.done.resolve();await resume;expect(reads).toEqual([0]);
});
test("a replaced imported source cannot speak when its delayed read returns",async()=>{
  const {ImportedSpeechSegmentSource}=await import("../src/reader/speech-source.ts");
  const chunk=deferred<string|null>();
  const h=harness({getSpeechSource:async a=>a.id==="a"?new ImportedSpeechSegmentSource("",1,()=>chunk.promise):null});
  const first=h.controller.start(article("a"));await settle();expect(h.spoken).toHaveLength(0);
  const next=h.controller.next();await settle();expect(h.spoken[0]!.text).toBe("b。");
  chunk.resolve("过期内容");await first;expect(h.spoken).toHaveLength(1);
  await h.controller.stop();h.spoken[0]!.done.resolve();await next;
});
