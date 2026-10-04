import {afterEach, expect, mock, test} from "bun:test";
import {createRoot, createSignal, type Accessor, type Setter} from "solid-js";
import type {TextLayoutLine, TextLayoutOptions} from "@podjs/framework/services";
import type {SystemTextLineOptions} from "@podjs/framework/text";
import type {ScrollEntry} from "../src/ui/ScrollEntries.tsx";
import type {ReaderTitleLayoutState} from "../src/ui/reader-title.ts";
import {defaultReaderPreset} from "../src/reader/preset.ts";

type Element = {kind: string; props: Record<string, unknown> & {children?: unknown; style?: Record<string, number>}};
const element = (kind: string) => (props: Element["props"]): Element => ({kind, props});
// Render the production TSX into an inspectable tree. Only the renderer boundary is
// replaced: title planning, Solid reactivity, paragraph layout and option assembly run.
// Bun's direct loader lowers this project's jsx:preserve through the classic factory.
const createElement = (component: (props: Element["props"]) => Element, props: Element["props"] | null, ...children: unknown[]) => component({...props, ...(children.length ? {children: children.length === 1 ? children[0] : children} : {})});
(globalThis as typeof globalThis & {React: {createElement: typeof createElement}}).React = {createElement};
mock.module("@pocketjs/framework/components", () => ({View: element("View"), Text: element("Text")}));
mock.module("@podjs/framework/text", () => ({SystemTextLine: element("SystemTextLine")}));
mock.module("@pocketjs/framework/host", () => ({getOps: () => ({measureText: (text: string) => Array.from(text).length * 20})}));
let layoutSupported = true;
mock.module("@podjs/framework/watch", () => ({
  getDisplayMetrics: () => ({logicalWidth: 233, logicalHeight: 233, physicalWidth: 466, physicalHeight: 466, density: 2}),
  getFontMetrics: () => ({cellHeight: 26, baseline: 20}),
  hasCapability: (name: string) => name === "text.layout" && layoutSupported || name === "text.raster",
}));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const result = new Promise<T>((accept, fail) => {resolve = accept; reject = fail;});
  return {result, resolve, reject, cancelled: false, cancel() {this.cancelled = true;}};
}
type MeasureOptions = {text: string; fontSizePx: number};
const measurements: MeasureOptions[] = [];
const pendingMeasurements: Array<{options: MeasureOptions; operation: ReturnType<typeof deferred<{widthPx: number}>>}> = [];
const pendingParagraphs: Array<{options: TextLayoutOptions; lines: TextLayoutLine[]; operation: ReturnType<typeof deferred<{lines: TextLayoutLine[]}>>}> = [];
let delayMeasurements = false, delayParagraphs = false, failMeasurements = false, failParagraphs = false;
const layouts: Array<{options: TextLayoutOptions; lines: TextLayoutLine[]}> = [];
mock.module("@podjs/framework/services", () => ({textLayout: {
  measure: (options: MeasureOptions) => {
    measurements.push({...options});
    if (delayMeasurements) {
      const operation = deferred<{widthPx: number}>();
      pendingMeasurements.push({options: {...options}, operation});
      return operation;
    }
    return {result: failMeasurements ? Promise.reject(Error("Title measurement unavailable")) : Promise.resolve({widthPx: Array.from(options.text).length * options.fontSizePx}), cancel() {}};
  },
  layout: (options: TextLayoutOptions) => {
    // The real title formatter has already inserted its hard breaks. This host
    // fixture consumes their source offsets and supplies variable native line boxes.
    const parts = options.text.split("\n");
    let start = 0, topPx = 0;
    const lines = parts.map((part, index): TextLayoutLine => {
      const last = index === parts.length - 1, height = last ? 45 : index === 0 ? 51 : 58;
      const line = {start, end: start + part.length + (last ? 0 : 1), visibleEnd: start + part.length, topPx, bottomPx: topPx + height, baselinePx: topPx + height - 9};
      start = line.end; topPx = line.bottomPx;
      return line;
    });
    layouts.push({options: {...options}, lines});
    if (delayParagraphs) {
      const operation = deferred<{lines: TextLayoutLine[]}>();
      pendingParagraphs.push({options: {...options}, lines, operation});
      return operation;
    }
    return {result: failParagraphs ? Promise.reject(Error("Title paragraph unavailable")) : Promise.resolve({lines}), cancel() {}};
  },
}}));

