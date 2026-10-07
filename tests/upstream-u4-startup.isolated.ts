import { expect, spyOn, test } from "bun:test";
import { appLogger } from "../src/logs/app-logger.ts";
import { __pumpPodEvents } from "@podjs/framework/watch";

type Startup = typeof import("../src/core/startup-trace.ts");
let serial = 0;
async function scenario(path: string, mode: "ready" | "timeout" | "rejected") {
  let now = 100;
  const clock = spyOn(globalThis.performance, "now").mockImplementation(() => now);
  const log: unknown[] = [], emitted: any[] = [], events: any[] = [];
  const logger = spyOn(appLogger,"d").mockImplementation((tag,message) => {log.push([tag,message]);});
  const root = globalThis as any, previous = root.pod;
  root.pod = {
    capabilities: () => JSON.stringify(["runtime.timer"]),
    emit: (line: string) => emitted.push(JSON.parse(line)),
    takeEvents: () => events.length ? JSON.stringify(events.splice(0)) : undefined,
  };
  try {
    const api: Startup = await import(`${path}?u4=${serial++}`);
    now = 106.6; api.startupMark("load"); api.startupMark("load");
    now = 110;
    expect(await api.startupStep("ok", async () => {now=120; return 42;})).toBe(42);
    await expect(api.startupStep("bad", async () => {now=130; throw new Error("bad");})).rejects.toThrow("bad");
    await expect(api.startupStep("sync", () => {now=132; throw new Error("sync");})).rejects.toThrow("sync");
    const result = api.afterFirstScreen().then(() => {log.push("wait.default");});
    const second = api.afterFirstScreen(19).then(() => {log.push("wait.second");});
    if (mode === "ready") {
      api.startupFirstScreen(); api.startupFirstScreen();
    } else {
      for (const request of emitted) events.push({t:"service.result",id:request.id,ok:mode==="timeout",value:null,error:{code:"timer",message:"failed"}});
      __pumpPodEvents();
    }
    await Promise.all([result,second]);
    log.push("waits.done");
    now = 140; api.startupFirstScreen(); api.startupFirstScreen();
    await api.afterFirstScreen(23); log.push("late.done");
    // Settle all losing timers; the legacy race does not cancel them.
    for (const request of emitted) events.push({t:"service.result",id:request.id,ok:true,value:null});
    __pumpPodEvents(); await Promise.resolve();
    return {log,requests:emitted.map(({id,...rest}) => rest)};
  } finally {clock.mockRestore();logger.mockRestore();root.pod=previous;}
}
for (const mode of ["ready","timeout","rejected"] as const) {
  test(`U4 startup adapter matches frozen log text, event order and timers: ${mode}`, async () => {
    const old = await scenario("./fixtures/upstream-u4/startup-trace.ts",mode);
    const current = await scenario("../src/core/startup-trace.ts",mode);
    expect(current).toEqual(old);
    expect(current.requests).toHaveLength(3);
    expect(current.log).toContainEqual(["Startup","firstScreen.resolved +"+(mode==="ready"?32:40)+"ms"]);
  });
}
