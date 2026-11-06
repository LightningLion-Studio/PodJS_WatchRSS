import {afterEach, expect, mock, test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {createComponent, createEffect, createMemo, createRenderEffect, createRoot, createSignal, getOwner, mergeProps, onCleanup, runWithOwner, type Owner} from "solid-js";
import * as solidRuntime from "solid-js";
import type {TextLayoutOptions} from "@podjs/framework/services";
import type {SystemTextLineOptions} from "@podjs/framework/text";
import type {InformationListAnchor} from "../src/ui/information-anchor.ts";
import type {InformationDocumentHandle, InformationDocumentProps} from "../src/ui/InformationDocument.tsx";
import type {InformationRef, InformationScreenProps, InformationSnapshot} from "../src/ui/InformationScreens.tsx";
import {defaultReaderPreset} from "../src/reader/preset.ts";
import {informationText} from "../src/ui/information-data.ts";

// Compile the real screen using production-style Solid getters. Every mock is
// a renderer/service boundary; the screen's effects and ownership remain real.
const require = createRequire(import.meta.url);
const {transformSync} = require("@babel/core");
const linkedSolidRuntimePath = fileURLToPath(import.meta.resolve("solid-js", fileURLToPath(import.meta.resolve("@pocketjs/framework/kinetics"))));
mock.module(linkedSolidRuntimePath, () => solidRuntime);
plugin({name: "information-screen-solid-test", setup(builder) {
  builder.onLoad({filter: /\/InformationScreens\.tsx$/}, async args => ({
    contents: transformSync(await Bun.file(args.path).text(), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[require("babel-preset-solid"), {generate: "universal", moduleName: "@pocketjs/framework/renderer"}], [require("@babel/preset-typescript"), {isTSX: true, allExtensions: true}]],
    }).code,
    loader: "js",
  }));
}});

type Element = {kind: string; props: Record<string, unknown> & {children?: unknown; style?: Record<string, unknown>}};
const element = (kind: string) => (props: Element["props"]): Element => {
  // The host renderer consumes a View's reactive children under its owner.
  // Cache that computation so inspecting the test tree does not instantiate
  // a fresh nested Show/component subtree on each traversal.
  const children = "children" in props ? createMemo(() => props.children) : undefined;
  return {kind, props: children ? mergeProps(props, {get children() {return children();}}) : props};
};
mock.module("@pocketjs/framework/renderer", () => ({createComponent, mergeProps, memo: createMemo, effect: createRenderEffect}));
mock.module("@pocketjs/framework/components", () => ({View: element("View"), Text: element("Text")}));
mock.module("@podjs/framework/text", () => ({SystemTextLine: element("SystemTextLine")}));
mock.module("@podjs/framework/watch", () => ({
  getDisplayMetrics: () => ({logicalWidth: 233, logicalHeight: 233, physicalWidth: 466, physicalHeight: 466, density: 1.75}),
  hasCapability: (name: string) => ["text.environment", "text.layout", "text.raster"].includes(name),
}));
mock.module("../src/ui/ScrollEntries.tsx", () => ({ScrollEntries: element("ScrollEntries")}));
mock.module("../src/ui/SafeQrScreen.tsx", () => ({SafeQrScreen: element("SafeQrScreen")}));
mock.module("../src/ui/BeianScreen.tsx", () => ({BeianScreen: element("BeianScreen")}));
mock.module("../src/ui/WatchProgressIndicator.tsx", () => ({WatchProgressIndicator: element("WatchProgressIndicator")}));

