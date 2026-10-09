import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import hashes from './fixtures/upstream-u12/sha256.json';
test('U12 original files retain ba59997 byte provenance',()=>{for(const [name,hash] of Object.entries(hashes))expect(createHash('sha256').update(readFileSync(import.meta.dir+'/fixtures/upstream-u12/'+name)).digest('hex')).toBe(hash);});
test('U12 navigation and host-file adapters preserve frozen outputs and host calls',()=>{
 const r=Bun.spawnSync(['bun','--conditions=browser','test','./tests/upstream-u12.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
 expect(r.exitCode,new TextDecoder().decode(r.stderr)).toBe(0);
},120000);
