import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('windowed reader scrolls through the real native mirror and Solid reconciler',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',fileURLToPath(new URL('./reader-native.isolated.ts',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
});
