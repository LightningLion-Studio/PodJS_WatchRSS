import {expect,test} from 'bun:test';
import type {SnapshotOrder} from '../src/onboarding/network.ts';
import {NetworkRecovery,isNetworkRecoveryCancellation} from '../src/network/recovery.ts';

type Route='checking'|'unavailable'|'available'|'bluetooth';
type Sample=Exclude<Route,'checking'>;
type Event=
 | 'start'|'success'|'transport'|'http'|'notice'|'observe-fail'|'check-fail'|'retry'|'retry-page'|'background'|'foreground'|'destroy'
 | {observe:Sample;old?:boolean;olderCapture?:boolean}
 | {check:Sample}
 | {late:Sample}
 | {cache:boolean}
 | {time:number};

const connected=(route:Route)=>route==='available'||route==='bluetooth';
const networkError={code:'network_error'};
const httpError={kind:'http',status:503};
const SILENT_LIMIT_MS=25000; // Initial 10 s check and 15 s to confirm after invalidation.

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const result=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {result,resolve,reject};
}

type ProbeCheck=ReturnType<typeof deferred<{status:Sample;order:SnapshotOrder}>>&{request:number;cancel():void};
type Outcome='success'|'error'|'cancelled';
type PageFeedback={loading:boolean;error?:unknown;retry?:()=>void};
type Business={
 generation:number; attempts:number; failedAt?:number; outcome?:Outcome;
 page:PageFeedback; lastFault?:unknown;
 pending?:ReturnType<typeof deferred<string>>;
};

/** Route facts used by the oracle. It knows sample precedence, but has no poll,
 * cancellation, waiter, or UI implementation. */
class RouteModel {
 status:Route='checking';
 private revision?:SnapshotOrder;
 private fence=0;

 reset(){this.status='checking';this.revision=undefined;this.fence=0;}
 notice(requested:number){this.fence=requested;this.status='checking';}
 sample(status:Sample,order:SnapshotOrder){
  if(status==='unavailable'&&order.requested<=this.fence)return;
  const previous=this.revision;
  if(previous){
   const direction=previous.captured!==undefined&&order.captured!==undefined
    ?order.captured-previous.captured
    :order.requested-previous.requested;
   if(direction<=0)return;
  }
  this.revision=order;
  this.status=status;
 }
}

class RecoveryProbe {
 readonly route=new RouteModel();
 readonly calls:Business[]=[];
 readonly network:NetworkRecovery;
 private active=true;
 private destroyed=false;
 private cached=false;
 private generation=1;
 private clock=0;
 private requested=0;
 private captured=0;
 private fence=0;
 private wasBlocking=false;
 private wasWaiting=false;
 private invalidRetry=false;
 private peakChecks=0;
 private maxCapture=0;
 private lateDeliveries=0;
 private retiredCheck?:ProbeCheck;
 private checks=new Set<ProbeCheck>();
 private timers=new Map<ReturnType<typeof deferred<void>>,number>();
 private observe!:(status:Route,order?:SnapshotOrder)=>void;
 private invalidate!:(requested:number)=>void;

 constructor(){
  this.network=new NetworkRecovery({
   observe:(observe,invalidate)=>{
    this.observe=observe;
    this.invalidate=invalidate;
    return ()=>{};
   },
   startCheck:()=>this.openCheck(),
   delay:ms=>{
    const timer=deferred<void>();
    this.timers.set(timer,this.clock+ms);
    // Cancellation releases the handle. It does not settle the promise ahead
    // of a possible late check result in the cancel-versus-completion race.
    return {result:timer.result,cancel:()=>{this.timers.delete(timer);}};
   },
  });
  this.network.preserveContent(()=>this.cached);
  this.network.setActive(true);
 }

 private openCheck():ProbeCheck{
  const request=++this.requested;
  const pending=deferred<{status:Sample;order:SnapshotOrder}>();
  let cancelled=false;
  const check={...pending,request,result:pending.result.then(reading=>{
   if(cancelled)this.lateDeliveries++;
   return reading;
  }),cancel:()=>{
   if(this.checks.delete(check)){
    cancelled=true;
    this.retiredCheck=check;
   }
  }};
  this.checks.add(check);
  this.peakChecks=Math.max(this.peakChecks,this.checks.size);
  return check;
 }

