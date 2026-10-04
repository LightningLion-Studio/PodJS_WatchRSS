import {afterEach, expect, mock, spyOn, test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {inflateSync} from "node:zlib";
import {createComponent, createMemo, createRenderEffect, createRoot, createSignal, getOwner, mergeProps, onCleanup, runWithOwner, type Owner} from "solid-js";
import type {TextLayoutOptions} from "@podjs/framework/services";
import type {BeianScreenProps} from "../src/ui/BeianScreen.tsx";
import {beianQrPixels} from "../src/ui/beian-qr.ts";

// Match production Solid getters for all three real components. Only host and
// renderer boundaries are mocked; this suite runs in its own Bun subprocess.
const require = createRequire(import.meta.url);
const {transformSync} = require("@babel/core");
plugin({name: "beian-layout-solid-test", setup(builder) {
  builder.onLoad({filter: /\/(BeianScreen|BeianText|BeianQrSurface)\.tsx$/}, async args => ({
    contents: transformSync(await Bun.file(args.path).text(), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[require("babel-preset-solid"), {generate: "universal", moduleName: "@pocketjs/framework/renderer"}], [require("@babel/preset-typescript"), {isTSX: true, allExtensions: true}]],
    }).code,
    loader: "js",
  }));
}});

type Element = {kind: string; props: Record<string, unknown> & {children?: unknown; style?: Record<string, unknown>}};
const element = (kind: string) => (props: Element["props"]): Element => {
  const children = "children" in props ? createMemo(() => props.children) : undefined;
  return {kind, props: children ? mergeProps(props, {get children() {return children();}}) : props};
};
const writes: Array<{path: string; bytes: Uint8Array}> = [], removed: string[] = [];
const textRequests: TextLayoutOptions[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
const delays: Array<ReturnType<typeof deferred<void>> & {milliseconds: number; cancelled: boolean}> = [];
const stateRequests: Array<ReturnType<typeof deferred<{id: string; state: string; error?: string}>> & {kind: string; id: string}> = [];
const frameCallbacks = new Set<() => void>();
const defaultCapabilities = ["text.environment", "text.layout", "text.raster", "data.images", "data.files.chunks", "runtime.timer", "system.share"];
const capabilities = new Set(defaultCapabilities);
let sdkInt = 30, fontScale = 1.8, titleHeightPx = 73, subtitleHeightPx = 51, displayDensity = 2;
let sharingFailure = false, writeFailure = false, sharingRequests = 0, nextFile = 0;
mock.module("@pocketjs/framework/renderer", () => ({createComponent, mergeProps, memo: createMemo, effect: createRenderEffect}));
mock.module("@pocketjs/framework/components", () => ({View: element("View"), Text: element("Text")}));
mock.module("@pocketjs/framework/lifecycle", () => ({onFrame(callback: () => void) {
  frameCallbacks.add(callback);
  onCleanup(() => frameCallbacks.delete(callback));
}}));
mock.module("@podjs/framework/watch", () => ({
  getDisplayMetrics: () => ({logicalWidth: 233, logicalHeight: 233, physicalWidth: Math.round(233 * displayDensity), physicalHeight: Math.round(233 * displayDensity), density: displayDensity}),
  hasCapability: (name: string) => capabilities.has(name),
}));
mock.module("@podjs/framework/text", () => ({SystemTextLine: element("SystemTextLine")}));
mock.module("@podjs/framework/media-surface", () => ({MediaSurface: element("MediaSurface")}));
mock.module("@podjs/framework/services", () => ({
  sharing: {environment: async () => {
    sharingRequests++;
    if (sharingFailure || !capabilities.has("system.share")) throw Error("fixture environment unavailable");
    return {sdkInt};
  }},
  textLayout: {
    environment: async () => ({density: displayDensity, fontScale, spValuesPx: []}),
    layout(options: TextLayoutOptions) {
      textRequests.push({...options});
      const height = options.text === "工信部备案" ? titleHeightPx : subtitleHeightPx;
      return {result: Promise.resolve({lines: [{start: 0, end: options.text.length, visibleEnd: options.text.length, topPx: 7, bottomPx: 7 + height, baselinePx: 7 + height - 9}]}), cancel() {}};
    },
  },
  fileChunks: {
    async createTemp(directory: string) {return {path: `${directory}/.pod-write-layout-${++nextFile}.part`};},
    async write(path: string, base64: string) {
      if (writeFailure) throw Error("fixture QR write failed");
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      writes.push({path, bytes});
      return {size: bytes.length};
    },
    async remove(path: string) {removed.push(path);},
  },
  delay(milliseconds: number) {
    const request = {...deferred<void>(), milliseconds, cancelled: false};
    delays.push(request);
    // Like host completion, a pending timer can still arrive after cancel.
    return {result: request.promise, cancel() {request.cancelled = true;}};
  },
  mediaSurfaces: {state(kind: string, id: string) {
    const request = {...deferred<{id: string; state: string; error?: string}>(), kind, id};
    stateRequests.push(request);
    return request.promise;
  }},
}));

const {BeianScreen} = await import("../src/ui/BeianScreen.tsx");
const {beianColumnLayout} = await import("../src/ui/BeianText.tsx");
const disposers: Array<() => void> = [];
const restorers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  while (restorers.length) restorers.pop()!();
  writes.length = 0; removed.length = 0; textRequests.length = 0;
  delays.length = 0; stateRequests.length = 0;
  frameCallbacks.clear(); capabilities.clear(); defaultCapabilities.forEach(value => capabilities.add(value));
  sdkInt = 30; fontScale = 1.8; titleHeightPx = 73; subtitleHeightPx = 51; displayDensity = 2;
  sharingFailure = false; writeFailure = false; sharingRequests = 0; nextFile = 0;
});
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function visit(value: unknown): Element[] {
  if (typeof value === "function") return visit(value());
  if (Array.isArray(value)) return value.flatMap(visit);
  if (!value || typeof value !== "object" || !("kind" in value)) return [];
  const node = value as Element;
  return [node, ...visit(node.props.children)];
}
function children(value: unknown): Element[] {
  if (typeof value === "function") return children(value());
  if (Array.isArray(value)) return value.flatMap(children);
  if (!value || typeof value !== "object" || !("kind" in value)) return [];
  return [value as Element];
}
function pathTo(value: unknown, target: Element): Element[] | undefined {
  for (const node of children(value)) {
    if (node === target) return [node];
    const nested = pathTo(node.props.children, target);
    if (nested) return [node, ...nested];
  }
}
function mount(overrides: Partial<BeianScreenProps> = {}) {
  let tree: unknown, owner!: Owner, dispose!: () => void;
  createRoot(stop => {
    let stopped = false;
    dispose = () => {if (!stopped) {stopped = true; stop();}};
    disposers.push(dispose); owner = getOwner()!;
    tree = BeianScreen(mergeProps({width: 233, height: 233}, overrides));
  });
  return {
    nodes: () => runWithOwner(owner, () => visit(tree))!,
    children: () => runWithOwner(owner, () => children((tree as Element).props.children))!,
    path: (node: Element) => runWithOwner(owner, () => pathTo(tree, node)),
    dispose,
  };
}
function role(nodes: Element[], name: string) {
  const matches = nodes.filter(node => node.props.accessibilityRole === name);
  expect(matches, `one ${name} accessibility node`).toHaveLength(1);
  return matches[0]!;
}
function geometry(style: Element["props"]["style"]) {
  expect(style).toBeDefined();
  return {insetL: style!.insetL, insetT: style!.insetT, width: style!.width, height: style!.height};
}
function pixels(layout: ReturnType<typeof beianColumnLayout>, density = 2) {
  return Object.fromEntries(Object.entries(layout).map(([key, value]) => [key, value * density]));
}
function surface(nodes: Element[]) {
  const matches = nodes.filter(node => node.kind === "MediaSurface");
  expect(matches, "one native image surface").toHaveLength(1);
  expect(matches[0]!.props.textureSampling, "native source requests linear final sampling").toBe("linear");
  return matches[0]!;
}
type PresentationFrame = {leftPx: number; topPx: number; widthPx: number; heightPx: number; scale: number; opacity: number};
function presentation(node: Element): PresentationFrame {
  expect(node.props.style?.presentationFrame).toBeDefined();
  return node.props.style!.presentationFrame as PresentationFrame;
}
function pixelWrapper(mounted: ReturnType<typeof mount>, native: Element) {
  const path = mounted.path(native);
  expect(path, "surface is in the real screen tree").toBeDefined();
  expect(path!.length).toBeGreaterThanOrEqual(3);
  const wrapper = path![1]!;
  expect(mounted.children()).toContain(wrapper);
  expect(wrapper.kind).toBe("View");
  return wrapper;
}
function emitState(node: Element, state: string, error?: string, id = "image-fixture-1") {
  (node.props.onState as (value: {id: string; state: string; error?: string}) => void)({id, state, error});
}
function clock() {
  let now = 10_000;
  const mocked = spyOn(Date, "now").mockImplementation(() => now);
  restorers.push(() => mocked.mockRestore());
  return {frame(timeMs: number) {now = 10_000 + timeMs; for (const callback of frameCallbacks) callback();}};
}
function expectTextWithoutQr(nodes: Element[]) {
  expect(nodes.some(node => node.props.accessibilityRole === "image" || node.kind === "MediaSurface")).toBe(false);
  expect(geometry(role(nodes, "header").props.style)).toEqual({insetL: 18, insetT: 73.5, width: 197, height: 36.5});
  expect(geometry(role(nodes, "text").props.style)).toEqual({insetL: 18, insetT: 118, width: 197, height: 25.5});
}

