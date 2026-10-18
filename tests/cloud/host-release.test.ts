import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('release cloud factory initializes without import-time network or data access',()=>{
 // Existing UI tests mock framework modules globally; verify the real bridge in isolation.
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./host-release.fixture.ts',import.meta.url))]);
 expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
});
test('release and debug host codecs preserve encrypted 4 MiB round trips and temporary cleanup',()=>{
 for(const release of ['0','1']){
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./host-debug.fixture.ts',import.meta.url))],{env:{...process.env,CLOUD_RELEASE:release}});
 expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
 }
// This is a 4 MiB correctness subprocess, not a five-second performance gate.
},60_000);