 private start(){
  if(!this.active)return;
  const call:Business={generation:this.generation,attempts:0,page:{loading:true}};
  this.calls.push(call);
  void this.network.run(()=>{
   call.attempts++;
   if(call.attempts>1&&(!this.active||!connected(this.route.status)||this.cached||call.generation!==this.generation))this.invalidRetry=true;
   call.pending=deferred<string>();
   return call.pending.result;
  }).then(
   ()=>{call.outcome='success';call.page={loading:false};},
   error=>{
    const cancelled=isNetworkRecoveryCancellation(error);
    call.outcome=cancelled?'cancelled':'error';
    call.page=cancelled?{loading:false}:{loading:false,error,retry:()=>this.start()};
   },
  );
 }

 private settleRequest(event:'success'|'transport'|'http'){
  const call=this.calls.find(work=>work.pending);
  if(!call)return;
  const pending=call.pending!;
  call.pending=undefined;
  if(event==='success'){pending.resolve('loaded');return;}
  if(event==='transport')call.failedAt??=this.clock;
  call.lastFault=event==='transport'?networkError:httpError;
  pending.reject(call.lastFault);
 }

 private sample(requested:number,olderCapture=false):SnapshotOrder {
  if(olderCapture)return {requested,captured:Math.max(0,this.maxCapture-1)};
  this.maxCapture=++this.captured;
  return {requested,captured:this.captured};
 }

 private lifecycle(active:boolean){
  if(active===this.active||this.destroyed)return;
  this.active=active;
  this.generation++;
  if(active)this.route.reset();
  this.network.setActive(active);
 }

 private async flush(){
  for(let turn=0;turn<16;turn++)await Promise.resolve();
 }

 private verify(){
  const {blocking,waiting}=this.network;
  // I1: check the liveness bound on every external event and each timer event.
  for(const call of this.calls){
   const needsFeedback=call.failedAt!==undefined&&!call.outcome&&!call.pending;
   if(needsFeedback&&call.generation!==this.generation)throw Error('I1: cancelled lifecycle still waiting');
   if(needsFeedback&&!blocking&&this.clock-call.failedAt!>=SILENT_LIMIT_MS)throw Error('I1: no retry or error after 25s');
   if(call.outcome==='error'&&this.active&&call.generation===this.generation){
    const page=call.page;
    if(page.loading||page.error!==call.lastFault||typeof page.retry!=='function')throw Error('I1: caller needs the original error and an enabled retry');
   }
   if(blocking&&this.checks.size===0&&this.network.overlayStatus==='checking')throw Error('I1: retry still disabled without a check');
   if(call.attempts>2)throw Error('I2: request retried more than once');
  }
  if(this.invalidRetry)throw Error('I2: retry outside an active usable route');
  if(this.peakChecks>1)throw Error('I3: overlapping checks');
  const closed=!this.active||this.wasBlocking&&!blocking||this.wasWaiting&&!waiting;
  if(closed&&(this.checks.size||this.timers.size))throw Error('I3: resources survived closure');
  if(this.active&&this.route.status!==this.network.status)throw Error(`I4: expected route ${this.route.status}, got ${this.network.status}`);
  if(blocking&&!this.wasBlocking&&this.route.status!=='unavailable')throw Error('I4: new overlay without fresh confirmation');
  if(this.active&&connected(this.route.status)&&blocking)throw Error('I5: overlay visible after accepting online');
  if(this.cached&&blocking)throw Error('I6: cached page blocked');
  this.wasBlocking=blocking;
  this.wasWaiting=waiting;
 }

 private async advance(ms:number){
  const end=this.clock+ms;
  while(true){
   const next=[...this.timers].reduce<[ReturnType<typeof deferred<void>>,number]|undefined>(
    (earlier,entry)=>entry[1]<=end&&(!earlier||entry[1]<earlier[1])?entry:earlier,undefined);
   if(!next)break;
   const [timer,due]=next;
   this.clock=due;
   this.timers.delete(timer);
   timer.resolve();
   await this.flush();
   this.verify();
  }
  this.clock=end;
 }