// Fixed reference measurements: assertions do not calculate expectations with
// the layout helper or font conversion under test. All fixture values are px.
const rows = [
  {scale: 1, title: 49, subtitle: 28, top: 51, subtitleTop: 116, qrTop: 176, qrHeight: 240, outputTop: 156, outputHeight: 280, localTop: 20},
  {scale: 1.3, title: 57, subtitle: 37, top: 42, subtitleTop: 115, qrTop: 184, qrHeight: 240, outputTop: 164, outputHeight: 280, localTop: 20},
  {scale: 1.8, title: 73, subtitle: 51, top: 36, subtitleTop: 125, qrTop: 208, qrHeight: 222, outputTop: 190, outputHeight: 258, localTop: 18},
] as const;
for (const row of rows) test(`fontScale ${row.scale} preserves the native measured frame in the real screen`, async () => {
  fontScale = row.scale; titleHeightPx = row.title; subtitleHeightPx = row.subtitle;
  expect(pixels(beianColumnLayout(233, 233, 2, row.title, row.subtitle, true))).toEqual({
    left: 36, width: 394, titleTop: row.top, titleHeight: row.title,
    subtitleTop: row.subtitleTop, subtitleHeight: row.subtitle,
    qrLeft: 113, qrTop: row.qrTop, qrWidth: 240, qrHeight: row.qrHeight,
  });
  const mounted = mount();
  await settle();
  const nodes = mounted.nodes();
  expect(geometry(role(nodes, "header").props.style)).toEqual({insetL: 18, insetT: row.top / 2, width: 197, height: row.title / 2});
  expect(geometry(role(nodes, "text").props.style)).toEqual({insetL: 18, insetT: row.subtitleTop / 2, width: 197, height: row.subtitle / 2});
  expect(geometry(role(nodes, "image").props.style)).toEqual({insetL: 56.5, insetT: row.qrTop / 2, width: 120, height: row.qrHeight / 2});
  const lines = nodes.filter(node => node.kind === "SystemTextLine");
  expect(lines).toHaveLength(2);
  expect(lines.map(node => (node.props.options as {heightPx: number}).heightPx)).toEqual([row.title, row.subtitle]);
  expect(lines.every(node => node.props.pixelScale === 2)).toBe(true);
  expect(textRequests.map(value => value.widthPx)).toEqual([394, 394]);
  const native = surface(nodes);
  expect(native.props).toMatchObject({kind: "image", widthPx: 280, heightPx: row.outputHeight, pixelScale: 2, style: {fit: "fit"}});
  expect(presentation(native)).toEqual({leftPx: 20, topPx: row.localTop, widthPx: 240, heightPx: row.qrHeight, scale: 1.16, opacity: .12});
  expect(geometry(pixelWrapper(mounted, native).props.style)).toEqual({insetL: 46.5, insetT: row.outputTop / 2, width: 140, height: row.outputHeight / 2});
});

