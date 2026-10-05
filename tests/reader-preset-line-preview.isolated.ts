import { afterEach, expect, mock, test } from "bun:test";
import { plugin } from "bun";
import { createRequire } from "node:module";
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from "solid-js";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
plugin({ name: "reader-preset-line-preview-solid-test", setup(builder) {
  builder.onLoad({ filter: /\/ReaderPresetSingleLinePreview\.tsx$/ }, async args => ({
    contents: transformSync(await Bun.file(args.path).text(), {
      filename: args.path, babelrc: false, configFile: false,
      presets: [[require("babel-preset-solid"), { generate: "universal", moduleName: "@pocketjs/framework/renderer" }], [require("@babel/preset-typescript"), { isTSX: true, allExtensions: true }]],
    }).code,
    loader: "js",
  }));
}});

type Element = { props: Record<string, any> & { children?: unknown } };
const element = (props: Element["props"]): Element => ({ props });
mock.module("@pocketjs/framework/renderer", () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module("@pocketjs/framework/components", () => ({ View: element }));
mock.module("@pocketjs/framework/host", () => ({ getOps: () => ({ measureText: (text: string) => Array.from(text).length * 8 }) }));
mock.module("@podjs/framework/watch", () => ({ hasCapability: () => false, getFontMetrics: () => undefined, getDisplayMetrics: () => ({ physicalWidth: 466, logicalWidth: 233 }) }));
mock.module("@podjs/framework/services", () => ({ textLayout: { layout() { throw new Error("text.layout should stay disabled"); } } }));
mock.module("../src/ui/ReaderBackground.tsx", () => ({ ReaderBackground: (props: Record<string, unknown>) => element({ debugName: "background", ...props }) }));
mock.module("../src/ui/ReaderTextRow.tsx", () => ({ ReaderTextRow: (props: Record<string, unknown>) => element({ debugName: "text", ...props }) }));

const { defaultReaderPreset } = await import("../src/reader/preset.ts");
const { ReaderPresetSingleLinePreview } = await import("../src/ui/ReaderPresetSingleLinePreview.tsx");
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); mock.restore(); });

function nodes(value: unknown): Element[] {
  if (typeof value === "function") return nodes(value());
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Element;
  return [node, ...nodes(node.props.children)];
}

test("passes the exact preset resources and BODY row into shared renderers", () => {
  const preset = defaultReaderPreset("paper", "纸张", false, 19);
  preset.body.fontWeight = 700;
  preset.body.letterSpacingEm = .08;
  preset.body.underline = true;
  preset.background = { ...preset.background, type: "IMAGE", assetId: "paper-bg", overlayOpacity: .25 };
  const snapshot = { state: { assets: { fonts: [], backgrounds: [], deletions: [] } }, revision: 7 } as any;
  const fonts = () => ({ path: "font.otf" }) as any;
  const tree = createRoot(dispose => {
    disposers.push(dispose);
    return ReaderPresetSingleLinePreview({ preset, snapshot, fonts, width: 200, height: 52, active: true });
  });
  const rendered = nodes(tree);
  const background = rendered.find(node => node.props.debugName === "background")!;
  const text = rendered.find(node => node.props.debugName === "text")!;
  expect(background.props).toMatchObject({ background: preset.background, snapshot, width: 200, height: 52, active: true });
  expect(text.props).toMatchObject({ preset, fonts, style: "body", fontSize: 19, width: 184, profile: "preview", rasterHeightExtraPx: 2 });
  expect(text.props.row).toMatchObject({ kind: "text", text: "纸张 · 正文预览", color: "#221f1bff", tracking: 19 * .08 });
});
