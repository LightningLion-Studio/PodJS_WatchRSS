import {expect,test} from 'bun:test';
import {resolve} from 'node:path';

test('automatic cloud resume matches the baseline for every wake source with and without an initialization fault',async()=>{
 const fixture=resolve(import.meta.dir,'cloud-auto-resume.isolated.ts');
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',fixture],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
 expect(out+err).toMatch(/^ 30 pass$/m);
});