test("short viewports constrain each child and spacer in native Column order", () => {
  const constrained = [
    {height: 100, titleHeight: 28, subtitleTop: 64, subtitleHeight: 0, qrTop: 64, qrHeight: 0},
    {height: 120, titleHeight: 43, subtitleTop: 84, subtitleHeight: 0, qrTop: 84, qrHeight: 0},
    {height: 140, titleHeight: 43, subtitleTop: 95, subtitleHeight: 9, qrTop: 104, qrHeight: 0},
    {height: 160, titleHeight: 43, subtitleTop: 95, subtitleHeight: 25, qrTop: 124, qrHeight: 0},
    {height: 200, titleHeight: 43, subtitleTop: 95, subtitleHeight: 25, qrTop: 152, qrHeight: 12},
  ];
  for (const row of constrained) {
    expect(pixels(beianColumnLayout(233, row.height / 2, 2, 43, 25, true)), `physical height ${row.height}`).toEqual({
      left: 36, width: 394, titleTop: 36, titleHeight: row.titleHeight,
      subtitleTop: row.subtitleTop, subtitleHeight: row.subtitleHeight,
      qrLeft: 113, qrTop: row.qrTop, qrWidth: 240, qrHeight: row.qrHeight,
    });
  }
});

test("the QR size threshold and column centering round on physical pixels", () => {
  for (const [height, top, qrHeight] of [[427, 36, 239], [428, 36, 240], [429, 37, 240]]) {
    expect(pixels(beianColumnLayout(233, height! / 2, 2, 43, 25, true))).toMatchObject({titleTop: top, qrHeight});
  }
  for (const [width, qrLeft, qrWidth] of [[311, 36, 239], [312, 36, 240], [313, 37, 240]]) {
    expect(pixels(beianColumnLayout(width! / 2, 233, 2, 43, 25, true))).toMatchObject({qrLeft, qrWidth});
  }
});

