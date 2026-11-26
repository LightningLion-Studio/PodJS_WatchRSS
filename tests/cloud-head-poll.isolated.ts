import {afterEach,beforeEach,expect,mock,test} from 'bun:test';
import {WatchAccountStore} from '../src/account/store';
import type {WatchAccountState} from '../src/account/types';
import {CLOUD_INTERVAL} from '../src/cloud/scheduler';
import {readCloudAccountStatus,subscribeCloudAccountStatus} from '../src/cloud/status';
import type {CloudSession,CloudSyncPorts} from '../src/cloud/service';
import {utf8Encode} from '../src/cloud/types';
import {notifyLibrarySqlCommit} from '../src/core/library-mutations';
import {playbackWork} from '../src/core/playback-work';
import {localTransferActivity} from '../src/sync/local-transfer';
import {stateSqlFixture} from './cloud/state-sql-fixture';
import {Clock,deferred,flush} from './helpers/ip-fixture';

const account:WatchAccountState={
 userId:'account',backendBaseUrl:'https://backend.invalid',phoneMasked:'Fixture',installId:'fixture',
 watchDeviceToken:'fixture-token',watchRefreshToken:'',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
 posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
 entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
 telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
};
const values=new Map<string,string>();
const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{values.set(key,value);},remove:key=>{values.delete(key);}});
const lifeListeners=new Set<(state:string)=>void>();
const screenListeners=new Set<(screen:{interactive:boolean;resumed:boolean})=>void>();
const networkListeners=new Set<()=>void>();
let life='active',screen={interactive:true,resumed:true};
let clock:Clock,sql:ReturnType<typeof stateSqlFixture>;
let forced:'on'|'off'|null=null;
let approved=true,readable=true,configEnabled=true,configStatus=200,configTtl=600,headStatus=200,etag='head-1',interval=20_000;
let headCode:string|undefined;
let headHeaders:Record<string,string>,headError:Error|undefined,headResponse:ReturnType<typeof deferred<void>>|undefined;
let v2Result:string|null=null,holdSync:ReturnType<typeof deferred<void>>|undefined,writer=false,worker=false;
const files=new Map<string,Uint8Array>();
const secure=new Map<string,string>();
const calls:{method:string;args:Record<string,any>}[]=[];
const syncTimes:number[]=[],messages:(string|undefined)[]=[],refreshes:string[]=[];
const originalNow=Date.now,originalRandom=Math.random;
const setLife=(value:string)=>{life=value;for(const fn of lifeListeners)fn(life);};
const setScreen=(interactive:boolean)=>{screen={interactive,resumed:true};for(const fn of screenListeners)fn(screen);};
const requests=()=>calls.filter(call=>call.method==='http.download');
const notifyLocalMemoSave=()=>notifyLibrarySqlCommit([{sql:'UPDATE memo_notes SET title=?'}],[1],'local-memo');
const heads=()=>requests().filter(call=>call.args.url.endsWith('/account/head'));
const configRequests=()=>requests().filter(call=>call.args.url.includes('/client-config?'));
const subscribe=<T>(set:Set<(value:T)=>void>,fn:(value:T)=>void)=>{set.add(fn);return ()=>{set.delete(fn);};};

