import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import {accountStatusIdentity,accountStatusSnapshot,type AccountStatusChange} from '../src/account/status';
import type {SyncV2UiPort} from '../src/ui/sync-v2-view';
import type {SyncV2UiState} from '../src/sync-v2/ui-state';
import type {WatchAccountState} from '../src/account/types';
import type {CloudSyncResult} from '../src/cloud/service';
import type {CloudApprovalState as WatchApprovalState} from '../src/cloud/approval-controller';
import type {ScrollEntry} from '../src/ui/ScrollEntries';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'cloud-approval-ui',setup(builder){builder.onLoad({filter:/\/(?:CloudSyncScreen|SyncV2Screen)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const output=Object.create(props);Object.defineProperty(output,'children',{value:props.children,enumerable:true});return {kind,props:output};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(props:Node['props'])=>element('View',props),Text:(props:Node['props'])=>element('Text',props)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>Array.from(s).length*10})}));
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(props:Node['props'])=>{const children=createMemo(()=>props.entries.map((entry:ScrollEntry)=>entry.render()));return element('ScrollEntries',{...props,children});}}));
const timers:{milliseconds:number;cancelled:boolean;resolve():void;reject(error:Error):void;throwOnCancel?:boolean}[]=[];
const nativeSetTimeout=globalThis.setTimeout;
const requests:{method:string;args:Record<string,unknown>}[]=[];let inputFinish:(code:string|null)=>void=()=>{},cancels=0;
mock.module('@podjs/framework/services',()=>({delay:(milliseconds:number)=>{requests.push({method:'runtime.delay',args:{milliseconds}});let resolve!:()=>void,reject!:(e:Error)=>void;const result=new Promise<void>((yes,no)=>{resolve=yes;reject=no;}),timer={milliseconds,cancelled:false,resolve,reject,throwOnCancel:false};timers.push(timer);return {result,cancel:()=>{timer.cancelled=true;if(timer.throwOnCancel)throw Error('host closed');reject(Error('cancelled'));}};},hostOperation:(method:string,args:Record<string,unknown>)=>{requests.push({method,args});return {result:new Promise<string|null>(resolve=>{inputFinish=resolve;}),cancel:()=>{cancels++;inputFinish(null);}};}}));
const {CloudSyncScreen}=await import('../src/ui/CloudSyncScreen');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();requests.length=0;timers.length=0;cancels=0;});
const settle=()=>new Promise<void>(resolve=>nativeSetTimeout(resolve,0));
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return [];return [value,...nodes(value.props.children)];}
type LoadStatus=Parameters<typeof CloudSyncScreen>[0]["load"];
function mount(withActions=false,ownerChoice=false,load?:LoadStatus){
 let logoutCalls=0;const actionCalls:string[]=[];let dispose=()=>{};
 let state:WatchApprovalState={phase:'idle',message:''},creates=0;const codes:string[]=[],listeners=new Set<()=>void>();
 const [active,setActive]=createSignal(true);
 const update=(next:WatchApprovalState)=>{state=next;for(const fn of listeners)fn();};
 const root=createRoot(stop=>{stops.push(stop);dispose=stop;return CloudSyncScreen({width:233,height:233,active,clearLocal:async()=>{},actions:withActions?{busy:false,message:'',subscribe:()=>()=>{},logout:async()=>{logoutCalls++;return true;},resolveOwner:async choice=>{actionCalls.push(choice);return true;},reregister:async()=>true}:undefined,load:load??(async()=>({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'waiting-approval',message:ownerChoice?'本机资料属于其他账号':'waiting',usedBytes:0,quotaBytes:1e9}})),available:()=>true,sync:{pending:false,start:async()=>{}},onPhone:()=>{},onError:()=>{},ref:()=>{},approval:{get state(){return state;},subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};},request:async()=>{creates++;update({phase:'requesting',message:'正在请求旧设备批准…'});return true;},confirmMatches:async()=>true,cancel:async()=>true,setForeground:()=>{}}});});
 return {root,update,setActive,codes,dispose,actionCalls,get logoutCalls(){return logoutCalls;},get creates(){return creates;}};
}
test('v2 approval tap starts only on explicit action and never opens a legacy code input',async()=>{
 const f=mount();await settle();expect(requests).toHaveLength(0);nodes(f.root).find(n=>n.props.accessibilityLabel==='请求设备批准')!.props.onPress();expect(f.creates).toBe(1);f.update({phase:'code',message:'请核对两端的 8 位授权码',code:'84279621',confirmed:false});await settle();expect(nodes(f.root).some(n=>n.props.accessibilityLabel==='输入配对码')).toBe(false);expect(requests).toHaveLength(0);f.setActive(false);await settle();expect(f.codes).toHaveLength(0);
});

