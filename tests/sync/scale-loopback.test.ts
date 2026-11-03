import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {SCALE_LOOPBACK_ARTICLES,SCALE_LOOPBACK_CHILD_MS,SCALE_LOOPBACK_PARENT_MS} from './scale-loopback-budget';
test(`${SCALE_LOOPBACK_ARTICLES} library loopback with isolated runtime and durable recovery`,async()=>{
 const child=Bun.spawn([Bun.which('bun')!,'test',resolve(import.meta.dir,'scale-loopback.isolated.ts')],{stdout:'inherit',stderr:'pipe'});
 // A child stalled outside Bun's test callback must not outlive the parent.
 const watchdog=setTimeout(()=>child.kill(),SCALE_LOOPBACK_CHILD_MS);
 try {
  const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(err).toContain('1 pass');
 } finally {clearTimeout(watchdog);if(child.exitCode===null)child.kill();}
},SCALE_LOOPBACK_PARENT_MS);
