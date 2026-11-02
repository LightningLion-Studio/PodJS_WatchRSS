import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
test('production idle stock ownership follows semantic idle transitions',()=>{const p=Bun.spawnSync(['bun','--conditions=browser','test',resolve(import.meta.dir,'douyin-stock-lifecycle.isolated.ts')],{cwd:process.cwd(),env:process.env});expect(p.exitCode,p.stdout.toString()+p.stderr.toString()).toBe(0);});
