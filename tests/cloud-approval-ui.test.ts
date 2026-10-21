import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('ported cloud page uses v2 requester controls without a legacy code-input dialog',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'cloud-approval-ui.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('1 pass');
});
