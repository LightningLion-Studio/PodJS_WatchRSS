import {expect,test} from 'bun:test';
test('U11 production ScrollEntries display defaults and explicit viewport wiring',()=>{
 const child=Bun.spawnSync(['bun','--conditions=browser','test','./tests/round-list.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 expect(child.exitCode,new TextDecoder().decode(child.stdout)+new TextDecoder().decode(child.stderr)).toBe(0);
});