const frameHooks = new Set<() => void>();
mock.module("@pocketjs/framework/lifecycle", () => ({onFrame: (callback: () => void) => {
  frameHooks.add(callback); onCleanup(() => frameHooks.delete(callback));
}}));
const frame = () => {for (const callback of [...frameHooks]) callback();};
const microtasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const nativeRequests: TextLayoutOptions[] = [];
const nativeMeasurements: Array<{text: string; fontSizePx: number; fontAsset?: string; fontWeight?: number; textMotion?: string}> = [];
const retryIntrinsicWidthPx = 150.25;
mock.module("@podjs/framework/services", () => ({textLayout: {
  environment: async () => ({density: 1.75, fontScale: 1.3, spValuesPx: []}),
  measure: (options: (typeof nativeMeasurements)[number]) => {
    nativeMeasurements.push({...options});
    return {result: Promise.resolve({widthPx: retryIntrinsicWidthPx}), cancel() {}};
  },
  layout: (options: TextLayoutOptions) => {
    nativeRequests.push({...options});
    const split = options.text.length > 16 ? 16 : options.text.length;
    const lines = [{start: 0, end: split, visibleEnd: split, topPx: 0, bottomPx: 35, baselinePx: 28}];
    if (split < options.text.length) lines.push({start: split, end: options.text.length, visibleEnd: options.text.length, topPx: 35, bottomPx: 69, baselinePx: 61});
    return {result: Promise.resolve({lines}), cancel() {}};
  },
}}));

interface LegalRequest {url: string; cancelled: boolean; resolve: (content: string) => void; reject: (error: Error) => void}
const requests: LegalRequest[] = [];
mock.module("../src/onboarding/legal-document.ts", () => ({fetchLegalDocument: (url: string) => {
  let resolve!: LegalRequest["resolve"], reject!: LegalRequest["reject"];
  const result = new Promise<string>((accept, fail) => {resolve = accept; reject = fail;});
  const request = {url, cancelled: false, resolve, reject};
  requests.push(request);
  // Host completion may race cancellation. The screen must reject late results.
  return {result, cancel() {request.cancelled = true;}};
}}));

const {createScroller} = await import("@pocketjs/framework/kinetics");
interface DocumentMount {props: InformationDocumentProps; handle: InformationDocumentHandle; setOffset: (offset: number) => void; initialAnchor?:InformationListAnchor; initialOffset?:number; disposed: boolean}
const documents: DocumentMount[] = [];
mock.module("../src/ui/InformationDocument.tsx", () => ({InformationDocument: (props: InformationDocumentProps) => {
  const initialAnchor = props.restoredListAnchor, initialOffset = props.restoredScrollOffsetPx;
  const [offset, setRawOffset] = createSignal(initialOffset ?? (initialAnchor ? initialAnchor.index * 100 + initialAnchor.offsetPx : 0));
  const [anchor, setAnchor] = createSignal<InformationListAnchor>(initialAnchor ?? {index:0,offsetPx:0});
  const setOffset = (value:number) => {setRawOffset(value);setAnchor({index:Math.floor(value/100),offsetPx:value%100});};
  const handle: InformationDocumentHandle = {
    scroller: createScroller({max: () => 10_000, extent: () => props.height}),
    ready: () => false,
    scrollOffsetPx: offset,
    restoreScrollOffsetPx: setOffset,
    listAnchor:anchor,
    restoreListAnchor(value) {setAnchor(value);setRawOffset(value.index*100+value.offsetPx);},
  };
  const document = {props, handle, setOffset, initialAnchor, initialOffset, disposed: false};
  documents.push(document);
  onCleanup(() => {document.disposed = true;props.onDispose?.(handle);});
  props.ref?.(handle);
  createEffect(() => props.onScrollOffsetChange?.(offset()));
  return {kind: "InformationDocument", props};
}}));

const {InformationScreen} = await import("../src/ui/InformationScreens.tsx");
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  documents.length = 0; requests.length = 0; nativeRequests.length = 0; nativeMeasurements.length = 0;
});
const settle = async () => {await microtasks();frame();await microtasks();};
const state = (content:string|null,error:string|null,scrollOffset=0,isLoading=content===null&&error===null,reloadKey=0,listAnchor:InformationListAnchor|null=content===null?null:{index:Math.floor(scrollOffset/100),offsetPx:scrollOffset%100}):InformationSnapshot => ({content,error,scrollOffset,isLoading,reloadKey,listAnchor});
const failure = "协议正文加载失败，请检查网络后重试。";