mock.module('@podjs/framework/watch',()=>({lifecycle:()=>life,onLifecycleChange:(fn:(value:string)=>void)=>subscribe(lifeListeners,fn)}));
mock.module('@podjs/framework/services',()=>({
 fileChunks:{},displayPower:{state:async()=>screen,onChange:(fn:(value:typeof screen)=>void)=>subscribe(screenListeners,fn)},
 onSqlChanged:()=>()=>{},onNetworkChange:(fn:()=>void)=>subscribe(networkListeners,fn),
 delay:(ms:number)=>clock.delay(Math.min(120_000,ms)),
 hostOperation(method:string,args:Record<string,any>){
  const cancelled=deferred<never>();
  const result=(async()=>{
   calls.push({method,args});
   if(method.startsWith('sql.'))return sql.host(method,args);
   if(method==='cloud.acquire'){
    if(writer)throw Error('overlapping foreground writer');
    if(worker)return {acquired:false};
    writer=true;
    return {acquired:true};
   }
   if(method==='cloud.release'){writer=false;return;}
   if(method.startsWith('cloud.'))return;
   if(method==='secure.get')return {exists:secure.has(args.key),value:secure.get(args.key)};
   if(method==='secure.set'){secure.set(args.key,args.value);return;}
   if(method==='file.createTemp')return {path:'temp-'+calls.length};
   if(method==='file.delete'){files.delete(args.path);return;}
   if(method==='file.read'){
    const body=files.get(args.path)!;
    return {offset:args.offset,size:body.length,dataBase64:Buffer.from(body.subarray(args.offset,args.offset+args.maxBytes)).toString('base64')};
   }
   if(method==='http.download'){
    const config=args.url.includes('/client-config?');
    const status=config?configStatus:headStatus;
    if(!config&&headError)throw headError;
    if(!config&&headResponse)await Promise.race([headResponse.result,cancelled.result]);
    const body= status===304?new Uint8Array():utf8Encode(JSON.stringify(config?
     {ttlSeconds:configTtl,features:{sync_head_poll_v1:{percent:configEnabled?100:0,salt:'fixture',minAppVersionCode:0,maxAppVersionCode:null,forced}}}:
     status===200?{etag,head:'2',epoch:'epoch',signingKeysRev:'1',pollAfterMs:interval}:headCode?{error:{code:headCode}}:{}));
    files.set(args.path,body);
    return {path:args.path,size:body.length,status,headers:config?{}:{ETag:'"'+etag+'"',...headHeaders}};
   }
   throw Error('Unexpected host method '+method);
  })();
  return {result,cancel(){if(method==='http.download'&&headResponse)cancelled.reject(Error('cancelled'));}};
 },
}));
mock.module('../src/cloud/host',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate',()=>({cloudGate:{allowed:true,require(){}}}));
mock.module('../src/llm/runtime',()=>({summaryAccountStore:store}));
mock.module('../src/logs/app-logger',()=>({appLogger:{i(){},w(){}}}));
mock.module('../src/services',()=>({
 getLibrarySyncRepository:async()=>({}),
 notifyNotesChanged(){refreshes.push('notes');},notifyLibraryChanged(){refreshes.push('library');},
 services:{subscribeChannel:()=>()=>{}},
}));
mock.module('../src/sync-v2/product-start',()=>({
 watchSyncV2Product:()=>({stop:async()=>{},async sync(){
  syncTimes.push(clock.now);
  await holdSync?.result;
  return {completionError:v2Result};
 }}),
 leasedSyncV2Session:()=>{throw Error('Unexpected real v2 session in test');},
}));
const {WatchCloudSyncService}=await import('../src/cloud/service');
mock.module('../src/cloud/runtime',()=>({createCloudRuntime:(
 _host:unknown,_repo:unknown,guard:{require():void},_accounts:unknown,_changed:unknown,_execution:unknown,
 formats:Pick<CloudSyncPorts,'keysReady'|'syncV2'|'primaryV2'>,
)=>{
 const service=new WatchCloudSyncService({
  ...formats,network:async()=>({active:true,validated:true,wifi:true,metered:false}),
  open:async()=> {
   const current=await store.read();
   if(!current)return;
   return {userId:current.userId,deviceId:'watch',assertCurrent:async()=>{},client:{
    async bootstrap(){return {
     libraryEpoch:'epoch',contentGeneration:'00000000-0000-4000-8000-000000000001',contentEmpty:false,contentClearedAt:null,
     syncV2:{},member:{readable,active:true,usedBytes:0,reservedBytes:0,quotaBytes:1000},
     devices:[{deviceId:'watch',revokedAt:null}],keyCommitments:[{keyVersion:1}],keyEnvelopes:[],
    };},
    setEpoch(){},setContentGeneration(){},
   },keys:{publicKeySpki:async()=>'',acceptBootstrap:async()=>approved?'ready':'waiting-approval',
    accountKey:async()=>new Uint8Array(32).fill(1)}} as unknown as CloudSession;
  },exclusive:async fn=>fn(),hash:async()=>'',uuid:async()=>'',now:Date.now,
 },guard);
 return {service,inspectOwner:async()=>{},approvals:{state:{phase:'idle'},active:false,subscribe:()=>()=>{},setForeground(){},reset(){}}};
}}));
const {startApplicationCloudSync,stopApplicationCloudSync}=await import('../src/cloud/application');
let offStatus:()=>void;
beforeEach(async()=>{
 clock=new Clock();clock.now=1000;sql=stateSqlFixture();
 Date.now=()=>clock.now;Math.random=()=>0.5;
 calls.length=syncTimes.length=messages.length=refreshes.length=0;
 writer=worker=false;values.clear();secure.clear();files.clear();life='active';screen={interactive:true,resumed:true};
 forced=null;configEnabled=approved=readable=true;headStatus=configStatus=200;interval=20_000;configTtl=600;etag='head-1';
 headHeaders={};headCode=undefined;headError=headResponse=holdSync=undefined;v2Result=null;
 await store.save(account);
 offStatus=subscribeCloudAccountStatus(()=>messages.push(readCloudAccountStatus()?.message));
});
afterEach(async()=>{
 offStatus();stopApplicationCloudSync();await flush();sql.db.close();
 Date.now=originalNow;Math.random=originalRandom;
});
async function start(){await startApplicationCloudSync().ready;await flush();await clock.advance(0);}

test('changed 200 immediately uses the writer; unchanged 200 and 304 do no sync, SQL or UI work',async()=>{
 interval=33_000;
 await start();
 expect(syncTimes).toEqual([1000]);
 expect(configRequests()[0]?.args.url).toMatch(/platform=watch&appVersionCode=\d+&installId=fixture$/);
 expect(heads()).toHaveLength(0);
 await clock.advance(20_000);
 expect(syncTimes).toEqual([1000,21_000]);
 expect(heads()[0]?.args).toMatchObject({method:'GET',headers:{Authorization:'Bearer fixture-token','x-watchrss-cloud-device-id':'watch'},followRedirects:false});
 expect(Object.keys(heads()[0]!.args.headers).map(key=>key.toLowerCase())).not.toContain('if-none-match');
 for(const status of [200,304]){
  headStatus=status;
  const before={calls:calls.length,http:requests().length,messages:messages.length,refreshes:refreshes.length};
  await clock.advance(interval);
  expect(requests().length-before.http).toBe(1);
  expect(calls.slice(before.calls).some(call=>call.method.startsWith('sql.'))).toBe(false);
  expect(messages).toHaveLength(before.messages);
  expect(refreshes).toHaveLength(before.refreshes);
  expect(syncTimes).toEqual([1000,21_000]);
 }
 etag='head-2';headStatus=200;
 await clock.advance(interval);
 expect(syncTimes).toEqual([1000,21_000,120_000]);
});

test('failed full sync does not record etag',async()=>{
 await start();
 v2Result='cloud_v2_pending';
 await clock.advance(20_000);
 v2Result=null;
 await clock.advance(30_000);
 expect(syncTimes).toEqual([1000,21_000,51_000]);
 await clock.advance(20_000);
 expect(syncTimes).toEqual([1000,21_000,51_000,71_000]);
 await clock.advance(20_000);
 expect(syncTimes).toEqual([1000,21_000,51_000,71_000]);
});

for(const [status,code] of [[404,undefined],[405,undefined],[400,'invalid_schema']] as const){
test(status+' on every head GET keeps legacy sync results and emits no extra notices',async()=>{
 const runLegacy=async(available:boolean)=>{
  configEnabled=available;
  configStatus=available?404:200;
  headStatus=status;headCode=code;
  await start();
  const initialMessages=messages.length;
  await clock.advance(20_000);
  expect(messages).toHaveLength(initialMessages);
  expect(heads()).toHaveLength(available?1:0);
  notifyLocalMemoSave();
  await clock.advance(2999);
  expect(syncTimes).toHaveLength(1);
  await clock.advance(1);
  expect(syncTimes).toEqual([1000]);
  for(const fn of networkListeners)fn();
  await clock.advance(CLOUD_INTERVAL);
  expect(heads()).toHaveLength(available?1:0);
  expect(messages).not.toContain('云同步失败，请稍后重试');
  expect(readCloudAccountStatus()).toMatchObject({phase:'complete',message:'云同步完成',resultSequence:2});
  return {syncTimes:[...syncTimes],messages:[...messages],
   results:readCloudAccountStatus()?.resultSequence,
   worker:calls.filter(call=>['cloud.schedule','cloud.cancel','cloud.enqueue'].includes(call.method))};
 };
 const fallback=await runLegacy(true);
 offStatus();stopApplicationCloudSync();await flush();
 clock=new Clock();clock.now=1000;
 syncTimes.length=messages.length=calls.length=0;
 offStatus=subscribeCloudAccountStatus(()=>messages.push(readCloudAccountStatus()?.message));
 expect(await runLegacy(false)).toEqual(fallback);
});
}

test('a service failure retries and a server-disabled response waits for cloud config',async()=>{
 configTtl=60;
 await start();
 headStatus=503;
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 headStatus=403;headCode='head_poll_disabled';configEnabled=false;
 await clock.advance(20_000);
 expect(heads()).toHaveLength(2);
 await clock.advance(20_000);
 expect(configRequests()).toHaveLength(2);
 await clock.advance(59_999);
 expect(heads()).toHaveLength(2);
 configEnabled=true;headStatus=200;headCode=undefined;
 await clock.advance(20_001);
 expect(heads()).toHaveLength(3);
});

test('429 honors Retry-After then exponentially backs off to five minutes on network failure',async()=>{
 await start();
 headStatus=429;headHeaders={'retry-after':'71'};
 const initialMessages=messages.length;
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 await clock.advance(70_999);
 expect(heads()).toHaveLength(1);
 headError=Error('network');
 await clock.advance(1);
 expect(heads()).toHaveLength(2);
 for(const [index,wait] of [40_000,80_000,160_000,300_000,300_000].entries()){
  await clock.advance(wait-1);
  expect(heads()).toHaveLength(index+2);
  await clock.advance(1);
  expect(heads()).toHaveLength(index+3);
 }
 expect(syncTimes).toEqual([1000]);
 expect(messages).toHaveLength(initialMessages);
});

for(const gate of ['screen','background','transfer','playback'] as const){
 test(gate+' cancels the poll timer and fences a response in flight',async()=>{
  await start();
  const close=()=>{
   if(gate==='screen'){setScreen(false);return ()=>setScreen(true);}
   if(gate==='background'){setLife('background');return ()=>setLife('active');}
   return gate==='transfer'?localTransferActivity.acquire():playbackWork.hold();
  };
  let reopen=close();
  expect(clock.timers.some(timer=>!timer.cancelled&&timer.at===21_000)).toBe(false);
  await clock.advance(25_000);
  expect(heads()).toHaveLength(0);
  headResponse=deferred<void>();
  reopen();
  await clock.advance(20_000);
  expect(heads()).toHaveLength(1);
  reopen=close();
  headResponse.resolve();
  headResponse=undefined;
  await flush();
  expect(writer).toBe(false);
  expect(syncTimes).toEqual([1000]);
  await clock.advance(60_000);
  expect(heads()).toHaveLength(1);
  reopen();
 });
}

test('the server config can switch polling off and back on without a writer run',async()=>{
 configTtl=30;
 await start();
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 configEnabled=false;
 await clock.advance(10_000);
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 expect(configRequests()).toHaveLength(2);
 configEnabled=true;
 await clock.advance(30_000);
 expect(heads()).toHaveLength(2);
 expect(syncTimes).toEqual([1000,21_000]);
});

test('memo publication interrupts a slow head request at the original three-second deadline',async()=>{
 await start();
 headResponse=deferred<void>();
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 expect(writer).toBe(true);
 notifyLocalMemoSave();
 await clock.advance(2999);
 expect(syncTimes).toEqual([1000]);
 await clock.advance(1);
 expect(writer).toBe(false);
 expect(syncTimes).toEqual([1000,24_000]);
});

test('an in-progress normal sync cancels the poll timer until the writer settles',async()=>{
 await start();
 holdSync=deferred<void>();
 notifyLocalMemoSave();
 await clock.advance(3_000);
 expect(syncTimes).toEqual([1000,4000]);
 await clock.advance(25_000);
 expect(heads()).toHaveLength(0);
 holdSync.resolve();
 holdSync=undefined;
 await flush();
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
});

test('approval, account, and the writer lease gate head traffic',async()=>{
 approved=false;
 await start();
 await clock.advance(30_000);
 expect(requests()).toHaveLength(0);
 approved=true;
 for(const fn of networkListeners)fn();
 await clock.advance(CLOUD_INTERVAL-30_000);
 expect(configRequests()).toHaveLength(1);
 worker=true;
 await clock.advance(20_000);
 expect(heads()).toHaveLength(0);
 worker=false;
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 await store.clear();await flush();
 await clock.advance(40_000);
 expect(heads()).toHaveLength(1);
});

for(const [random,wait] of [[0,18_000],[0.5,20_000],[0.999_999,22_000]] as const){
 test('jitter boundary '+wait+' ms',async()=>{
  Math.random=()=>random;
  await start();
  await clock.advance(wait-1);
  expect(heads()).toHaveLength(0);
  await clock.advance(1);
  expect(heads()).toHaveLength(1);
 });
}

test('forced off on cold start keeps the first foreground memo on the legacy schedule',async()=>{
 forced='off';
 holdSync=deferred<void>();
 await start();
 notifyLocalMemoSave();
 holdSync.resolve();
 await flush();
 await clock.advance(3000);
 expect(syncTimes).toEqual([1000]);
 await clock.advance(CLOUD_INTERVAL-3000);
 expect(syncTimes).toEqual([1000,301_000]);
 expect(heads()).toHaveLength(0);
});


test('an off rule survives foreground reentry and config failure',async()=>{
 forced='off';configTtl=30;
 await start();
 setLife('background');
 configStatus=503;
 await clock.advance(30_000);
 setLife('active');await flush();await clock.advance(0);
 expect(configRequests()).toHaveLength(2);
 notifyLocalMemoSave();
 await clock.advance(23_000);
 expect(heads()).toHaveLength(0);
 expect(syncTimes).toEqual([1000]);
});

test('an account switch waits for its own off rule before expediting a save',async()=>{
 await start();
 await store.clear();await flush();
 holdSync=deferred<void>();forced='off';
 await store.save({...account,userId:'another-account',installId:'another-install'});await flush();
 expect(syncTimes).toEqual([1000,1000]);
 notifyLocalMemoSave();
 holdSync.resolve();await flush();await clock.advance(23_000);
 expect(configRequests().at(-1)?.args.url).toContain('installId=another-install');
 expect(syncTimes).toEqual([1000,1000]);
 expect(heads()).toHaveLength(0);
});

test('an unavailable client-config uses the packaged default for polling and memo saves',async()=>{
 configStatus=503;
 await start();
 await clock.advance(20_000);
 expect(heads()).toHaveLength(1);
 notifyLocalMemoSave();
 await clock.advance(3000);
 expect(syncTimes).toEqual([1000,21_000,24_000]);
});
