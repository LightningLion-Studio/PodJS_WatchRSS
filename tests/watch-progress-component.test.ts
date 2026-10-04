import {expect, test} from "bun:test";
import {resolve} from "node:path";

test("progress and production network components pause and release frame callbacks", async () => {
  const child = Bun.spawn([Bun.which("bun")!, "--conditions=browser", "test", resolve(import.meta.dir, "watch-progress-component.isolated.ts")], {stdout: "pipe", stderr: "pipe"});
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stdout + stderr).toBe(0);
  expect(stdout + stderr).toMatch(/[1-9]\d* pass/);
});
