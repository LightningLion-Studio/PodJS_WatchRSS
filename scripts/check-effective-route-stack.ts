import { strict as assert } from "node:assert";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
assert(!config.error);
const project = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(project.fileNames, project.options);
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter(file => relative(root, file.fileName).startsWith("src/"));

const main = "src/ui/screen.tsx";
const startup = "src/ui/StartupGate.tsx";
const boundary = "src/ui/effective-route-stack.ts";
const warning = "src/ui/bluetooth-warning-navigation.ts";
const reader = "src/ui/routes/reader.tsx";
const media = "src/ui/routes/media-controller.ts";
const saved = "src/ui/routes/saved-controller.ts";
const shell = "src/debug/shell-host.ts";

const accessors = new Map([
  [main, new Set(["effectiveStack", "effectiveCurrent", "effectivePage", "entryPage"])],
  [startup, new Set(["effectiveStack", "effectiveCurrentLegal"])],
  [reader, new Set(["props.stack", "props.page"])],
  [media, new Set(["dependencies.current"])],
  [saved, new Set(["dependencies.current"])],
  [shell, new Set(["port.current"])],
]);
const restoredReaders = new Map([
  ["src/navigation/activity-navigation.ts", new Set(["decodedRoute", "restoreActivityNavigation", "stack.restore", "stack.resolve"])],
  ["src/navigation/startup-navigation.ts", new Set(["restoreActivityNavigation"])],
  [main, new Set(["startupActivityNavigation", "resolveActivityNavigation"])],
]);
const derivedReaders = new Set(["backUnderlay", "telemetryScreenOwner"]);
const types = new Set(["RouteEntry", "ActivityRoute", "LegalEntry", "Page", "StartupLegalPage"]);
function isRouteType(type: ts.Type, arrays = true): boolean {
  const name = (type.aliasSymbol ?? type.getSymbol())?.getName();
  if (name && types.has(name)) return true;
  if (type.isUnion()) return type.types.some(member => isRouteType(member, arrays));
  const element = arrays ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
  return !!element && element !== type && isRouteType(element, false);
}

const inventory: { kind: string; location: string; expression: string }[] = [];
const connections = new Map<string, number>();
function add(file: ts.SourceFile, node: ts.Node, kind: string, expression = node.getText(file)) {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  inventory.push({ kind, location: `${relative(root, file.fileName)}:${line + 1}:${character + 1}`, expression });
}
function connect(file: ts.SourceFile, node: ts.Node, name: string) {
  connections.set(name, (connections.get(name) ?? 0) + 1);
  add(file, node, "effective input", name);
}
function visit(file: ts.SourceFile, path: string, node: ts.Node) {
  if (ts.isIdentifier(node) && node.text === "actualStack" && ts.isCallExpression(node.parent)) {
    assert.equal(path, boundary, "Only the effective stack boundary can read the actual stack");
    const field = node.parent.parent;
    assert(ts.isPropertyAccessExpression(field) && ["routes", "warning"].includes(field.name.text));
    add(file, field, "boundary");
  }
  if (ts.isCallExpression(node)) {
    const target = node.expression.getText(file);
    if (accessors.get(path)?.has(target)) {
      add(file, node, "effective read");
    } else if (/^props\.page$/.test(target) && isRouteType(checker.getTypeAtLocation(node))) {
      // Retained route components receive their own entry's page.
      add(file, node, "entry page");
    } else if (["setStack", "setLegal", "dependencies.setStack", "commitStack"].includes(target) &&
        [main, startup, media].includes(path)) {
      add(file, node, "navigation commit", target);
      if (target === "commitStack") {
        assert.equal(node.arguments[1]?.getText(file), "warningNavigation.dismiss");
        connect(file, node, `warning dismissal in ${path}`);
      }
    } else if (isRouteType(checker.getTypeAtLocation(node))) {
      if (path === main && ["traceServiceWork", "kv.batch"].includes(target)) add(file, node, "navigation commit", target);
      else if (restoredReaders.get(path)?.has(target)) add(file, node, "restored route data");
      else if (derivedReaders.has(target) ||
        /\.(at|find|filter|slice|reverse|map)$/.test(target)) add(file, node, "derived route data", target);
      else assert.fail(`Unclassified route read ${path}: ${target}`);
    }
    if (path === main && ts.isIdentifier(node.expression) && [
      "createMediaRouteController", "createSavedRouteController", "bindShellCommands", "bindPairingRequestRoute",
    ].includes(target)) {
      const arg = node.arguments[0];
      assert(ts.isObjectLiteralExpression(arg));
      const property = target === "bindPairingRequestRoute" ? "page" : "current";
      const accessor = property === "page" ? "effectivePage" : "effectiveCurrent";
      assert(arg.properties.some(p => ts.isPropertyAssignment(p) &&
        p.name.getText(file) === property && p.initializer.getText(file) === accessor));
      connect(file, node, target);
      if (target === "createMediaRouteController") {
        assert(arg.properties.some(p => ts.isShorthandPropertyAssignment(p) && p.name.text === "motion"));
        connect(file, node, "media content motion");
      }
    }
  }
  if (ts.isJsxAttribute(node) && path === main && node.name.getText(file) === "stack") {
    assert.equal(node.initializer?.getText(file), "{effectiveStack}");
    connect(file, node, "ReaderRoutes stack");
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "page" &&
      isRouteType(checker.getTypeAtLocation(node.expression), false)) {
    add(file, node, "route entry property");
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "phase") {
    const target = node.expression.getText(file);
    const type = checker.getTypeAtLocation(node.expression);
    if (type.getSymbol()?.name === "BackMotion" || target === "dependencies.motion") {
      assert([main, startup, reader, media, warning].includes(path), `Unclassified BackMotion read ${path}`);
      add(file, node, path === warning ? "warning input" : "content transition");
    }
  }
  ts.forEachChild(node, child => visit(file, path, child));
}

for (const file of sources) visit(file, relative(root, file.fileName), file);
for (const name of [
  "createMediaRouteController", "createSavedRouteController", "bindShellCommands", "bindPairingRequestRoute", "ReaderRoutes stack", "media content motion",
  `warning dismissal in ${main}`, `warning dismissal in ${startup}`,
]) assert.equal(connections.get(name), 1, name);
for (const row of inventory) console.log(`${row.kind}\t${row.location}\t${row.expression}`);
console.log(`Checked ${inventory.length} reads and bindings in ${sources.length} source files.`);
