import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('production pairing pages keep endpoint content inside the framework safe circle',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'pairing-round-list.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toMatch(/23 pass/);
});
