import { delay } from "@podjs/framework/services";
import { appLogger } from "../logs/app-logger.ts";

const now = () => globalThis.performance?.now?.() ?? Date.now();
const origin = now();
const seen = new Set<string>();

/** Logs milliseconds since the JS bundle started, once per phase name. */
export function startupMark(phase: string): void {
  if (seen.has(phase)) return;
  seen.add(phase);
  appLogger.i("Startup", `${phase} +${Math.round(now() - origin)}ms`);
}

/** Times one awaited startup step. */
export async function startupStep<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const began = now();
  try { return await run(); }
  finally { appLogger.i("Startup", `${phase} took ${Math.round(now() - began)}ms (+${Math.round(now() - origin)}ms)`); }
}

let firstScreenResolve: (() => void) | undefined;
const firstScreen = new Promise<void>(resolve => { firstScreenResolve = resolve; });
/** Marks the first content screen as loaded; deferred startup work may begin. */
export function startupFirstScreen(): void { firstScreenResolve?.(); firstScreenResolve = undefined; }
/** Resolves after the first content screen loaded, or after `maxMs` as a fallback. */
export function afterFirstScreen(maxMs = 3000): Promise<void> {
  // QuickJS setTimeout is a zero-delay microtask polyfill; use the host timer.
  return Promise.race([firstScreen, delay(maxMs).result.then(() => undefined, () => undefined)]);
}
