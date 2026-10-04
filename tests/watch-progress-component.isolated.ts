import {afterEach, expect, mock, spyOn, test} from "bun:test";
import {plugin} from "bun";
import {createRequire} from "node:module";
import * as solid from "solid-js";
import {createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps} from "solid-js";
import type {IntroAction, IntroState} from "../src/onboarding/state.ts";

// Use production's reactive Solid transform, with only the drawing primitive
// replaced. The actual component lifecycle registers real frame callbacks.
const require = createRequire(import.meta.url);
const {transformSync} = require("@babel/core");
plugin({name: "watch-progress-solid-test", setup(builder) {
  builder.onLoad({filter: /\/(WatchProgressIndicator|OnboardingNetworkScreen|OnboardingScreen)\.tsx$/}, async args => ({
    contents: transformSync(await Bun.file(args.path).text(), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[require("babel-preset-solid"), {generate: "universal", moduleName: "@pocketjs/framework/renderer"}], [require("@babel/preset-typescript"), {isTSX: true, allExtensions: true}]],
    }).code,
    loader: "js",
  }));
}});
type Element = {props: Record<string, unknown> & {children?: Element[]; style?: Record<string, unknown>}};
mock.module("@pocketjs/framework/renderer", () => ({createComponent, mergeProps, memo: createMemo, effect: createRenderEffect}));
const element = (props: Element["props"]): Element => {
  // The real primitive consumes children once while mounting. Preserve the
  // Show accessors it returns, rather than remounting a new subtree on reads.
  const renderedProps = Object.create(props) as Element["props"];
  Object.defineProperty(renderedProps, "children", {value: props.children, enumerable: true});
  return {props: renderedProps};
};
mock.module("@pocketjs/framework/components", () => ({View: element, Text: element, Image: element}));
mock.module("@pocketjs/framework/host", () => ({getOps: () => ({measureText: (text: string) => Array.from(text).length * 12})}));
mock.module("../src/ui/OnboardingCustomizationScreen.tsx", () => ({OnboardingCustomizationScreen: () => null}));
// The SDK checkout has its own node_modules. Production bundles one Solid
// runtime; keep this test's component and real frame hook on that same owner.
mock.module(Bun.resolveSync("solid-js", "/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/frame.ts"), () => solid);
const {resetFrameHooks, runFrameHooks} = await import("/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/frame.ts");
const {WatchProgressIndicator} = await import("../src/ui/WatchProgressIndicator.tsx");
const {OnboardingScreen} = await import("../src/ui/OnboardingScreen.tsx");
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); resetFrameHooks(); mock.restore(); });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function nodes(value: unknown): Element[] {
  if (typeof value === "function") return nodes(value());
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Element;
  return [node, ...nodes(node.props.children)];
}
const arcs = (root: unknown) => nodes(root).filter(node => typeof node.props.style?.arcWidth === "number");
function mountNetwork() {
  const [active, setActive] = createSignal(true);
  const [state, setState] = createSignal<IntroState>({page: 3, agreed: true, agreementError: false, offlineWarning: false, internet: "checking"});
  const actions: IntroAction[] = [];
  let disposeRoot!: () => void;
  const node = createRoot(dispose => {
    disposers.push(dispose); disposeRoot = dispose;
    return OnboardingScreen({width: 233, height: 233, get state() { return state(); }, active,
      onAction: action => actions.push(action), readerDark: true, onToggleReaderTheme() {}, onOpenLegal() {},
    });
  });
  return {node, setActive, setState, actions, dispose: () => disposeRoot()};
}

test("two arcs preserve a full track, stroke and indeterminate accessibility state", () => {
  const node = createRoot(dispose => {
    disposers.push(dispose);
    return WatchProgressIndicator({}) as unknown as Element;
  });
  expect(node.props.style).toEqual({width: 40, height: 40});
  expect(node.props.accessibilityLabel).toBe("正在加载");
  expect(node.props.accessibilityState).toEqual({busy: true});
  const [track, foreground] = node.props.children!;
  expect(track.props.accessibilityHidden).toBe(true);
  expect(foreground.props.accessibilityHidden).toBe(true);
  expect(track.props.style).toEqual({arcStart: 0, arcSweep: 360, arcWidth: 3, bgColor: "#b6b6b659"});
  expect(foreground.props.style!.arcWidth).toBe(3);
  expect(foreground.props.style!.bgColor).toBe("#ff6026");
  expect(foreground.props.style!.arcSweep).toBe(.1);
});

