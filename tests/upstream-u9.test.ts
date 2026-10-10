import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import hashes from './fixtures/upstream-u9/sha256.json';
test('U9 originals retain frozen d1d4515 byte provenance',()=>{
 for(const [name,hash] of Object.entries(hashes))expect(createHash('sha256').update(readFileSync(import.meta.dir+'/fixtures/upstream-u9/'+name+'.txt')).digest('hex')).toBe(hash);
});
for(const suite of ['algorithms','overlay'])test('U9 '+suite+' isolated browser verification',()=>{
 const result=Bun.spawnSync(['bun','--conditions=browser','test','./tests/upstream-u9-'+suite+'.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 if(result.exitCode)console.error(new TextDecoder().decode(result.stderr));expect(result.exitCode).toBe(0);
});
