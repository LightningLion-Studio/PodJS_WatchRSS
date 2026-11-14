import {expect,test} from 'bun:test';
test('rotated gestures in RSS, Douyin and Bilibili components',()=>{
 const run=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/player-rotgest.isolated.ts'],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
