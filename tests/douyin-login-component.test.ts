import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
test('Douyin login probes before authorization and renders unavailable states', async () => {
  const child = Bun.spawn([Bun.which('bun')!, '--conditions=browser', 'test', resolve(import.meta.dir, 'douyin-login-component.isolated.ts')], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, out + err).toBe(0); expect(out + err).toMatch(/7 pass/);
});