async function withoutBrowserTimers(action:()=>Promise<void>){
 const globals=globalThis as unknown as Record<string,unknown>,set=globals.setTimeout,clear=globals.clearTimeout;delete globals.setTimeout;delete globals.clearTimeout;
 try{await action();}finally{globals.setTimeout=set;globals.clearTimeout=clear;}
}
const press=(f:ReturnType<typeof mount>,label:string)=>nodes(f.root).find(n=>n.props.accessibilityLabel===label)!.props.onPress();
const labels=(f:ReturnType<typeof mount>)=>nodes(f.root).map(n=>n.props.accessibilityLabel);
test('release QuickJS cloud page can leave and reopen with both browser timer globals absent',async()=>withoutBrowserTimers(async()=>{
 for(let i=0;i<3;i++){const f=mount();await settle();expect(labels(f)).toContain('请求设备批准');expect(()=>f.dispose()).not.toThrow();}expect(timers).toHaveLength(0);
}));
test('a stalled first status read times out and a late result cannot replace the failure',async()=>withoutBrowserTimers(async()=>{
 let calls=0,finishLate!:(value:null)=>void;
 const f=mount(false,false,()=>++calls===1
  ? new Promise(resolve=>{finishLate=resolve;})
  : Promise.resolve({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,
   accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'waiting-approval',message:'waiting',usedBytes:0,quotaBytes:1e9}}));
 await settle();
 expect(labels(f)).toContain('正在读取');
 expect(timers).toHaveLength(1);
 expect(timers[0]!.milliseconds).toBe(10_000);
 timers[0]!.throwOnCancel=true;
 timers[0]!.resolve();
 await settle();
 expect(labels(f)).toContain('状态读取失败');
 finishLate(null);
 await settle();
 expect(labels(f)).toContain('状态读取失败');
 press(f,'重新读取');
 await settle();
 expect(labels(f)).toContain('请求设备批准');
 expect(calls).toBe(2);
 expect(()=>f.dispose()).not.toThrow();
}));
test('host wall-clock confirmation expires after 4000ms and requires two deliberate presses, with no browser timers',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true);await settle();press(f,'退出账号');expect(f.logoutCalls).toBe(0);expect(timers[0].milliseconds).toBe(4000);expect(labels(f)).toContain('再按一次确认退出');timers[0].resolve();await settle();expect(labels(f)).toContain('退出账号');press(f,'退出账号');expect(f.logoutCalls).toBe(0);press(f,'再按一次确认退出');expect(f.logoutCalls).toBe(1);expect(timers[1].cancelled).toBe(true);f.dispose();
}));
test('superseded host timer cannot disarm a different action; host failure disarms without executing it',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true,true);await settle();press(f,'清空本机资料');press(f,'合并到当前账号');expect(timers[0].cancelled).toBe(true);timers[0].resolve();await settle();expect(labels(f)).toContain('再按一次确认合并');expect(f.actionCalls).toEqual([]);timers[1].reject(Error('timer unavailable'));await settle();expect(labels(f)).toContain('合并到当前账号');expect(f.actionCalls).toEqual([]);f.dispose();
}));
test('disposing an armed cloud page cancels its host timer; even closing host and late completion cannot break cleanup',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true);await settle();press(f,'退出账号');timers[0].throwOnCancel=true;expect(()=>f.dispose()).not.toThrow();expect(timers[0].cancelled).toBe(true);timers[0].resolve();await settle();expect(f.logoutCalls).toBe(0);const next=mount(true);await settle();expect(labels(next)).toContain('退出账号');next.dispose();
}));

