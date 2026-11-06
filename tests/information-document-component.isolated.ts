import {afterEach, expect, mock, test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {createComponent, createEffect, createMemo, createRenderEffect, createRoot, createSignal, getOwner, mergeProps, runWithOwner, type Owner} from "solid-js";
import * as solidRuntime from "solid-js";
import type {TextLayoutLine, TextLayoutOptions} from "@podjs/framework/services";
import type {SystemTextLineOptions} from "@podjs/framework/text";
import type {ScrollEntry} from "../src/ui/ScrollEntries.tsx";
import type {InformationDocumentHandle, InformationDocumentProps} from "../src/ui/InformationDocument.tsx";
import {defaultReaderPreset} from "../src/reader/preset.ts";
import {BEIAN_NUMBER} from "../src/ui/information-data.ts";

// Preserve the same reactive JSX getters as the application's Solid universal
// transform. Bun's untransformed classic JSX would snapshot component props.
const require = createRequire(import.meta.url);
const {transformSync} = require("@babel/core");
// The real scroller lives in the linked SDK, which has its own node_modules.
// Match production's single-Solid alias so its offset signal notifies app effects.
const linkedSolidRuntimePath = fileURLToPath(import.meta.resolve("solid-js", fileURLToPath(import.meta.resolve("@pocketjs/framework/kinetics"))));
mock.module(linkedSolidRuntimePath, () => solidRuntime);
plugin({name: "information-document-solid-test", setup(builder) {
  builder.onLoad({filter: /\/(InformationDocument|ReaderTitleEntry)\.tsx$/}, async args => ({
    contents: transformSync(await Bun.file(args.path).text(), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[require("babel-preset-solid"), {generate: "universal", moduleName: "@pocketjs/framework/renderer"}], [require("@babel/preset-typescript"), {isTSX: true, allExtensions: true}]],
    }).code,
    loader: "js",
  }));
}});

type Element = {kind: string; props: Record<string, unknown> & {children?: unknown; style?: Record<string, unknown>}};
const element = (kind: string) => (props: Element["props"]): Element => ({kind, props});
mock.module("@pocketjs/framework/renderer", () => ({createComponent, mergeProps, memo: createMemo, effect: createRenderEffect}));
mock.module("@pocketjs/framework/components", () => ({View: element("View"), Text: element("Text")}));
mock.module("@podjs/framework/text", () => ({SystemTextLine: element("SystemTextLine")}));
mock.module("@pocketjs/framework/host", () => ({getOps: () => ({measureText: (text: string) => Array.from(text).length * 14})}));
mock.module("../src/ui/ScrollEntries.tsx", () => ({ScrollEntries: element("ScrollEntries")}));
mock.module("../src/ui/ReaderBackground.tsx", () => ({ReaderBackground: element("ReaderBackground")}));

let environmentAvailable = true;
let environmentScale = 1.3;
let holdMeasurements = false;
let footerIntrinsicWidth = 280.25;
interface MeasurementRequest {
  options: {text: string; fontSizePx: number};
  settled: boolean;
  cancelled: boolean;
  resolve: (value: {widthPx: number}) => void;
  reject: (error: Error) => void;
}
const measurements: MeasurementRequest[] = [];
const measuredWidth = (options: {text: string; fontSizePx: number}) => options.text === BEIAN_NUMBER ? footerIntrinsicWidth : Array.from(options.text).length * options.fontSizePx;
mock.module("@podjs/framework/watch", () => ({
  getDisplayMetrics: () => ({logicalWidth: 233, logicalHeight: 233, physicalWidth: 466, physicalHeight: 466, density: 1.75}),
  getFontMetrics: () => ({cellHeight: 26, baseline: 20}),
  hasCapability: (name: string) => name === "text.layout" || name === "text.raster" || name === "text.environment" && environmentAvailable,
}));

