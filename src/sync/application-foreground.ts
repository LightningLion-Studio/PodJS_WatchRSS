import {ForegroundSyncController,type ForegroundListener,type ForegroundTimer} from './foreground.ts';
import type {LibrarySessionOptions,LibrarySessionRepository,SessionActionResult} from './session.ts';
import type {DisplayPowerState} from '@podjs/framework/services';
export interface ApplicationSyncListener extends ForegroundListener {
 start(options:LibrarySessionOptions & {onListening?:()=>void;onPeer?:(peer:{remoteName:string|null;remoteAddress:string})=>void}):ReturnType<ForegroundListener['start']>;
}
export interface ApplicationForegroundPorts {
 acquireConnectionPage?:()=>()=>void;
 repository():Promise<LibrarySessionRepository>;
 createListener(repository:LibrarySessionRepository):ApplicationSyncListener;
 lifecycle():string;
 onLifecycle(listener:(state:string)=>void):()=>void;
 display:{state():Promise<DisplayPowerState>;onChange(listener:(value:DisplayPowerState)=>void):()=>void;keepAwake(owner:string,active:boolean):Promise<unknown>};
 radio:{status():Promise<{available:boolean;permission:string;enabled:boolean}>};
 silence:{setEnabled(enabled:boolean):Promise<unknown>;lease(owner:string,active:boolean):Promise<unknown>};
 delay(milliseconds:number):ForegroundTimer;
 onLibraryChanged?():void;
 onState?(state:ApplicationSyncState):void;
 onError?(error:unknown):void;
}
export type ApplicationSyncState='initializing'|'idle'|'starting'|'listening'|'transferring'|'failed'|'disposed';
/** Scalar snapshots only: subscribers cannot mutate a protocol request/response. */
export type ApplicationSyncEvent = Readonly<
 | {type:'state';state:ApplicationSyncState}
 | {type:'error';message:string}
 | {type:'completed';action:string;success:boolean;message:string;count:number;received:number;applied:number}