test('approver: a pending request is accepted only by tap; digits show with match/mismatch; key goes out only on 一致',async()=>{
 type S=import('../src/cloud/approver-controller').CloudApproverState;
 let state:S={phase:'idle',requests:[],message:''};const listeners=new Set<()=>void>(),calls:string[]=[];
 const update=(next:S)=>{state=next;for(const fn of listeners)fn();};
 const root=createRoot(stop=>{stops.push(stop);return CloudSyncScreen({width:233,height:233,active:()=>true,load:async()=>({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'idle',message:'',usedBytes:0,quotaBytes:1e9}}),available:()=>true,sync:{pending:false,start:async()=>{}},onPhone:()=>{},onError:()=>{},ref:()=>{},
  approver:{get state(){return state;},subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},accept:async (id:string)=>{calls.push('accept:'+id);return true;},confirm:async (match:boolean)=>{calls.push('confirm:'+match);return true;},cancel:async()=>{calls.push('cancel');return true;}}} as any);});
 const all=()=>nodes(root).map(n=>n.props.accessibilityLabel).filter(Boolean),tap=(label:string)=>nodes(root).find(n=>n.props.accessibilityLabel===label)!.props.onPress();
 await settle();expect(all()).not.toContain('核对授权码');
 update({phase:'requested',message:'有新设备请求授权',requests:[{requestId:'r1',requesterLabel:'小程序 · 本机',expiresAt:Date.now()+60000}]});await settle();
 expect(calls).toEqual([]);tap('核对授权码');expect(calls).toEqual(['accept:r1']);
 update({...state,phase:'waiting',requestId:'r1',requesterLabel:'小程序 · 本机'});await settle();expect(all()).not.toContain('一致');tap('取消');expect(calls.at(-1)).toBe('cancel');
 update({...state,phase:'code',code:'84279621'});await settle();expect(all()).toContain('核对码 84279621');
 tap('不一致');expect(calls.at(-1)).toBe('confirm:false');tap('一致');expect(calls.at(-1)).toBe('confirm:true');
 update({...state,phase:'unsupported',code:undefined,message:'服务端暂不支持手表批准授权'});await settle();expect(all()).not.toContain('核对授权码');expect(all()).not.toContain('一致');
});

const {WatchCloudScheduler} = await import('../src/cloud/scheduler');
import type {CloudScheduledRun} from '../src/cloud/scheduler';
const {CloudManualHandoff, MANUAL_INTENT_KEY} = await import('../src/cloud/manual-handoff');
const {fixture: cloudFixture} = await import('./cloud/service-fixture');
const {coalescedRequest} = await import('../src/ui/cloud-sync-view');
const {connectCloudAccountStatus, subscribeCloudAccountStatus, notifyCloudAccountStatus, readCloudAccountStatus} = await import('../src/cloud/status');
const {NetworkRecovery} = await import('../src/network/recovery');
const historical = process.env.CLOUDSYNC_R14_REPRO === '1';
const guard = {require() {}};
const schedulerPorts = {now: () => 0, delay: () => () => {}, scheduleWorker: async () => {}, cancelWorker: async () => {}};