interface LayoutRequest {
  options: TextLayoutOptions;
  cancelled: boolean;
  settled: boolean;
  resolve: (value: {lines: TextLayoutLine[]}) => void;
  reject: (error: Error) => void;
  lines?: TextLayoutLine[];
}
const requests: LayoutRequest[] = [];
mock.module("@podjs/framework/services", () => ({textLayout: {
  environment: async () => ({density: 1.75, fontScale: environmentScale, spValuesPx: []}),
  measure: (options: {text: string; fontSizePx: number}) => {
    if (!holdMeasurements) return {result: Promise.resolve({widthPx: measuredWidth(options)}), cancel() {}};
    let resolve!: MeasurementRequest["resolve"], reject!: MeasurementRequest["reject"];
    const result = new Promise<{widthPx: number}>((accept, fail) => {resolve = accept; reject = fail;});
    const request = {options: {...options}, settled: false, cancelled: false, resolve, reject};
    measurements.push(request);
    return {result, cancel() {request.cancelled = true;}};
  },
  layout: (options: TextLayoutOptions) => {
    let resolve!: LayoutRequest["resolve"], reject!: LayoutRequest["reject"];
    const result = new Promise<{lines: TextLayoutLine[]}>((accept, fail) => {resolve = accept; reject = fail;});
    const request = {options: {...options}, resolve, reject, cancelled: false, settled: false};
    requests.push(request);
    // Deliberately permit a late reply after cancel; the production owner must ignore it.
    return {result, cancel() {request.cancelled = true;}};
  },
}}));

const {InformationDocument, useInformationDocument} = await import("../src/ui/InformationDocument.tsx");
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  requests.length = 0; measurements.length = 0;
  environmentAvailable = true; environmentScale = 1.3; holdMeasurements = false; footerIntrinsicWidth = 280.25;
});
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const body = "这段正文用于检查完整语义与长段落滚动。".repeat(70);
const quote = "• 阅读内容仅在本地保存";
const code = "https://example.test/privacy";
const title = "隐私政策更新说明";

function props(overrides: Partial<InformationDocumentProps> = {}): InformationDocumentProps {
  const preset = defaultReaderPreset();
  preset.categoryTypographyEnabled = true;
  preset.title = {fontSizeSp: 21};
  return mergeProps({title, content: `${body}\n\n${quote}\n${code}`, width: 233, height: 233, preset,
    fonts: () => ({fontPath: "reader/fonts/custom.ttf", fontFaceIndex: 1}),
    backgroundSnapshot: {state: {}, revision: 0}, onBeian() {}, active: () => true,
  }, overrides);
}

function mountHook(overrides: Partial<InformationDocumentProps> = {}) {
  let hook!: ReturnType<typeof useInformationDocument>, owner!: Owner;
  const errors: unknown[] = [], offsets: number[] = [];
  const readiness: Array<{ready: boolean; errors: unknown[]}> = [];
  const input = props(mergeProps({onLayoutError: (error: unknown) => errors.push(error), onScrollOffsetChange: (offset: number) => offsets.push(offset)}, overrides));
  createRoot(dispose => {
    disposers.push(dispose); owner = getOwner()!; hook = useInformationDocument(input);
    createEffect(() => readiness.push({ready: hook.ready(), errors: [...errors]}));
  });
  return {hook, owner, errors, offsets, readiness};
}

interface Visit {node: Element; hidden: boolean}
function visit(value: unknown, hidden = false): Visit[] {
  if (typeof value === "function") return visit(value(), hidden);
  if (Array.isArray(value)) return value.flatMap(child => visit(child, hidden));
  if (!value || typeof value !== "object" || !("kind" in value)) return [];
  const node = value as Element, isHidden = hidden || node.props.accessibilityHidden === true;
  return [{node, hidden: isHidden}, ...visit(node.props.children, isHidden)];
}
const renderEntry = (entry: ScrollEntry, owner: Owner): Visit[] => runWithOwner(owner, () => visit(entry.render()))!;
const renderedEntries = (mounted: ReturnType<typeof mountHook>) => mounted.hook.entries().map(entry => ({entry, nodes: renderEntry(entry, mounted.owner)}));
function entryWithLabel(mounted: ReturnType<typeof mountHook>, label: string) {
  const found = renderedEntries(mounted).find(value => value.nodes.some(({node, hidden}) => !hidden && node.props.accessibilityLabel === label));
  expect(found, `missing semantic entry: ${label.slice(0, 30)}`).toBeDefined();
  return found!;
}

