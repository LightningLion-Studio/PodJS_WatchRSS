import {afterEach, expect, mock, test} from 'bun:test';
import {WatchAccountStore} from '../src/account/store';
import type {WatchAccountState} from '../src/account/types';
import {CLOUD_SYNC_SUSPENDED,type CloudForegroundExecution} from '../src/cloud/execution';
import {cloudAccountIdentity} from '../src/cloud/identity';
import {MANUAL_INTENT_KEY, readManualIntent} from '../src/cloud/manual-handoff';
import {CLOUD_INTERVAL} from '../src/cloud/scheduler';
import {notifyLibrarySqlCommit} from '../src/core/library-mutations';
import {playbackWork} from '../src/core/playback-work';
import {localTransferActivity} from '../src/sync/local-transfer';
import {stateSqlFixture} from './cloud/state-sql-fixture';
import {Clock, deferred, flush} from './helpers/ip-fixture';

const account=(userId:string):WatchAccountState=>({
 userId,backendBaseUrl:'https://fixture.invalid',phoneMasked:'Fixture',installId:'fixture',
 watchDeviceToken:'fixture',watchRefreshToken:'fixture',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
 posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
 entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
 telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
});
type Display={interactive:boolean;resumed:boolean};
type ChannelChange={kind:string;origin?:'remote'|'local'};
const lifecycleListeners=new Set<(state:string)=>void>();
const displayListeners=new Set<(value:Display)=>void>();
const networkListeners=new Set<()=>void>();
const channelListeners=new Set<(value:ChannelChange)=>void>();
const sqlListeners=new Set<()=>void>();
const sub=<Args extends unknown[]>(listeners:Set<(...args:Args)=>void>,fn:(...args:Args)=>void)=>{
 listeners.add(fn);return()=>{listeners.delete(fn);};
};
let clock:Clock, sql:ReturnType<typeof stateSqlFixture>;
let life:string, display:Display;
let faultFor:string|undefined, faults:number;
let retryForA:number|undefined;
let finishA:ReturnType<typeof deferred<void>>|undefined;
let execution:CloudForegroundExecution,suspensions:number;
const accounts=new Map<string,string>(),secure=new Map<string,string>();
const executions:{account:string|null;grant?:string;mode?:string}[]=[];
const deletes:{account:string;token:string}[]=[];
const inspected:string[]=[];
const store=new WatchAccountStore({
 get:key=>accounts.get(key)??null,set:(key,value)=>{accounts.set(key,value);},remove:key=>{accounts.delete(key);},
});
const serviceStatus:{retryAtMillis?:number}={};
const sync=async(manual:boolean,mode?:string)=>{
 const current=execution.begin();
 const owner=await store.read();
 const grant=manual?readManualIntent(secure.get(MANUAL_INTENT_KEY)):undefined;
 if(grant)expect(grant.scope).toBe(cloudAccountIdentity(owner));
 executions.push({account:owner?.userId??null,grant:grant?.token,mode});
 if(owner?.userId==='A')await finishA?.result;
 try{current();}catch(error){
  if(!(error instanceof Error)||error.message!==CLOUD_SYNC_SUSPENDED)throw error;
  suspensions++;
  return false;
 }
 serviceStatus.retryAtMillis=owner?.userId==='A'?retryForA:undefined;
 return !!grant;
};
mock.module('@podjs/framework/watch',()=>({
 lifecycle:()=>life,onLifecycleChange:(fn:(state:string)=>void)=>sub(lifecycleListeners,fn),
}));
mock.module('@podjs/framework/services',()=>({fileChunks:{readBytes:async()=>{throw Error('Unexpected archived book read');}},
 displayPower:{state:async()=>display,onChange:(fn:(value:Display)=>void)=>sub(displayListeners,fn)},
 onSqlChanged:(_topic:string,fn:()=>void)=>sub(sqlListeners,fn),
 onNetworkChange:(fn:()=>void)=>sub(networkListeners,fn),
 delay:(ms:number)=>clock.delay(ms),
 hostOperation:(method:string,args:Record<string,unknown>)=>({
  result:(async()=>{
   if(method.startsWith('sql.'))return sql.host(method,args);
   const key=String(args.key);
   if(method==='secure.get'){
    if(key===MANUAL_INTENT_KEY&&faultFor&&(await store.read())?.userId===faultFor){
     faultFor=undefined;
     faults++;
     throw Error('fixture single grant read failure during initialization');
    }
    return {exists:secure.has(key),value:secure.get(key)};
   }
   if(method==='secure.update')return {};
   if(method==='secure.compareAndSet'){
    const previous=secure.get(key);
    if((previous??null)!==args.expected)return {updated:false};
    if(args.value===null){
     const intent=readManualIntent(previous);
     if(key===MANUAL_INTENT_KEY&&intent)deletes.push({account:JSON.parse(intent.scope)[0],token:intent.token});
     secure.delete(key);
    }else secure.set(key,String(args.value));
    return {updated:true};
   }
   if(['cloud.enqueue','cloud.localTransfer','cloud.schedule','cloud.cancel'].includes(method))return {};
   throw Error('Unexpected host method in auto-resume fixture: '+method);
  })(),cancel(){},
 }),
}));
mock.module('../src/cloud/host',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate',()=>({cloudGate:{allowed:true,require(){}}}));
mock.module('../src/llm/runtime',()=>({summaryAccountStore:store}));
const channel=(value:ChannelChange)=>{for(const fn of channelListeners)fn(value);};
mock.module('../src/services',()=>({
 getLibrarySyncRepository:async()=>({}),
 notifyNotesChanged(){channel({kind:'notes'});},
 notifyLibraryChanged(origin:'local'|'remote'='local'){channel({kind:'library',origin});},
 services:{subscribeChannel:(fn:(value:ChannelChange)=>void)=>sub(channelListeners,fn)},
}));
mock.module('../src/cloud/runtime',()=>({createCloudRuntime:(
 _host:unknown,_repository:unknown,_guard:unknown,_accounts:unknown,_notify:unknown,foreground:CloudForegroundExecution,
)=>{
 execution=foreground;
 return {
 inspectOwner:async()=>{inspected.push((await store.read())?.userId??'none');return true;},
 approvals:{active:false,state:{phase:'idle'},subscribe:()=>()=>{},setForeground(){},reset(){}},
 service:{
  status:serviceStatus,reset(){},subscribe:()=>()=>{},syncNow:sync,
  syncNowResult:async(manual:boolean,mode?:string)=>({ok:await sync(manual,mode),...serviceStatus}),
 },
 };
}}));
const {startApplicationCloudSync,stopApplicationCloudSync}=await import('../src/cloud/application');
const realNow=Date.now;
let releaseHold:(()=>void)|undefined;
afterEach(async()=>{
 stopApplicationCloudSync();
 finishA?.resolve();
 releaseHold?.();
 releaseHold=undefined;
 await flush();
 Date.now=realNow;
 sql.db.close();
});

const lifecycle=(value:string)=>{life=value;for(const fn of lifecycleListeners)fn(value);};
const screen=(interactive:boolean)=>{
 display={interactive,resumed:interactive};
 for(const fn of displayListeners)fn(display);
};
const network=()=>{for(const fn of networkListeners)fn();};
const advanceClock=(advance:number)=>clock.advance(advance);
const changeAccount=(id:string,fail:boolean)=>{
 // Simulate a native account replacement followed by the production invalidation event.
 // This preserves any A timer until B initializes, as in 7cab5c09.
 const target=account(id);
 secure.set(MANUAL_INTENT_KEY,JSON.stringify({
  version:2,token:'grant_'+id,scope:cloudAccountIdentity(target),mode:'all',createdAt:clock.now,epoch:null,
 }));
 faultFor=fail?id:undefined;
 accounts.set('state_json',JSON.stringify(target));
 store.invalidate();
};
const release=()=>{releaseHold?.();releaseHold=undefined;};
const restart=async()=>{
 stopApplicationCloudSync();
 life='active';
 await startApplicationCloudSync().ready;
};
const cases=[
 {name:'application foreground',waitsForWake:true,prepare:()=>lifecycle('background'),wake:()=>lifecycle('active')},
 {name:'display resumes',waitsForWake:true,prepare:()=>screen(false),wake:()=>screen(true)},
 {name:'network',wake:network},
 {name:'library SQL commit',wake:()=>notifyLibrarySqlCommit([{sql:'UPDATE articles SET title = ?'}],[1])},
 {name:'local non-notes channel',wake:()=>channel({kind:'library',origin:'local'})},
 {name:'coalescing timer',prepare:()=>{lifecycle('background');lifecycle('active');},wake:()=>advanceClock(CLOUD_INTERVAL)},
 {name:'deferred timer',defer:true,wake:()=>advanceClock(30000)},
 {name:'local transfer releases suspended work',waitsForWake:true,writing:true,suspended:true,prepare:()=>{releaseHold=localTransferActivity.acquire();},wake:release},
 {name:'playback releases suspended work',waitsForWake:true,writing:true,suspended:true,prepare:()=>{releaseHold=playbackWork.hold();},wake:release},
 {name:'previous writer settles',waitsForWake:true,writing:true,idleOnFailure:true,ignored:true,wake:()=>finishA!.resolve()},
 {name:'account identity notification',target:'C',wake:()=>changeAccount('C',false)},
 {name:'same-account credential notification',idleOnFailure:true,wake:()=>store.save({...account('B'),watchDeviceToken:'refreshed'})},
 {name:'remote SQL notification',idleOnFailure:true,ignored:true,wake:()=>{for(const fn of sqlListeners)fn();}},
 {name:'notes notification',idleOnFailure:true,ignored:true,wake:()=>channel({kind:'notes'})},
 {name:'cold start',waitsForWake:true,prepare:()=>lifecycle('background'),wake:restart},
] as const;
for(const row of cases)for(const failed of [false,true]){
 test(`${row.name} after initialization ${failed?'fails':'succeeds'}`,async()=>{
  life='active';display={interactive:true,resumed:true};
  clock=new Clock();
  sql=stateSqlFixture();
  Date.now=()=>clock.now;
  accounts.clear();secure.clear();executions.length=0;deletes.length=0;inspected.length=0;
  faults=0;faultFor=undefined;serviceStatus.retryAtMillis=undefined;suspensions=0;
  retryForA='defer' in row?30000:undefined;
  finishA='writing' in row?deferred<void>():undefined;
  await store.save(account('A'));
  await startApplicationCloudSync().ready;
  await flush();
  expect(executions).toEqual([{account:'A',grant:undefined,mode:'recent128'}]);
  if('prepare' in row)row.prepare();
  await flush();
  if(!row.name.endsWith('timer'))clock.now=CLOUD_INTERVAL;
  changeAccount('B',failed);
  await flush();
  expect(faults).toBe(Number(failed));
  if('suspended' in row){
   finishA!.resolve();
   await flush();
   expect(suspensions).toBe(1);
   expect(deletes).toEqual([]);
   expect(readManualIntent(secure.get(MANUAL_INTENT_KEY))?.token).toBe('grant_B');
  }
  const beforeWake=executions.length;
  await row.wake();
  await flush();
  if('suspended' in row){
   const immediate=executions.length;
   await advanceClock(2*CLOUD_INTERVAL);
   expect(executions).toHaveLength(immediate);
  }
  const target='target' in row?row.target:'B';
  // A verified same-account notification now wakes a known durable record.
  const credentialWake=row.name==='same-account credential notification'&&process.env.CLOUD_RESUME_REFERENCE!=='1';
  const remains=failed&&'idleOnFailure' in row&&!credentialWake;
  // Outputs measured on 7cab5c09 with this same fixture. The candidate
  // must also retry initialization without promoting a credential refresh to work.
  const completed=remains?[]:target==='C'&&!failed?['B','C']:[target];
  const result={
   calls:executions.map(call=>[call.account,call.grant??null,call.mode]),
   cleaned:deletes.map(call=>[call.account,call.token]),
   pending:readManualIntent(secure.get(MANUAL_INTENT_KEY))?.token??null,
   beforeWake,
  };
  console.log('matrix '+JSON.stringify({entry:row.name,failed,...result}));
  expect(result).toEqual({
   calls:[['A',null,'recent128'],...completed.map(id=>[id,'grant_'+id,'all'])],
   cleaned:completed.map(id=>[id,'grant_'+id]),
   pending:remains?'grant_B':null,
   beforeWake:failed||'waitsForWake' in row?1:2,
  });
  if(process.env.CLOUD_RESUME_REFERENCE!=='1'&&failed&&target==='B'){
   expect(inspected.filter(id=>id==='B')).toHaveLength('ignored' in row?1:2);
  }
 });
}