type CloudPageProps=Parameters<typeof CloudSyncScreen>[0];
function syncPage(load: CloudPageProps['load'], sync: CloudPageProps['sync'], subscribe?: CloudPageProps['subscribe'], network?: InstanceType<typeof NetworkRecovery>, readCloud?:CloudPageProps['readCloud'], syncV2?:SyncV2UiPort) {
 const [active, setActive] = createSignal(true);
 let dispose=()=>{};
 const root = createRoot(stop => {
  stops.push(stop);
  dispose=stop;
  const props = {width: 233, height: 233, active, load, subscribe, readCloud, syncV2, onSyncV2() {}, available: () => true, sync, onPhone() {}, onError() {}, ref() {}};
  if (network) {
   const {Provider} = networkContext;
   return createComponent(Provider, {value: network, get children() { return CloudSyncScreen(props); }});
  }
  return CloudSyncScreen(props);
 });
 return {
  setActive,dispose,
  labels: () => nodes(root).map(n => n.props.accessibilityLabel).filter(Boolean),
  buttons: () => nodes(root).filter(n=>n.props.accessibilityRole==='button')
    .map(n=>[n.props.accessibilityLabel,typeof n.props.onPress==='function'&&!n.props.accessibilityState?.disabled]),
  press(label: string) { nodes(root).find(n => n.props.accessibilityLabel === label)!.props.onPress(); },
 };
}
const {NetworkRecoveryContext: networkContext} = await import('../src/network/context');
function syncSnapshot(cloud: NonNullable<ReturnType<typeof readCloudAccountStatus>>, accountId: string) {
 const value=accountStatusSnapshot({
  userId:accountId,backendBaseUrl:'https://fixture.invalid',phoneMasked:'Fixture',installId:'fixture',
  watchDeviceToken:'fixture',watchRefreshToken:'fixture',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
  posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
  entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
  telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
 },Date.now(),cloud)!;
 return historical?{...value,accountId,accountScope:accountId}:value;
}

test('retained cloud route takes the service snapshot after both deliveries of one success', async () => {
 const {service} = await cloudFixture();
 const read = () => ({...service.status, accountId: 'A'});
 stops.push(connectCloudAccountStatus(read), service.subscribe(notifyCloudAccountStatus));
 let calls = 0;
 const scheduler = new WatchCloudScheduler({...schedulerPorts, sync: async (_manual, _mode, execute?: unknown) => {
  calls++;
  if(historical)return (execute as (work: () => Promise<boolean>) => Promise<boolean>)(() => service.syncNow(true));
  const result=await service.syncNowResult(true);
  (execute as CloudScheduledRun).publish(result);
  return result.ok;
 }}, guard);
 stops.push(() => scheduler.dispose());
 let delivered:CloudSyncResult|undefined;
 const sync = coalescedRequest(async () => {
  if(historical)return await scheduler.manual() as unknown as CloudSyncResult;
  await scheduler.manual('recent128',false,undefined,result=>{delivered=result;});
  return delivered;
 });
 let reads = 0;
 const page = syncPage(async () => {reads++; return syncSnapshot(read(), 'A');}, sync, subscribeCloudAccountStatus);
 await settle();
 page.press('立即同步');
 for (let i = 0; i < 100 && sync.pending; i++) await settle();
 await settle();
 expect(page.labels()).toContain('已同步');
 if(!historical)expect(delivered?.resultSequence).toBe(service.status.resultSequence);
 page.setActive(false);
 await settle();
 const before = reads;
 page.setActive(true);
 await settle();
 expect(reads - before).toBe(1);
 expect(page.labels()).toContain('已同步');
 expect(page.labels()).toContain('立即同步');
 notifyCloudAccountStatus();
 await settle();
 expect(page.labels()).toContain('已同步');
 expect(calls).toBe(1);
});

function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => {resolve = done;});
 return {promise, resolve};
}

