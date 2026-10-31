import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function run(args:string[],env:Record<string,string|undefined>){
 const child=Bun.spawn([process.execPath,...args],{env,stdout:'pipe',stderr:'pipe'});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit,out+err).toBe(0);return out;
}
for(const baseline of [true,false])test(`real ReaderBody inline contain, relayout, retained rows and filePath: ${baseline?'frozen U3':'framework'}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-image-'));const env={...process.env,WRSS_IMAGE_BASELINE:baseline?'1':''};
 try{await run([join(import.meta.dir,'fixtures/build-reader-image.ts'),dir],env);
  for(const local of [false,true])for(const native of [false,true])await run([join(dir,'reader-image.js')],{...env,LOCAL:local?'1':'',NATIVE_LAYOUT:native?'1':'0'});
  if(!baseline)for(const page of [false,true])await run([join(dir,'reader-image.js')],{...env,LOCAL:'1',NATIVE_LAYOUT:'0',LATE_IMAGE:'1',PAGE_MODE:page?'1':'0'});
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
