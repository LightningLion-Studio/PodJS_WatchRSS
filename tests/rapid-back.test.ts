import {expect,test} from 'bun:test';
for(const scenario of ['4','8','delayed','timeout','lifecycle'])test(`K18 real route regression: ${scenario}`,()=>{
 const result=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/rapid-back.isolated.ts'],{cwd:import.meta.dir+'/..',env:{...process.env,RAPID_BACK_CASE:scenario},stdout:'pipe',stderr:'pipe'});
 if(result.exitCode)console.error(new TextDecoder().decode(result.stdout),new TextDecoder().decode(result.stderr));
 expect(result.exitCode).toBe(0);
});
