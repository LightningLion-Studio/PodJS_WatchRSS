import {expect,test} from 'bun:test';
test('DYVOL real player system audio and crown regressions',()=>{
 const run=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/dyvol.isolated.ts'],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
