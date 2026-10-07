import { createStartupTrace, createFirstScreenGate } from "@podjs/framework/startup";
import { appLogger } from "../logs/app-logger.ts";

const trace = createStartupTrace({ sink: message => appLogger.d("Startup", message) });
/** Logs milliseconds since the JS bundle started, once per phase name. */
export const startupMark = trace.mark;
/** Times one awaited startup step. */
export const startupStep = trace.step;

const firstScreen = createFirstScreenGate({
  onReady: already => startupMark(already ? "firstScreen.alreadyDelivered" : "firstScreen.delivered"),
  onResolved: () => startupMark("firstScreen.resolved"),
});
/** Marks the first content screen as loaded; deferred startup work may begin. */
export const startupFirstScreen = firstScreen.ready;
/** Resolves after the first content screen loaded, or after `maxMs` as a fallback. */
export const afterFirstScreen = firstScreen.wait;