async function accountSwitch() {
 let scope = 'A', stored: string | undefined, enqueueFailure = false, id = 0;
 const calls: {account: string; grant?: string}[] = [];
 const deletions: string[] = [];
 const confirmed = deferred<void>(), finish = deferred<void>();
 const host = async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
  if (method === 'crypto.random') return {bytesBase64: 'grant_' + ++id} as T;
  if (method === 'secure.get') return {exists: !!stored, value: stored} as T;
  if (method === 'secure.compareAndSet') {
   expect(args.key).toBe(MANUAL_INTENT_KEY);
   if ((stored ?? null) !== args.expected) return {updated: false} as T;
   if (args.value === null && stored) deletions.push(JSON.parse(stored).scope);
   stored = (args.value ?? undefined) as string | undefined;
   return {updated: true} as T;
  }
  if (method === 'cloud.enqueue' && enqueueFailure) {enqueueFailure = false; throw Error('standby registration failed');}
  return {} as T;
 };
 let handoff: InstanceType<typeof CloudManualHandoff>;
 const scheduler = new WatchCloudScheduler({...schedulerPorts, sync: async (_manual, _mode, context?: unknown) => {
  const account = scope;
  const grant = await handoff.authorized();
  const port = async () => {calls.push({account, grant: grant?.scope}); return true;};
  if (historical) await (context as (work: () => Promise<boolean>) => Promise<boolean>)(port);
  else await port();
  if (account === 'A') {
   confirmed.resolve();
   await finish.promise;
   throw Error('A post-sync cleanup failed');
  }
  return true;
 }}, guard);
 const dispatch = (mode: 'all'|'recent128', restored?: boolean, intent?: any) => scheduler.manual(mode, restored, intent);
 handoff = new CloudManualHandoff(host, async () => scope, historical ? {dispatch, warn: () => {}} as any : dispatch);
 const a = scheduler.manual().catch(() => false);
 await confirmed.promise;
 scope = 'B';
 handoff.accountChanged();
 scheduler.accountChanged();
 // Save B's grant, fail its first standby registration, and release only A's
 // follow-up after the restore has joined or refused the old task.
 enqueueFailure = true;
 const b = handoff.manual().catch(() => false);
 while (!stored) await Promise.resolve();
 if (historical) await b;
 const restored = handoff.restore().catch(() => false);
 await settle();
 finish.resolve();
 const result = await restored;
 await a;
 await b;
 await settle();
 const outcome = {calls:[...calls],deletions:[...deletions],result,stored};
 const later=await handoff.restore().catch(()=>false);
 handoff.dispose();
 scheduler.dispose();
 return {...outcome,later,callsAfter:calls,deletionsAfter:deletions,storedAfter:stored};
}

test('restoring B while A throws during follow-up cannot inherit A’s success or delete B’s record', async () => {
 const result = await accountSwitch();
 expect(result).toMatchObject({result: false, calls: [{account: 'A', grant: undefined}], deletions: []});
 expect(JSON.parse(result.stored!).scope).toBe('B');
 expect(result.later).toBe(true);
 expect(result.callsAfter).toEqual([{account:'A',grant:undefined},{account:'B',grant:'B'}]);
 expect(result.deletionsAfter).toEqual(['B']);
 expect(result.storedAfter).toBeUndefined();
});

test('offline manual retry checks the route and recovers only once when online', async () => {
 let checks = 0, attempts = 0, online = false;
 let notify!: (status: 'unavailable' | 'available') => void;
 const network = new NetworkRecovery({
  observe(fn) {notify = fn; fn('unavailable'); return () => {};},
  check: async () => {checks++; return online ? 'available' : 'unavailable';},
 });
 network.setActive(true);
 stops.push(() => network.dispose());
 const cloud = {phase: 'idle' as const, message: '尚未同步', usedBytes: 0, quotaBytes: 0};
 const page = syncPage(async () => syncSnapshot(cloud, 'A'), coalescedRequest(async () => {
  attempts++;
  return online ? {ok: true, resultSequence: 1} : {ok: false, networkFailure: true};
 }), undefined, network);
 await settle();
 page.press('立即同步');
 await settle();
 expect(network.blocking).toBe(true);
 expect(checks).toBe(1);
 await network.retry();
 expect(checks).toBe(2);
 expect(attempts).toBe(1);
 online = true;
 notify('available');
 await settle();
 expect(attempts).toBe(2);
 expect(network.blocking).toBe(false);
});

