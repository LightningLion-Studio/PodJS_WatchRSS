import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('RSS feed keeps geometry across pagination and invalidates measured inputs',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',fileURLToPath(new URL('./rss-feed-geometry.isolated.ts',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
});