test("narrow and smaller-than-padding viewports clamp both QR axes independently", () => {
  expect(pixels(beianColumnLayout(100, 233, 2, 43, 25, true))).toEqual({
    left: 36, width: 128, titleTop: 55, titleHeight: 43,
    subtitleTop: 114, subtitleHeight: 25, qrLeft: 36, qrTop: 171, qrWidth: 128, qrHeight: 240,
  });
  expect(pixels(beianColumnLayout(35, 35, 2, 43, 25, true))).toEqual({
    left: 36, width: 0, titleTop: 36, titleHeight: 0,
    subtitleTop: 36, subtitleHeight: 0, qrLeft: 36, qrTop: 36, qrWidth: 0, qrHeight: 0,
  });
});

test("missing QR keeps the native final spacer while removing the requested QR size", () => {
  expect(pixels(beianColumnLayout(233, 233, 2, 43, 25, false))).toEqual({
    left: 36, width: 394, titleTop: 175, titleHeight: 43,
    subtitleTop: 234, subtitleHeight: 25, qrLeft: 233, qrTop: 291, qrWidth: 0, qrHeight: 0,
  });
});

test("a narrow real screen keeps the rectangular frame and asks the native image surface to Fit its square source", async () => {
  fontScale = 1; titleHeightPx = 43; subtitleHeightPx = 25;
  const mounted = mount({width: 100});
  await settle();
  const nodes = mounted.nodes();
  expect(geometry(role(nodes, "image").props.style)).toEqual({insetL: 18, insetT: 85.5, width: 64, height: 120});
  const native = surface(nodes);
  expect(native.props).toMatchObject({widthPx: 150, heightPx: 280, pixelScale: 2, style: {fit: "fit"}});
  expect(presentation(native)).toEqual({leftPx: 11, topPx: 20, widthPx: 128, heightPx: 240, scale: 1.16, opacity: .12});
  expect(geometry(pixelWrapper(mounted, native).props.style)).toEqual({insetL: 12.5, insetT: 75.5, width: 75, height: 140});
  expect(textRequests.map(value => value.widthPx)).toEqual([128, 128]);
});