 async step(event:Event){
  if(typeof event==='string'){
   switch(event){
    case 'start':this.start();break;
    case 'success':case 'transport':case 'http':this.settleRequest(event);break;
    case 'notice':
     if(this.active){
      this.fence=this.requested;
      this.route.notice(this.fence);
      this.invalidate(this.fence);
     }
     break;
    case 'observe-fail':if(this.active)this.observe('checking');break;
    case 'check-fail':{
     const check=this.checks.values().next().value;
     if(check){this.checks.delete(check);check.reject('snapshot failed');}
     break;
    }
    case 'retry':if(this.network.blocking)void this.network.retry();break;
    case 'retry-page':
     if(this.active&&!this.network.blocking){
      const operation=this.calls.slice().reverse().find(call=>call.generation===this.generation&&call.page.retry);
      operation?.page.retry?.();
     }
     break;
    case 'background':this.lifecycle(false);break;
    case 'foreground':this.lifecycle(true);break;
    case 'destroy':this.lifecycle(false);this.destroyed=true;this.network.dispose();break;
   }
  }else if('observe' in event){
   if(this.active){
    const order=this.sample(event.old?this.fence:++this.requested,event.olderCapture);
    this.route.sample(event.observe,order);
    this.observe(event.observe,order);
   }
  }else if('check' in event){
   const check=this.checks.values().next().value;
   if(check){
    const order=this.sample(check.request);
    this.route.sample(event.check,order);
    this.checks.delete(check);
    check.resolve({status:event.check,order});
   }
  }else if('late' in event){
   const check=this.retiredCheck;
   if(check){
    this.retiredCheck=undefined;
    const before=this.lateDeliveries;
    check.resolve({status:event.late,order:this.sample(check.request)});
    await this.flush();
    if(this.lateDeliveries!==before+1)throw Error('late sample did not reach the cancelled operation promise');
   }
  }else if('cache' in event){
   this.cached=event.cache;
   this.network.refreshUsable();
  }else await this.advance(event.time);
  await this.flush();
  this.verify();
 }

 async finish(){
  // Complete business work and give the recovery layer the entire deadline,
  // with no promise of a successful system sample.
  for(const call of this.calls){
   call.pending?.resolve('loaded');
   call.pending=undefined;
  }
  await this.flush();
  await this.step({time:SILENT_LIMIT_MS});
  for(const call of this.calls){
   if(call.failedAt!==undefined&&!call.outcome&&!this.network.blocking)throw Error('I1: no terminal feedback at end of trace');
  }
 }
}

