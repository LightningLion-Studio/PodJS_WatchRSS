import {expect,test} from "bun:test";
import {resolve} from "node:path";
test("reader text rows preserve production geometry and share host queries",async()=>{
  const child=Bun.spawn([Bun.which("bun")!,"--conditions=browser","test",resolve(import.meta.dir,"reader-text-row.isolated.ts")],{stdout:"pipe",stderr:"pipe"});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(exit,out+err).toBe(0);
});
