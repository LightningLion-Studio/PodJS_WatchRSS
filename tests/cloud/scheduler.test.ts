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

test('an unbound/empty sync result does not create a retry timer or a background spin',async()=>{
 let runs=0,timers=0;const s=new WatchCloudScheduler({now:()=>0,sync:async()=>{runs++;return false;},delay:()=>{timers++;return()=>{};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);await settle();for(let i=0;i<100;i++)await settle();expect(runs).toBe(1);expect(timers).toBe(0);
 s.foreground(false);for(let i=0;i<100;i++)s.trigger();await settle();expect(runs).toBe(1);expect(timers).toBe(0);s.dispose();
});

test('R47 local transfer hold defers changes until close and does not invent a no-change cloud run',async()=>{
 let count=0,now=0;const timers:{fn:()=>void;cancelled:boolean}[]=[];const s=new WatchCloudScheduler({now:()=>now,sync:async()=>{count++;return true;},delay:(_,fn)=>{const t={fn,cancelled:false};timers.push(t);return()=>{t.cancelled=true;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);await settle();expect(count).toBe(1);s.hold(true);s.hold(false);await settle();expect(count).toBe(1);expect(timers).toHaveLength(0);
 s.hold(true);s.trigger();s.trigger();now=CLOUD_INTERVAL;expect(count).toBe(1);s.hold(false);await settle();expect(count).toBe(2);s.dispose();
});
test('R47 cloud hold fences active work and retains an explicit queued full manual request',async()=>{
 const {CloudForegroundExecution}=await import('../../src/cloud/execution');const {LocalTransferActivity}=await import('../../src/sync/local-transfer');const activity=new LocalTransferActivity(),execution=new CloudForegroundExecution(true);let finish!:(b:boolean)=>void;const modes:string[]=[];
 const s=new WatchCloudScheduler({now:()=>0,sync:async(_,mode)=>{modes.push(mode!);return new Promise<boolean>(r=>{finish=r;});},delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 const off=activity.subscribe(active=>{execution.foreground(!active);s.hold(active);});s.foreground(true);const old=execution.begin();const release=activity.acquire(),nested=activity.acquire();expect(()=>old()).toThrow('cloud_sync_suspended');finish(false);await settle();expect(await s.manual('all')).toBe(false);expect(await s.manual('recent128')).toBe(false);release();release();expect(activity.active).toBe(true);expect(modes).toEqual(['recent128']);nested();await settle();expect(modes).toEqual(['recent128','all']);expect(()=>old()).toThrow();expect(()=>execution.begin()).not.toThrow();finish(true);await settle();s.dispose();off();
});

test('R47 suspending an already-running manual all run resumes its original scope',async()=>{
 const calls:[boolean,string|undefined][]=[],finishes:((v:boolean)=>void)[]=[];const s=new WatchCloudScheduler({now:()=>0,sync:(manual,mode)=>{calls.push([manual,mode]);return new Promise<boolean>(r=>finishes.push(r));},delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);finishes[0]!(true);await settle();const full=s.manual('all');await settle();s.hold(true);finishes[1]!(false);await full;await settle();expect(calls).toEqual([[false,'recent128'],[true,'all']]);s.hold(false);await settle();expect(calls.at(-1)).toEqual([true,'all']);finishes[2]!(true);await settle();s.dispose();
});

test('R47 an in-flight cloud run that completes successfully during a no-change local transfer needs no replay',async()=>{
 let count=0,finish!:(v:boolean)=>void;const s=new WatchCloudScheduler({now:()=>0,sync:async()=>{count++;return new Promise<boolean>(r=>{finish=r;});},delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);s.hold(true);finish(true);await settle();s.hold(false);await settle();expect(count).toBe(1);s.dispose();
});
test('account replacement discards a delayed manual all retry and never authorizes a full run for the new account',async()=>{
 let now=0;const calls:[boolean,string|undefined][]=[],timers:{fn:()=>void;cancelled:boolean}[]=[];
 const scheduler=new WatchCloudScheduler({now:()=>now,sync:async(manual,mode)=>{calls.push([manual,mode]);return true;},delay:(_ms,fn)=>{const timer={fn,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 scheduler.deferUntil(30000,'all');scheduler.foreground(true);expect(calls).toEqual([]);scheduler.accountChanged();await settle();expect(calls).toEqual([[false,'recent128']]);now=30000;for(const timer of timers)if(!timer.cancelled)timer.fn();await settle();expect(calls.every(([manual])=>!manual)).toBe(true);scheduler.dispose();
});
test('an old held run cannot restore its manual authorization after an account replacement',async()=>{
 let finish!:(success:boolean)=>void;const calls:[boolean,string|undefined][]=[];
 const scheduler=new WatchCloudScheduler({now:()=>0,sync:async(manual,mode)=>{calls.push([manual,mode]);return calls.length===1?new Promise<boolean>(r=>finish=r):true;},delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 const run=scheduler.manual('all');await settle();scheduler.hold(true);scheduler.foreground(true);scheduler.accountChanged();finish(false);await run;await settle();scheduler.hold(false);await settle();expect(calls).toEqual([[true,'all'],[false,'recent128']]);scheduler.dispose();
});
