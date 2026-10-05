import {expect,test} from 'bun:test';
import {resolve} from 'node:path';

test('Douyin immersive entry settles feed outcomes and never gates navigation on detail requests',async()=>{
  const child=Bun.spawn([process.execPath,'--conditions=browser','test',resolve(import.meta.dir,'douyin-entry-component.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,out+err).toBe(0);
  expect(out+err).toMatch(/0 fail/);
});
