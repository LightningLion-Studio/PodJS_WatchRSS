import {test,expect,mock} from 'bun:test';
let life='active',screen={interactive:true,resumed:true};
const lifecycleListeners=new Set<(value:string)=>void>(),displayListeners=new Set<(value:typeof screen)=>void>(),accountListeners=new Set<()=>void>();
const timers:{ms:number;resolve:()=>void;cancelled:boolean}[]=[];
const calls:string[]=[];let discoverable=true,syncResult=false;
const approver={active:false,state:{phase:'idle'},subscribe:()=>()=>{},setForeground(active:boolean){this.active=active&&discoverable;calls.push('foreground:'+active);},reset(){calls.push('reset');},async poll(){calls.push('poll');return true;},async accept(id:string){calls.push('accept:'+id);return true;},async confirm(match:boolean){calls.push('confirm:'+match);return true;},async cancel(){calls.push('cancel');return true;}};
mock.module('@podjs/framework/watch',()=>({lifecycle:()=>life,onLifecycleChange:(fn:any)=>{lifecycleListeners.add(fn);return()=>lifecycleListeners.delete(fn);}}));
mock.module('@podjs/framework/services',()=>({displayPower:{state:async()=>screen,onChange:(fn:any)=>{displayListeners.add(fn);return()=>displayListeners.delete(fn);}},onNetworkChange:()=>()=>{},delay:(ms:number)=>{let resolve!:()=>void;const result=new Promise<void>(r=>resolve=r),timer={ms,resolve,cancelled:false};timers.push(timer);return {result,cancel(){timer.cancelled=true;}};},hostOperation:()=>({result:Promise.resolve({exists:false}),cancel(){}})}));
mock.module('../src/cloud/host.ts',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate.ts',()=>({cloudGate:{allowed:true,require(){}}}));
let account={userId:'account',backendBaseUrl:'https://backend.invalid'};
mock.module('../src/llm/runtime.ts',()=>({summaryAccountStore:{read:async()=>account,subscribe:(fn:any)=>{accountListeners.add(fn);return()=>accountListeners.delete(fn);}}}));
mock.module('../src/core/library-mutations.ts',()=>({subscribeLibraryMutations:()=>()=>{}}));
mock.module('../src/services.ts',()=>({getLibrarySyncRepository:async()=>({}),notifyLibraryChanged(){},services:{subscribeChannel:()=>()=>{}}}));
mock.module('../src/cloud/status.ts',()=>({connectCloudAccountStatus:()=>()=>{},notifyCloudAccountStatus(){}}));
let doSync!:()=>Promise<unknown>;
mock.module('../src/cloud/scheduler.ts',()=>({WatchCloudScheduler:class {constructor(p:any){doSync=()=>p.sync(false);}foreground(){}hold(){}accountChanged(){}async start(){}dispose(){}trigger(){}async setUpgradeRequired(){}deferUntil(){}}}));
mock.module('../src/cloud/manual-handoff.ts',()=>({manualEpochKey:()=>'',CloudManualHandoff:class {async authorized(){return undefined;}foregroundChanged(){}localTransferChanged(){}subscribe(){return()=>{};}accountChanged(){}async restore(){}dispose(){}}}));
mock.module('../src/cloud/runtime.ts',()=>({createCloudRuntime:()=>({inspectOwner:async()=>true,approver,approvals:{active:false,state:{phase:'idle'},subscribe:()=>()=>{},setForeground(){},reset(){}},service:{status:{phase:'idle'},reset(){},subscribe:()=>()=>{},syncNow:async()=>syncResult}})}));
const {startApplicationCloudSync,stopApplicationCloudSync,applicationCloudApproval,applicationCloudApprover}=await import('../src/cloud/application');
const {localTransferActivity}=await import('../src/sync/local-transfer');
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const activeTimers=()=>timers.filter(t=>!t.cancelled);

test('cloud page opens once, polls every 5 seconds and cancels its timer on page close',async()=>{
 applicationCloudApproval.setForeground(false);const app=startApplicationCloudSync();await app.ready;calls.length=0;
 expect(activeTimers()).toHaveLength(0);applicationCloudApproval.setForeground(true);await flush();expect(calls.filter(c=>c==='poll')).toHaveLength(1);expect(activeTimers().map(t=>t.ms)).toEqual([5000]);
 const tick=activeTimers()[0];tick.cancelled=true;tick.resolve();await flush();expect(calls.filter(c=>c==='poll')).toHaveLength(2);expect(activeTimers().map(t=>t.ms)).toEqual([5000]);
 applicationCloudApproval.setForeground(false);expect(activeTimers()).toHaveLength(0);stopApplicationCloudSync();
});
test('HOME, SCREEN_OFF and local transfer fence polling; foreground resumes its timer',async()=>{
 applicationCloudApproval.setForeground(true);const app=startApplicationCloudSync();await app.ready;await flush();
 life='background';for(const fn of lifecycleListeners)fn(life);expect(approver.active).toBe(false);expect(activeTimers()).toHaveLength(0);
 life='active';for(const fn of lifecycleListeners)fn(life);expect(approver.active).toBe(true);expect(activeTimers().map(t=>t.ms)).toEqual([5000]);
 screen={interactive:false,resumed:true};for(const fn of displayListeners)fn(screen);expect(approver.active).toBe(false);expect(activeTimers()).toHaveLength(0);
 screen={interactive:true,resumed:true};for(const fn of displayListeners)fn(screen);const release=localTransferActivity.acquire();expect(approver.active).toBe(false);expect(activeTimers()).toHaveLength(0);release();expect(approver.active).toBe(true);
 applicationCloudApproval.setForeground(false);stopApplicationCloudSync();
});
test('successful foreground sync discovers once off-page; failed/background sync does not',async()=>{
 const app=startApplicationCloudSync();await app.ready;calls.length=0;syncResult=false;await doSync();expect(calls.filter(c=>c==='poll')).toHaveLength(0);
 syncResult=true;await doSync();expect(calls.filter(c=>c==='poll')).toHaveLength(1);expect(activeTimers()).toHaveLength(0);
 life='background';for(const fn of lifecycleListeners)fn(life);await doSync();expect(calls.filter(c=>c==='poll')).toHaveLength(1);
 life='active';stopApplicationCloudSync();
});
test('unsupported feature arms no repeating timer; exported controls route explicit actions',async()=>{
 discoverable=false;applicationCloudApproval.setForeground(true);const app=startApplicationCloudSync();await app.ready;expect(activeTimers()).toHaveLength(0);calls.length=0;
 await applicationCloudApprover.accept('request');await applicationCloudApprover.confirm(false);await applicationCloudApprover.cancel();expect(calls).toEqual(['accept:request','confirm:false','cancel']);
 account={...account,userId:'other'};for(const fn of accountListeners)fn();await flush();expect(calls).toContain('reset');applicationCloudApproval.setForeground(false);stopApplicationCloudSync();discoverable=true;
});
