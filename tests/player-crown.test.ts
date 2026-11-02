import {expect,test} from "bun:test";
test("real player crown integration in an isolated module runtime",()=>{
 const run=Bun.spawnSync([process.execPath,"--conditions=browser","test","./tests/player-crown.isolated.ts"],{cwd:process.cwd(),env:process.env});
 expect(run.exitCode,run.stderr.toString()).toBe(0);
});
