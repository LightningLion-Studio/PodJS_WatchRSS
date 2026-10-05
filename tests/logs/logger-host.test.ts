import {test,expect} from 'bun:test';

test('host logger creates missing file, chunks UTF-8, atomically trims/clears and reloads',()=>{
 const result=Bun.spawnSync(['bun','--eval',String.raw`
  import {mock} from 'bun:test';
  import {strict as assert} from 'node:assert';
  import {createHash} from 'node:crypto';
  const files=new Map(),calls=[];let sequence=0,failCommit=false;
  const bytes=p=>{assert(files.has(p),'missing file '+p);return files.get(p);};
  const api={
   async stat(p){return {exists:files.has(p),size:files.get(p)?.length??0};},
   async read(p,offset,max){const b=bytes(p);return {offset,size:b.length,eof:offset+max>=b.length,dataBase64:b.subarray(offset,offset+max).toString('base64')};},
   async write(p,s){const b=Buffer.from(s,'base64');assert(b.length<=65536);files.set(p,b);return {size:b.length};},
   async append(p,s,offset){const old=bytes(p),b=Buffer.from(s,'base64');assert.equal(old.length,offset);assert(b.length<=65536);files.set(p,Buffer.concat([old,b]));calls.push(['append',p,b.length]);return {size:old.length+b.length};},
   async createTemp(dir){const path=dir+'/'+ ++sequence;files.set(path,Buffer.alloc(0));return {path};},
   async hash(p){const b=bytes(p);return {size:b.length,sha256:createHash('sha256').update(b).digest('hex')};},
   async commit(p,target,size,hash){assert.deepEqual(await api.hash(p),{size,sha256:hash});if(failCommit)throw Error('commit failed');files.set(target,bytes(p));files.delete(p);calls.push(['commit',target]);},
   async remove(p){files.delete(p);}
  };
  mock.module('@podjs/framework/watch',()=>({kv:{get(){}}}));
  mock.module('@podjs/framework/services',()=>({fileChunks:api}));
  const {createHostLogFile}=await import('./src/logs/logger-host.ts');
  const {AppLogger}=await import('./src/logs/app-logger.ts');
  const file=createHostLogFile();const log=new AppLogger(file);
  assert.equal(await log.readLogs(),null);
  log.i('Network','初'.repeat(30000)+'😀'+'尾'.repeat(30000));
  await log.flush();const full=await log.readLogs();assert(full.includes('初'.repeat(30000)+'😀'+'尾'.repeat(30000)));
  assert(calls.filter(c=>c[0]==='append').length>=3);
  assert.equal(await new AppLogger(createHostLogFile()).readLogs(),full);
  files.set('app_log.txt',Buffer.from(Array.from({length:10},(_,i)=>i+':'+ '中'.repeat(180000)).join('\n')+'\n'));
  log.d('T','rotate');await log.flush();assert((await log.readLogs()).startsWith('2:'));assert(calls.some(c=>c[0]==='commit'));
  const before=await file.read();failCommit=true;await assert.rejects(file.replace('new'));assert.equal(await file.read(),before);assert.equal(files.size,1);failCommit=false;
  await log.clearLogs();assert((await log.readLogs()).includes('日志已清空'));assert.equal(files.size,1);
 `],{cwd:new URL('../..',import.meta.url).pathname,stdout:'pipe',stderr:'pipe'});
 expect(result.stderr.toString()).toBe('');expect(result.exitCode).toBe(0);
});