const {useReaderTitleEntry} = await import("../src/ui/ReaderTitleEntry.tsx");
const {useReaderTitle} = await import("../src/ui/reader-title.ts");
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  layouts.length = measurements.length = pendingMeasurements.length = pendingParagraphs.length = 0;
  layoutSupported = true;
  delayMeasurements = delayParagraphs = failMeasurements = failParagraphs = false;
});
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const longTitle = "隐私政策更新说明：关于我们如何处理个人信息以及保护您的阅读偏好";
const resolveMeasurement = (request: typeof pendingMeasurements[number]) => request.operation.resolve({widthPx: Array.from(request.options.text).length * request.options.fontSizePx});
const resolveParagraph = (request: typeof pendingParagraphs[number]) => request.operation.resolve({lines: request.lines});

function mount(width = 205, color = "#ffffff", onLayoutState?: (state: ReaderTitleLayoutState) => void) {
  let entry!: Accessor<ScrollEntry>, setWidth!: Setter<number>, setColor!: Setter<string>, setText!: Setter<string>, disposeRoot!: () => void;
  const states: ReaderTitleLayoutState[] = [];
  createRoot(dispose => {
    disposers.push(dispose); disposeRoot = dispose;
    const [available, changeWidth] = createSignal(width), [paint, changeColor] = createSignal(color), [text, changeText] = createSignal(longTitle);
    setWidth = changeWidth; setColor = changeColor; setText = changeText;
    const preset = defaultReaderPreset();
    preset.categoryTypographyEnabled = true;
    preset.title = {alignment: "JUSTIFY", colorArgb: 0xffaa3311};
    const font = () => ({fontPath: "reader/fonts/title.ttf", fontFaceIndex: 1, variationSettings: "'wght' 650"});
    entry = useReaderTitleEntry(text, available, () => preset, () => font, paint, state => {
      states.push({...state}); onLayoutState?.(state);
    });
  });
  return {entry: () => entry(), setWidth, setColor, setText, states, dispose: () => disposeRoot()};
}

function descendants(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== "object" || !("kind" in value)) return [];
  const node = value as Element;
  return [node, ...descendants(node.props.children)];
}

function rendered(entry: ScrollEntry) {
  const tree = entry.render() as unknown as Element;
  const nodes = descendants(tree);
  return {tree, nodes, lines: nodes.filter(node => node.kind === "SystemTextLine").map(node => ({node, options: node.props.options as SystemTextLineOptions}))};
}

test("a long title at 205dp renders the measured 190dp paragraph inside a centered container", async () => {
  const hook = mount();
  await settle();
  const entry = hook.entry(), {tree, nodes, lines} = rendered(entry);
  expect(lines.length).toBeGreaterThan(1);
  expect(tree.props.style).toMatchObject({insetL: 7.5, width: 190});
  const request = layouts.at(-1)!;
  expect(request.options.text.replaceAll("\n", "")).toBe(longTitle);
  expect(lines).toHaveLength(request.lines.length);
  expect(request.options.widthPx).toBe(380);
  for (const [index, {options}] of lines.entries()) {
    const native = request.lines[index]!;
    expect(options.paragraph).toMatchObject({...request.options, lineIndex: index});
    expect(options.widthPx).toBe(request.options.widthPx);
    expect(options.text).toBe(request.options.text.slice(native.start, native.visibleEnd));
    expect(options.heightPx).toBe(native.bottomPx - native.topPx);
    expect(options.baselinePx).toBe(native.baselinePx - native.topPx);
    expect(options).toMatchObject({fontPath: "reader/fonts/title.ttf", fontFaceIndex: 1, variationSettings: "'wght' 650"});
  }
  const rows = nodes.filter(node => node.kind === "View" && node.props.style?.insetT !== undefined);
  expect(rows.map(node => node.props.style?.insetT)).toEqual(request.lines.map(line => line.topPx / 2));
  expect(entry.height).toBe(request.lines.at(-1)!.bottomPx / 2);
});

