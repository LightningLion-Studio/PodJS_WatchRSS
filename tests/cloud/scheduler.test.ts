import {test,expect} from 'bun:test';
import {WatchCloudScheduler,CLOUD_INTERVAL} from '../../src/cloud/scheduler';
import {enabled} from './k2-crypto';
import {WatchHeadPoll} from '../../src/cloud/head-poll';
import {PlaybackWork} from '../../src/core/playback-work';
import {LocalTransferActivity} from '../../src/sync/local-transfer';
import {Clock,deferred,flush} from '../helpers/ip-fixture';
import type {ManualIntent} from '../../src/cloud/manual-handoff';
import {CloudVisibility} from '../../src/cloud/visibility';
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


test('restored durable manual grant shares the active run and respects its upgrade stop',async()=>{
 let finish!:(value:boolean)=>void,count=0;const s=new WatchCloudScheduler({now:()=>0,sync:()=>{count++;return new Promise<boolean>(resolve=>{finish=resolve;});},delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 s.foreground(true);const restore=s.manual('all',true);expect(count).toBe(1);
 await s.setUpgradeRequired(true);finish(false);expect(await restore).toBe(false);await settle();expect(count).toBe(1);
 expect(await s.manual('all',true)).toBe(false);expect(count).toBe(1);
 const explicit=s.manual('all');await settle();expect(count).toBe(2);finish(true);expect(await explicit).toBe(true);s.dispose();
});

test('a new explicit request waits for the previous account without receiving its follow-up error',async()=>{
 let account='A',fail!: (reason:Error)=>void;
 const calls:string[]=[];
 const s=new WatchCloudScheduler({now:()=>0,delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{},
  sync:async()=>{
   calls.push(account);
   if(account==='A')await new Promise<void>((_done,reject)=>{fail=reject;});
   return true;
  },
 },enabled);
 const old=s.manual().catch(error=>error);
 account='B';
 s.accountChanged();
 const next=s.manual();
 expect(calls).toEqual(['A']);
 const cleanup=Error('A follow-up failed');
 fail(cleanup);
 expect(await old).toBe(cleanup);
 expect(await next).toBe(true);
 expect(calls).toEqual(['A','B']);
 s.dispose();
});

const wakeSources=[
 'phone release','playback release','foreground','network','retry deadline',
 'account notification','cold start','approval delivery',
] as const;
const queuedWork=['approval','durable grant','suspended writer'] as const;
for(const wake of wakeSources)for(const work of queuedWork)for(const failed of [false,true]){
 test(`wake matrix: ${wake} / ${work} / previous preparation ${failed?'failed':'succeeded'}`,async()=>{
  const clock=new Clock();
  const scope=JSON.stringify(['fixture','https://fixture.invalid']);
  const grant:ManualIntent={version:2,token:'fixture_all',scope,mode:'all',epoch:null,createdAt:0};
  const calls:{manual:boolean;mode:string;scope:string}[]=[],cleared:string[]=[];
  let stored:ManualIntent|undefined;
  let priorAttempt=false,prepareAttempts=0;
  let writer:ReturnType<typeof deferred<boolean>>|undefined;
  const playback=new PlaybackWork(),phone=new LocalTransferActivity();
  const makeScheduler=()=>new WatchCloudScheduler({
   now:()=>clock.now,
   delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn).catch(()=>{});return ()=>timer.cancel();},
   scheduleWorker:async()=>{},cancelWorker:async()=>{},
   prepare:()=>{if(!priorAttempt)return true;prepareAttempts++;return !failed;},
   mayHavePendingIntent:()=>!!stored,
   async sync(requestedManual,mode,run){
    // With successful preparation, fail the next read instead. This leaves
    // the same work pending and tests the two distinct pre-execution exits.
    if(priorAttempt)throw Error('fixture pre-execution read failure');
    if(requestedManual&&!stored)return false;
    run.bindIntent(stored);
    calls.push({manual:!!stored||run.afterApproval,mode:stored?.mode??mode,scope});
    if(writer)return writer.result;
    if(stored){cleared.push(stored.token);stored=undefined;}
    return true;
   },
  },enabled);
  let scheduler=makeScheduler();
  const offPhone=phone.subscribe(held=>scheduler.hold(held||playback.active));
  const offPlayback=playback.subscribe(held=>scheduler.hold(held||phone.active));
  try{
   if(work==='suspended writer')writer=deferred<boolean>();
   scheduler.foreground(true);await flush();
   expect(calls).toEqual([{manual:false,mode:'recent128',scope}]);
   calls.length=0;
   priorAttempt=true;
   await clock.advance(CLOUD_INTERVAL);
   if(work==='approval')scheduler.approvalCompleted();
   if(work==='durable grant'){
    stored=grant;
    await scheduler.manual('all',false,grant).catch(()=>false);
   }
   if(writer){
    const release=playback.hold();
    writer.resolve(false);writer=undefined;await flush();
    release();
   }
   await flush();
   expect(prepareAttempts).toBe(1);
   expect(calls).toEqual([]);
   expect(cleared).toEqual([]);
   priorAttempt=false;
   await clock.advance(CLOUD_INTERVAL);
   expect(calls).toEqual([]);

   switch(wake){
    case 'phone release':phone.acquire()();break;
    case 'playback release':playback.hold()();break;
    case 'foreground':scheduler.foreground(false);scheduler.foreground(true);break;
    case 'network':scheduler.trigger('network');break;
    case 'retry deadline':
     scheduler.deferUntil(clock.now+1000);
     await flush();
     expect(calls).toEqual([]);
     await clock.advance(1000);
     break;
    case 'account notification':scheduler.wakePending();break;
    case 'cold start':
     scheduler.dispose();
     scheduler=makeScheduler();
     scheduler.foreground(true);
     await scheduler.start(true);
     break;
    case 'approval delivery':scheduler.approvalCompleted();break;
   }
   await flush();
   // Manual policy is guaranteed only by a durable grant or an approval.
   // Restart discards the two in-memory requests while preserving the record.
   const manual=work==='durable grant'||wake==='approval delivery'||work==='approval'&&wake!=='cold start';
   const result={calls,cleared,pending:stored?.token??null};
   expect(result).toEqual({
    calls:[{manual,mode:work==='durable grant'?'all':'recent128',scope}],
    cleared:work==='durable grant'?[grant.token]:[],pending:null,
   });
   console.log('wake-matrix '+JSON.stringify({wake,work,failed,...result}));
  }finally{
   scheduler.dispose();offPlayback();offPhone();writer?.resolve(false);
  }
 });
}

