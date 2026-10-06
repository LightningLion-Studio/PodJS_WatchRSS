import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('default debug memory hook is installed only for host debug builds',async()=>{
 const suite=fileURLToPath(new URL('./debug-memory-host.isolated.ts',import.meta.url));
 for(const debug of ['0','1']){
  const child=Bun.spawn([process.execPath,'--conditions=browser','test',suite],{env:{...process.env,WRSS_MEMORY_DEBUG:debug},stdout:'pipe',stderr:'pipe'});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,`debug=${debug}\n${stdout}\n${stderr}`).toBe(0);
 }
},30_000);