function nativeLines(options: TextLayoutOptions): TextLayoutLine[] {
  if (options.text === BEIAN_NUMBER) return footerIntrinsicWidth > options.widthPx
    ? [{start: 0, end: 8, visibleEnd: 8, topPx: 0, bottomPx: 29, baselinePx: 22}, {start: 8, end: options.text.length, visibleEnd: options.text.length, topPx: 29, bottomPx: 54, baselinePx: 49}]
    : [{start: 0, end: options.text.length, visibleEnd: options.text.length, topPx: 0, bottomPx: 25, baselinePx: 20}];
  const parts = options.text.split("\n"), lines: TextLayoutLine[] = [];
  let start = 0, topPx = 0;
  for (const [partIndex, part] of parts.entries()) {
    // Fixed native-service fixture: source lines longer than 12 UTF-16 units
    // produce measured visual lines. These are host replies, not app wrapping.
    for (let at = 0; at < part.length || at === 0; at += 12) {
      const endInPart = Math.min(part.length, at + 12), lastInPart = endInPart === part.length;
      const end = start + endInPart + (lastInPart && partIndex < parts.length - 1 ? 1 : 0);
      const height = partIndex === parts.length - 1 && lastInPart ? 31 : 39;
      lines.push({start: start + at, end, visibleEnd: start + endInPart, topPx, bottomPx: topPx + height, baselinePx: topPx + height - 7});
      topPx += height;
      if (!part.length) break;
    }
    start += part.length + (partIndex < parts.length - 1 ? 1 : 0);
  }
  return lines;
}
function release(request: LayoutRequest) {
  if (request.settled) return;
  request.settled = true; request.lines = nativeLines(request.options); request.resolve({lines: request.lines});
}
async function releaseLayouts(predicate: (request: LayoutRequest) => boolean = () => true) {
  for (let pass = 0; pass < 30; pass++) {
    await settle();
    const pending = requests.filter(request => !request.settled && predicate(request));
    if (!pending.length) return;
    pending.forEach(release);
  }
  throw Error("paragraph requests did not settle");
}
const linesIn = (nodes: Visit[]) => nodes.filter(({node}) => node.kind === "SystemTextLine");
const isTitleRequest = (request: LayoutRequest) => request.options.text.replaceAll("\n", "") === title;
function expectTitleFallback(mounted: ReturnType<typeof mountHook>) {
  expect(mounted.errors).toHaveLength(1);
  expect(String(mounted.errors[0])).toMatch(/title.*native|native.*title/i);
  expect(mounted.readiness.find(state => state.ready)?.errors).toEqual(mounted.errors);
}

function rejectLayout(request: LayoutRequest, error: Error) {
  expect(request.settled).toBe(false);
  request.settled = true;
  request.reject(error);
}

async function releaseMeasurements() {
  for (let pass = 0; pass < 100; pass++) {
    await settle();
    const pending = measurements.filter(request => !request.settled);
    if (!pending.length) return;
    for (const request of pending) {
      request.settled = true;
      request.resolve({widthPx: measuredWidth(request.options)});
    }
  }
  throw Error("title measurements did not settle");
}

