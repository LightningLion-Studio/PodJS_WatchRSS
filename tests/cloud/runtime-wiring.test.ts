import {test,expect} from 'bun:test';
import ts from 'typescript';
import {resolve} from 'node:path';
import {runtimeSession} from './runtime-wiring.fixture';
import {readingThroughputFixture} from './reading-throughput-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import type {WatchCloudLibraryAdapter} from '../../src/cloud/library';

test('real createCloudRuntime/openSession forwards body-free public methods and work to the app log',async()=>{
 const f=await readingThroughputFixture(12);try{
  const repo=Object.assign(new SqlLibrarySessionRepository(f.db,{...f.ports,codec:{...f.ports.codec,encode:async()=>{throw Error('gzip forbidden');},decode:async()=>{throw Error('gunzip forbidden');}}}),{deviceId:async()=> 'watch'});repo.mergeCloud=async()=>{throw Error('old mergeCloud forbidden');};
  const run=await runtimeSession(repo),adapter=run.session.library as WatchCloudLibraryAdapter;
  const work=async<T>(stage:any,units:number,action:()=>Promise<T>|T)=>{const value=await action();run.diagnostic.report(JSON.stringify({event:'records-work',stage,units,durationMillis:1,outcome:'complete'}));return value;};
  await adapter.applyRecords(f.metadata,false,work);await adapter.applyRecords(f.docs,false,work);await run.diagnostic.flush();
  expect((await f.db.query('SELECT count(*) n FROM article_reading_state WHERE changed_at>=100'))[0].n).toBe(12);expect(run.logs.join('')).toContain('"stage":"reading-index"');expect(run.logs.join('')).toContain('"stage":"reading-merge"');
  const coldRepo=Object.assign(new SqlLibrarySessionRepository(f.db,f.ports),{deviceId:async()=> 'watch'});coldRepo.mergeCloud=async()=>{throw Error('old reading merge forbidden');};const cold=await runtimeSession(coldRepo),coldWork=async<T>(stage:any,units:number,action:()=>Promise<T>|T)=>{const value=await action();cold.diagnostic.report(JSON.stringify({event:'records-work',stage,units,durationMillis:1,outcome:'complete'}));return value;};await (cold.session.library as WatchCloudLibraryAdapter).applyRecords(f.docs,false,coldWork);await cold.diagnostic.flush();expect(cold.logs.join('')).toContain('"stage":"reading-index"');
 }finally{f.sql.close();}
});

test('all optional adapter methods, including inherited book methods, belong to the actual runtime proxy',async()=>{
 const f=await readingThroughputFixture(1);try{
  const run=await runtimeSession(Object.assign(f.repo,{deviceId:async()=> 'watch'}));
  const config=ts.readConfigFile(resolve('tsconfig.json'),ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd()),program=ts.createProgram([resolve('src/cloud/library.ts')],parsed.options),checker=program.getTypeChecker(),source=program.getSourceFile(resolve('src/cloud/library.ts'))!,declaration=source.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='CloudLibraryRepository')!;
  const optional=checker.getTypeAtLocation(declaration).getProperties().filter(s=>s.flags&ts.SymbolFlags.Optional).map(s=>s.name).sort(),keys=Object.keys(run.proxy);
  expect(optional.length).toBeGreaterThan(12);for(const method of optional){expect(keys,method).toContain(method);expect(typeof (run.proxy as any)[method],method).toBe(typeof (f.repo as any)[method]);}
  // This comparison automatically acquires future interface members; it does
  // not maintain a second hard-coded method list alongside the proxy.
  expect(optional).toContain('mergeCloudReading');expect(optional).toContain('mergeCloudPublicMetadata');expect(optional).toContain('mergeCloudLegacyBookReading');
 }finally{f.sql.close();}
},30000);

test('runtime mutation proxies fence account, owner, run cancellation and post-IO changes before returning',async()=>{
 const f=await readingThroughputFixture(1);try{
  for(const reason of ['account','owner','run','post-account']){
   let cancelled=false,calls=0;const repo=Object.assign(f.repo,{deviceId:async()=> 'watch'}),run=await runtimeSession(repo,()=>{if(cancelled)throw Error('cloud_sync_suspended');});
   repo.mergeCloudReading=async()=>{calls++;if(reason==='post-account')run.values.delete('state_json');return 0;};
   if(reason==='account')run.values.delete('state_json');if(reason==='owner')run.values.set('watchrss.library.owner','other');if(reason==='run')cancelled=true;
   await expect(run.proxy.mergeCloudReading!([])).rejects.toThrow();expect(calls).toBe(reason==='post-account'?1:0);
  }
 }finally{f.sql.close();}
});
