import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('RSS envelope, preserved migration, concurrency and real-incident regressions use unmocked production modules',()=>{
 const child=Bun.spawnSync([process.execPath,'test',fileURLToPath(new URL('./encoded-body-repair.isolated.ts',import.meta.url))]);
 expect(child.exitCode,child.stdout.toString()+child.stderr.toString()).toBe(0);
});