for (const fixture of [
  {name: "225px QR width at an exact maximum-scale padding boundary", density: 2, width: 148.5, height: 233,
    qr: {leftPx: 36, topPx: 208, widthPx: 225, heightPx: 222},
    output: {leftPx: 18, topPx: 190, widthPx: 261, heightPx: 258}, localLeft: 18, localTop: 18},
  {name: "odd physical screen and QR height", density: 2, width: 233.5, height: 233.5,
    qr: {leftPx: 114, topPx: 208, widthPx: 240, heightPx: 223},
    output: {leftPx: 94, topPx: 190, widthPx: 280, heightPx: 259}, localLeft: 20, localTop: 18},
  {name: "noninteger density", density: 1.75, width: 233, height: 233,
    qr: {leftPx: 99, topPx: 198, widthPx: 210, heightPx: 178},
    output: {leftPx: 82, topPx: 183, widthPx: 244, heightPx: 208}, localLeft: 17, localTop: 15},
]) test(`${fixture.name} preserves integer output bounds and the QR center at maximum scale`, async () => {
  displayDensity = fixture.density;
  const mounted = mount({width: fixture.width, height: fixture.height});
  await settle();
  const nodes = mounted.nodes(), native = surface(nodes), frame = presentation(native);
  expect(geometry(role(nodes, "image").props.style)).toEqual({
    insetL: fixture.qr.leftPx / fixture.density, insetT: fixture.qr.topPx / fixture.density,
    width: fixture.qr.widthPx / fixture.density, height: fixture.qr.heightPx / fixture.density,
  });
  expect(native.props).toMatchObject({widthPx: fixture.output.widthPx, heightPx: fixture.output.heightPx, pixelScale: fixture.density});
  expect(geometry(pixelWrapper(mounted, native).props.style)).toEqual({
    insetL: fixture.output.leftPx / fixture.density, insetT: fixture.output.topPx / fixture.density,
    width: fixture.output.widthPx / fixture.density, height: fixture.output.heightPx / fixture.density,
  });
  expect(frame).toEqual({leftPx: fixture.localLeft, topPx: fixture.localTop, widthPx: fixture.qr.widthPx, heightPx: fixture.qr.heightPx, scale: 1.16, opacity: .12});
  expect([native.props.widthPx, native.props.heightPx].every(Number.isInteger)).toBe(true);
  expect(frame.leftPx + frame.widthPx / 2).toBe(fixture.output.widthPx / 2);
  expect(frame.topPx + frame.heightPx / 2).toBe(fixture.output.heightPx / 2);
  expect(fixture.output.leftPx + frame.leftPx).toBe(fixture.qr.leftPx);
  expect(fixture.output.topPx + frame.topPx).toBe(fixture.qr.topPx);
  // Scale 29/25 adds 2/25 of the unscaled dimension at each edge. Each
  // separately rounded output edge must retain less than one spare pixel.
  for (const slack of [frame.leftPx - 2 * frame.widthPx / 25, frame.topPx - 2 * frame.heightPx / 25]) {
    expect(slack).toBeGreaterThanOrEqual(0);
    expect(slack).toBeLessThan(1);
  }
});

test("the fixed root-level pixel output has no ancestor transform and never resizes during the native animation", async () => {
  const timer = clock(), mounted = mount();
  await settle();
  const nodes = mounted.nodes(), native = surface(nodes), semantic = role(nodes, "image"), wrapper = pixelWrapper(mounted, native);
  const rootChildren = mounted.children();
  expect(rootChildren).toContain(semantic);
  expect(children(semantic.props.children)).toHaveLength(0);
  expect(String(semantic.props.class)).not.toMatch(/\bbg-/);
  expect(wrapper).not.toBe(semantic);
  expect(rootChildren.indexOf(wrapper)).toBeGreaterThan(rootChildren.indexOf(role(nodes, "header")));
  expect(rootChildren.indexOf(wrapper)).toBeGreaterThan(rootChildren.indexOf(role(nodes, "text")));
  const outputGeometry = {insetL: 46.5, insetT: 95, width: 140, height: 129};
  expect(geometry(wrapper.props.style)).toEqual(outputGeometry);
  for (const ancestor of mounted.path(native)!) {
    expect(ancestor.props.style?.scale).toBeUndefined();
    expect(ancestor.props.style?.opacity).toBeUndefined();
    expect(String(ancestor.props.class)).not.toMatch(/(?:^|\s)(?:scale|opacity)-/);
  }
  emitState(native, "ready");
  for (const elapsed of [0, 250, 992, 1650]) {
    timer.frame(elapsed);
    const current = surface(mounted.nodes()), frame = presentation(current);
    expect(current).toBe(native);
    expect(pixelWrapper(mounted, current)).toBe(wrapper);
    expect(geometry(wrapper.props.style)).toEqual(outputGeometry);
    expect(current.props).toMatchObject({widthPx: 280, heightPx: 258});
    expect(frame).toMatchObject({leftPx: 20, topPx: 18, widthPx: 240, heightPx: 222});
    expect(frame.scale).toBe(semantic.props.style!.scale as number);
    expect(frame.opacity).toBe(semantic.props.style!.opacity as number);
    if (elapsed === 992) {
      expect(frame.opacity).toBe(1);
      expect(frame.scale).toBeGreaterThan(1);
      expect(frame.scale).toBeLessThan(1.16);
    }
    const halfWidth = frame.widthPx * frame.scale / 2, halfHeight = frame.heightPx * frame.scale / 2;
    expect(frame.leftPx + frame.widthPx / 2 - halfWidth).toBeGreaterThanOrEqual(0);
    expect(frame.leftPx + frame.widthPx / 2 + halfWidth).toBeLessThanOrEqual(280);
    expect(frame.topPx + frame.heightPx / 2 - halfHeight).toBeGreaterThanOrEqual(0);
    expect(frame.topPx + frame.heightPx / 2 + halfHeight).toBeLessThanOrEqual(258);
  }
  expect(presentation(native).opacity).toBe(1);
  expect(presentation(native).scale).toBeCloseTo(1, 12);
  expect(writes).toHaveLength(1);
  expect(removed).toHaveLength(0);
  expect(delays).toHaveLength(0);
});

