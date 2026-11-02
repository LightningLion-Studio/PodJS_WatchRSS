import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('DYUI closed auth observations use the shared synchronous bridge in an isolated runtime',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',resolve(import.meta.dir,'bench.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toContain('6 pass');
});
