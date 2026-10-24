import {expect,test} from 'bun:test';
// Services integration mocks the pool module. Keep real-account/client checks in their own runtime.
test('RSS acquisition auth policy, public client and local-to-pool state preservation',async()=>{
 const child=Bun.spawn([process.execPath,'test',`${import.meta.dir}/rss-acquisition.fixture.ts`],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('3 pass');
});
