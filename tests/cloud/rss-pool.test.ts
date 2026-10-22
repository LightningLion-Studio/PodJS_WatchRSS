import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('public pool real client resolves first, fetches entries, preserves XML text and fences logout/cancellation',()=>{
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./rss-pool.fixture.ts',import.meta.url))]);expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
});
