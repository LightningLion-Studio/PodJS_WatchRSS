import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
for(const fixture of ['network-overlay-component','network-overlay-host']){
 test(`${fixture} regressions`,async()=>{
  const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,fixture+'.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,out+err).toBe(0);
 },90000);
}
