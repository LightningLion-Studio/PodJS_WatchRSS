import { test, expect } from "bun:test";
import { resolve } from "node:path";
// Host module mocks are process-global in Bun. Keep distinct native shims isolated.
for(const name of ["image", "browser-auth"]){
 (process.env.PODJS_TEST_WORKERS==='2'?test.concurrent:test)(`${name} native host contract in an isolated runtime`,async()=>{
  const process = Bun.spawn([Bun.which("bun")!, "--conditions=browser", "test", resolve(import.meta.dir,`${name}.isolated.ts`)],{stdout:"pipe",stderr:"pipe",timeout:5000});
  try{
   const [exit,stdout,stderr]=await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);
   expect(exit,stdout+stderr).toBe(0);
   expect(stderr+stdout).toMatch(/[1-9]\d* pass/);
  }finally{if(process.exitCode===null){process.kill();await process.exited;}}
 });
}
