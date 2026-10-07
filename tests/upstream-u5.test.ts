import {expect,test} from "bun:test";
import {startupExitFrame} from "../src/ui/startup-transition.ts";
import {startupExitFrame as before} from "./fixtures/upstream-u5/startup-transition.ts";
test("U5 startup frozen oracle including nonfinite and fractional times",()=>{for(const time of [NaN,Infinity,-Infinity,-1,0,1,299.9,300,301,...Array.from({length:4000},(_,i)=>i/7-100)])expect(startupExitFrame(time)).toEqual(before(time));});
test("U5 component differential browser process",async()=>{const child=Bun.spawn([Bun.which("bun")!,"--conditions=browser","test",import.meta.dir+"/upstream-u5.isolated.ts"],{stdout:"pipe",stderr:"pipe"});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);});
