import { expect, test } from "bun:test";
import { createComputed, createRoot } from "solid-js";
import { createEffectiveRouteStack } from "../src/ui/effective-route-stack.ts";

test("warning presentation preserves the exact effective stack", () => createRoot(dispose => {
  try {
    const initial = [{ page: "home" }];
    const stack = createEffectiveRouteStack(initial);
    const observed: typeof initial[] = [];
    createComputed(() => { observed.push(stack.effectiveStack()); });
    stack.showWarning();
    expect(stack.warningShown()).toBe(true);
    expect(stack.effectiveStack()).toBe(initial);
    stack.commitStack(entries => entries, () => { throw Error("no-op dismissed warning"); });
    stack.hideWarning();
    expect(stack.effectiveStack()).toBe(initial);
    expect(observed).toEqual([initial]);
    const replacement = [...initial];
    stack.commitStack(replacement, () => { throw Error("no warning to dismiss"); });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(replacement);
  } finally { dispose(); }
}));

test("push, replace and pop dismiss the warning at commit", () => createRoot(dispose => {
  try {
    const home = { page: "home" };
    const articles = { page: "articles" };
    const notes = { page: "notes" };
    const stack = createEffectiveRouteStack([home]);
    const dismiss = () => {
      expect(stack.warningShown()).toBe(true);
      stack.hideWarning();
    };
    for (const entries of [[home, articles], [home, notes], [home]]) {
      stack.showWarning();
      stack.commitStack(() => entries, dismiss);
      expect(stack.warningShown()).toBe(false);
      expect(stack.effectiveStack()).toBe(entries);
    }
  } finally { dispose(); }
}));
