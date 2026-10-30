import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('DYFIX device codec fallback requires explicit capability evidence',async()=>{
 const child=Bun.spawn([process.execPath,'test',resolve(import.meta.dir,'douyin-codec.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toMatch(/2 pass/);
});
