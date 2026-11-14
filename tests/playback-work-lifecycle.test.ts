import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('speech playback owner follows route, host lifecycle, error and disposal',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',resolve(import.meta.dir,'playback-work-lifecycle.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('1 pass');
});