test("light and custom alpha colors reach every rendered line and its native paragraph paint", async () => {
  const hook = mount(205, "#221f1b");
  for (const [color, colorArgb] of [["#221f1b", 0xff221f1b], ["#12345680", 0x80123456]] as const) {
    hook.setColor(color);
    await settle();
    const {lines} = rendered(hook.entry());
    expect(lines.length).toBeGreaterThan(1);
    expect(layouts.at(-1)!.options).toMatchObject({colorArgb, align: "center", justify: false});
    for (const {options} of lines) {
      expect(options).toMatchObject({colorArgb, align: "center"});
      expect(options.paragraph).toMatchObject({colorArgb, align: "center", justify: false});
    }
  }
});

test("a narrower available width updates measurement, container and every raster line together", async () => {
  const hook = mount();
  await settle();
  hook.setWidth(160);
  expect(hook.states.at(-1)).toEqual({settled: false, native: false});
  await settle();
  const {tree, lines} = rendered(hook.entry());
  expect(tree.props.style).toMatchObject({insetL: 0, width: 160});
  expect(lines.length).toBeGreaterThan(1);
  for (const {options} of lines) {
    expect(options.widthPx).toBe(320);
    expect(options.paragraph?.widthPx).toBe(320);
  }
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
});

test("a completed fallback paragraph cannot settle a title whose measurements are pending", async () => {
  delayMeasurements = true;
  const hook = mount();
  await settle();
  expect(layouts.length).toBeGreaterThan(0);
  expect(pendingMeasurements).toHaveLength(1);
  expect(hook.states.some(state => state.settled)).toBe(false);
  delayMeasurements = false;
  resolveMeasurement(pendingMeasurements[0]!);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
});

test("completed title planning still waits for its current paragraph rather than the old fallback", async () => {
  delayParagraphs = true;
  const hook = mount();
  await settle();
  expect(pendingParagraphs.length).toBeGreaterThan(1);
  expect(hook.states.some(state => state.settled)).toBe(false);
  const old = pendingParagraphs[0]!, current = pendingParagraphs.at(-1)!;
  expect(old.operation.cancelled).toBe(true);
  resolveParagraph(old);
  await settle();
  expect(hook.states.some(state => state.settled)).toBe(false);
  resolveParagraph(current);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
});

test("a new width cancels old work and ignores late measurement and paragraph replies", async () => {
  delayMeasurements = delayParagraphs = true;
  const hook = mount();
  await settle();
  const oldMeasure = pendingMeasurements[0]!, oldParagraph = pendingParagraphs.at(-1)!;
  hook.setWidth(160);
  await settle();
  const currentMeasure = pendingMeasurements.at(-1)!, fallbackParagraph = pendingParagraphs.at(-1)!;
  expect(currentMeasure).not.toBe(oldMeasure);
  expect(oldMeasure.operation.cancelled).toBe(true);
  expect(oldParagraph.operation.cancelled).toBe(true);
  resolveMeasurement(oldMeasure); resolveParagraph(oldParagraph);
  await settle();
  expect(hook.states.some(state => state.settled)).toBe(false);
  delayMeasurements = false;
  resolveMeasurement(currentMeasure);
  await settle();
  const currentParagraph = pendingParagraphs.at(-1)!;
  expect(currentParagraph).not.toBe(fallbackParagraph);
  expect(fallbackParagraph.operation.cancelled).toBe(true);
  resolveParagraph(fallbackParagraph);
  await settle();
  expect(hook.states.some(state => state.settled)).toBe(false);
  resolveParagraph(currentParagraph);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
  for (const {options} of rendered(hook.entry()).lines) expect(options.paragraph?.widthPx).toBe(320);
});