function visit(value: unknown): Element[] {
  if (typeof value === "function") return visit(value());
  if (Array.isArray(value)) return value.flatMap(visit);
  if (!value || typeof value !== "object" || !("kind" in value)) return [];
  const node = value as Element;
  return [node, ...visit(node.props.children)];
}
function textIn(value: unknown): string {
  if (typeof value === "function") return textIn(value());
  if (Array.isArray(value)) return value.map(textIn).join("");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || !("kind" in value)) return "";
  const node = value as Element;
  return String(node.props.accessibilityLabel ?? "") + String((node.props.options as SystemTextLineOptions | undefined)?.text ?? "") + textIn(node.props.children);
}
function mount(overrides: Partial<InformationScreenProps> = {}) {
  let tree: unknown, owner!: Owner, dispose!: () => void, ref: Parameters<InformationRef>[0] | undefined;
  const snapshots: InformationSnapshot[] = [], navigation: string[] = [], events:string[] = [];
  const input: InformationScreenProps = {
    width: 233, height: 233, page: "privacy", legalBaseUrl: "https://legal.example.test/",
    preset: defaultReaderPreset(), fonts: () => ({fontPath: "reader/fonts/custom.ttf", fontFaceIndex: 1}),
    backgroundSnapshot: {state: {}, revision: 3}, active: () => true, accessibilityLabel: "协议正文",
    onNavigate: page => navigation.push(page), onSnapshotChange: snapshot => snapshots.push({...snapshot}),
    onRestorationEvent:event => events.push(event),
    ref: value => {ref = value;}, ...overrides,
  };
  createRoot(stop => {dispose = stop; disposers.push(stop); owner = getOwner()!; tree = InformationScreen(input);});
  const nodes = () => runWithOwner(owner, () => visit(tree))!;
  const snapshot = () => {expect(ref?.snapshot).toBeFunction(); return ref!.snapshot!();};
  return {input, nodes, snapshot, snapshots, navigation, events, dispose, ref: () => ref, owner};
}
function renderedDocument(mounted: ReturnType<typeof mount>) {
  expect(mounted.nodes().filter(node => node.kind === "InformationDocument")).toHaveLength(1);
  const document = [...documents].reverse().find(value => !value.disposed);
  expect(document).toBeDefined();
  return document!;
}
function retry(mounted: ReturnType<typeof mount>) {
  const control = runWithOwner(mounted.owner, () => mounted.nodes().find(node => typeof node.props.onPress === "function" && /重试|重新加载/.test(textIn(node))))!;
  expect(control, "visible retry control").toBeDefined();
  (control!.props.onPress as () => void)();
}

test("remote loading shows a black spinner without a title, list or success document", async () => {
  const mounted = mount();
  await settle();
  const nodes = mounted.nodes();
  expect(requests.map(request => request.url)).toEqual(["https://legal.example.test/functions/v1/legal/watch/privacy-policy"]);
  expect(nodes.filter(node => node.kind === "WatchProgressIndicator")).toHaveLength(1);
  expect(nodes.some(node => node.kind === "View" && String(node.props.class).includes("bg-black"))).toBe(true);
  expect(nodes.some(node => ["ScrollEntries", "InformationDocument", "SystemTextLine", "Text"].includes(node.kind))).toBe(false);
  expect(mounted.snapshot()).toEqual(state(null,null));
  expect(mounted.ref()!.scroller.offset()).toBe(0);
});

