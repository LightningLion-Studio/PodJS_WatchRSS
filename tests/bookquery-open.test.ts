import {expect,test} from 'bun:test';
for(const mode of ['superseded','late','input','mark-late','roundtrip','continuous','page','restoring-continuous','restoring-page','chunk-continuous','chunk-page','retry-late-continuous','retry-late-page'])test(`BOOKQUERY real routes: ${mode}`,async()=>{
 const child=Bun.spawn([process.execPath,'--conditions=browser','test','./tests/bookquery-open.isolated.ts'],{cwd:import.meta.dir+'/..',env:{...process.env,BOOKQUERY_CASE:mode},stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
},30000);