test('a cached cloud page keeps its status and controls after a transport failure', async () => {
 let attempts=0,checks=0;
 const network=new NetworkRecovery({
  observe(fn){fn('unavailable');return()=>{};},
  check:async()=>{checks++;return 'unavailable';},
 });
 network.setActive(true);
 stops.push(()=>network.dispose());
 const cloud={phase:'complete' as const,message:'云同步完成',usedBytes:1024,quotaBytes:1e6,lastCompletedAt:10};
 const page=syncPage(async()=>syncSnapshot(cloud,'A'),coalescedRequest(async()=>{
  attempts++;
  return {ok:false,resultSequence:2,networkFailure:true};
 }),undefined,network);
 await settle();
 page.press('立即同步');
 await settle();
 expect(page.labels()).toContain('已同步');
 expect(page.labels()).toContain('立即同步');
 expect({attempts,checks,blocking:network.blocking}).toEqual({attempts:1,checks:0,blocking:false});
});

const historyState:SyncV2UiState={
 enabled:true,phase:'idle',lastSyncedAtMillis:null,errorCode:null,choice:null,unopenableNotes:[],recoveryCopies:[],
 keepDiscardedLocalChanges7Days:false,gates:{historyRestore:true,choiceApply:false,noteSegments:false},publication:null,ownDeviceId:null,
};

function historyPort(overrides:Partial<SyncV2UiPort>={}):SyncV2UiPort{
 const unused=async()=>{throw Error('Unexpected Sync v2 operation in history fixture');};
 return {
  snapshot:async()=>historyState,subscribe:()=>()=>{},history:unused,
  syncNow:unused,openChoice:unused,chooseLocal:unused,chooseCloud:unused,chooseMerge:unused,closeChoice:unused,
  rollback:unused,restoreRecovery:unused,setKeepDiscarded:unused,...overrides,
 };
}