test("changing title text keeps readiness pending until the new source paragraph arrives", async () => {
  const hook = mount();
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
  delayParagraphs = true;
  const text = "仅当前标题的段落测量可以完成布局";
  hook.setText(text);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: false, native: false});
  const current = pendingParagraphs.at(-1)!;
  expect(current.options.text.replaceAll("\n", "")).toBe(text);
  resolveParagraph(current);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
  expect(rendered(hook.entry()).lines.map(line => line.options.text).join("")).toBe(text);
});

test("missing native layout capability settles on fallback without issuing native requests", async () => {
  layoutSupported = false;
  const hook = mount();
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: false});
  expect(measurements).toHaveLength(0);
  expect(layouts).toHaveLength(0);
  expect(hook.entry().height).toBeGreaterThan(0);
});

test("measurement failure settles on fallback even when paragraph layout succeeds", async () => {
  failMeasurements = true;
  const hook = mount();
  await settle();
  expect(layouts.length).toBeGreaterThan(0);
  expect(hook.states.at(-1)).toEqual({settled: true, native: false});
  expect(hook.entry().height).toBeGreaterThan(0);
});

test("paragraph failure settles on fallback after successful title planning", async () => {
  failParagraphs = true;
  const hook = mount();
  await settle();
  expect(measurements.length).toBeGreaterThan(0);
  expect(hook.states.at(-1)).toEqual({settled: true, native: false});
  expect(rendered(hook.entry()).lines.every(line => line.options.paragraph === undefined)).toBe(true);
});

test("empty title planning can succeed synchronously without exposing premature paragraph readiness", async () => {
  delayParagraphs = true;
  const hook = mount();
  hook.setText("");
  await settle();
  expect(hook.states.some(state => state.settled)).toBe(false);
  const paragraph = pendingParagraphs.at(-1)!;
  expect(paragraph.options.text).toBe("");
  resolveParagraph(paragraph);
  await settle();
  expect(hook.states.at(-1)).toEqual({settled: true, native: true});
});

test("disposing a pending title suppresses all late settled callbacks", async () => {
  delayMeasurements = delayParagraphs = true;
  const hook = mount();
  await settle();
  const before = [...hook.states];
  hook.dispose();
  expect(pendingMeasurements.every(request => request.operation.cancelled)).toBe(true);
  expect(pendingParagraphs.every(request => request.operation.cancelled)).toBe(true);
  for (const request of pendingMeasurements) resolveMeasurement(request);
  for (const request of pendingParagraphs) resolveParagraph(request);
  await settle();
  expect(hook.states).toEqual(before);
});

test("entry settled callbacks do not subscribe layout work to the signals they read", async () => {
  const [probe, setProbe] = createSignal(0);
  const hook = mount(205, "#ffffff", () => {probe();});
  await settle();
  const before = {measurements: measurements.length, paragraphs: layouts.length, callbacks: hook.states.length};
  setProbe(1);
  await settle();
  expect({measurements: measurements.length, paragraphs: layouts.length, callbacks: hook.states.length}).toEqual(before);
});

test("planning settled callbacks are untracked and report native success only after measurement", async () => {
  delayMeasurements = true;
  const [probe, setProbe] = createSignal(0), states: ReaderTitleLayoutState[] = [];
  createRoot(dispose => {
    disposers.push(dispose);
    const preset = defaultReaderPreset(), font = () => ({});
    useReaderTitle(() => longTitle, () => 205, () => preset, () => font, "compose", state => {probe(); states.push({...state});});
  });
  await settle();
  expect(states).toEqual([{settled: false, native: false}]);
  setProbe(1);
  await settle();
  expect(pendingMeasurements).toHaveLength(1);
  expect(states).toEqual([{settled: false, native: false}]);
  delayMeasurements = false;
  resolveMeasurement(pendingMeasurements[0]!);
  await settle();
  expect(states).toEqual([{settled: false, native: false}, {settled: true, native: true}]);
});