for(const offset of [-1,0,30000])test('a failed run cannot schedule itself again at a fixed time, retry offset='+offset,async()=>{
 const clock=new Clock();clock.now=300000;
 const initial=clock.now,starts:number[]=[];
 const scheduler=new WatchCloudScheduler({
  now:()=>clock.now,
  delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn).catch(()=>{});return ()=>timer.cancel();},
  scheduleWorker:async()=>{},cancelWorker:async()=>{},
  mayHavePendingIntent:()=>true,
  async sync(_manual,_mode,run){
   run.bindIntent(undefined);
   starts.push(clock.now);
   if(starts.length<=8){
    scheduler.deferUntil(clock.now+offset,'all');
    scheduler.wakePending();
   }
   return false;
  },
 },enabled);
 try{
  scheduler.foreground(true);await flush();
  expect(starts).toEqual([initial]);
  const delay=offset>0?offset:CLOUD_INTERVAL;
  await clock.advance(delay-1);
  expect(starts).toEqual([initial]);
  await clock.advance(1);
  expect(starts).toEqual([initial,initial+delay]);
 }finally{scheduler.dispose();}
});

for(const wake of ['approval delivery','restored manual grant'] as const)test(wake+' respects a future service retry deadline',async()=>{
 const clock=new Clock(),starts:{at:number;manual:boolean}[]=[];
 const grant:ManualIntent={version:2,token:'fixture_all',scope:'fixture',mode:'all',createdAt:0,epoch:null};
 const scheduler=new WatchCloudScheduler({
  now:()=>clock.now,
  delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn).catch(()=>{});return ()=>timer.cancel();},
  scheduleWorker:async()=>{},cancelWorker:async()=>{},
  async sync(manual,_mode,run){
   starts.push({at:clock.now,manual:manual||run.afterApproval});
   run.bindIntent(manual?grant:undefined);
   return true;
  },
 },enabled);
 try{
  scheduler.deferUntil(30000);
  scheduler.foreground(true);
  if(wake==='approval delivery')scheduler.approvalCompleted();
  else await scheduler.manual(grant.mode,true,grant);
  await clock.advance(29999);
  expect(starts).toEqual([]);
  await clock.advance(1);
  expect(starts).toEqual([{at:30000,manual:true}]);
 }finally{scheduler.dispose();}
});