test("native body blocks own semantics while only visible measured visual lines are rendered", async () => {
  const mounted = mountHook();
  await releaseLayouts();
  expect(mounted.errors).toEqual([]);
  const bodyEntry = entryWithLabel(mounted, body), titleEntry = entryWithLabel(mounted, title);
  const rendered = linesIn(bodyEntry.nodes), measured = requests.find(request => request.options.text === body && !request.cancelled)!;
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThan(measured.lines!.length);
  expect(rendered.length).toBeLessThan(24);
  expect(rendered.every(value => value.hidden)).toBe(true);
  expect(linesIn(titleEntry.nodes).every(value => value.hidden)).toBe(true);
  expect(bodyEntry.nodes.filter(({node, hidden}) => !hidden && node.props.accessibilityLabel === body)).toHaveLength(1);
  expect(entryWithLabel(mounted, quote)).toBeDefined();
  expect(entryWithLabel(mounted, code)).toBeDefined();
  const firstIndices = rendered.map(({node}) => (node.props.options as SystemTextLineOptions).paragraph!.lineIndex);
  mounted.hook.scroller.scrollTo(500, {immediate: true});
  const after = linesIn(entryWithLabel(mounted, body).nodes);
  expect(after.every(value => value.hidden)).toBe(true);
  expect(after.map(({node}) => (node.props.options as SystemTextLineOptions).paragraph!.lineIndex)).not.toEqual(firstIndices);
  for (const {node} of after) {
    const options = node.props.options as SystemTextLineOptions, line = measured.lines![options.paragraph!.lineIndex]!;
    expect(options.text).toBe(body.slice(line.start, line.visibleEnd));
    expect(options.heightPx).toBe(line.bottomPx - line.topPx);
    expect(options.baselinePx).toBe(line.baselinePx - line.topPx);
    expect(options.widthPx).toBe(options.paragraph!.widthPx);
  }
});

test("each visible one-line source block paints its single measured line", async () => {
  const texts = ["短正文", "• 引用", "https://x.cn"];
  const mounted = mountHook({content: texts.join("\n")});
  await releaseLayouts();
  for (const text of texts) {
    const lines = linesIn(entryWithLabel(mounted, text).nodes);
    expect(lines).toHaveLength(1);
    expect((lines[0]!.node.props.options as SystemTextLineOptions).text).toBe(text);
  }
});

test("restored physical offset survives delayed title, body and footer replies and an explicit restore", async () => {
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  await settle();
  expect(requests.some(request => !request.settled)).toBe(true);
  for (let frame = 0; frame < 20; frame++) mounted.hook.scroller.step();
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  await releaseLayouts(request => request.options.text.replaceAll("\n", "") !== title);
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.scroller.offset()).toBe(0);
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  mounted.hook.restoreScrollOffsetPx(1400);
  expect(mounted.hook.scrollOffsetPx()).toBe(1400);
  expect(mounted.hook.scroller.offset()).toBe(0);
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.scrollOffsetPx()).toBe(1400);
  mounted.hook.scroller.scrollBy(-30, {immediate: true});
  expect(mounted.hook.scrollOffsetPx()).toBe(1340);
  expect(mounted.offsets.at(-1)).toBe(1340);
});

test("settled restoration clamps an oversized snapshot to the real document range", async () => {
  const mounted = mountHook({restoredScrollOffsetPx: 1_000_000});
  expect(mounted.hook.scrollOffsetPx()).toBe(1_000_000);
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  const maximum = Math.max(0, mounted.hook.entries().reduce((height, entry) => height + entry.height, 0) - 233);
  expect(mounted.hook.scroller.offset()).toBe(maximum);
  expect(mounted.hook.scrollOffsetPx()).toBe(Math.round(maximum * 2));
  mounted.hook.scroller.scrollTo(1_000_000, {immediate: true});
  expect(mounted.hook.scroller.offset()).toBe(maximum);
});

