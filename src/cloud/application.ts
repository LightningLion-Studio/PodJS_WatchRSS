import {cloudAccountIdentity} from './identity';
import {hostOperation,delay,onNetworkChange} from '@podjs/framework/services';
import {lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import {subscribeLibraryMutations} from '../core/library-mutations';
import {initializeCloudHost} from './host';
import {cloudGate} from './gate';
import {summaryAccountStore} from '../llm/runtime';
import {getLibrarySyncRepository,notifyLibraryChanged,services} from '../services';
import {createCloudRuntime} from './runtime';
import {WatchCloudScheduler} from './scheduler';
import {connectCloudAccountStatus,notifyCloudAccountStatus} from './status';
let owner:ReturnType<typeof start>|undefined;

function start(){
 let disposed=false,scheduler:WatchCloudScheduler|undefined;const cleanups:(()=>void)[]=[];
 const ready=(async()=>{
  if(!await initializeCloudHost())return;
  if(disposed)return;
  const guard={require(){cloudGate.require();if(disposed)throw Error('Cloud runtime disposed');}};
  const host=<T>(method:string,args:Record<string,unknown>)=>{if(method!=='cloud.release'&&method!=='file.delete')guard.require();return hostOperation<T>(method,args).result;};
  const runtime=createCloudRuntime(host,getLibrarySyncRepository,guard,summaryAccountStore,notifyLibraryChanged);
  scheduler=new WatchCloudScheduler({sync:(manual,mode)=>runtime.service.syncNow(manual,mode),now:Date.now,delay:(ms,fn)=>{const timer=delay(ms);void timer.result.then(fn).catch(()=>{});return ()=>timer.cancel();},scheduleWorker:()=>host<void>('cloud.schedule',{}),cancelWorker:()=>host<void>('cloud.cancel',{})},guard);
  cleanups.push(connectCloudAccountStatus(()=>cloudGate.allowed&&!disposed?runtime.service.status:undefined),runtime.service.subscribe(notifyCloudAccountStatus));
  let identity='';
  const account=async()=>{const state=await summaryAccountStore.read(),next=cloudAccountIdentity(state);if(disposed||next===identity)return;identity=next;runtime.service.reset();scheduler?.accountChanged();};
  cleanups.push(summaryAccountStore.subscribe(()=>{void account().catch(()=>{});}),subscribeLibraryMutations(()=>scheduler?.trigger()),services.subscribeChannel(e=>{if(e.kind!=='notes')scheduler?.trigger();}),onNetworkChange(()=>scheduler?.trigger()),onLifecycleChange(state=>scheduler?.foreground(state==='active')));
  await account();if(!disposed)scheduler.foreground(lifecycle()==='active');await scheduler.start(true);
 })();void ready.catch(()=>{});
 return {ready,manual:(mode:'all'|'recent128'='recent128')=>scheduler?.manual(mode)??Promise.resolve(false),dispose(){disposed=true;scheduler?.dispose();for(const off of cleanups)off();}};
}
export function startApplicationCloudSync(){return owner??=start();}
export function stopApplicationCloudSync(){owner?.dispose();owner=undefined;}
export function manualCloudSync(mode:'all'|'recent128'='recent128'){cloudGate.require();return owner?.manual(mode)??Promise.resolve(false);}
