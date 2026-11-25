import {expect,test} from 'bun:test';

for(const scenario of ['home','feed','missing','settings','timeout','intro','privacy','bluetooth-legal','bluetooth-useragreement','bluetooth-first-run']){
 test(`production first-screen readiness: ${scenario}`,()=>{
  const child=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/startup-ready.isolated.ts'],{
   cwd:import.meta.dir+'/..',
   env:{...process.env,WRSS_STARTUP_FIXTURE:scenario},
   stdout:'pipe',stderr:'pipe',
  });
  expect(child.exitCode,child.stdout.toString()+child.stderr.toString()).toBe(0);
 });
}