const anchorContent = Array.from({length: 16}, (_, index) => `第${index + 1}段。` + '用于检验列表条目恢复。'.repeat(8)).join('\n\n');
test('canonical restoration waits for every native layout and consumes its initial prop once', async () => {
  const initial = {index: 12, offsetPx: 37};
  const [saved, setSaved] = createSignal(initial);
  const mounted = mountHook({content: anchorContent, get restoredListAnchor() {return saved();}, restoredScrollOffsetPx: 900});
  expect(mounted.hook.listAnchor()).toEqual(initial);
  await releaseLayouts(request => !isTitleRequest(request));
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.scroller.offset()).toBe(0);
  expect(mounted.hook.listAnchor()).toEqual(initial);
  setSaved({index: 4, offsetPx: 0});
  expect(mounted.hook.listAnchor()).toEqual(initial);
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.entries().slice(0, 2).map(entry => entry.height)).toEqual([18, 4]);
  expect(mounted.hook.listAnchor()).toEqual(initial);
  const expected = mounted.hook.entries().slice(0, 12).reduce((sum, entry) => sum + entry.height * 2, 0) + 37;
  expect(mounted.hook.scrollOffsetPx()).toBe(expected);
  expect(mounted.hook.scrollOffsetPx()).not.toBe(900);
  mounted.hook.scroller.scrollBy(5, {immediate: true});
  setSaved({index: 12, offsetPx: 37});
  expect(mounted.hook.listAnchor()).toEqual({index: 12, offsetPx: 47});
});

test('explicit canonical restoration replaces a pending target and manual scroll cancels it', async () => {
  const mounted = mountHook({content: anchorContent, restoredListAnchor: {index: 12, offsetPx: 37}});
  await settle();
  mounted.hook.restoreListAnchor({index: 6, offsetPx: 19});
  expect(mounted.hook.listAnchor()).toEqual({index: 6, offsetPx: 19});
  mounted.hook.scroller.scrollTo(10, {immediate: true});
  await releaseLayouts();
  expect(mounted.hook.listAnchor()).toEqual({index: 0, offsetPx: 20});
  expect(mounted.hook.scrollOffsetPx()).toBe(20);
  mounted.hook.restoreListAnchor({index: 6, offsetPx: 19});
  expect(mounted.hook.listAnchor()).toEqual({index: 6, offsetPx: 19});
});

test('content reflow keeps the current canonical item and offset instead of its old absolute position', async () => {
  const [content, setContent] = createSignal(anchorContent);
  const mounted = mountHook({get content() {return content();}, restoredListAnchor: {index: 12, offsetPx: 37}});
  await releaseLayouts();
  const before = mounted.hook.scrollOffsetPx();
  setContent('新增的较长首段'.repeat(200) + '\n\n' + anchorContent.split('\n\n').slice(1).join('\n\n'));
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.listAnchor()).toEqual({index: 12, offsetPx: 37});
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.listAnchor()).toEqual({index: 12, offsetPx: 37});
  expect(mounted.hook.scrollOffsetPx()).toBeGreaterThan(before);
  expect(mounted.hook.scrollOffsetPx()).toBe(mounted.hook.entries().slice(0, 12).reduce((sum, entry) => sum + entry.height * 2, 0) + 37);
});

test('manual movement cancels an automatic reflow anchor and the mount disposes once', async () => {
  const [content, setContent] = createSignal(anchorContent);
  let disposed = 0, mountedHandle: InformationDocumentHandle | undefined, disposedHandle: InformationDocumentHandle | undefined;
  const mounted = mountHook({get content() {return content();}, restoredListAnchor: {index: 12, offsetPx: 37},
    ref: value => {mountedHandle = value;}, onDispose: value => {disposed++; disposedHandle = value;}});
  await releaseLayouts();
  setContent(anchorContent + '\n\n新增末段');
  expect(mounted.hook.ready()).toBe(false);
  mounted.hook.scroller.scrollTo(5, {immediate: true});
  await releaseLayouts();
  expect(mounted.hook.scrollOffsetPx()).toBe(10);
  expect(mounted.hook.listAnchor()).toEqual({index: 0, offsetPx: 10});
  disposers.pop()!();
  expect(disposed).toBe(1);
  expect(disposedHandle).toBe(mountedHandle);
});

