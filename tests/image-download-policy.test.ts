import {expect,test} from 'bun:test';
test('production image download policy and cancellation',()=>{
 const result=Bun.spawnSync([process.execPath,'test','--conditions=browser','./tests/image-download-policy.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 if(result.exitCode)throw Error(new TextDecoder().decode(result.stderr));expect(result.exitCode).toBe(0);
});
