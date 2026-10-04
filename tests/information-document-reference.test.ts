import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildInformationBlocks } from "../src/ui/information-document.ts";
import reference from "./android-startup/assets/information-document-reference.json";

const projectRoot = new URL("../", import.meta.url);
const kotlinSource = readFileSync(
  new URL("tests/native-onboarding/test/InfoRestorationReferenceTest.kt", projectRoot), "utf8",
);
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

function requiredMatch(pattern: RegExp): RegExpMatchArray {
  const match = kotlinSource.match(pattern);
  expect(match).not.toBeNull();
  if (!match) throw new Error("Native information fixture no longer matches " + pattern.source);
  return match;
}

function kotlinString(encoded: string): string {
  // This fixture uses ordinary Kotlin strings with JSON-compatible escapes.
  return JSON.parse('"' + encoded + '"') as string;
}

test("shared static document exactly matches the native Kotlin title and body template", () => {
  const title = kotlinString(requiredMatch(/const val TITLE = "((?:\\.|[^"\\])*)"/)[1]);
  const count = Number(requiredMatch(/const val PARAGRAPHS = (\d+)/)[1]);
  const bodyTemplate = requiredMatch(
    /fun body\(marker: String\) = \(1\.\.PARAGRAPHS\)\.joinToString\("((?:\\.|[^"\\])*)"\) \{\s*"((?:\\.|[^"\\])*)"\s*\}/,
  );
  const separator = kotlinString(bodyTemplate[1]);
  const template = kotlinString(bodyTemplate[2]);
  const marker = requiredMatch(
    /@Test fun staticBodyRecreation\(\) = scenario\("static"\) \{[^]*?InfoActivity\.createIntent\(context, TITLE, body\("([^"]+)"\)\)/,
  )[1];
  const numberPlaceholder = "${it.toString().padStart(2, '0')}";

  expect(title).toBe("原生协议恢复对照");
  expect(count).toBe(32);
  expect(separator).toBe("\n\n");
  expect(marker).toBe("STATIC");
  expect(template).toBe(
    "$marker 第" + numberPlaceholder + "段。此内容仅用于隔离协议页面的生命周期与滚动验证。",
  );
  const paragraphs = Array.from({ length: count }, (_, index) =>
    template.replace("$marker", marker).replace(numberPlaceholder, String(index + 1).padStart(2, "0")),
  );
  const nativeBody = paragraphs.join(separator);

  expect(reference.title).toBe(title);
  expect(reference.staticBody).toBe(nativeBody);
  expect(reference.staticBodySha256).toBe(sha256(nativeBody));
  expect(sha256(reference.staticBody)).toBe(reference.staticBodySha256);
  expect(buildInformationBlocks(reference.staticBody)).toEqual(
    paragraphs.map(text => ({ type: "text", text, style: "body" })),
  );
});

type TextObservation = {
  text: string; left: number; top: number; right: number; bottom: number;
};
type NativeSnapshot = {
  scrollAxis: number;
  scrollAxisMax: string;
  texts: TextObservation[];
  capture: { file: string; width: number; height: number; pngSha256: string; pixelSha256: string };
};
type NativeProof = {
  scenario: string;
  testClass: string;
  passed: boolean;
  processDeathTested: boolean;
  before: NativeSnapshot;
  after: NativeSnapshot;
  observedScrollUnchanged: boolean;
  observedPixelsEqual: boolean;
};

