import {test,expect} from 'bun:test';import {resolve} from 'node:path';
test('production cloud application wires page/lifecycle/SCREEN_OFF/local BLE handoff',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'cloud-application-handoff.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('4 pass');
});

test('device approval polling dispatches through account preparation and the current grant',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'cloud-approval-poll.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
 expect(out+err).toMatch(/^ 19 pass$/m);
});