test('empty content still has its canonical body and footer items, including the footer leading gap', async () => {
  const mounted = mountHook({content: '', height: 40, restoredListAnchor: {index: 4, offsetPx: 5}});
  await releaseLayouts();
  expect(mounted.hook.entries()).toHaveLength(7);
  expect(entryWithLabel(mounted, '暂无正文').entry).toBe(mounted.hook.entries()[4]!);
  expect(entryWithLabel(mounted, BEIAN_NUMBER).entry).toBe(mounted.hook.entries()[5]!);
  expect(mounted.hook.listAnchor()).toEqual({index: 4, offsetPx: 5});
  mounted.hook.restoreListAnchor({index: 5, offsetPx: 5});
  expect(mounted.hook.listAnchor()).toEqual({index: 5, offsetPx: 5});
  expect(mounted.hook.scrollOffsetPx()).toBe(mounted.hook.entries().slice(0, 5).reduce((sum, entry) => sum + entry.height * 2, 0) + 5);
});

test('a changed title keeps the body anchor pending until current native title planning finishes', async () => {
  const [currentTitle, setCurrentTitle] = createSignal(title);
  const mounted = mountHook({get title() {return currentTitle();}, content: anchorContent, restoredListAnchor: {index: 12, offsetPx: 37}});
  await releaseLayouts();
  const before = mounted.hook.scrollOffsetPx();
  holdMeasurements = true;
  setCurrentTitle(title.repeat(4));
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.listAnchor()).toEqual({index: 12, offsetPx: 37});
  await releaseMeasurements();
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.listAnchor()).toEqual({index: 12, offsetPx: 37});
  expect(mounted.hook.scrollOffsetPx()).toBeGreaterThan(before);
});

test('a canonical target clamps against the final shortened document and captures its actual bottom', async () => {
  const mounted = mountHook({content: anchorContent, restoredListAnchor: {index: 1000, offsetPx: 9999}});
  expect(mounted.hook.listAnchor()).toEqual({index: 1000, offsetPx: 9999});
  await releaseLayouts();
  const maximum = mounted.hook.entries().reduce((sum, entry) => sum + entry.height, 0) - 233;
  expect(mounted.hook.scroller.offset()).toBe(maximum);
  const actual = mounted.hook.listAnchor();
  expect(actual.index).toBeLessThan(mounted.hook.entries().length - 1);
  mounted.hook.restoreListAnchor(actual);
  expect(mounted.hook.scroller.offset()).toBe(maximum);
});

test("intentional scrolling cancels a pending restore before late native replies arrive", async () => {
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  await settle();
  mounted.hook.scroller.scrollTo(10, {immediate: true});
  expect(mounted.hook.scrollOffsetPx()).toBe(20);
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.scrollOffsetPx()).toBe(20);
});

test("a cancelled saved target stays cancelled when a shorter final layout clamps a provisional scroll", async () => {
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  await settle();
  mounted.hook.scroller.scrollTo(1_000_000, {immediate: true});
  const provisional = mounted.hook.scroller.offset();
  expect(mounted.hook.scrollOffsetPx()).toBe(Math.round(provisional * 2));
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  const maximum = Math.max(0, mounted.hook.entries().reduce((height, entry) => height + entry.height, 0) - 233);
  expect(provisional).toBeGreaterThan(maximum);
  expect(mounted.hook.scroller.offset()).toBe(maximum);
  expect(mounted.hook.scrollOffsetPx()).toBe(Math.round(maximum * 2));
  expect(mounted.hook.scrollOffsetPx()).not.toBe(900);
});

test("provisional paragraph replies cannot finish restoration while native title planning is still pending", async () => {
  holdMeasurements = true;
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  await releaseLayouts();
  expect(measurements.some(request => !request.settled)).toBe(true);
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  expect(mounted.hook.scroller.offset()).toBe(0);
  await releaseMeasurements();
  expect(mounted.hook.ready()).toBe(false);
  expect(requests.some(request => !request.settled && !request.cancelled)).toBe(true);
  await releaseLayouts();
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.scroller.offset()).toBe(450);
});

