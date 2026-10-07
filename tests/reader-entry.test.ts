import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
for(const mode of ['saved','prefix','cancel','portable'])test(`ReaderBody entry through production defaults: ${mode}`,async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',fileURLToPath(new URL('./reader-entry.isolated.ts',import.meta.url))],{env:{...process.env,READER_ENTRY_CASE:mode},stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
},30000);