test("failure uses native typography and centered natural geometry before retry cancels the old request", async () => {
  const mounted = mount();
  requests[0]!.reject(Error("offline fixture"));
  await settle(); await settle();
  const nodes = mounted.nodes();
  expect(nodes.some(node => node.kind === "InformationDocument" || node.kind === "ScrollEntries" || node.kind === "WatchProgressIndicator")).toBe(false);
  const messageRequest = nativeRequests.find(options => options.text === failure)!;
  const labelRequest = nativeRequests.find(options => options.text === "重新加载")!;
  const nativeFontSize = Math.fround(37.6); // Compose 14sp at fixed Info density 2 and fontScale 1.3.
  expect(messageRequest).toMatchObject({widthPx: 370, align: "center", fontWeight: 400, fontSizePx: nativeFontSize});
  expect(nativeMeasurements).toEqual([{text: "重新加载", fontWeight: 400, fontSizePx: nativeFontSize, textMotion: "static"}]);
  expect(labelRequest).toMatchObject({widthPx: 151, align: "left", fontSizePx: nativeFontSize});
  const message = nodes.find(node => node.props.accessibilityLabel === failure)!;
  const control = nodes.find(node => node.props.accessibilityRole === "button" && node.props.accessibilityLabel === "重新加载")!;
  // Native host replies: two message lines total 69px, one label line 35px.
  // Coordinates are logical units; multiplying by renderScale 2 gives the
  // independent 466px reference column: top135, gap32, touchTop236, touch96.
  expect(message.props.style).toEqual({insetL: 24, insetT: 67.5, width: 185, height: 34.5});
  expect(control.props.style).toEqual({insetL: 24, insetT: 118, width: 185, height: 48});
  const controlNodes = runWithOwner(mounted.owner, () => visit(control))!;
  const buttonBackground = controlNodes.find(node => String(node.props.class).includes("bg-[#23272a]"))!;
  expect(buttonBackground.props.style).toEqual({insetT: 4, height: 40});
  const labelBox = controlNodes.find(node => node.props.style?.width === 75.5)!;
  expect(labelBox.props.style).toEqual({insetL: 55, insetT: 15.5, width: 75.5, height: 17.5});
  const lines = nodes.filter(node => node.kind === "SystemTextLine");
  expect(lines).toHaveLength(3);
  expect(lines.map(node => (node.props.options as SystemTextLineOptions).text)).toEqual([failure.slice(0, 16), failure.slice(16), "重新加载"]);
  expect(lines.map(node => (node.props.options as SystemTextLineOptions).heightPx)).toEqual([35, 34, 35]);
  expect(lines.map(node => (node.props.options as SystemTextLineOptions).baselinePx)).toEqual([28, 26, 28]);
  expect(lines.map(node => (node.props.options as SystemTextLineOptions).paragraph!.lineIndex)).toEqual([0, 1, 0]);
  expect(lines.every(node => node.props.pixelScale === 2)).toBe(true);
  expect(mounted.snapshot()).toEqual(state(null,failure));
  retry(mounted);
  await settle();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.cancelled).toBe(true);
  expect(mounted.nodes().filter(node => node.kind === "WatchProgressIndicator")).toHaveLength(1);
  expect(mounted.snapshot()).toEqual(state(null,null,0,true,1));
  requests[1]!.resolve("重试成功正文");
  await settle();
  const document = renderedDocument(mounted);
  expect(document.props.content).toBe("重试成功正文");
  expect(document.props.title).toBe("隐私政策");
});