test("a current title paragraph failure reports once and lets fallback restoration settle", async () => {
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  await releaseLayouts(request => !isTitleRequest(request));
  const current = [...requests].reverse().find(request => isTitleRequest(request) && !request.cancelled && !request.settled)!;
  expect(current).toBeDefined();
  expect(mounted.hook.ready()).toBe(false);
  expect(mounted.hook.scroller.offset()).toBe(0);
  expect(mounted.errors).toEqual([]);
  rejectLayout(current, Error("current title paragraph service failed"));
  await releaseLayouts();
  expectTitleFallback(mounted);
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.displayReady()).toBe(true);
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  expect(mounted.hook.scroller.offset()).toBe(450);
  const lines = linesIn(entryWithLabel(mounted, title).nodes);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(({node}) => !(node.props.options as SystemTextLineOptions).paragraph)).toBe(true);
  mounted.hook.scroller.scrollBy(-20, {immediate: true});
  await settle();
  expect(mounted.errors).toHaveLength(1);
  expect(mounted.hook.scrollOffsetPx()).toBe(860);
});

test("a cancelled old title paragraph failure cannot report after the newer generation succeeds", async () => {
  const [width, setWidth] = createSignal(233);
  const mounted = mountHook({get width() {return width();}, restoredScrollOffsetPx: 900});
  await releaseLayouts(request => !isTitleRequest(request));
  const old = [...requests].reverse().find(request => isTitleRequest(request) && !request.cancelled && !request.settled)!;
  expect(old).toBeDefined();
  expect(old.options.widthPx).toBe(380);
  setWidth(180);
  expect(old.cancelled).toBe(true);
  await releaseLayouts(request => request !== old);
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.scroller.offset()).toBe(450);
  expect(mounted.errors).toEqual([]);
  const titleLines = linesIn(entryWithLabel(mounted, title).nodes);
  expect(titleLines.length).toBeGreaterThan(0);
  expect(titleLines.every(({node}) => (node.props.options as SystemTextLineOptions).paragraph?.widthPx === 304)).toBe(true);
  rejectLayout(old, Error("late cancelled title paragraph failure"));
  await settle(); await settle();
  expect(mounted.errors).toEqual([]);
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
  expect(linesIn(entryWithLabel(mounted, title).nodes).map(({node}) => (node.props.options as SystemTextLineOptions).paragraph?.widthPx)).toEqual(titleLines.map(() => 304));
});

test("a current title planning measurement failure reports fallback while restoration still completes", async () => {
  holdMeasurements = true;
  const mounted = mountHook({restoredScrollOffsetPx: 900});
  await settle();
  const current = [...measurements].reverse().find(request => request.options.text !== BEIAN_NUMBER && !request.cancelled && !request.settled)!;
  expect(current).toBeDefined();
  expect(mounted.hook.ready()).toBe(false);
  current.settled = true;
  current.reject(Error("current title planning measurement failed"));
  await releaseMeasurements();
  await releaseLayouts();
  expectTitleFallback(mounted);
  expect(mounted.hook.ready()).toBe(true);
  expect(mounted.hook.displayReady()).toBe(true);
  expect(mounted.hook.scroller.offset()).toBe(450);
  expect(mounted.hook.scrollOffsetPx()).toBe(900);
});

test("Compose font scale uses Info's fixed density and the footer uses its raw font and measured natural height", async () => {
  const mounted = mountHook();
  await releaseLayouts();
  const bodyLayout = requests.find(request => request.options.text === body && !request.cancelled)!;
  // Genuine Compose 1.7.1 oracle values at scale 1.3 and density 2 (the host
  // context fixture deliberately reports density 1.75 instead).
  expect(bodyLayout.options.fontSizePx).toBe(37.599998474121094);
  const titleLayout = requests.find(request => request.options.text.replaceAll("\n", "") === title && !request.cancelled)!;
  expect(titleLayout.options.fontSizePx).toBe(48.599998474121094);
  expect(requests.find(request => request.options.text === quote)!.options.fontSizePx).toBe(37.599998474121094);
  expect(requests.find(request => request.options.text === code)!.options.fontSizePx).toBe(33.119998931884766);
  const footer = entryWithLabel(mounted, BEIAN_NUMBER), visible = linesIn(footer.nodes);
  expect(visible).toHaveLength(1);
  expect(visible[0]!.hidden).toBe(true);
  const options = visible[0]!.node.props.options as SystemTextLineOptions;
  expect(options).toMatchObject({fontWeight: 400, heightPx: 25, baselinePx: 20, widthPx: 281, align: "left"});
  expect(options.fontPath).toBeUndefined();
  expect(options.paragraph).toMatchObject({text: BEIAN_NUMBER});
  expect(footer.entry.height).toBe(18.5); // native six-dp gap plus 25px/2 measured text
  expect(footer.nodes.find(({node}) => node.props.accessibilityLabel === BEIAN_NUMBER)!.node.props.style).toMatchObject({insetL: 32.5, width: 140.5});
});

