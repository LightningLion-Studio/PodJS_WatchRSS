import {expect,test} from 'bun:test';
test('round-screen row splitting keeps every settings/card row fully reachable',()=>{
 const child=Bun.spawnSync(['bun','--conditions=browser','test','./tests/round-rows.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 expect(child.exitCode,new TextDecoder().decode(child.stdout)+new TextDecoder().decode(child.stderr)).toBe(0);
});
