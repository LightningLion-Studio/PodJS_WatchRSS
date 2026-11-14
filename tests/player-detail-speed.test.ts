import {expect,test} from 'bun:test';
test('player detail speed source races',()=>{
 const run=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/player-detail-speed.isolated.ts'],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