test("changing available height recreates the image surface without rewriting its source PNG", async () => {
  const [height, setHeight] = createSignal(233);
  const mounted = mount({get height() {return height();}});
  await settle();
  expect(geometry(role(mounted.nodes(), "image").props.style)).toEqual({insetL: 56.5, insetT: 104, width: 120, height: 111});
  const original = surface(mounted.nodes());
  expect(original.props).toMatchObject({widthPx: 280, heightPx: 258});
  expect(writes).toHaveLength(1);
  setHeight(210);
  await settle();
  expect(geometry(role(mounted.nodes(), "image").props.style)).toEqual({insetL: 56.5, insetT: 104, width: 120, height: 88});
  expect(surface(mounted.nodes())).not.toBe(original);
  expect(surface(mounted.nodes()).props).toMatchObject({widthPx: 280, heightPx: 206});
  expect(presentation(surface(mounted.nodes()))).toMatchObject({leftPx: 20, topPx: 15, widthPx: 240, heightPx: 176});
  expect(writes).toHaveLength(1);
  expect(removed).toHaveLength(0);
});

test("resizing isolates the new surface from an old pending state failure and cancelled deadline", async () => {
  const timer = clock(), [height, setHeight] = createSignal(233);
  const mounted = mount({get height() {return height();}});
  await settle();
  const oldSurface = surface(mounted.nodes());
  emitState(oldSurface, "loading", undefined, "image-old");
  expect(delays.map(value => value.milliseconds)).toEqual([5000, 16]);
  const oldDeadline = delays[0]!;
  delays[1]!.resolve();
  await settle();
  expect(stateRequests).toHaveLength(1);
  expect(stateRequests[0]).toMatchObject({kind: "image", id: "image-old"});

  setHeight(210);
  await settle();
  const newSurface = surface(mounted.nodes());
  expect(newSurface).not.toBe(oldSurface);
  expect(newSurface.props).toMatchObject({widthPx: 280, heightPx: 206});
  expect(presentation(newSurface)).toMatchObject({leftPx: 20, topPx: 15, widthPx: 240, heightPx: 176});
  expect(oldDeadline.cancelled).toBe(true);
  emitState(newSurface, "loading", undefined, "image-new");
  expect(delays.map(value => value.milliseconds)).toEqual([5000, 16, 5000, 16]);
  delays[3]!.resolve();
  await settle();
  expect(stateRequests).toHaveLength(2);
  expect(stateRequests[1]).toMatchObject({kind: "image", id: "image-new"});

  stateRequests[0]!.reject(Error("unknown_surface"));
  oldDeadline.resolve();
  await settle();
  expect(surface(mounted.nodes())).toBe(newSurface);
  expect(geometry(role(mounted.nodes(), "image").props.style)).toEqual({insetL: 56.5, insetT: 104, width: 120, height: 88});
  expect(delays[2]!.cancelled).toBe(false);
  expect(writes).toHaveLength(1);
  expect(removed).toHaveLength(0);

  stateRequests[1]!.resolve({id: "image-new", state: "ready"});
  await settle();
  expect(delays[2]!.cancelled).toBe(true);
  timer.frame(0); timer.frame(250);
  expect(Math.abs((role(mounted.nodes(), "image").props.style!.opacity as number) - native250.alpha)).toBeLessThan(.00002);
  expect(surface(mounted.nodes())).toBe(newSurface);
  mounted.dispose();
  await settle();
  expect(removed).toEqual([writes[0]!.path]);
});