test("inactive status stays hidden and ignores retry until its owner resumes", async () => {
  const [active, setActive] = createSignal(false);
  const mounted = mount({active});
  const loadingNodes = mounted.nodes();
  expect(loadingNodes[0]!.props.accessibilityHidden).toBe(true);
  const spinner = loadingNodes.find(node => node.kind === "WatchProgressIndicator")!;
  expect((spinner.props.active as () => boolean)()).toBe(false);
  expect(loadingNodes.find(node => node.kind === "View" && String(node.props.class).includes("bg-black"))!.props.accessibilityHidden).toBe(true);
  requests[0]!.reject(Error("inactive offline fixture"));
  await settle(); await settle();
  const failureNodes = mounted.nodes();
  const control = failureNodes.find(node => node.props.accessibilityRole === "button")!;
  expect(control.props.focusable).toBe(false);
  expect(failureNodes.find(node => node.kind === "View" && String(node.props.class).includes("bg-black"))!.props.accessibilityHidden).toBe(true);
  retry(mounted);
  await settle();
  expect(requests).toHaveLength(1);
  expect(mounted.snapshot().error).toBe(failure);
  setActive(true);
  await settle();
  expect(control.props.focusable).toBe(true);
  expect(mounted.nodes()[0]!.props.accessibilityHidden).toBe(false);
  expect(mounted.nodes().find(node => node.kind === "View" && String(node.props.class).includes("bg-black"))!.props.accessibilityHidden).toBe(false);
  retry(mounted);
  await settle();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.cancelled).toBe(true);
  const resumedSpinner = mounted.nodes().find(node => node.kind === "WatchProgressIndicator")!;
  expect((resumedSpinner.props.active as () => boolean)()).toBe(true);
});

for (const lateOutcome of ["resolve", "reject"] as const) test(`a cancelled prior screen cannot replace the new document on late ${lateOutcome}`, async () => {
  const previous = mount(), oldRequest = requests[0]!;
  previous.dispose();
  expect(oldRequest.cancelled).toBe(true);
  const previousSnapshotCount = previous.snapshots.length;
  const current = mount({page: "useragreement"});
  expect(requests[1]!.url).toBe("https://legal.example.test/functions/v1/legal/watch/user-agreement");
  requests[1]!.resolve("新实例的用户协议正文");
  await settle();
  const document = renderedDocument(current);
  if (lateOutcome === "resolve") oldRequest.resolve("过时的隐私正文");
  else oldRequest.reject(Error("cancelled old host response"));
  await settle(); await settle();
  expect(renderedDocument(current)).toBe(document);
  expect(document.props.content).toBe("新实例的用户协议正文");
  expect(current.snapshot()).toEqual(state("新实例的用户协议正文",null));
  expect(previous.snapshots).toHaveLength(previousSnapshotCount);
});

test("retained content skips fetching and reports the document's pending physical offset", async () => {
  const restored = state("备案页背后的已完成协议",null,777);
  const mounted = mount({restoredBackground: restored});
  await settle();
  const document = renderedDocument(mounted);
  expect(requests).toHaveLength(0);
  expect(document.initialAnchor).toEqual(restored.listAnchor ?? undefined);
  expect(document.handle.scroller.offset()).toBe(0);
  expect(mounted.snapshot()).toEqual(restored);
  expect(mounted.snapshots.at(-1)).toEqual(restored);
  document.setOffset(913);
  await settle();
  expect(mounted.snapshot().scrollOffset).toBe(913);
  expect(mounted.snapshots.at(-1)?.scrollOffset).toBe(913);
  document.props.onBeian();
  expect(mounted.navigation).toEqual(["beian"]);
});

test("retained failure skips fetching until the user retries", async () => {
  const mounted = mount({restoredBackground: state(null,failure)});
  await settle(); await settle();
  expect(requests).toHaveLength(0);
  expect(mounted.nodes().some(node => node.kind === "InformationDocument" || node.kind === "WatchProgressIndicator")).toBe(false);
  expect(mounted.snapshot()).toEqual(state(null,failure));
  retry(mounted);
  await settle();
  expect(requests).toHaveLength(1);
  expect(mounted.nodes().filter(node => node.kind === "WatchProgressIndicator")).toHaveLength(1);
  requests[0]!.resolve("恢复错误后成功获取正文");
  await settle();
  expect(renderedDocument(mounted).props.content).toBe("恢复错误后成功获取正文");
});

