import { expect, test } from "bun:test";

test("Bluetooth warning is transparent to the effective stack", () => {
  const result = Bun.spawnSync(
    [process.execPath, "--conditions=browser", "test", "./tests/effective-route-stack.isolated.ts"],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});