const online={observe:'available'} as const;
const offline={observe:'unavailable'} as const;
const checkOffline={check:'unavailable'} as const;
const checkOnline={check:'available'} as const;
const tick={time:5000};
const outage:Event[]=[online,'start','transport',checkOffline];
const unknownWait:Event[]=[online,'start','transport','notice','observe-fail',{late:'unavailable'}];
type Expected=[attempts:number,outcome:Outcome];
const recovered:Expected=[2,'success'],localError:Expected=[1,'error'],left:Expected=[1,'cancelled'];
const counterexamples:[string,Event[],Expected[]][]=[
 ['r1 observer missed outage and repeats online',[...outage,online,'success',online],[recovered]],
 ['r1 manual failure enables a second click',[...outage,'retry','check-fail','retry',checkOnline,'success'],[recovered]],
 ['r1 cached home channel list',[{cache:true},offline,'start','transport'],[localError]],
 ['r2 old duplicate snapshot and later manual online',[...outage,'retry',offline,checkOnline,'success',{observe:'unavailable',olderCapture:true}],[recovered]],
 ['r2 cached single-channel articles',[offline,'start','transport',{cache:true}],[localError]],
 ['r3 failed check after observed outage',[online,'start','transport','notice',offline,'check-fail','retry','check-fail',online,'success'],[recovered]],
 ['r4 stale outage after route notice',[offline,'notice','observe-fail',{observe:'unavailable',old:true},'start','transport','check-fail'],[localError]],
 ['r4 polling without notification',[...outage,tick,'check-fail',tick,checkOnline,'success'],[recovered]],
 ['r5 slow poll skips tick, then times out',[...outage,tick,tick,tick,{late:'available'},tick,checkOnline,'success'],[recovered]],
 ['r5 observer closes pending poll',[...outage,tick,online,{late:'available'},'success',tick],[recovered]],
 ['r5 manual replaces pending poll',[...outage,tick,'retry',tick,checkOnline,{late:'unavailable'},'success'],[recovered]],
 ['r5 cached data closes pending poll',[...outage,tick,{cache:true},{late:'available'},tick],[localError]],
 ['r5 background, late completion and foreground',[...outage,tick,'background','foreground',{late:'available'},offline],[left]],
 ['r5 destroy with pending poll',[...outage,tick,'destroy',{late:'available'},tick],[left]],
 ['r6 new request after polling check invalidation',[...outage,'start',tick,'notice','observe-fail','transport',{late:'unavailable'},checkOffline,online,'success','success'],[recovered,recovered]],
 ['r6 shared check invalidation with late offline',[online,'start','start','transport','transport','notice','observe-fail',{late:'unavailable'},online,'success','success'],[recovered,recovered]],
 ['r6 shared check invalidation with late online',[online,'start','start','transport','transport','notice','observe-fail',{late:'available'},tick,checkOnline,'success','success'],[recovered,recovered]],
 ['r7 all subsequent samples fail for 120 seconds',[...unknownWait,...Array.from({length:24},()=>[tick,'check-fail'] as const).flat()],[localError]],
 ['r7 repeated notice cannot extend an unknown wait',[...unknownWait, tick,'notice','observe-fail',tick,'notice','observe-fail',tick,'notice','observe-fail',tick,'check-fail',tick],[localError]],
 ['automatic retry failure returns to the page once',[...outage,online,'transport',online],[[2,'error']]],
 ['page retry runs a new request after the unconfirmed deadline',[...unknownWait,{time:15000},'retry-page','success'],[localError,[1,'success']]],
 ['HTTP failure stays with the page',[offline,'start','http'],[localError]],
 ['bluetooth recovery releases the wait',[...outage,{observe:'bluetooth'},'success'],[recovered]],
];
for(const [label,events,expected] of counterexamples){
 test(label,async()=>{
  const probe=new RecoveryProbe();
  try{
   for(const event of events)await probe.step(event);
   await probe.finish();
   expect(probe.calls.map(call=>[call.attempts,call.outcome])).toEqual(expected);
  }finally{await probe.step('destroy');}
 });
}

function randomEvents(draw:()=>number):Event[]{
 const pool:Event[]=['start','start','start','transport','transport','success','http',online,offline,
  {observe:'bluetooth'},'observe-fail','notice','notice',checkOnline,checkOffline,{check:'bluetooth'},
  'check-fail','check-fail','retry','retry-page','background','foreground',{late:'available'},{late:'unavailable'},
  {observe:'unavailable',old:true},{observe:'unavailable',olderCapture:true},{cache:true},{cache:false},{cache:false},
  {time:1000},tick,tick,{time:10000},{time:15000}];
 const events:Event[]=draw()%2===0?['start','transport','notice','observe-fail']:['start','transport'];
 for(let step=0;step<128;step++)events.push(pool[draw()%pool.length]!);
 if(draw()%12===0)events.splice(96,0,'destroy',{late:'available'},'foreground');
 return events;
}

test('recovery invariants under 18000 seeded random traces',async()=>{
 const seeds=[0x1,0xffffffff,0x9e3779b9,0xdeadbeef,0x12345678,0xa5a5a5a5];
 let count=0;
 for(const seed of seeds){
  let state=seed;
  const draw=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  for(let index=0;index<3000;index++){
   const events=randomEvents(draw);
   const probe=new RecoveryProbe();
   let step=0;
   try{
    for(;step<events.length;step++)await probe.step(events[step]!);
    await probe.finish();
    await probe.step('destroy');
   }catch(error){
    throw new Error(`seed=0x${seed.toString(16)} trace=${index} step=${step} events=${JSON.stringify(events)}`,{cause:error});
   }
   count++;
  }
 }
 expect(count).toBe(18000);
},90000);