test("a covered page without retained content publishes its completed fetch before activation", async () => {
  const mounted = mount({active: () => false, restoredBackground: state(null,null)});
  expect(requests).toHaveLength(1);
  requests[0]!.resolve("Bundle-only 下层页面重新取得的正文");
  await settle();
  const expected = state("Bundle-only 下层页面重新取得的正文",null);
  expect(mounted.snapshots.at(-1)).toEqual(expected);
  expect(mounted.snapshot()).toEqual(expected);
  const document = renderedDocument(mounted);
  expect(document.props.active?.()).toBe(false);
  expect(document.handle.ready()).toBe(false);
  expect(requests).toHaveLength(1);
});

test("covering and resuming a successful document preserves its instance, offset and request", async () => {
  const [active, setActive] = createSignal(true);
  const mounted = mount({active});
  requests[0]!.resolve("正在阅读的协议正文");
  await settle();
  const document = renderedDocument(mounted);
  document.setOffset(1200);
  setActive(false);
  await settle();
  expect(document.props.active?.()).toBe(false);
  expect(renderedDocument(mounted)).toBe(document);
  expect(mounted.nodes()[0]!.props.accessibilityHidden).toBe(true);
  expect(document.disposed).toBe(false);
  expect(mounted.snapshot().scrollOffset).toBe(1200);
  setActive(true);
  await settle();
  expect(document.props.active?.()).toBe(true);
  expect(renderedDocument(mounted)).toBe(document);
  expect(mounted.nodes()[0]!.props.accessibilityHidden).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.cancelled).toBe(false);
});

for (const page of ["info", "licenses"] as const) test(`static ${page} forwards the real reader inputs and renders only the document`, async () => {
  const mounted = mount({page});
  await settle();
  const document = renderedDocument(mounted), nodes = mounted.nodes();
  expect(requests).toHaveLength(0);
  expect(document.props.content).toBe(page === "info" ? informationText.intro : informationText.licenses);
  expect(document.props.title).toBe(page === "info" ? "项目自介" : "开源许可与清单");
  expect(document.props.preset).toBe(mounted.input.preset);
  expect(document.props.fonts).toBe(mounted.input.fonts);
  expect(document.props.backgroundSnapshot).toBe(mounted.input.backgroundSnapshot);
  expect(document.props.active).toBe(mounted.input.active);
  expect(document.props.accessibilityLabel).toBe("协议正文");
  expect(nodes.some(node => node.kind === "ScrollEntries" || typeof node.props.onPress === "function")).toBe(false);
});

test("a successful empty response remains a document instead of returning to loading", async () => {
  const mounted = mount();
  requests[0]!.resolve("");
  await settle();
  expect(renderedDocument(mounted).props.content).toBe("");
  expect(mounted.nodes().some(node => node.kind === "WatchProgressIndicator")).toBe(false);
});

test("top restoration refetches but a response before the next frame keeps the consumed live list", async () => {
  const original = state("恢复的原正文",null,1207,false,4), mounted = mount({restoredState:original,restoreMode:'recreated'});
  const document = renderedDocument(mounted);
  expect(requests).toHaveLength(1);
  expect(document.initialAnchor).toEqual({index:12,offsetPx:7});
  expect(mounted.snapshot()).toEqual({...original,isLoading:true});
  expect(mounted.events).toEqual(['document-mounted','candidate-consumed']);
  requests[0]!.resolve("同帧新正文");
  await microtasks();
  expect(document.props.content).toBe("恢复的原正文");
  frame();
  expect(renderedDocument(mounted)).toBe(document);
  expect(document.disposed).toBe(false);
  expect(document.props.content).toBe("同帧新正文");
  expect(mounted.snapshot()).toEqual({...original,content:"同帧新正文"});
  expect(mounted.events).toEqual(['document-mounted','candidate-consumed','response-applied']);
});