test("a large-font footer wraps left within the centered available box and keeps native line heights", async () => {
  environmentScale = 1.8; footerIntrinsicWidth = 350;
  const mounted = mountHook({width: 180});
  await releaseLayouts();
  const footer = entryWithLabel(mounted, BEIAN_NUMBER), lines = linesIn(footer.nodes);
  expect(lines).toHaveLength(2);
  expect(lines.every(line => line.hidden)).toBe(true);
  expect(lines.map(({node}) => (node.props.options as SystemTextLineOptions).text).join("")).toBe(BEIAN_NUMBER);
  expect(lines.map(({node}) => (node.props.options as SystemTextLineOptions).heightPx)).toEqual([29, 25]);
  for (const {node} of lines) {
    const options = node.props.options as SystemTextLineOptions;
    expect(options).toMatchObject({widthPx: 304, align: "left"});
    expect(options.paragraph).toMatchObject({widthPx: 304, align: "left"});
  }
  expect(footer.entry.height).toBe(33);
  expect(footer.nodes.find(({node}) => node.props.accessibilityLabel === BEIAN_NUMBER)!.node.props.style).toMatchObject({insetL: 0, width: 152});
});

test("the component reveals its correctly configured scroll list only after pending restoration settles", async () => {
  let tree: unknown, owner!: Owner, handle!: InformationDocumentHandle;
  const input = props({restoredScrollOffsetPx: 900, accessibilityLabel: "隐私政策", ref: value => {handle = value;}});
  createRoot(dispose => {disposers.push(dispose); owner = getOwner()!; tree = InformationDocument(input);});
  const nodes = () => runWithOwner(owner, () => visit(tree))!;
  expect(nodes().some(({node}) => node.kind === "ScrollEntries")).toBe(false);
  await releaseLayouts(request => request.options.text.replaceAll("\n", "") !== title);
  expect(handle.ready()).toBe(false);
  expect(nodes().some(({node}) => node.kind === "ScrollEntries")).toBe(false);
  await releaseLayouts();
  expect(handle.ready()).toBe(true);
  const list = nodes().find(({node}) => node.kind === "ScrollEntries")!.node;
  expect(list.props).toMatchObject({height: 233, padding: 14, verticalPadding: 0, gap: 0, accessibilityLabel: "隐私政策"});
  expect(list.props.controller).toBe(handle.scroller);
  expect(handle.scrollOffsetPx()).toBe(900);
  expect(nodes().find(({node}) => node.kind === "ReaderBackground")!.node.props.background).toBe(input.preset.background);
});

test("an unsupported text environment reports failure and keeps the component list absent", async () => {
  environmentAvailable = false;
  const errors: unknown[] = [];
  let tree: unknown, owner!: Owner;
  createRoot(dispose => {
    disposers.push(dispose); owner = getOwner()!;
    tree = InformationDocument(props({onLayoutError: error => errors.push(error)}));
  });
  await settle();
  const nodes = runWithOwner(owner, () => visit(tree))!;
  expect(errors).toHaveLength(1);
  expect(nodes.some(({node}) => node.kind === "ScrollEntries")).toBe(false);
});
