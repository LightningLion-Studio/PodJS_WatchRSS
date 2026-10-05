import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('standalone phone pages render and react through production Solid transform',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'phone-pages-component.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toMatch(/[1-9]\d* pass/);
});
