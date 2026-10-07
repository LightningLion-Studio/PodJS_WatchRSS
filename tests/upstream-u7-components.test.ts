import {expect,test} from 'bun:test';
test('U7 component oracle differential in isolated Solid browser runtime',()=>{
 const result=Bun.spawnSync(['bun','--conditions=browser','test','./tests/upstream-u7-components.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 if(result.exitCode!==0)console.error(new TextDecoder().decode(result.stderr));
 expect(result.exitCode).toBe(0);
});
