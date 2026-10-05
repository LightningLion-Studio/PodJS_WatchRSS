import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('host cloud factory reads application.buildInfo and exits release before any other I/O',()=>{
 // Existing UI tests mock framework modules globally; verify the real bridge in isolation.
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./host-release.fixture.ts',import.meta.url))]);
 expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
});
test('debug host codec uses bounded file operations for incompressible 4 MiB chunks and cleans all temporary files',()=>{
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./host-debug.fixture.ts',import.meta.url))]);
 expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
});
