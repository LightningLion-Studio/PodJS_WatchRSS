import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('native Bili prepare/state failures reach production route recovery and resume playback',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'--conditions=browser','test',resolve(import.meta.dir,'bili-native-fallback.isolated.ts')],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
});