>;
export const didApplyLibrary=(result:SessionActionResult)=>result.libraryApplied&&(result.request.action==='syncBooks'?Number(result.response.applied)>0:result.request.action==='syncLibrary'&&result.request.phase!=='probe'&&Number((result.response.stats as Record<string,unknown>|undefined)?.applied)>0);
const OWNER='rfcomm-bootstrap';
/** Application lifetime binding. UI navigation does not own the native listener. */
export class ApplicationForegroundSync {
 readonly ready:Promise<void>;
 private controller:ForegroundSyncController|undefined;
 private display:DisplayPowerState|undefined;
 private radio={available:false,permission:'required',enabled:false};
 private active:boolean;
 private exclusive=false;
 private disposed=false;
 private disposeJob:Promise<void>|undefined;
 private refreshVersion=0;
 private mediaEnabled=false;
 private screenDesired:boolean|undefined;
 private resources:Promise<void>=Promise.resolve();
 private subscriptions:(()=>void)[]=[];
 private currentState:ApplicationSyncState='initializing';
 constructor(private readonly ports:ApplicationForegroundPorts,options:LibrarySessionOptions={}){
  this.active=ports.lifecycle()==='active';
  this.subscriptions.push(ports.onLifecycle(state=>{this.active=state==='active';this.refreshVersion++;this.apply();if(this.active)void this.refresh();}));
  this.subscriptions.push(ports.display.onChange(value=>{const wake=value.interactive&&!this.display?.interactive;this.display=value;this.apply();if(wake)void this.refresh();}));
  this.ready=this.initialize(options);void this.ready.catch(()=>{});
 }
 private observers=new Set<(event:ApplicationSyncEvent)=>void>();
 /** Observation only; does not start, stop, or claim the application listener. */
 subscribe(observer:(event:ApplicationSyncEvent)=>void):()=>void {
  if(this.disposed)return ()=>{};
  this.observers.add(observer);return ()=>{this.observers.delete(observer);};
 }
 private emit(event:ApplicationSyncEvent){if(this.disposed&&!(event.type==='state'&&event.state==='disposed'))return;Object.freeze(event);for(const observer of [...this.observers])try{observer(event);}catch{}}
 private completed(result:SessionActionResult){
  const {request,response}=result,stats=response.stats;
  this.emit({type:'completed',action:String(request.action??''),success:response.success===true,message:typeof response.message==='string'?response.message:'',count:Number(response.count)||0,received:Array.isArray(request.articles)?request.articles.length:0,applied:stats&&typeof stats==='object'&&!Array.isArray(stats)?Number((stats as Record<string,unknown>).applied)||0:0});
 }
 /** Permission scope for an active connection page; transport ownership stays here. */
 acquireConnectionPage():()=>void {return this.disposed?()=>{}:this.ports.acquireConnectionPage?.()??(()=>{});}
 get state(){return this.currentState;}
 private status(state:ApplicationSyncState){if(this.disposed&&state!=='disposed')return;this.currentState=state;try{this.ports.onState?.(state);}catch{}this.emit({type:'state',state});}
 private report(error:unknown){try{this.ports.onError?.(error);}catch{}this.emit({type:'error',message:error instanceof Error?error.message:String(error)});}
 private enqueue(action:()=>Promise<unknown>):Promise<void>{this.resources=this.resources.then(action).then(()=>{},error=>{this.report(error);});return this.resources;}
 private keepScreen(active:boolean){if(this.disposed&&active||this.screenDesired===active)return;this.screenDesired=active;void this.enqueue(()=>this.ports.display.keepAwake(OWNER,active));}
 setMediaEnabled(enabled:boolean){if(this.disposed||this.mediaEnabled===enabled)return;this.mediaEnabled=enabled;if(this.controller)void this.enqueue(()=>this.ports.silence.setEnabled(enabled));}
 async acquireExclusive(){
  if(this.disposed||this.exclusive)throw Error("Bluetooth listener already owned");
  this.exclusive=true;
  try{await this.ready;if(this.disposed)throw Error("Bluetooth disposed");await this.controller?.quiesce();}
  catch(error){this.exclusive=false;this.apply();throw error;}
  return ()=>{this.exclusive=false;this.apply();};
 }
 setExclusive(exclusive:boolean){if(this.disposed)return;this.exclusive=exclusive;this.apply();}
 private async initialize(options:LibrarySessionOptions){
  try{
   const repository=await this.ports.repository();if(this.disposed)return;
   this.controller=new ForegroundSyncController({
    createListener:()=>{
     const listener=this.ports.createListener(repository);
     return {
      stop:()=>listener.stop(),
      start:async opts=>{
       this.status('starting');
       try{return await listener.start({...opts,onListening:()=>this.status('listening'),onPeer:peer=>{this.status('transferring');opts.onPeer?.(peer);}});}
       finally{this.status('idle');}
      },
     };
    },
    delay:ms=>this.ports.delay(ms),keepScreenOn:active=>this.keepScreen(active),
    acquireMedia:owner=>{if(!this.disposed)void this.enqueue(()=>this.ports.silence.lease(owner,true));},
    releaseMedia:owner=>{void this.enqueue(()=>this.ports.silence.lease(owner,false));},
    onError:error=>{this.status('failed');this.report(error);},
   },{...options,onActionCompleted:result=>{options.onActionCompleted?.(result);this.completed(result);},onSessionClosed:results=>{options.onSessionClosed?.(results);if(results.some(didApplyLibrary))this.ports.onLibraryChanged?.();}});
   await this.enqueue(()=>this.ports.silence.setEnabled(this.mediaEnabled));if(this.disposed)return;
   this.status('idle');await this.refresh();
  }catch(error){this.status('failed');this.report(error);throw error;}
 }
 private apply(){if(this.disposed)return;this.controller?.update({resumed:this.active&&this.display?.resumed===true,interactive:this.display?.interactive===true,exclusive:this.exclusive,permission:this.radio.permission==='granted',enabled:this.radio.available&&this.radio.enabled});}
 async refresh(){
  if(this.disposed||!this.controller)return;const version=++this.refreshVersion;
  try{const [display,radio]=await Promise.all([this.ports.display.state(),this.ports.radio.status()]);if(this.disposed||version!==this.refreshVersion)return;this.display=display;this.radio=radio;this.apply();}
  catch(error){if(this.disposed||version!==this.refreshVersion)return;this.radio={available:false,permission:'required',enabled:false};this.apply();this.status('failed');this.report(error);}
 }
 dispose():Promise<void>{return this.disposeJob??=this.close();}
 private async close(){
  this.disposed=true;this.refreshVersion++;for(const stop of this.subscriptions)stop();this.subscriptions=[];
  await this.ready.catch(()=>{});await this.controller?.dispose();
  await this.enqueue(async()=>{try{await this.ports.display.keepAwake(OWNER,false);}finally{try{await this.ports.silence.lease(OWNER,false);}finally{await this.ports.silence.setEnabled(false);}}});
  this.status('disposed');this.observers.clear();
 }
}