test('cloud state model follows service outcomes and only completes an executed grant', async () => {
 const checked=new Set<string>();
 for(const seed of [0x434c4f55,0x4c494645,0x53434f50,0x52455355,0x50414745,0x46454e43]){
  const accounts={A:await cloudFixture(),B:await cloudFixture()};
  type Account=keyof typeof accounts;
  let account:Account='A',active=true,nextToken=0,stored:string|undefined,random=seed;
  const current=()=>accounts[account].service;
  const read=()=>({...current().status,accountId:account});
  const executed=new Map<string,Account>();
  const completed:string[]=[];
  const clear=connectCloudAccountStatus(read);
  const unsubscribe=Object.values(accounts).map(({service})=>service.subscribe(notifyCloudAccountStatus));

  const host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{
   if(method==='crypto.random')return {bytesBase64:'grant_'+(++nextToken)} as T;
   if(method==='secure.get')return {exists:!!stored,value:stored} as T;
   if(method==='secure.compareAndSet'){
    if((stored??null)!==args.expected)return {updated:false} as T;
    if(args.value===null&&stored){
     const {token,scope}=JSON.parse(stored);
     expect(executed.get(token)).toBe(scope);
     completed.push(token);
    }
    stored=(args.value??undefined) as string|undefined;
    return {updated:true} as T;
   }
   return {} as T;
  };
  let delivered:CloudSyncResult|undefined;
  let handoff:InstanceType<typeof CloudManualHandoff>;
  const scheduler=new WatchCloudScheduler({...schedulerPorts,async sync(manual,mode,run){
   const owner=account,service=current();
   const intent=await handoff.authorized(owner);
   if(!run.current||owner!==account||manual&&!intent)return false;
   run.bindIntent(intent);
   if(intent){
    expect(intent.scope).toBe(owner);
    executed.set(intent.token,owner);
   }
   const result=await service.syncNowResult(manual,mode);
   run.publish(result);
   if(run.current&&result.ok&&intent)await handoff.completeExecuted(intent);
   return result.ok;
  }},guard);
  handoff=new CloudManualHandoff(host,async()=>account,{
   dispatch:(intent,restored,observe)=>scheduler.manual(intent.mode,restored,intent,observe),
  });
  const sync=coalescedRequest(async()=>{
   delivered=undefined;
   await handoff.manual('recent128',{scope:account,observe:result=>{delivered=result;}});
   return delivered;
  });
  const accountListeners=new Set<(change:AccountStatusChange)=>void>();
  const accountEvent=(change:AccountStatusChange)=>{for(const listener of accountListeners)listener(change);};
  const port=historyPort();
  const page=syncPage(async()=>syncSnapshot(read(),account),sync,listener=>{
   accountListeners.add(listener);
   const off=subscribeCloudAccountStatus(listener);
   return()=>{accountListeners.delete(listener);off();};
  },undefined,undefined,port);
  const seen:Record<Account,number>={A:0,B:0};
  try{
   await settle();
   for(let step=0;step<32;step++){
    random=(Math.imul(random,1664525)+1013904223)>>>0;
    const event=(random>>>24)%6;
    const context='seed='+seed+' step='+step+' event='+event;
    switch(event){
     case 0: active=!active;page.setActive(active);break;
     case 1:
      account=account==='A'?'B':'A';
      handoff.accountChanged();scheduler.accountChanged();notifyCloudAccountStatus();break;
     case 2: notifyCloudAccountStatus();break;
     case 3:
     case 4:{
      const fixture=accounts[account];
      fixture.network.validated=event===3;
      const result=await current().syncNowResult(false);
      fixture.network.validated=true;
      expect(result.resultSequence,context).toBeGreaterThan(seen[account]);
      seen[account]=result.resultSequence!;
      break;
     }
     case 5:
      if(active){
       page.press(current().status.message==='等待网络连接'?'重试':'立即同步');
       for(let i=0;i<100&&sync.pending;i++)await settle();
       expect(delivered?.resultSequence,context).toBeGreaterThan(seen[account]);
       expect(delivered?.resultSequence,context).toBe(current().status.resultSequence);
       seen[account]=delivered!.resultSequence!;
      }
    }
    await settle();
    if(active&&(random&3)===0){
     const kind=random&4?'credential update':'token refresh';
     const before=page.buttons();
     const existing=kind==='credential update'?undefined:accountStatusIdentity(syncSnapshot(read(),account));
     expect(before,context).toContainEqual(['查看历史',true]);
     accountEvent({kind:'account',account:existing});
     expect(page.buttons(),context+' '+kind).toEqual(before);
     await settle();
     expect(page.buttons(),context+' '+kind).toEqual(before);
     checked.add(kind);
    }
    if(active){
     const status=current().status;
     const expected=status.phase==='complete'?'已同步':status.message==='等待网络连接'?'等待网络':'尚未同步';
     expect(page.labels(),context).toContain(expected);
    }
   }
   expect(completed.length).toBeGreaterThan(0);
   expect(new Set(completed).size).toBe(completed.length);
  }finally{
   page.dispose();
   handoff.dispose();
   scheduler.dispose();
   for(const off of unsubscribe)off();
   clear();
  }
 }
 expect([...checked].sort()).toEqual(['credential update','token refresh']);
});

test('a new service result refreshes the loaded account while secure storage is unreadable',async()=>{
 const {service,network}=await cloudFixture();
 const read=()=>({...service.status,accountId:'A'});
 stops.push(connectCloudAccountStatus(read),service.subscribe(notifyCloudAccountStatus));
 network.validated=false;
 await service.syncNowResult();
 let loads=0;
 const page=syncPage(async()=>{
  if(++loads>1)throw Error('fixture secure storage unavailable');
  return syncSnapshot(read(),'A');
 },coalescedRequest(async()=>undefined),fn=>subscribeCloudAccountStatus(()=>fn({kind:'cloud'})),undefined,readCloudAccountStatus);
 await settle();
 expect(page.labels()).toContain('等待网络');
 network.validated=true;
 await service.syncNowResult();
 await settle();
 expect(page.labels()).toContain('已同步');
 expect(page.labels()).toContain('立即同步');
 expect(loads).toBe(1);
});

