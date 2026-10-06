import {expect,test} from "bun:test";
import {resolve} from "node:path";
test("home mounts only visible text measurements",async()=>{
 const child=Bun.spawn([Bun.which("bun")!,"--conditions=browser","test",resolve(import.meta.dir,"home-lazy-measure.isolated.ts")],{stdout:"pipe",stderr:"pipe"});
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit,out+err).toBe(0);
});
