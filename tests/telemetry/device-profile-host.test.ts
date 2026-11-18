import {test,expect} from 'bun:test';
test('device profile production host identity isolation',()=>{
 const child=Bun.spawnSync([process.execPath,'test','./tests/telemetry/device-profile-host.isolated.ts'],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 if(child.exitCode)throw Error(new TextDecoder().decode(child.stderr));expect(child.exitCode).toBe(0);
});
