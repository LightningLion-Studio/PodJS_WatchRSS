import {test,expect} from 'bun:test';
import {bookFixture} from '../books/fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {playbackWork,PlaybackWork} from '../../src/core/playback-work';
test('video and speech route owners defer local reconstruction until every route releases',async()=>{
 const f=await bookFixture(),video=playbackWork.hold(),speech=playbackWork.hold();let operations=0,done=false;
 const db={...f.db,query:async(...args:Parameters<typeof f.db.query>)=>{operations++;return f.db.query(...args);}};
 try{const repo=new SqlLibrarySessionRepository(db,f.ports);const task=repo.prepareFastProjection().then(()=>{done=true;});await new Promise(r=>setTimeout(r,20));expect(operations).toBe(0);expect(done).toBe(false);video();await new Promise(r=>setTimeout(r,10));expect(done).toBe(false);speech();await task;expect(done).toBe(true);expect(operations).toBeGreaterThan(0);}
 finally{video();speech();f.sql.close();}
});
test('deferred reconstruction rechecks cancellation without advancing work',async()=>{
 const gate=new PlaybackWork(),release=gate.hold();let cancelled=false,commits=0;const task=gate.wait(()=>{if(cancelled)throw Error('cancelled');}).then(()=>{commits++;});cancelled=true;release();await expect(task).rejects.toThrow('cancelled');expect(commits).toBe(0);
});
test('a throwing observer cannot leak an owner or prevent another observer from resuming',async()=>{
 const gate=new PlaybackWork(),events:boolean[]=[];const off=gate.subscribe(()=>{throw Error('disposed cloud guard');});gate.subscribe(active=>events.push(active));
 let release:()=>void=()=>{};expect(()=>{release=gate.hold();}).not.toThrow();expect(gate.active).toBe(true);const waiting=gate.wait();expect(()=>release()).not.toThrow();await waiting;off();expect(gate.active).toBe(false);expect(events).toEqual([true,false]);
});
test('playback and background interleavings fence the old run, release its lease, and resume one queued run',async()=>{
 const {CloudForegroundExecution,cloudRunHost}=await import('../../src/cloud/execution');const {WatchCloudScheduler}=await import('../../src/cloud/scheduler');
 const gate=new PlaybackWork(),execution=new CloudForegroundExecution(true);let foreground=true,runs=0,acks=0,releases=0,finish!:()=>void;
 const pending=new Promise<void>(r=>{finish=r;});
 const scheduler=new WatchCloudScheduler({now:()=>0,delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{},sync:async()=>{
  runs++;const current=execution.begin(),host=cloudRunHost(async<T>(method:string)=>{if(method==='test.ack')acks++;if(method==='cloud.release')releases++;return {} as T;},current);
  try{if(runs===1)await pending;await host('test.ack',{});return true;}catch{return false;}finally{await host('cloud.release',{});}
 }},{require(){}});
 const off=gate.subscribe(active=>{execution.foreground(foreground&&!active);scheduler.hold(active);});
 try{
  scheduler.foreground(true);expect(runs).toBe(1);const video=gate.hold(),speech=gate.hold();scheduler.trigger();
  finish();for(let i=0;i<15;i++)await Promise.resolve();expect(acks).toBe(0);expect(releases).toBe(1);expect(runs).toBe(1);
  foreground=false;execution.foreground(false);scheduler.foreground(false);video();speech();for(let i=0;i<15;i++)await Promise.resolve();expect(runs).toBe(1);
  foreground=true;execution.foreground(true);scheduler.foreground(true);for(let i=0;i<15;i++)await Promise.resolve();expect(runs).toBe(2);expect(acks).toBe(1);expect(releases).toBe(2);
 }finally{off();scheduler.dispose();}
});
