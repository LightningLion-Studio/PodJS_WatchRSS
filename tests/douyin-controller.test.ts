import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const controllerFixture=resolve(import.meta.dir,'douyin-controller.isolated.ts');
test('D2 route controller reconstruction and same-item recovery',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',controllerFixture],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toMatch(/111 pass/);
});

for(const boundary of ['prepare','publish']){
 test(`RVRESCAP6-01 restores only the compliant source after SIGKILL during ${boundary}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'douyin-restart-'));
  const db=join(dir,'playback.sqlite');
  try{
   const run=async(phase:string)=>{
    const child=Bun.spawn([process.execPath,'--conditions=browser','test',controllerFixture,'-t','^RVRESCAP6-01 subprocess'],{
     stdout:'pipe',stderr:'pipe',env:{...process.env,DOUYIN_RESTART_PHASE:phase,DOUYIN_RESTART_DB:db},timeout:4000,
    });
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,signal:child.signalCode,output:out+err};
   };
   const killed=await run(boundary);
   expect(killed.signal,killed.output).toBe('SIGKILL');
   expect(killed.output).toContain(`"boundary":"${boundary}"`);
   const restarted=await run('restore');
   expect(restarted.code,killed.output+restarted.output).toBe(0);
   expect(restarted.output).toMatch(/1 pass/);
   expect(killed.output).toContain('"deletionCommitted":true');
  }finally{rmSync(dir,{recursive:true,force:true});}
 },10000);
}
