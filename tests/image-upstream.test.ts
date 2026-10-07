import {expect,test} from 'bun:test';
for(const baseline of [true,false])test(`image migration contracts: ${baseline?'frozen 6df598d':'framework wiring'}`,async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',`${import.meta.dir}/image.isolated.ts`],{env:{...process.env,WRSS_IMAGE_BASELINE:baseline?'1':''},stdout:'pipe',stderr:'pipe'});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit,out+err).toBe(0);
});
test('image component tree and reactive geometry match frozen component',async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',`${import.meta.dir}/image-component.isolated.ts`],{stdout:'pipe',stderr:'pipe'});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit,out+err).toBe(0);
});