test("a committed loading branch discards only the consumed live list and later success starts at zero", async () => {
  const original = state("旧正文仍单独保存",null,2309), mounted = mount({restoredState:original});
  const document = renderedDocument(mounted);
  frame();
  expect(document.disposed).toBe(true);
  expect(mounted.nodes().filter(node => node.kind==='WatchProgressIndicator')).toHaveLength(1);
  expect(mounted.snapshot()).toEqual(state(original.content,null,0,true,0,null));
  expect(mounted.events).toContain('document-unmounted');
  expect(mounted.events).toContain('loading-committed');
  requests[0]!.resolve("慢响应正文");
  await microtasks();
  frame();
  const replacement = renderedDocument(mounted);
  expect(replacement).not.toBe(document);
  expect(replacement.initialAnchor).toBeUndefined();
  expect(mounted.snapshot()).toEqual(state("慢响应正文",null));
  expect(mounted.events.filter(event => event==='candidate-consumed')).toHaveLength(1);
});

test("saving and recreating after committed unmount cannot resurrect the consumed candidate", async () => {
  const first = mount({restoredState:state("首次正文",null,1508)});
  renderedDocument(first);
  frame();
  const checkpoint = first.snapshot();
  expect(checkpoint.listAnchor).toBeNull();
  first.dispose();
  const second = mount({restoredState:checkpoint});
  expect(second.nodes().some(node=>node.kind==='InformationDocument')).toBe(false);
  requests.at(-1)!.resolve("第二次恢复响应");
  await microtasks(); frame();
  expect(renderedDocument(second).initialAnchor).toBeUndefined();
  expect(second.snapshot().listAnchor).toEqual({index:0,offsetPx:0});
});

test("an unconsumed candidate survives loading, another save, error and retry until the first document mount", async () => {
  const pending = state("加载时保留的旧正文",null,0,true,2,{index:8,offsetPx:17});
  const first = mount({restoredState:pending});
  frame(); frame();
  expect(first.nodes().some(node=>node.kind==='InformationDocument')).toBe(false);
  expect(first.snapshot().listAnchor).toEqual(pending.listAnchor);
  expect(first.events).not.toContain('candidate-consumed');
  const checkpoint=first.snapshot();first.dispose();
  const second=mount({restoredState:checkpoint});
  requests.at(-1)!.reject(Error('restored pending failure'));
  await microtasks();frame();await microtasks();
  expect(second.snapshot()).toEqual(state(null,failure,0,false,2,pending.listAnchor));
  expect(second.events).not.toContain('candidate-consumed');
  retry(second);frame();
  expect(second.snapshot().listAnchor).toEqual(pending.listAnchor);
  requests.at(-1)!.resolve("首次可挂载的正文");
  await microtasks();frame();
  const document=renderedDocument(second);
  expect(document.initialAnchor).toEqual(pending.listAnchor ?? undefined);
  expect(second.snapshot().listAnchor).toEqual(pending.listAnchor);
  expect(second.events.filter(event=>event==='candidate-consumed')).toHaveLength(1);
});

test("a retained underlying instance uses the new explicit restore mode without issuing a request", async () => {
  const snapshot=state("下层实例的已完成正文",null,1913,false,5);
  const mounted=mount({restoredState:snapshot,restoreMode:'retained-underlying',active:()=>false});
  frame();
  expect(requests).toHaveLength(0);
  expect(renderedDocument(mounted).initialAnchor).toEqual(snapshot.listAnchor ?? undefined);
  expect(mounted.snapshot()).toEqual(snapshot);
});

test("disposing the whole successful screen does not publish a synthetic lost-list checkpoint", async () => {
  const mounted=mount({restoredState:state("待保存的正文",null,1217),restoreMode:'retained-underlying'});
  const document=renderedDocument(mounted);
  document.setOffset(1519);
  const checkpoint=mounted.snapshot(),count=mounted.snapshots.length;
  mounted.dispose();
  expect(document.disposed).toBe(true);
  expect(mounted.snapshots).toHaveLength(count);
  expect(mounted.snapshots.at(-1)).toEqual(checkpoint);
  expect(mounted.events).not.toContain('document-unmounted');
});
