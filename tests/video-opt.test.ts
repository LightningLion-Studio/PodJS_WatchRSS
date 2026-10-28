import {expect,test} from 'bun:test';
test('video optimization gates, native feedback, privacy and list budgets',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',`${import.meta.dir}/video-opt.isolated.ts`],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
});
