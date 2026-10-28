import {test,expect} from 'bun:test';
test('production contention default host path in a timerless guest',()=>{const child=Bun.spawnSync([process.execPath,'test',import.meta.dir+'/manifest-contention-host.isolated.ts'],{cwd:import.meta.dir+'/../..',stdout:'pipe',stderr:'pipe'});expect(child.exitCode,Buffer.from(child.stderr).toString()).toBe(0);});
