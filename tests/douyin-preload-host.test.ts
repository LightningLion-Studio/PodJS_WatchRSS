import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('production Douyin preload host keeps per-route Bluetooth consent through READY',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'douyin-preload-host.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('3 pass');
});
