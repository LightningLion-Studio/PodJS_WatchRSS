import {afterEach,expect,mock,test} from 'bun:test';
import {WatchAccountStore} from '../src/account/store';
import {WatchTokenManager} from '../src/account/token';
import type {WatchAccountState} from '../src/account/types';
import type {ApprovalStatus} from '../src/cloud/approval';
import {cloudAccountIdentity} from '../src/cloud/identity';
import {MANUAL_INTENT_KEY,readManualIntent} from '../src/cloud/manual-handoff';
import {CLOUD_INTERVAL} from '../src/cloud/scheduler';
import type {CloudSyncResult} from '../src/cloud/service';
import {utf8Encode} from '../src/cloud/types';
import {playbackWork} from '../src/core/playback-work';
import {localTransferActivity} from '../src/sync/local-transfer';
import {stateSqlFixture} from './cloud/state-sql-fixture';
import {Clock,deferred,flush} from './helpers/ip-fixture';

const account=(userId:string):WatchAccountState=>({
 userId,backendBaseUrl:'https://fixture.invalid',phoneMasked:'Fixture',installId:'fixture',
 watchDeviceToken:'fixture',watchRefreshToken:'',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
 posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
 entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
 telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
});
const accounts=new Map<string,string>(),secure=new Map<string,string>(),networkListeners=new Set<()=>void>();
const store=new WatchAccountStore({
 get:key=>accounts.get(key)??null,set:(key,value)=>{accounts.set(key,value);},remove:key=>{accounts.delete(key);},
});
let clock:Clock,sql:ReturnType<typeof stateSqlFixture>;
let rejectGrantReads=false,failedReads=0,blockedReads=0,polls=0;
let blockGrantRead:ReturnType<typeof deferred<void>>|undefined;
let blockSync:ReturnType<typeof deferred<void>>|undefined;
let releaseHold:(()=>void)|undefined;
let syncResult:((manual:boolean,mode:'all'|'recent128')=>Promise<CloudSyncResult>)|undefined;
const cleared:string[]=[];
const calls:{entry:string;manual:boolean;mode:string;scope?:string;grant?:string}[]=[];
mock.module('@podjs/framework/watch',()=>({lifecycle:()=>'active',onLifecycleChange:()=>()=>{}}));
mock.module('@podjs/framework/services',()=>({
 displayPower:{state:async()=>({interactive:true,resumed:true}),onChange:()=>()=>{}},
 onSqlChanged:()=>()=>{},
 onNetworkChange(fn:()=>void){networkListeners.add(fn);return()=>{networkListeners.delete(fn);};},
 delay:(ms:number)=>clock.delay(ms),
 hostOperation:(method:string,args:Record<string,unknown>)=>({
  result:(async()=>{
   if(method.startsWith('sql.'))return sql.host(method,args);
   const key=String(args.key);
   if(method==='secure.get'){
    if(key===MANUAL_INTENT_KEY&&rejectGrantReads){
     failedReads++;
     throw Error('fixture grant read unavailable during preparation');
    }
    if(key===MANUAL_INTENT_KEY&&blockGrantRead){
     blockedReads++;
     await blockGrantRead.result;
    }
    return {exists:secure.has(key),value:secure.get(key)};
   }
   if(method==='secure.compareAndSet'){
    if((secure.get(key)??null)!==args.expected)return {updated:false};
    if(args.value===null){
     const intent=readManualIntent(secure.get(key));
     if(intent)cleared.push(intent.token);
     secure.delete(key);
    }else secure.set(key,String(args.value));
    return {updated:true};
   }
   if(method==='cloud.acquire')return {acquired:true};
   if(['cloud.release','cloud.enqueue','cloud.localTransfer','cloud.schedule','cloud.cancel'].includes(method))return {};
   throw Error('Unexpected host method in approval fixture: '+method);
  })(),cancel(){},
 }),
}));
mock.module('../src/cloud/host',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate',()=>({cloudGate:{allowed:true,require(){}}}));
mock.module('../src/llm/runtime',()=>({summaryAccountStore:store}));
mock.module('../src/services',()=>({
 getLibrarySyncRepository:async()=>({deviceId:async()=>'fixture-watch'}),
 notifyNotesChanged(){},notifyLibraryChanged(){},services:{subscribeChannel:()=>()=>{}},
}));
mock.module('../src/cloud/authorization',()=>({
 createCloudAuthorization:()=>({
  approval:async(changed:(state:ApprovalStatus)=>void)=>{
   let confirmed=false;
   const update=(state:ApprovalStatus)=>{machine.status=state;changed(state);};
   const machine={
    status:{phase:'idle'} as ApprovalStatus,setForeground(){},dispose(){},cancel:async()=>{},
    async start(){update({phase:'pending'});},
    async confirmCode(matches:boolean){confirmed=matches;},
    async poll(){polls++;update(confirmed?{phase:'complete'}:{phase:'code',code:'00000000'});},
   };
   return machine;
  },
 }),
}));
const {WatchCloudSyncService}=await import('../src/cloud/service');
const realSyncNowResult=WatchCloudSyncService.prototype.syncNowResult;
const observe=(entry:string,manual:boolean,mode:string,scope?:string)=>{
 const grant=readManualIntent(secure.get(MANUAL_INTENT_KEY))?.token;
 calls.push({entry,manual,mode,scope,grant});
};
WatchCloudSyncService.prototype.syncNow=async(manual=false,mode='recent128',scope)=>{
 observe('direct',manual,mode,scope);
 return true;
};
WatchCloudSyncService.prototype.syncNowResult=async(manual=false,mode='recent128',scope)=>{
 observe('scheduled',manual,mode,scope);
 if(syncResult)return syncResult(manual,mode);
 await blockSync?.result;
 return {ok:true,resultSequence:calls.length};
};
const {applicationCloudApproval,startApplicationCloudSync,stopApplicationCloudSync}=await import('../src/cloud/application');
const realNow=Date.now,scopeB=cloudAccountIdentity(account('B'));
afterEach(async()=>{
 stopApplicationCloudSync();
 applicationCloudApproval.setForeground(false);
 blockGrantRead?.resolve();
 blockSync?.resolve();
 releaseHold?.();
 releaseHold=undefined;
 await flush();
 Date.now=realNow;
 sql.db.close();
});

const switchAccount=(id:string)=>{
 const next=account(id);
 accounts.set('watchrss.library.owner',JSON.stringify([next.backendBaseUrl,next.userId]));
 accounts.set('state_json',JSON.stringify(next));
 store.invalidate();
};
const setup=async()=>{
 clock=new Clock();sql=stateSqlFixture();Date.now=()=>clock.now;
 rejectGrantReads=false;blockGrantRead=undefined;blockSync=undefined;failedReads=0;blockedReads=0;polls=0;
 syncResult=undefined;
 accounts.clear();secure.clear();calls.length=0;cleared.length=0;
 await store.save(account('A'));
 await startApplicationCloudSync().ready;
 await flush();
 expect(calls).toEqual([{entry:'scheduled',manual:false,mode:'recent128',scope:cloudAccountIdentity(account('A')),grant:undefined}]);
 calls.length=0;
};
const stageB=async()=>{
 secure.set(MANUAL_INTENT_KEY,JSON.stringify({version:2,token:'grant_b',scope:scopeB,mode:'all',createdAt:1,epoch:null}));
 rejectGrantReads=true;
 switchAccount('B');
 await flush();
 expect(failedReads).toBe(1);
 expect(calls).toEqual([]);
};
const confirmForPoll=async()=>{
 applicationCloudApproval.setForeground(true);
 expect(await applicationCloudApproval.request()).toBe(true);
 await clock.advance(1500);
 expect(applicationCloudApproval.state.phase).toBe('code');
 expect(await applicationCloudApproval.confirmMatches(true)).toBe(true);
 expect(applicationCloudApproval.state.phase).toBe('code');
};
const finishPoll=async()=>{
 await clock.advance(1500);
 expect(applicationCloudApproval.state.phase).toBe('complete');
 expect(polls).toBe(2);
};
const completeByPoll=async()=>{await confirmForPoll();await finishPoll();};
const expectCompletedB=()=>{
 expect(calls).toEqual([{entry:'scheduled',manual:true,mode:'all',scope:scopeB,grant:'grant_b'}]);
 expect(cleared).toEqual(['grant_b']);
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
};

test('approval poll retries preparation and preserves the full grant while reads fail',async()=>{
 await setup();await stageB();await completeByPoll();
 expect(calls).toEqual([]);
 expect(failedReads).toBe(2);
 expect(cleared).toEqual([]);
 expect(readManualIntent(secure.get(MANUAL_INTENT_KEY))?.token).toBe('grant_b');
 rejectGrantReads=false;
 await clock.advance(CLOUD_INTERVAL);
 for(const notify of networkListeners)notify();
 await flush();
 expectCompletedB();
});

test('approval poll runs and completes the original full grant when preparation recovers',async()=>{
 await setup();await stageB();
 rejectGrantReads=false;
 await completeByPoll();
 expectCompletedB();
});

test('approval poll without a pending grant schedules the usual recent sync',async()=>{
 await setup();await completeByPoll();
 expect(calls).toEqual([{entry:'scheduled',manual:true,mode:'recent128',scope:cloudAccountIdentity(account('A')),grant:undefined}]);
 expect(cleared).toEqual([]);
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
});

test('approval poll does not carry its request across an account switch during preparation',async()=>{
 await setup();await stageB();
 rejectGrantReads=false;
 const blocked=blockGrantRead=deferred<void>();
 await completeByPoll();
 expect(blockedReads).toBe(1);
 expect(calls).toEqual([]);
 switchAccount('C');
 await flush();
 blockGrantRead=undefined;blocked.resolve();
 await flush();
 expect(calls).toEqual([{entry:'scheduled',manual:false,mode:'recent128',scope:cloudAccountIdentity(account('C')),grant:undefined}]);
 // Account initialization discards a grant scoped to the old account.
 expect(cleared).toEqual(['grant_b']);
});

const notifyNetwork=()=>{for(const notify of networkListeners)notify();};
const scopeA=cloudAccountIdentity(account('A'));
const stageAll=()=>{
 secure.set(MANUAL_INTENT_KEY,JSON.stringify({version:2,token:'concurrent_all',scope:scopeA,mode:'all',createdAt:1,epoch:null}));
};
const recentApproval=(scope:string)=>({entry:'scheduled',manual:true,mode:'recent128',scope,grant:undefined});
const scheduledAll={entry:'scheduled',manual:true,mode:'all',scope:scopeA,grant:'concurrent_all'};

for(const failure of ['account preparation','grant read before sync'])test('approval preserves its manual mode after '+failure+' fails without a grant',async()=>{
 await setup();
 rejectGrantReads=true;
 if(failure==='account preparation'){switchAccount('B');await flush();}
 await completeByPoll();
 expect(calls).toEqual([]);
 expect(failedReads).toBe(failure==='account preparation'?2:1);
 rejectGrantReads=false;
 await clock.advance(CLOUD_INTERVAL);
 expect(calls).toEqual([]);
 notifyNetwork();await flush();
 expect(calls).toEqual([recentApproval(failure==='account preparation'?scopeB:scopeA)]);
 expect(cleared).toEqual([]);
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
});

for(const covers of [true,false])test('approval delivered during grant read coalesces only with a covering sync, grant='+covers,async()=>{
 await setup();await clock.advance(CLOUD_INTERVAL);
 if(covers)stageAll();
 await confirmForPoll();
 const read=blockGrantRead=deferred<void>();
 notifyNetwork();await flush();
 expect(blockedReads).toBe(1);
 await finishPoll();
 expect(calls).toEqual([]);
 blockGrantRead=undefined;read.resolve();await flush();
 expect(calls).toEqual(covers?[scheduledAll]:[
  {entry:'scheduled',manual:false,mode:'recent128',scope:scopeA,grant:undefined},
  recentApproval(scopeA),
 ]);
 expect(cleared).toEqual(covers?['concurrent_all']:[]);
 expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
});

test('approval remains queued if a covering sync started before delivery',async()=>{
 await setup();await clock.advance(CLOUD_INTERVAL);stageAll();
 await confirmForPoll();
 const writer=blockSync=deferred<void>();
 notifyNetwork();await flush();
 expect(calls).toEqual([scheduledAll]);
 await finishPoll();
 expect(calls).toEqual([scheduledAll]);
 blockSync=undefined;writer.resolve();await flush();
 expect(calls).toEqual([scheduledAll,recentApproval(scopeA)]);
 expect(cleared).toEqual(['concurrent_all']);
});

for(const [name,hold] of [
 ['phone transfer',()=>localTransferActivity.acquire()],
 ['playback',()=>playbackWork.hold()],
] as const)test('releasing '+name+' alone wakes an approval after failed preparation',async()=>{
 await setup();
 rejectGrantReads=true;
 switchAccount('B');await flush();
 await completeByPoll();
 expect(calls).toEqual([]);
 expect(failedReads).toBe(2);
 releaseHold=hold();
 rejectGrantReads=false;
 await clock.advance(CLOUD_INTERVAL);
 expect(calls).toEqual([]);
 releaseHold();releaseHold=undefined;
 await clock.advance(CLOUD_INTERVAL);
 expect(calls).toEqual([recentApproval(scopeB)]);
 expect(cleared).toEqual([]);
});

test('same-account notification alone wakes a retained approval without a durable record',async()=>{
 await setup();rejectGrantReads=true;switchAccount('B');await flush();
 await completeByPoll();
 rejectGrantReads=false;await clock.advance(CLOUD_INTERVAL);
 expect(calls).toEqual([]);
 await store.save({...account('B'),watchDeviceToken:'renewed'});await flush();
 expect(calls).toEqual([recentApproval(scopeB)]);
 expect(cleared).toEqual([]);
});

test('playback release alone discovers a durable grant after failed preparation',async()=>{
 await setup();await stageB();
 releaseHold=playbackWork.hold();
 rejectGrantReads=false;await clock.advance(CLOUD_INTERVAL);
 expect(calls).toEqual([]);
 releaseHold();releaseHold=undefined;await flush();
 expectCompletedB();
});

for(const ttl of [1,30000,59999,60000,60001,3600000])test('a failing sync cannot wake its own grant at fixed time, token TTL='+ttl,async()=>{
 await setup();
 await clock.advance(CLOUD_INTERVAL);
 await store.save({...account('A'),watchRefreshToken:'initial-refresh',tokenExpiresAtMillis:clock.now+30000,refreshTokenExpiresAtMillis:clock.now+3600000});
 await flush();
 stageAll();
 const {fixture}=await import('./cloud/service-fixture');
 const {crypto,enabled}=await import('./cloud/k2-crypto');
 const f=await fixture();
 f.fault(request=>new URL(request.url).pathname.endsWith('/bootstrap')?{status:503,error:'temporarily_unavailable'}:undefined);
 let refreshes=0;
 const tokens=new WatchTokenManager(store,{
  backendBaseUrl:account('A').backendBaseUrl,
  transport:{request:async()=>({
   status:200,headers:{},body:utf8Encode(JSON.stringify({
    watchAccessToken:'fixture-'+ ++refreshes,watchRefreshToken:'fixture-refresh-'+refreshes,
    accessTokenExpiresAt:clock.now+ttl,refreshTokenExpiresAt:clock.now+3600000,entitlement:{plan:'member',active:true},
   })),
  })},
 });
 const service=new WatchCloudSyncService({
  now:()=>clock.now,network:async()=>f.network,hash:crypto.sha256,uuid:async()=>'fixture',exclusive:async work=>work(),
  open:async()=>{await tokens.freshAccount();return f.session;},
 },enabled);
 const results:{at:number;ok:boolean;retryAt?:number}[]=[];
 let attempts=0;
 syncResult=async(manual,mode)=>{
  if(++attempts>8)return {ok:false};
  const result=await realSyncNowResult.call(service,manual,mode);
  results.push({at:clock.now,ok:result.ok,retryAt:result.retryAtMillis});
  return result;
 };
 notifyNetwork();
 for(let i=0;i<30;i++)await new Promise<void>(resolve=>setTimeout(resolve,0));
 expect(calls).toEqual([scheduledAll]);
 expect(results).toEqual([{at:CLOUD_INTERVAL,ok:false,retryAt:undefined}]);
 expect(refreshes).toBe(1);
 expect(readManualIntent(secure.get(MANUAL_INTENT_KEY))?.token).toBe('concurrent_all');
 expect(cleared).toEqual([]);
});
