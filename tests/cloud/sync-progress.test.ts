import {expect,test} from 'bun:test';
import {SyncProgress,type SyncProgressSnapshot} from '../../src/cloud/sync-progress';
import {Clock} from '../helpers/ip-fixture';

function fixture(){
 const clock=new Clock(),summaries:string[]=[];
 const progress=new SyncProgress(()=>clock.now,(ms,callback)=>{
  const timer=clock.delay(ms);
  void timer.result.then(callback,()=>{});
  return ()=>timer.cancel();
 },line=>summaries.push(line));
 return {clock,progress,summaries};
}

test('phase transitions and finish publish immediately; changed counts publish at most every 500 ms',async()=>{
 const {clock,progress}=fixture(),events:[number,SyncProgressSnapshot|undefined][]=[];
 progress.subscribe(value=>events.push([clock.now,value]));
 progress.start();
 await clock.advance(100);
 progress.stage('download');
 progress.plan('items',10);
 progress.advance(1);
 await clock.advance(499);
 progress.advance(1);
 expect(events.map(([at])=>at)).toEqual([0,100]);
 await clock.advance(1);
 expect(events.at(-1)).toEqual([600,{stage:'download',count:{unit:'items',total:10,done:2}}]);
 progress.advance(0);
 await clock.advance(10);
 progress.stage('write');
 expect(events.at(-1)).toEqual([610,{stage:'write'}]);
 progress.finish('complete');
 expect(events.at(-1)).toEqual([610,{stage:'complete'}]);
 await clock.advance(500);
 expect(events).toHaveLength(5);
});

test('hidden consumers stop receiving events and can read the latest count on return',async()=>{
 const {clock,progress}=fixture();
 let events=0;
 const stop=progress.subscribe(()=>events++);
 progress.start();
 progress.stage('download');
 progress.plan('items',10);
 progress.advance(4);
 stop();
 await clock.advance(500);
 expect(events).toBe(2);
 expect(progress.snapshot?.count).toEqual({unit:'items',total:10,done:4});
 expect(clock.timers.every(timer=>timer.cancelled)).toBe(true);
});

test('round summary records stage timings, routes, payload sizes and anonymous note timestamps only',async()=>{
 const {clock,progress,summaries}=fixture();
 progress.start({savedAt:0});
 await clock.advance(3000);
 progress.stage('upload');
 const complete=progress.request('PUT','https://private-account.example/functions/v1/sync/v2/objects/note-object-id/parts/65536?token=private-token');
 const other=progress.request('GET','https://private-account.example/private-note-text');
 progress.advance(1);
 await clock.advance(250);
 complete?.(64,32);
 other?.(0,10);
 progress.finish('complete');
 expect(summaries).toHaveLength(1);
 const summary=JSON.parse(summaries[0]!);
 expect(summary.note).toEqual({savedAt:0,publishStartedAt:3000,syncedAt:3250});
 expect(summary.stages[1]).toEqual({stage:'upload',startedAt:3000,durationMs:250,requests:2,
  routes:{'PUT /functions/v1/sync/v2/objects/{oid}/parts/{offset}':1,other:1},
  objects:1,sentBytes:64,receivedBytes:42,httpMs:500});
 expect(summaries[0]).not.toMatch(/private|note-object-id|65536|token/);
});
