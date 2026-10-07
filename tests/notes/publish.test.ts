import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
for(const mode of ['first','entry','late','revisit'])test(`note publication through production timer contract: ${mode}`,async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test',fileURLToPath(new URL('./publish.isolated.ts',import.meta.url))],{env:{...process.env,NOTE_PUBLISH_CASE:mode},stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
},30000);
