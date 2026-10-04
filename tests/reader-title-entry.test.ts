import {expect, test} from "bun:test";
import {resolve} from "node:path";

test("production reader title hook renders its native paragraph and settled-state contracts", async () => {
  // Bun module mocks are process-global; browser conditions enable real Solid effects.
  const child = Bun.spawn([Bun.which("bun")!, "--conditions=browser", "test", resolve(import.meta.dir, "reader-title-entry.isolated.ts")], {stdout: "pipe", stderr: "pipe"});
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stdout + stderr).toBe(0);
  expect(stdout + stderr).toMatch(/[1-9]\d* pass/);
});