test('review Sync v2 history round trip and ordinary same-account credential rotation',async()=>{
 const {SyncV2Screen}=await import('../src/ui/SyncV2Screen');
 const {WatchAccountStore}=await import('../src/account/store');

 const data=new Map<string,string>();
 const store=new WatchAccountStore({
  get:key=>data.get(key)??null,
  set:(key,value)=>{data.set(key,value);},
  remove:key=>{data.delete(key);},
 });
 const account:WatchAccountState={
  userId:'A',backendBaseUrl:'https://fixture.invalid',phoneMasked:'Fixture',installId:'fixture',
  watchDeviceToken:'old',watchRefreshToken:'old',tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0,
  posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
  entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
  telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},
 };
 await store.save(account);
 const [active,setActive]=createSignal(true);
 let reads=0,v2Reads=0,syncRequests=0,historyReads=0;
 const [historyActive,setHistoryActive]=createSignal(false);
 const opens:string[]=[];
 const serviceCloud={phase:'complete' as const,message:'',usedBytes:10,quotaBytes:100,lastCompletedAt:100,accountRevision:1};
 const v2=historyPort({
  snapshot:async()=>{
   v2Reads++;
   return historyState;
  },
  history:async()=>{historyReads++;return {items:[{commitOid:'test-1',retiredAtMillis:100,expiresAtMillis:500,authorDeviceId:null}],pageToken:null};},
 });
 const root=createRoot(stop=>{
  stops.push(stop);
  return CloudSyncScreen({width:233,height:233,active,available:()=>true,
   load:async()=>{reads++;return accountStatusSnapshot((await store.read())!,1000,serviceCloud);},
   subscribe:fn=>store.subscribe(account=>fn({kind:'account',account})),
   sync:{pending:false,start:async()=>{syncRequests++;}},
   syncV2:v2,onSyncV2:target=>{opens.push(target);setActive(false);setHistoryActive(true);},
   onPhone(){},onError(){},ref(){},
  });
 });
 const child=createRoot(stop=>{
  stops.push(stop);
  return SyncV2Screen({width:233,height:233,active:historyActive,target:()=> 'history',port:v2,onDone(){},onError(){},ref(){}});
 });
 const find=(label:string)=>nodes(root).find(n=>n.props.accessibilityLabel===label);
 await settle();
 expect(find('查看历史')).toBeDefined();
 find('查看历史')!.props.onPress();
 await settle();
 expect(opens).toEqual(['history']);
 expect(historyReads).toBe(1);
 expect(nodes(child).some(n=>n.props.accessibilityLabel==='回到这个版本')).toBe(true);
 setHistoryActive(false);
 setActive(true);
 await settle();
 expect(find('查看历史')).toBeDefined();
 expect(find('已同步')).toBeDefined();
 const before={reads,v2Reads};
 let notifications=0;
 stops.push(store.subscribe(payload=>{if(payload===undefined)notifications++;}));
 await store.save({...account,watchDeviceToken:'rotated'});
 await settle();await settle();
 const result={accountReads:reads-before.reads,v2Reads:v2Reads-before.v2Reads,history:!!find('查看历史'),historyReads,synced:!!find('已同步'),syncRequests,notifications};
 expect(result).toEqual({accountReads:1,v2Reads:0,history:true,historyReads:1,synced:true,syncRequests:0,notifications:1});
 const credentials=(await store.read())!;
 await store.refresh(credentials,async current=>({...current,watchDeviceToken:'new-access',watchRefreshToken:'new-refresh'}));
 await settle();
 expect(v2Reads).toBe(before.v2Reads);
 expect(find('查看历史')?.props.onPress).toBeFunction();
 const beforeGeneration=v2Reads;
 serviceCloud.accountRevision++;
 store.invalidate();
 await settle();
 expect(v2Reads-beforeGeneration).toBe(1);
 expect(find('查看历史')?.props.onPress).toBeFunction();

});
