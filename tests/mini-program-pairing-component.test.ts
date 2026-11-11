import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('pairing completion invokes the home callback through the production component',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'mini-program-pairing-component.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toMatch(/3 pass/);
});

test('pairing SAS survives reactive row updates without closing the session',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'mini-program-pairing-lifecycle.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);expect(out+err).toMatch(/1 pass/);
});
