import {expect,test} from 'bun:test';
// Other service suites install process-wide framework/media mocks. Exercise the real parser/queue together.
test('persistent offline media production, retry, merge policy, cancellation and migration',async()=>{
 const child=Bun.spawn([process.execPath,'test',`${import.meta.dir}/offline-queue.fixture.ts`],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);expect(out+err).toContain('8 pass');
});