test("native reference records the preserved semantic position and exact existing PNG files", () => {
  const native = reference.nativeReference;
  expect(native.source).toBe("artifacts/native-info-static-proof.json");
  // Keep the captured evidence beside the tests: artifacts/ is ignored and
  // must not make the normal offline suite depend on a previous device run.
  const proofUrl = new URL("tests/fixtures/information-document/native-info-static/native-info-static-proof.json", projectRoot);
  const proof = JSON.parse(readFileSync(proofUrl, "utf8")) as NativeProof;

  expect(proof.scenario).toBe("static");
  expect(proof.testClass).toBe("dev.podjs.reference.InfoRestorationReferenceTest");
  expect(proof.passed).toBe(true);
  expect(proof.processDeathTested).toBe(false);
  expect(proof.observedScrollUnchanged).toBe(true);
  expect(proof.observedPixelsEqual).toBe(true);
  // Compose's lazy-list semantic range is not the document's physical pixel offset.
  expect(native.semanticScrollAxis).toBe(6037);
  expect(native.semanticScrollAxisMax).toBe(6137);
  // The source proof never reads or asserts the active preset, font, theme or fontScale.
  expect(native.runtimePresetVerified).toBe(false);
  expect(native.visibleParagraphs).toEqual([
    { number: 9, left: 28, top: 0, right: 438, bottom: 88 },
    { number: 10, left: 28, top: 100, right: 438, bottom: 213 },
    { number: 11, left: 28, top: 225, right: 438, bottom: 338 },
    { number: 12, left: 28, top: 350, right: 438, bottom: 463 },
  ]);
  expect(native.anchor).toEqual({ paragraph: 10, topPx: 100 });
  const anchorParagraph = native.visibleParagraphs.find(paragraph => paragraph.number === native.anchor.paragraph);
  expect(anchorParagraph).toBeDefined();
  if (!anchorParagraph) throw new Error("Native anchor paragraph is absent from the visible reference");
  expect(native.anchor.topPx).toBe(anchorParagraph.top);

  for (const [phase, snapshot] of [["before", proof.before], ["after", proof.after]] as const) {
    expect(snapshot.scrollAxis).toBe(native.semanticScrollAxis);
    expect(Number(snapshot.scrollAxisMax)).toBe(native.semanticScrollAxisMax);
    expect(snapshot.capture.file).toBe("native-info-static-" + phase + ".png");
    expect(snapshot.capture.width).toBe(466);
    expect(snapshot.capture.height).toBe(466);
    expect(snapshot.capture.pngSha256).toBe(native.pngSha256);
    const png = readFileSync(new URL(snapshot.capture.file, proofUrl));
    expect(sha256(png)).toBe(native.pngSha256);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(snapshot.capture.width);
    expect(png.readUInt32BE(20)).toBe(snapshot.capture.height);

    // Only the PNG-confirmed visible paragraphs are retained; lazy prefetch semantics
    // can contain additional or zero-sized nodes that are absent from the image.
    for (const { number, ...bounds } of native.visibleParagraphs) {
      const text = reference.staticBody.split("\n\n")[number - 1];
      const observations = snapshot.texts.filter(item => item.text === text);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toEqual({ text, ...bounds });
    }
  }
  expect(proof.before.capture.pixelSha256).toBe(proof.after.capture.pixelSha256);
});

test("shared role document exercises body, URL code and bullet quote without losing source text", () => {
  expect(reference.rolesTitle).toBe("协议阅读角色对照");
  expect(reference.rolesBody).toBe(
    "普通正文角色。\n\nhttps://example.org/watchrss/reference\n\n• 引用角色段落。",
  );
  expect(buildInformationBlocks(reference.rolesBody)).toEqual([
    { type: "text", text: "普通正文角色。", style: "body" },
    { type: "text", text: "https://example.org/watchrss/reference", style: "code" },
    { type: "text", text: "• 引用角色段落。", style: "quote" },
  ]);
});

test("new live-layout native reference uses the same static and role inputs", () => {
  const source = readFileSync(new URL("tests/native-onboarding/test/InformationDocumentReferenceTest.kt", projectRoot), "utf8");
  const constant = (name: string): string => {
    const match = source.match(new RegExp('const val ' + name + ' = "((?:\\\\.|[^"\\\\])*)"'));
    if (!match) throw Error('Missing native reference constant ' + name);
    return kotlinString(match[1]);
  };
  expect(constant('TITLE')).toBe(reference.title);
  expect(constant('ROLES_TITLE')).toBe(reference.rolesTitle);
  expect(constant('ROLE_BODY')).toBe(reference.rolesBody);
  const count = source.match(/const val PARAGRAPHS = (\d+)/);
  const template = source.match(/fun staticBody\(\) = \(1\.\.PARAGRAPHS\)\.joinToString\("((?:\\.|[^"\\])*)"\) \{\s*"((?:\\.|[^"\\])*)"\s*\}/);
  if (!count || !template) throw Error('Missing native static body generator');
  const text = Array.from({length: Number(count[1])}, (_, index) =>
    kotlinString(template[2]).replace("${it.toString().padStart(2, '0')}", String(index + 1).padStart(2, '0')),
  ).join(kotlinString(template[1]));
  expect(text).toBe(reference.staticBody);
  expect(sha256(text)).toBe(reference.staticBodySha256);
});
