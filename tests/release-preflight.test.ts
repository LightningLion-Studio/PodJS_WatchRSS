import {expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('offline release preflight gates, SDK fixture and ledger recording', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/release', '-p', 'test_preflight.py', '-v'], {
    cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
  });
  expect(result.stderr).toContain('OK');
  expect(result.status, result.stderr).toBe(0);
}, 120_000);
