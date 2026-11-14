import {expect,test} from 'bun:test';
test('hold press lifecycle',()=>{
 const run=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/hold-press.isolated.ts'],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
