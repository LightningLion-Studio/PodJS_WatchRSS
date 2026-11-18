import {stateSqlFixture} from './cloud/state-sql-fixture';
import {test,expect,mock} from 'bun:test';
import {cloudAccountIdentity} from '../src/cloud/identity';
import type {AccountCloudStatus} from '../src/account/status';
import {WatchAccountStore} from '../src/account/store';
import type {WatchAccountState} from '../src/account/types';
import {MANUAL_INTENT_KEY} from '../src/cloud/manual-handoff';
let life='active',display={interactive:true,resumed:true};const lifecycleListeners=new Set<(state:string)=>void>(),displayListeners=new Set<(value:typeof display)=>void>();
const stateSql=stateSqlFixture();const calls:{method:string;args:any}[]=[],secure=new Map<string,string>();let finish!:(success:boolean)=>void,assertRun!:()=>void;
const modes:[boolean,string|undefined][]=[];
const account:WatchAccountState={
 userId:'account',backendBaseUrl:'https://backend.invalid',phoneMasked:'Fixture',installId:'fixture',
 watchDeviceToken:'fixture',watchRefreshToken:'fixture',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
 posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
 entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
 telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
};
const accounts=new Map<string,string>();
const store=new WatchAccountStore({
 get:key=>accounts.get(key)??null,set:(key,value)=>{accounts.set(key,value);},remove:key=>{accounts.delete(key);},
});
let faultFor:string|undefined,faults=0;
const manualCalls:{scope?:string;account:string|undefined;token:string|undefined}[]=[];
mock.module('@podjs/framework/watch',()=>({lifecycle:()=>life,onLifecycleChange:(fn:any)=>{lifecycleListeners.add(fn);return()=>lifecycleListeners.delete(fn);}}));
mock.module('@podjs/framework/services',()=>({
 displayPower:{state:async()=>display,onChange:(fn:any)=>{displayListeners.add(fn);return()=>displayListeners.delete(fn);}},
 onSqlChanged:()=>()=>{},onNetworkChange:()=>()=>{},delay:()=>({result:new Promise(()=>{}),cancel(){}}),
 hostOperation:(method:string,args:any)=>({result:(async()=>{calls.push({method,args});if(method.startsWith('sql.'))return stateSql.host(method,args);if(method==='crypto.random')return {bytesBase64:'opaque_'+calls.length};if(method==='secure.get'){
  if(args.key===MANUAL_INTENT_KEY&&faultFor&&(await store.read())?.userId===faultFor){
   faultFor=undefined;faults++;throw Error('fixture single read failure during account handoff');
  }
  return {exists:secure.has(args.key),value:secure.get(args.key)};
 }if(method==='secure.set')secure.set(args.key,args.value);if(method==='secure.delete')secure.delete(args.key);if(method==='secure.compareAndSet'){if((secure.get(args.key)??null)!==args.expected)return {updated:false};if(args.value===null)secure.delete(args.key);else secure.set(args.key,args.value);return {updated:true};}if(method==='secure.update'){for(const [k,v]of Object.entries(args.expected??{}))if((secure.get(k)??null)!==v)return {updated:false};for(const [k,v]of Object.entries(args.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}return {updated:true};}return {};})(),cancel(){}}),
}));
mock.module('../src/cloud/host.ts',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate.ts',()=>({cloudGate:{allowed:true,require(){}}}));
mock.module('../src/llm/runtime.ts',()=>({summaryAccountStore:store}));
mock.module('../src/core/library-mutations.ts',()=>({subscribeLibraryMutations:()=>()=>{}}));
mock.module('../src/services.ts',()=>({getLibrarySyncRepository:async()=>({}),notifyNotesChanged(){},notifyLibraryChanged(){},services:{subscribeChannel:()=>()=>{}}}));
let cloudStatus:()=>AccountCloudStatus|undefined=()=>undefined;
mock.module('../src/cloud/status.ts',()=>({connectCloudAccountStatus:(read:typeof cloudStatus)=>{cloudStatus=read;return()=>{cloudStatus=()=>undefined;};},notifyCloudAccountStatus(){}}));
mock.module('../src/cloud/runtime.ts',()=>({createCloudRuntime:(...args:any[])=>({
 inspectOwner:async()=>true,
 approvals:{active:false,state:{phase:'idle'},subscribe:()=>()=>{},setForeground(){},reset(){}},
 service:{status:{phase:'idle'},reset(){},subscribe:()=>()=>{},syncNowResult:async(manual:boolean,mode?:string,scope?:string)=>{
  modes.push([manual,mode]);if(!manual)return {ok:false};
  assertRun=args[5].begin();
  const result=new Promise<boolean>(resolve=>finish=resolve);
  const current=await store.read();
  manualCalls.push({scope,account:current?.userId,token:current?.watchDeviceToken});
  return {ok:await result};
 }},
})}));
const {startApplicationCloudSync,stopApplicationCloudSync,manualCloudSync,applicationCloudApproval,applicationCloudHandoff}=await import('../src/cloud/application');
const {localTransferActivity}=await import('../src/sync/local-transfer');
const flush=async()=>{await new Promise(resolve=>setTimeout(resolve,0));for(let i=0;i<80;i++)await Promise.resolve();};
test('production application keeps manual work on page exit, hands HOME/lock to OS, and exports local BLE hold',async()=>{
 for(const reason of ['HOME','lock']){
  accounts.clear();await store.save(account);
  calls.length=0;secure.clear();stateSql.db.exec('DROP TABLE IF EXISTS cloud_state_values;DROP TABLE IF EXISTS cloud_state_chunks;DROP TABLE IF EXISTS cloud_state_migrations');life='active';display={interactive:true,resumed:true};const app=startApplicationCloudSync();await app.ready;await flush();
  const generation=cloudStatus()?.accountRevision;expect(generation).toBeGreaterThan(0);
  const manual=manualCloudSync('all',cloudAccountIdentity(account),false,generation);await flush();expect(assertRun).toBeDefined();assertRun();
  applicationCloudApproval.setForeground(false);await flush();expect(calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(1);assertRun();
  const release=localTransferActivity.acquire();await flush();expect(calls.some(c=>c.method==='cloud.localTransfer'&&c.args.active===true)).toBe(true);expect(assertRun).toThrow('cloud_sync_suspended');release();await flush();expect(assertRun).toThrow('cloud_sync_suspended');
  if(reason==='HOME'){life='background';for(const fn of lifecycleListeners)fn(life);}else{display={interactive:false,resumed:true};for(const fn of displayListeners)fn(display);}
  await flush();expect(calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(2);expect(applicationCloudHandoff.state.phase).toBe('queued');finish(false);await manual;stopApplicationCloudSync();await flush();
 }
});


test('production startup restores an old authorized recent128 intent before automatic work without asking or widening scope',async()=>{
 accounts.clear();await store.save(account);
 calls.length=0;secure.clear();stateSql.db.exec('DROP TABLE IF EXISTS cloud_state_values;DROP TABLE IF EXISTS cloud_state_chunks;DROP TABLE IF EXISTS cloud_state_migrations');modes.length=0;life='active';display={interactive:true,resumed:true};
 const key='watchrss.cloud.manual.v1',epoch='epoch-from-current-account';
 secure.set(key,JSON.stringify({version:1,token:'legacy_restore',scope:JSON.stringify([account.userId,account.backendBaseUrl]),mode:'recent128',createdAt:1}));
 secure.set('watchrss.cloud.epoch.'+JSON.stringify([account.backendBaseUrl,account.userId]),epoch);
 const app=startApplicationCloudSync();await app.ready;await flush();expect(modes).toEqual([[true,'recent128']]);expect(calls.some(c=>c.method==='crypto.random')).toBe(false);
 expect(calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(1);expect(calls.find(c=>c.method==='cloud.enqueue')!.args).toEqual({token:'legacy_restore',standby:true});
 finish(true);await flush();expect(secure.has(key)).toBe(false);stopApplicationCloudSync();await flush();
});

for(const retry of ['credential event','manual request'])test('an account switch retries a transient grant read via '+retry,async()=>{
 accounts.clear();secure.clear();calls.length=0;manualCalls.length=0;faults=0;
 life='active';display={interactive:true,resumed:true};
 await store.save(account);
 const app=startApplicationCloudSync();
 try{
  await app.ready;await flush();
  const previous=cloudStatus()!.accountRevision!;
  await store.clear();await flush();
  const next={...account,userId:'account-b',watchDeviceToken:'new-token'};
  faultFor=next.userId;
  await store.save(next);await flush();
  expect(faults).toBe(1);
  const generation=cloudStatus()!.accountRevision!;
  expect(generation).toBeGreaterThan(previous);
  const scope=cloudAccountIdentity(next);
  expect(await manualCloudSync('recent128',scope,false,previous)).toBeUndefined();
  expect(manualCalls).toEqual([]);
  expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
  if(retry==='credential event'){
   const before=calls.length;
   await store.save({...next,watchDeviceToken:'rotated-token'});
   await flush();
   expect(calls.slice(before).some(c=>c.method==='secure.get'&&c.args.key===MANUAL_INTENT_KEY)).toBe(true);
  }
  const manual=manualCloudSync('recent128',scope,false,generation);
  await flush();
  expect(manualCalls).toEqual([{scope,account:next.userId,token:retry==='credential event'?'rotated-token':'new-token'}]);
  expect(secure.has(MANUAL_INTENT_KEY)).toBe(true);
  finish(true);
  expect(await manual).toMatchObject({ok:true});
  expect(secure.has(MANUAL_INTENT_KEY)).toBe(false);
  expect(cloudStatus()?.accountRevision).toBe(generation);
 }finally{stopApplicationCloudSync();await flush();}
});
