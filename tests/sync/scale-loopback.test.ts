import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('5500 library loopback with isolated runtime and durable recovery',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'test',resolve(import.meta.dir,'scale-loopback.isolated.ts')],{stdout:'inherit',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,Promise.resolve(''),new Response(child.stderr).text()]);
 console.log(out);expect(code,err).toBe(0);expect(err).toContain('1 pass');
},360000);
