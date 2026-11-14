import {expect,test} from 'bun:test';
test('player detail panel controls and disposal',()=>{
 const run=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/player-detail-panel.isolated.ts'],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
