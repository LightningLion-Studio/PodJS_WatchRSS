import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('production stock adapter reuses one checked frame and supplied headers without persisting capabilities',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'douyin-stock-host.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toContain('1 pass');
});
