import {expect,test} from 'bun:test';
test('platform disclosures in production Home and media routes',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',import.meta.dir+'/platform-disclosure-component.isolated.ts'],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,out+err).toBe(0);
});
