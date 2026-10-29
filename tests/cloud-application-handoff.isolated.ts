import {test,expect,mock} from 'bun:test';
let life='active',display={interactive:true,resumed:true};const lifecycleListeners=new Set<(state:string)=>void>(),displayListeners=new Set<(value:typeof display)=>void>();
const calls:{method:string;args:any}[]=[],secure=new Map<string,string>();let finish!:(success:boolean)=>void,assertRun!:()=>void;
const account={userId:'account',backendBaseUrl:'https://backend.invalid'};
mock.module('@podjs/framework/watch',()=>({lifecycle:()=>life,onLifecycleChange:(fn:any)=>{lifecycleListeners.add(fn);return()=>lifecycleListeners.delete(fn);}}));
mock.module('@podjs/framework/services',()=>({
 displayPower:{state:async()=>display,onChange:(fn:any)=>{displayListeners.add(fn);return()=>displayListeners.delete(fn);}},
 onNetworkChange:()=>()=>{},delay:()=>({result:new Promise(()=>{}),cancel(){}}),
 hostOperation:(method:string,args:any)=>({result:(async()=>{calls.push({method,args});if(method==='crypto.random')return {bytesBase64:'opaque_'+calls.length};if(method==='secure.get')return {exists:secure.has(args.key),value:secure.get(args.key)};if(method==='secure.set')secure.set(args.key,args.value);if(method==='secure.delete')secure.delete(args.key);return {};})(),cancel(){}}),
}));
mock.module('../src/cloud/host.ts',()=>({initializeCloudHost:async()=>true}));
mock.module('../src/cloud/gate.ts',()=>({cloudGate:{allowed:true,require(){}}}));
mock.module('../src/llm/runtime.ts',()=>({summaryAccountStore:{read:async()=>account,subscribe:()=>()=>{}}}));
mock.module('../src/core/library-mutations.ts',()=>({subscribeLibraryMutations:()=>()=>{}}));
mock.module('../src/services.ts',()=>({getLibrarySyncRepository:async()=>({}),notifyLibraryChanged(){},services:{subscribeChannel:()=>()=>{}}}));
mock.module('../src/cloud/status.ts',()=>({connectCloudAccountStatus:()=>()=>{},notifyCloudAccountStatus(){}}));
mock.module('../src/cloud/runtime.ts',()=>({createCloudRuntime:(...args:any[])=>({
 inspectOwner:async()=>true,
 approvals:{active:false,state:{phase:'idle'},subscribe:()=>()=>{},setForeground(){},reset(){}},
 service:{status:{phase:'idle'},reset(){},subscribe:()=>()=>{},syncNow:async(manual:boolean)=>{if(!manual)return false;assertRun=args[5].begin();return new Promise<boolean>(resolve=>finish=resolve);}},
})}));
const {startApplicationCloudSync,stopApplicationCloudSync,manualCloudSync,applicationCloudApproval,applicationCloudHandoff}=await import('../src/cloud/application');
const {localTransferActivity}=await import('../src/sync/local-transfer');
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
test('production application keeps manual work on page exit, hands HOME/lock to OS, and exports local BLE hold',async()=>{
 for(const reason of ['HOME','lock']){
  calls.length=0;life='active';display={interactive:true,resumed:true};const app=startApplicationCloudSync();await app.ready;await flush();
  const manual=manualCloudSync('all');await flush();expect(assertRun).toBeDefined();assertRun();
  applicationCloudApproval.setForeground(false);await flush();expect(calls.some(c=>c.method==='cloud.enqueue')).toBe(false);assertRun();
  const release=localTransferActivity.acquire();await flush();expect(calls.some(c=>c.method==='cloud.localTransfer'&&c.args.active===true)).toBe(true);expect(assertRun).toThrow('cloud_sync_suspended');release();await flush();expect(assertRun).toThrow('cloud_sync_suspended');
  if(reason==='HOME'){life='background';for(const fn of lifecycleListeners)fn(life);}else{display={interactive:false,resumed:true};for(const fn of displayListeners)fn(display);}
  await flush();expect(calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(1);expect(applicationCloudHandoff.state.phase).toBe('queued');finish(false);await manual;stopApplicationCloudSync();await flush();
 }
});
