import {test,expect} from 'bun:test';
import {WatchCloudScheduler,CLOUD_INTERVAL} from '../../src/cloud/scheduler';
import {enabled} from './k2-crypto';
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('foreground/account/network/data bursts coalesce at five minutes; inactive pauses; manual bypasses',async()=>{
 let now=0;const calls:boolean[]=[],timers:{at:number;fn:()=>void;cancelled:boolean}[]=[];let scheduled=0,cancelled=0;
 const scheduler=new WatchCloudScheduler({now:()=>now,sync:async manual=>{calls.push(manual);return true;},delay:(ms,fn)=>{const t={at:now+ms,fn,cancelled:false};timers.push(t);return ()=>{t.cancelled=true;};},scheduleWorker:async()=>{scheduled++;},cancelWorker:async()=>{cancelled++;}},enabled);
 await scheduler.start(true);scheduler.foreground(true);await settle();expect(calls).toEqual([false]);
 for(let i=0;i<20;i++)scheduler.trigger();expect(timers.filter(t=>!t.cancelled)).toHaveLength(1);expect(timers[0].at).toBe(CLOUD_INTERVAL);
 now=CLOUD_INTERVAL;timers[0].fn();await settle();expect(calls).toEqual([false,false]);scheduler.foreground(false);scheduler.trigger();expect(calls).toHaveLength(2);
 expect(await scheduler.manual()).toBe(true);expect(calls).toEqual([false,false,true]);scheduler.dispose();expect(scheduled).toBe(1);expect(cancelled).toBe(0);
});
test('explicitly disabled scheduler cancels old worker; default uninitialized host gate fails closed',async()=>{
 const calls:string[]=[];const ports={now:()=>0,delay:()=>()=>{},sync:async()=>{calls.push('sync');return true;},scheduleWorker:async()=>{calls.push('schedule');},cancelWorker:async()=>{calls.push('cancel');}};
 const s=new WatchCloudScheduler(ports);await s.start(false);expect(calls).toEqual(['cancel']);expect(()=>s.foreground(true)).toThrow();await expect(s.start(true)).rejects.toThrow();
});
test('events received while syncing schedule one trailing run and never overlap',async()=>{
 let finish:((v:boolean)=>void)|undefined,now=0,count=0;let timer:(()=>void)|undefined;
 const s=new WatchCloudScheduler({now:()=>now,sync:async()=>{count++;return new Promise<boolean>(resolve=>{finish=resolve;});},delay:(_,fn)=>{timer=fn;return ()=>{timer=undefined;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);s.trigger();s.trigger();expect(count).toBe(1);finish!(true);await settle();expect(timer).toBeDefined();now=CLOUD_INTERVAL;timer!();expect(count).toBe(2);finish!(true);await settle();s.dispose();
});

test('committed reading/save/source mutations notify scheduling without UI refresh or derived cache noise',async()=>{
 const {subscribeLibraryMutations,notifyLibrarySqlCommit}=await import('../../src/core/library-mutations');let calls=0;const stop=subscribeLibraryMutations(()=>{calls++;});
 notifyLibrarySqlCommit([{sql:'UPDATE articles SET is_read=1 WHERE id=?'}]);notifyLibrarySqlCommit([{sql:'INSERT INTO article_reading_state VALUES(?)'}]);notifyLibrarySqlCommit([{sql:'DELETE FROM article_saved_states WHERE article_id=?'}]);expect(calls).toBe(3);
 notifyLibrarySqlCommit([{sql:'INSERT INTO article_sync_encoding_cache VALUES(?)'}]);notifyLibrarySqlCommit([{sql:'CREATE TABLE IF NOT EXISTS articles(id)'}]);expect(calls).toBe(3);stop();notifyLibrarySqlCommit([{sql:'DELETE FROM channels'}]);expect(calls).toBe(3);
});
test('R35 deferred deadline wins normal debounce; pausing preserves it, account replacement cancels it',async()=>{
 let now=0,runs=0;const timers:{at:number;fn:()=>void;cancelled:boolean}[]=[];const s=new WatchCloudScheduler({now:()=>now,sync:async()=>{runs++;return true;},delay:(ms,fn)=>{const t={at:now+ms,fn,cancelled:false};timers.push(t);return()=>{t.cancelled=true;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);await settle();now=590000;await s.manual();s.deferUntil(600000);await settle();expect(timers.at(-1)!.at).toBe(600000);s.foreground(false);expect(timers.at(-1)!.cancelled).toBe(true);s.foreground(true);expect(timers.at(-1)!.at).toBe(600000);s.accountChanged();await settle();expect(timers.at(-1)!.cancelled).toBe(true);expect(runs).toBe(3);s.dispose();
});
test('R45 upgrade response cancels automatic/worker retries; explicit manual retry and a new account remain possible',async()=>{let count=0,cancelled=0,scheduled=0;const s=new WatchCloudScheduler({now:()=>0,sync:async()=>{count++;return true;},delay:()=>()=>{},scheduleWorker:async()=>{scheduled++;},cancelWorker:async()=>{cancelled++;}},enabled);await s.start(true);s.foreground(true);await settle();await s.setUpgradeRequired(true);for(let i=0;i<20;i++){s.trigger();s.foreground(true);}expect(count).toBe(1);expect(cancelled).toBe(1);expect(await s.manual()).toBe(true);expect(count).toBe(2);s.accountChanged();await settle();expect(scheduled).toBe(2);expect(count).toBe(3);s.dispose();});
