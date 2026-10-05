import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('production route Context, scroll and RSS input survive reconstruction with native retention boundaries',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'activity-components.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit,stdout+stderr).toBe(0);expect(stdout+stderr).toMatch(/[1-9]\d* pass/);
},20000);