for (const api of [30, 31]) test(`API ${api} preserves the 240px PNG source and sends distinct native color stages with its supported blur`, async () => {
  sdkInt = api;
  const mounted = mount();
  await settle();
  const nodes = mounted.nodes(), native = surface(nodes), qr = role(nodes, "image");
  expect(geometry(qr.props.style)).toEqual({insetL: 56.5, insetT: 104, width: 120, height: 111});
  expect(qr.props.style).toMatchObject({opacity: .12, scale: 1.16});
  expect(native.props).toMatchObject({kind: "image", widthPx: 280, heightPx: 258, pixelScale: 2, style: {
    fit: "fit", blurPx: api >= 31 ? 36 : 0, blurEdgeMode: "clamp", brightness: 1,
    brightnessBias: 58 / 255, saturation: 1, colorArgb: 0xff000000,
    overlayColorArgb: 0xffffffff, overlayOpacity: .24, active: true,
  }});
  expect(presentation(native)).toEqual({leftPx: 20, topPx: 18, widthPx: 240, heightPx: 222, scale: 1.16, opacity: .12});
  expect(sharingRequests).toBe(1);
  expect(writes).toHaveLength(1);
  expect(native.props.path).toBe(writes[0]!.path);
  const png = writes[0]!.bytes, view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([240, 240, 1, 0]);
  const scanlines = inflateSync(png.subarray(41, 41 + view.getUint32(33)));
  expect(scanlines.length).toBe(31 * 240);
  const actual: Uint8Array = new Uint8Array(240 * 240 * 4);
  for (let y = 0; y < 240; y++) {
    expect(scanlines[y * 31]).toBe(0);
    for (let x = 0; x < 240; x++) {
      const gray = scanlines[y * 31 + 1 + (x >>> 3)]! & (1 << (7 - (x & 7))) ? 255 : 0;
      const offset = (y * 240 + x) * 4;
      actual[offset] = actual[offset + 1] = actual[offset + 2] = gray; actual[offset + 3] = 255;
    }
  }
  expect(actual).toEqual(beianQrPixels(240));
  mounted.dispose();
  await settle();
  expect(removed).toEqual([writes[0]!.path]);
});

// Independent high-precision Bezier inversion of QrCodePanel's native curves
// at 250ms. These constants are not calculated with BeianScreen's easing code.
const native250 = {
  alpha: .6347001402523769, scale: 1.1463831229431118,
  brightnessBias: .20451273040138905, overlayOpacity: .21350563690663498,
  blurPx: 33.56717921614449,
  gray133: 126.98062071760803, gray220: 161.8485357643561,
  gutter: 34.55557471077514,
};
for (const api of [30, 31]) test(`API ${api} starts only when the bitmap is ready and preserves native animation parameters at 250ms`, async () => {
  sdkInt = api;
  const timer = clock(), mounted = mount();
  await settle();
  const native = surface(mounted.nodes()), qr = role(mounted.nodes(), "image");
  timer.frame(0); timer.frame(1000);
  expect(qr.props.style?.opacity).toBe(.12);
  expect(presentation(native).opacity).toBe(.12);
  expect(native.props.style?.brightnessBias).toBe(58 / 255);
  emitState(native, "ready");
  timer.frame(1000); timer.frame(1250);
  expect(Math.abs((qr.props.style!.opacity as number) - native250.alpha)).toBeLessThan(.00002);
  expect(Math.abs((qr.props.style!.scale as number) - native250.scale)).toBeLessThan(.000002);
  expect(presentation(native).opacity).toBe(qr.props.style!.opacity as number);
  expect(presentation(native).scale).toBe(qr.props.style!.scale as number);
  const style = native.props.style!;
  expect(style.brightness).toBe(1);
  expect(Math.abs((style.brightnessBias as number) - native250.brightnessBias)).toBeLessThan(.00002);
  expect(Math.abs((style.overlayOpacity as number) - native250.overlayOpacity)).toBeLessThan(.00002);
  if (api >= 31) expect(Math.abs((style.blurPx as number) - native250.blurPx)).toBeLessThan(.001);
  else expect(style.blurPx).toBe(0);
  expect(writes).toHaveLength(1);
  // A repeated ready notification must not restart entry animation.
  emitState(native, "ready"); timer.frame(2650);
  expect(qr.props.style?.opacity).toBe(1);
  expect(qr.props.style?.scale).toBeCloseTo(1, 12);
  expect(presentation(native)).toMatchObject({opacity: 1});
  expect(presentation(native).scale).toBeCloseTo(1, 12);
  expect(native.props.style).toMatchObject({brightness: 1, brightnessBias: 0, overlayOpacity: 0, blurPx: 0});
});