test("hidden route time cannot advance the phase even when no background frames arrive", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const [active, setActive] = createSignal(true);
  let disposeRoot!: () => void;
  const node = createRoot(dispose => {
    disposers.push(dispose); disposeRoot = dispose;
    return WatchProgressIndicator({size: 18, active}) as unknown as Element;
  });
  const [track, foreground] = node.props.children!;
  expect(node.props.style).toEqual({width: 18, height: 18});
  runFrameHooks(0);
  now += 333; runFrameHooks(0);
  expect(foreground.props.style!.arcSweep).toBeCloseTo(224.912780224, 4);
  const pausedStyle = {...foreground.props.style};
  setActive(false); await settle();
  expect(node.props.accessibilityHidden).toBe(true);
  const beforeInactiveFrame = clock.mock.calls.length;
  runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(beforeInactiveFrame);
  now += 60_000; // No frame callback while the host is backgrounded.
  expect(foreground.props.style).toEqual(pausedStyle);
  setActive(true); await settle(); runFrameHooks(0);
  expect(foreground.props.style).toEqual(pausedStyle);
  now += 333; runFrameHooks(0);
  expect(foreground.props.style!.arcSweep).toBe(290);
  expect(track.props.style!.arcSweep).toBe(360);
  const beforeDispose = {...foreground.props.style};
  disposeRoot(); now += 333;
  const beforeDisposedFrame = clock.mock.calls.length;
  runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(beforeDisposedFrame);
  expect(foreground.props.style).toEqual(beforeDispose);
});

test("production network checking uses native-sized arcs and cancels them when status resolves", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const mounted = mountNetwork();
  const loading = nodes(mounted.node).find(node => node.props.accessibilityLabel === "正在检测互联网状态")!;
  expect(loading.props.style).toEqual({width: 18, height: 18});
  expect(loading.props.accessibilityState).toEqual({busy: true});
  expect(arcs(mounted.node)).toHaveLength(2);
  expect(arcs(mounted.node).every(node => node.props.style!.arcWidth === 3)).toBe(true);
  const continueButton = () => nodes(mounted.node).find(node => node.props.accessibilityRole === "button")!;
  expect(continueButton().props.accessibilityState).toEqual({disabled: true});
  (continueButton().props.onPress as () => void)();
  expect(mounted.actions).toEqual([]);
  runFrameHooks(0); now += 666; runFrameHooks(0);
  expect(arcs(mounted.node)[1].props.style!.arcSweep).toBe(290);
  for (const [internet, color] of [["available", "#41c96b"], ["unavailable", "#e54d4d"], ["bluetooth", "#ffa726"]] as const) {
    mounted.setState(state => ({...state, internet})); await settle();
    expect(arcs(mounted.node)).toHaveLength(0);
    expect(nodes(mounted.node).some(node => node.props.style?.bgColor === color)).toBe(true);
    expect(continueButton().props.accessibilityState).toEqual({disabled: false});
    const calls = clock.mock.calls.length;
    now += 333; runFrameHooks(0);
    expect(clock.mock.calls.length).toBe(calls);
  }
  (continueButton().props.onPress as () => void)();
  expect(mounted.actions).toEqual([{type: "next"}]);
  mounted.setState(state => ({...state, internet: "checking"})); await settle();
  expect(arcs(mounted.node)[1].props.style!.arcSweep).toBe(.1);
  runFrameHooks(0); now += 333; runFrameHooks(0);
  expect(arcs(mounted.node)[1].props.style!.arcSweep).toBeCloseTo(224.912780224, 4);
  mounted.setState(state => ({...state, page: 2})); await settle();
  expect(arcs(mounted.node)).toHaveLength(0);
  const beforeLeaving = clock.mock.calls.length;
  now += 333; runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(beforeLeaving);
});

test("production network pauses for owner lifecycle and offline overlays and unregisters on disposal", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const mounted = mountNetwork();
  arcs(mounted.node); runFrameHooks(0); now += 333; runFrameHooks(0);
  const pausedArc = {...arcs(mounted.node)[1].props.style};
  mounted.setActive(false); await settle();
  let calls = clock.mock.calls.length;
  now += 60_000; runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(calls);
  expect(arcs(mounted.node)[1].props.style).toEqual(pausedArc);
  mounted.setActive(true); await settle(); runFrameHooks(0);
  expect(arcs(mounted.node)[1].props.style).toEqual(pausedArc);
  mounted.setState(state => ({...state, offlineWarning: true})); await settle();
  calls = clock.mock.calls.length;
  now += 60_000; runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(calls);
  mounted.setState(state => ({...state, offlineWarning: false})); await settle(); runFrameHooks(0);
  expect(arcs(mounted.node)[1].props.style).toEqual(pausedArc);
  now += 333; runFrameHooks(0);
  expect(arcs(mounted.node)[1].props.style!.arcSweep).toBe(290);
  mounted.dispose(); calls = clock.mock.calls.length;
  now += 333; runFrameHooks(0);
  expect(clock.mock.calls.length).toBe(calls);
});
