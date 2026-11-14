import {expect,test} from 'bun:test';
for(const platform of ['rss','bili','douyin'])for(const angle of [0,30,90,180,270])test(`rotated production shell ${platform} ${angle}`,()=>{
 const child=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/rotgest-shell.isolated.ts'],{cwd:import.meta.dir+'/..',env:{...process.env,ROTGEST_PLATFORM:platform,ROTGEST_ANGLE:String(angle)},stdout:'pipe',stderr:'pipe'});
 expect(child.exitCode,child.stdout.toString()+child.stderr.toString()).toBe(0);
});