test("the API 30 color-stage contract clamps grayscale before Screen and gives Fit gutters only the white overlay", async () => {
  const timer = clock(), mounted = mount();
  await settle();
  const native = surface(mounted.nodes());
  emitState(native, "ready"); timer.frame(0); timer.frame(250);
  const style = native.props.style!, alpha = presentation(native).opacity;
  expect(style).toMatchObject({brightness: 1, colorArgb: 0xff000000, overlayColorArgb: 0xffffffff, blurPx: 0});
  const bias = style.brightnessBias as number, overlay = style.overlayOpacity as number;
  // Evaluate the native host contract from the actual component parameters.
  // GPU sampling/blur are verified in the SDK suite; this no-blur scalar check
  // distinguishes additive+clamp from the removed affine binary approximation.
  const sourceColor = (gray: number) => {
    const biased = Math.min(1, gray / 255 * (style.brightness as number) + bias);
    return alpha * (biased + (1 - biased) * overlay) * 255;
  };
  expect(Math.abs(sourceColor(133) - native250.gray133)).toBeLessThan(.01);
  expect(Math.abs(sourceColor(220) - native250.gray220)).toBeLessThan(.01);
  expect(sourceColor(220)).toBe(alpha * 255);
  // Fit's unpainted 9px gutters have no source sample and therefore no image
  // ColorMatrix bias. Black background plus white Screen is alpha*overlay.
  const gutterColor = alpha * overlay * 255;
  expect(Math.abs(gutterColor - native250.gutter)).toBeLessThan(.01);
  expect(sourceColor(0) - gutterColor).toBeGreaterThan(20);
});

test("a source initialization failure removes only the QR and cleans the owned temporary file", async () => {
  writeFailure = true;
  const mounted = mount();
  await settle();
  expectTextWithoutQr(mounted.nodes());
  expect(writes).toHaveLength(0);
  expect(removed).toEqual(["beian-qr/.pod-write-layout-1.part"]);
});

test("a native surface initialization error releases its source and ignores a late ready notification", async () => {
  const mounted = mount();
  await settle();
  const native = surface(mounted.nodes());
  (native.props.onError as (error: Error) => void)(Error("fixture texture sampling mismatch"));
  await settle();
  expectTextWithoutQr(mounted.nodes());
  expect(removed).toEqual([writes[0]!.path]);
  emitState(native, "ready");
  await settle();
  expectTextWithoutQr(mounted.nodes());
  expect(removed).toHaveLength(1);
});

test("missing image capabilities do not create a QR source or query the sharing environment", async () => {
  for (const missing of ["data.images", "data.files.chunks", "runtime.timer"]) {
    capabilities.delete(missing);
    const mounted = mount();
    await settle();
    expectTextWithoutQr(mounted.nodes());
    expect(writes).toHaveLength(0);
    expect(sharingRequests).toBe(0);
    mounted.dispose(); capabilities.add(missing);
  }
});

test("unsupported or invalid Android versions do not create a QR source", async () => {
  for (const version of [29, 30.5, NaN]) {
    sdkInt = version;
    const mounted = mount();
    await settle();
    expectTextWithoutQr(mounted.nodes());
    expect(writes).toHaveLength(0);
    mounted.dispose();
  }
});

for (const unavailable of ["environment rejection", "missing system.share"]) test(`${unavailable} preserves the QR with the API 30 no-blur baseline`, async () => {
  sdkInt = 31;
  if (unavailable === "environment rejection") sharingFailure = true;
  else capabilities.delete("system.share");
  const mounted = mount();
  await settle();
  expect(geometry(role(mounted.nodes(), "image").props.style)).toEqual({insetL: 56.5, insetT: 104, width: 120, height: 111});
  const native = surface(mounted.nodes());
  expect(native.props).toMatchObject({kind: "image", widthPx: 280, heightPx: 258, style: {fit: "fit", blurPx: 0, brightness: 1, brightnessBias: 58 / 255, overlayOpacity: .24}});
  expect(presentation(native)).toEqual({leftPx: 20, topPx: 18, widthPx: 240, heightPx: 222, scale: 1.16, opacity: .12});
  expect(sharingRequests).toBe(1);
  expect(writes).toHaveLength(1);
  expect(removed).toHaveLength(0);
});
