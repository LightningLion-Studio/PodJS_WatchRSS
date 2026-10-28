import {test,expect} from 'bun:test';
test('production RSS search input lifecycle stays visible',()=>{const child=Bun.spawnSync([process.execPath,'--conditions=browser','test',import.meta.dir+'/rss-search-input.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});expect(child.exitCode,Buffer.from(child.stderr).toString()).toBe(0);});
