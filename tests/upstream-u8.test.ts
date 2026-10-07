import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import hashes from './fixtures/upstream-u8/sha256.json';
test('U8 oracle originals retain frozen 592c763 SHA256 provenance',()=>{
 for(const [name,hash] of Object.entries(hashes))expect(createHash('sha256').update(readFileSync(import.meta.dir+'/fixtures/upstream-u8/'+name+'.txt')).digest('hex')).toBe(hash);
});
for(const suite of ['algorithms','components'])test('U8 '+suite+' frozen differential in isolated browser runtime',()=>{
 const result=Bun.spawnSync(['bun','--conditions=browser','test','./tests/upstream-u8-'+suite+'.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 if(result.exitCode)console.error(new TextDecoder().decode(result.stderr));expect(result.exitCode).toBe(0);
});
