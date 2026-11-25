import type {HostOperation} from '@podjs/framework/services';
import type {InternetListener,SnapshotOrder} from '../onboarding/network.ts';
import type {InternetStatus} from '../onboarding/state.ts';

/** An HTTP response anywhere in the bounded cause chain takes priority over timeout text. */
function hasHttpFailure(error:unknown,depth=0):boolean {
 if(depth>4)return false;
 const e=error as {kind?:unknown;status?:unknown;httpStatus?:unknown;code?:unknown;message?:unknown;cause?:unknown}|null;
 return e?.kind==='http'||Number(e?.status)>=400||Number(e?.httpStatus)>=400
  || /http_status:\d{3}|\bHTTP[ _:]?\d{3}|webview_http_\d{3}/i.test(String(e?.code??'')+' '+String(e?.message??''))
  || e?.cause!==undefined&&hasHttpFailure(e.cause,depth+1);
}
/** Closed transport classification. Business, parsing, cancellation and HTTP errors stay local. */
export function isTransportFailure(error: unknown,depth=0): boolean {
 if(depth>4)return false;
 const e=error as {code?:unknown;kind?:unknown;status?:unknown;httpStatus?:unknown;networkFailure?:unknown;nativeTransportFailure?:unknown;cause?:unknown;message?:unknown;name?:unknown}|null;
 const code=String(e?.code??''),message=String(e?.message??'');
 if(e?.kind==='api'||e?.kind==='auth'||hasHttpFailure(error))return false;
 if(/cancel|abort/i.test(code)||e?.name==='AbortError')return false;
 if(e?.networkFailure===true)return true;
 if(code==='REQUEST_FAILED')return false; // This legacy code also means signing/storage/API failure.
 if(e?.kind==='transport')return e.cause===undefined||isTransportFailure(e.cause,depth+1);
 if(code==='host_error'&&e?.nativeTransportFailure===true)return true;
 return /^(network_error|network_timeout|timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|webview_load_-(2|6|7|8|11))$/.test(code)
  || (e?.cause!==undefined&&isTransportFailure(e.cause,depth+1))
  || /(?:UnknownHostException|SocketTimeoutException|ConnectException|Unable to resolve host|failed to connect|Network is unreachable|timed out|DNS lookup failed|connection reset|unexpected end of stream|broken pipe)/i.test(message);
}
type Reading=InternetStatus|{status:InternetStatus;order:SnapshotOrder;onBluetooth?:boolean;defaultNetworkId?:string};
interface PendingCheck {request:HostOperation<Reading>;timeout?:HostOperation<void>;done:Promise<void>;finish():void}
const RECOVERY_POLL_MS=5000;
const RECOVERY_CHECK_TIMEOUT_MS=10000;
const UNCONFIRMED_WAIT_MS=15000;
export type RecoveryPorts={
 observe(listener:InternetListener,invalidateOffline:(lastRequested:number,connectionChanged?:boolean)=>void):()=>void;
 delay?(ms:number):HostOperation<void>;
}&({startCheck():HostOperation<Reading>}|{check():Promise<Reading>});
const cancelled=()=>Object.assign(new Error('操作已取消'),{code:'cancelled',networkRecoveryCancelled:true});
export const isNetworkRecoveryCancellation=(error:unknown)=>(error as {networkRecoveryCancelled?:unknown}|null)?.networkRecoveryCancelled===true;
interface Waiter {resolve(retry:boolean):void;reject(error:unknown):void;usable:()=>boolean}
/** One recovery attempt per failed foreground operation. No global transport interception. */
export class NetworkRecovery {
 status:InternetStatus='checking';
 private active=false;
 private stop?:()=>void;
 private generation=0;
 private lastOrder?:SnapshotOrder;
 private legacyOrder=0;
 private offlineInvalidatedThrough=0;
 private pollTimer?:HostOperation<void>;
 private confirmationDeadline?:HostOperation<void>;
 private pendingCheck?:PendingCheck;
 private retrying=false;
 private outageConfirmed=false;
 private content=new Set<()=>boolean>();
 private waiters=new Set<Waiter>();
 private listeners=new Set<()=>void>();
 private hint=false;
 private bluetoothNetworkId?:string;
 private bluetoothDismissal?:{networkId?:string};
 constructor(private ports:RecoveryPorts){}
 get waiting(){return this.waiters.size>0;}
 get blocking(){return this.active&&this.waiting&&this.outageConfirmed;}
 // Keep a visible outage prompt through revalidation. Only a manual
 // check in flight disables Retry.
 get overlayStatus():InternetStatus{return this.retrying?'checking':'unavailable';}
 get bluetooth(){return this.active&&this.hint&&!this.bluetoothDismissal&&this.status==='bluetooth';}
 preserveContent(usable:()=>boolean){
  this.content.add(usable);
  return ()=>{this.content.delete(usable);};
 }
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private publish(){
  this.updateConfirmationDeadline();
  this.updatePoll();
  for(const fn of this.listeners)fn();
 }
 private updateConfirmationDeadline(){
  if(!this.active||!this.waiting||this.outageConfirmed){
   const deadline=this.confirmationDeadline;
   this.confirmationDeadline=undefined;
   deadline?.cancel();
   return;
  }
  if(this.confirmationDeadline)return;
  if(!this.ports.delay){this.releaseUnconfirmed();return;}
  // One deadline for the wait, independent of route notifications and probes.
  const deadline=this.ports.delay(UNCONFIRMED_WAIT_MS);
  this.confirmationDeadline=deadline;
  const expire=()=>{
   if(this.confirmationDeadline!==deadline)return;
   this.confirmationDeadline=undefined;
   this.releaseUnconfirmed();
   this.publish();
  };
  void deadline.result.then(expire,expire);
 }
 private releaseUnconfirmed(){
  this.cancelCheck();
  for(const waiter of this.waiters)waiter.resolve(false);
  this.waiters.clear();
 }
 private updatePoll(){
  if(!this.active||!this.waiting){
   const timer=this.pollTimer;
   this.pollTimer=undefined;
   timer?.cancel();
   return;
  }
  if(this.pollTimer||!this.ports.delay)return;
  const timer=this.ports.delay(RECOVERY_POLL_MS);
  this.pollTimer=timer;
  void timer.result.then(()=>{
   if(this.pollTimer!==timer)return;
   this.pollTimer=undefined;
   this.updatePoll();
   if(!this.pendingCheck)void this.check();
  },()=>{
   if(this.pollTimer===timer)this.pollTimer=undefined;
  });
 }
 /** Mark foreground native work as well as JavaScript requests for the advisory. */
 requestStarted(){this.hint=true;this.publish();}
 setActive(value:boolean){
  if(this.active===value)return;this.active=value;this.generation++;
  if(!value){
   this.cancelCheck('background');
   this.stop?.();
   this.stop=undefined;
   for(const waiter of this.waiters)waiter.reject(cancelled());
   this.waiters.clear();
   this.outageConfirmed=false;
   this.retrying=false;
   this.hint=false;
   this.publish();
   return;
  }
  this.status='checking';
  this.lastOrder=undefined;
  this.offlineInvalidatedThrough=0;
  const generation=this.generation;
  this.stop=this.ports.observe((status,order,onBluetooth,defaultNetworkId)=>{
   if(generation!==this.generation)return;
   // A subscription error has no sample. Keep the last confirmed state.
   if(!order&&status==='checking')return;
   this.accept(status,order??{requested:++this.legacyOrder},onBluetooth,defaultNetworkId);
  },(lastRequested,connectionChanged)=>{
   if(generation!==this.generation)return;
   // Wake callers of the obsolete check so they can wait for a fresh route.
   this.offlineInvalidatedThrough=lastRequested;
   if(connectionChanged)this.bluetoothDismissal=undefined;
   this.cancelCheck();
   if(this.status!=='checking'){
    this.status='checking';
    this.publish();
   }
  });
  this.publish();
 }
 private accept(status:InternetStatus,order:SnapshotOrder,onBluetooth?:boolean,defaultNetworkId?:string){
  if(status==='unavailable'&&order.requested<=this.offlineInvalidatedThrough)return;
  const last=this.lastOrder;
  if(last){
   const captured=order.captured!==undefined&&last.captured!==undefined;
   const previous=captured?last.captured!:last.requested;
   const next=captured?order.captured!:order.requested;
   if(next<=previous)return;
  }
  this.lastOrder=order;
  this.status=status;
  // Availability can drop while the default transport remains Bluetooth.
  if(onBluetooth===false||(onBluetooth===undefined&&status==='available')){
   this.bluetoothNetworkId=undefined;
   this.bluetoothDismissal=undefined;
  }else if(onBluetooth&&defaultNetworkId!==undefined){
   this.bluetoothNetworkId=defaultNetworkId;
   const dismissedId=this.bluetoothDismissal?.networkId;
   // On resume the subscription may have missed an entire handover.
   if(dismissedId!==undefined&&dismissedId!==defaultNetworkId)this.bluetoothDismissal=undefined;
  }
  if(this.waiting)this.refreshUsable();else this.publish();
 }
 private check():Promise<void>{
  if(this.pendingCheck)return this.pendingCheck.done;
  const requested=++this.legacyOrder;
  let request:HostOperation<Reading>;
  try{
   request='startCheck' in this.ports
    ?this.ports.startCheck()
    :{result:this.ports.check(),cancel:()=>{}};
  }catch{return Promise.resolve();}
  const timeout=this.ports.delay?.(RECOVERY_CHECK_TIMEOUT_MS);
  let finish!:()=>void;
  const done=new Promise<void>(resolve=>finish=resolve);
  const check={request,timeout,done,finish};
  this.pendingCheck=check;
  const expire=(reason:string)=>{
   if(this.pendingCheck===check)request.cancel(reason);
  };
  const result=timeout?Promise.race([
   request.result,
   timeout.result.then(()=>expire('timeout'),()=>expire('error')),
  ]):request.result;
  void result.catch(()=>undefined).then(reading=>{
   if(this.pendingCheck!==check)return;
   this.pendingCheck=undefined;
   timeout?.cancel();
   try{
    if(typeof reading==='string')this.accept(reading,{requested});
    else if(reading)this.accept(reading.status,reading.order,reading.onBluetooth,reading.defaultNetworkId);
   }finally{check.finish();}
  });
  return done;
 }
 private cancelCheck(reason?:string){
  const check=this.pendingCheck;
  this.pendingCheck=undefined;
  check?.finish();
  check?.timeout?.cancel();
  check?.request.cancel(reason);
 }
 dismissBluetooth(){this.bluetoothDismissal={networkId:this.bluetoothNetworkId};this.publish();}
 /** Recheck the system route; a button press never assumes the internet works. */
 async retry(){
  if(!this.active||!this.waiting||this.retrying)return;
  const generation=this.generation;
  this.retrying=true;
  // A manual recheck replaces the automatic sample without overlapping it.
  this.cancelCheck();
  this.publish();
  try{
   await this.check();
  }finally{
   if(generation===this.generation){
    this.retrying=false;
    this.publish();
   }
  }
 }
 /** Wake pending work when a cached source becomes playable without a network change. */
 refreshUsable(){
  if(!this.active||!this.waiting)return;
  const wasWaiting=this.waiting;
  const connected=this.status==='available'||this.status==='bluetooth';
  for(const waiter of this.waiters){
   const usable=waiter.usable();
   if(usable||connected){
    this.waiters.delete(waiter);
    waiter.resolve(!usable);
   }
  }
  if(this.waiting)this.outageConfirmed ||= this.status==='unavailable';
  else{
   this.outageConfirmed=false;
   if(wasWaiting)this.cancelCheck();
  }
  this.publish();
 }
 async run<T>(work:()=>Promise<T>,usable:()=>boolean=()=>false):Promise<T>{
  const canUseContent=()=>usable()||[...this.content].some(hasContent=>hasContent());
  const generation=this.generation;
  this.requestStarted();
  const attempt=async()=>{const result=await work();return result;};
  let result:T;
  try{result=await attempt();}catch(error){
   if(!isTransportFailure(error)||!this.active||generation!==this.generation||canUseContent())throw error;
   const joiningRecovery=this.waiting;
   if(!joiningRecovery){
    const lastNotice=this.offlineInvalidatedThrough;
    await this.check();
    if(!this.active||generation!==this.generation)throw cancelled();
    if(this.status!=='unavailable'&&lastNotice===this.offlineInvalidatedThrough)throw error;
   }
   if(canUseContent())throw error;
   const retry=await new Promise<boolean>((resolve,reject)=>{
    this.waiters.add({resolve,reject,usable:canUseContent});
    this.refreshUsable();
    // An existing recovery can complete while the fresh check is in flight.
    if(joiningRecovery&&this.waiting)void this.check();
   });
   if(!retry)throw error;
   if(!this.active||generation!==this.generation)throw cancelled();
   return attempt(); // Never recursively arm another automatic retry.
  }
  return result;
 }
 /** Result-returning clients retain their existing success/error contract. */
 async recover(error:unknown,retry:()=>void|Promise<void>,usable?:()=>boolean):Promise<void>{
  let initial=true;
  try{await this.run(async()=>{if(initial){initial=false;throw error;}await retry();},usable);}
  catch(failure){if(!usable?.())throw failure;}
 }
 async result<T>(work:()=>Promise<T>,usable?:()=>boolean):Promise<T>{
  let failure:T|undefined;
  try{return await this.run(async()=>{const value=await work();if((value as {ok?:boolean})?.ok===false&&isTransportFailure(value)){failure=value;throw value;}return value;},usable);}
  catch(error){if(error===failure)return failure!;throw error;}
 }
 dispose(){this.setActive(false);this.listeners.clear();this.content.clear();}
}

export type NetworkWork=Pick<NetworkRecovery,'run'|'result'|'recover'|'refreshUsable'|'requestStarted'>;
export const directNetworkWork:NetworkWork={requestStarted:()=>{},run:work=>work(),result:work=>work(),recover:async error=>{throw error;},refreshUsable:()=>{}};
/** Bind methods to the original client. Mutations and background work are never intercepted. */
export function networkReadClient<T extends object>(client:T,network:NetworkWork,reads:readonly (keyof T)[],usable:()=>boolean=()=>false):T {
 const methods=new Map<PropertyKey,unknown>();
 return new Proxy(client,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(!methods.has(key))methods.set(key,reads.includes(key as keyof T)?(...args:unknown[])=>network.run(()=>value.apply(target,args),usable):value.bind(target));
  return methods.get(key);
 }});
}
