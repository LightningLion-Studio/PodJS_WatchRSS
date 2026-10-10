import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('external acoustic page waits for activation and owns cancellation/result delivery',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'external-component.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit,stdout+stderr).toBe(0);expect(stdout+stderr).toContain('2 pass');
});