const retryBoundaryWakes=[
 'phone release','playback release','foreground restore','screen restore',
 'network','library SQL','local channel','same-account notification','account switch',
 'cold start','approval delivery','retry timer','writer settles',
] as const;
for(const wake of retryBoundaryWakes)for(const offset of [-1,0,1]){
 test(`retry boundary: ${wake} / ${offset}ms`,async()=>{
  const clock=new Clock();clock.now=CLOUD_INTERVAL;
  const start=clock.now,retryAt=start+offset,starts:number[]=[];
  const firstResult=deferred<void>();
  const visibility=new CloudVisibility('active');
  const phone=new LocalTransferActivity(),playback=new PlaybackWork();
  let ready=wake!=='account switch';
  const scheduler=new WatchCloudScheduler({
   now:()=>clock.now,
   delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn).catch(()=>{});return ()=>timer.cancel();},
   scheduleWorker:async()=>{},cancelWorker:async()=>{},
   prepare:()=>ready,
   async sync(_manual,_mode,run){
    run.bindIntent(undefined);
    starts.push(clock.now);
    if(starts.length!==1)return true;
    await firstResult.result;
    run.publish({ok:false,retryAtMillis:retryAt});
    scheduler.deferUntil(retryAt);
    return false;
   },
  },enabled);
  const offPhone=phone.subscribe(held=>scheduler.hold(held));
  const offPlayback=playback.subscribe(held=>scheduler.hold(held));
  try{
   scheduler.foreground(true);
   if(wake==='cold start')await scheduler.start(true);
   if(wake==='account switch'){
    await flush();
    expect(starts).toEqual([]);
    ready=true;
    scheduler.accountChanged();
   }
   expect(starts).toEqual([start]);
   switch(wake){
    case 'phone release':phone.acquire()();break;
    case 'playback release':playback.hold()();break;
    case 'foreground restore':
     scheduler.foreground(visibility.lifecycle('background'));
     scheduler.foreground(visibility.lifecycle('active'));
     break;
    case 'screen restore':
     scheduler.foreground(visibility.display({interactive:false,resumed:true}));
     scheduler.foreground(visibility.display({interactive:true,resumed:true}));
     break;
    case 'network':scheduler.trigger('network');break;
    case 'library SQL':scheduler.trigger('library');break;
    case 'local channel':scheduler.trigger('channel');break;
    // The baseline has no scheduler entry for these two events. Its service
    // deadline still exercises the same time comparison in pump().
    case 'same-account notification':scheduler.wakePending?.();break;
    case 'approval delivery':scheduler.approvalCompleted?.();break;
   }
   firstResult.resolve();await flush();
   const immediate=[...starts];
   await clock.advance(1);
   const result={wake,offset,immediate,starts};
   console.log('retry-boundary '+JSON.stringify(result));
   expect(immediate).toEqual(offset<=0?[start,start]:[start]);
   expect(starts).toEqual([start,Math.max(start,retryAt)]);
  }finally{
   scheduler.dispose();offPhone();offPlayback();firstResult.resolve();
  }
 });
}

function memoHeadPoll(clock:Clock) {
 return new WatchHeadPoll({
  eligible:()=>true,now:()=>clock.now,
  delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn,()=>{});return ()=>timer.cancel();},
  read:async()=>({enabled:true,ttlMs:CLOUD_INTERVAL}),
  observeHead:async()=>false,
 });
}

test('memo commits coalesce within three seconds and bypass the five-minute automatic interval',async()=>{
 const clock=new Clock(),calls:{at:number;savedAt?:number;manual:boolean}[]=[];
 const headPoll=memoHeadPoll(clock);
 headPoll.update();
 await clock.advance(0);
 expect(headPoll.expediteMemos).toBe(true);
 const scheduler=new WatchCloudScheduler({
  headPoll,
  now:()=>clock.now,delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn,()=>{});return ()=>timer.cancel();},
  scheduleWorker:async()=>{},cancelWorker:async()=>{},
  async sync(manual,_mode,run){run.bindIntent(undefined);calls.push({at:clock.now,savedAt:run.note?.savedAt,manual});return true;},
 },enabled);
 scheduler.foreground(true);
 await clock.advance(100);
 scheduler.trigger('library');
 scheduler.noteSaved();
 await clock.advance(1200);
 scheduler.noteSaved();
 await clock.advance(1799);
 expect(calls).toHaveLength(1);
 await clock.advance(1);
 expect(calls[1]).toEqual({at:3100,savedAt:100,manual:false});
 scheduler.noteSaved();
 await clock.advance(2999);
 expect(calls).toHaveLength(2);
 await clock.advance(1);
 expect(calls[2]).toEqual({at:6100,savedAt:3100,manual:false});
 scheduler.dispose();
});

test('memo dispatch respects the fault retry deadline and keeps the original save across failure',async()=>{
 const clock=new Clock(),calls:(number|undefined)[]=[];
 const headPoll=memoHeadPoll(clock);
 headPoll.update();
 await clock.advance(0);
 expect(headPoll.expediteMemos).toBe(true);
 const scheduler=new WatchCloudScheduler({
  headPoll,
  now:()=>clock.now,delay:(ms,fn)=>{const timer=clock.delay(ms);void timer.result.then(fn,()=>{});return ()=>timer.cancel();},
  scheduleWorker:async()=>{},cancelWorker:async()=>{},
  async sync(_manual,_mode,run){
   run.bindIntent(undefined);calls.push(run.note?.savedAt);
   if(calls.length===2){scheduler.deferUntil(40000);return false;}
   return true;
  },
 },enabled);
 scheduler.foreground(true);
 await clock.advance(40);
 scheduler.noteSaved();
 await clock.advance(3000);
 expect(calls).toEqual([undefined,40]);
 scheduler.noteSaved();
 await clock.advance(40000-clock.now-1);
 expect(calls).toHaveLength(2);
 await clock.advance(1);
 expect(calls).toEqual([undefined,40,40]);
 scheduler.dispose();
});
