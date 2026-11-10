import {SyncV2Lifetime} from './lifetime';
/** 26.4 P6-10 product lifecycle. One owner per account identity:
 * - switch off, or bootstrap without a syncV2 announcement: no runtime, no v2
 *   request, no local write, no UI port;
 * - on: open once after the v1 account and its keys are ready, then install
 *   the UI port;
 * - the only unmount point is stop() (logout, account switch, dispose). */
export interface SyncV2ProductSession<Port> {ui:Port;sync?():Promise<unknown>;close():Promise<void>}
export interface SyncV2ProductOptions<Port> {
 /** SYNC_V2_PRODUCT.syncV2 (src/sync-v2/gate.ts). */
 enabled:boolean;
 /** Production SQL teardown must finish before the next owner opens. */
 drainOnStop?:boolean;
 /** True only when the v1 bootstrap carries the syncV2 announcement (P6-11). */
 announced:()=>Promise<boolean>;
 open:(lifetime:SyncV2Lifetime)=>Promise<SyncV2ProductSession<Port>|null>;
 install:(port:Port|undefined)=>void;
}
export function watchSyncV2Product<Port>(options:SyncV2ProductOptions<Port>){
 let generation=0,identity:string|null=null,session:SyncV2ProductSession<Port>|null=null,opening:Promise<Port|null>|null=null,lifetime:SyncV2Lifetime|undefined;
 let stopping:Promise<void>|undefined;
 const stop=()=>{
  generation++;
  if(stopping)return stopping;
  lifetime?.cancel();lifetime=undefined;identity=null;const closing=session,pending=opening;opening=null;session=null;options.install(undefined);
  // Keep ownership until SQL teardown drains. All stop callers and the next
  // start share this barrier, even after session/opening have been detached.
  return stopping=(async()=>{try{await closing?.close();}finally{if(options.drainOnStop)await pending?.catch(()=>{});}})().finally(()=>{stopping=undefined;});
 };
 const product={
  /** Idempotent per account identity; a new identity first unmounts the old one. */
  async start(next:string):Promise<Port|null>{
   if(options.enabled!==true)return null;
   if(stopping){const ticket=generation;await stopping;if(ticket!==generation)return null;}
   if(identity!==next){if(identity!==null||session){const stopped=stop(),ticket=generation;await stopped;if(ticket!==generation)return null;}identity=next;}
   if(session)return session.ui;
   const ticket=generation;
   return opening??=(async()=>{
    const current=lifetime=new SyncV2Lifetime();
    try{
     if(!await options.announced()||ticket!==generation)return null;
     const opened=await options.open(current);if(!opened)return null;
     if(ticket!==generation){await opened.close();return null;}
     session=opened;options.install(opened.ui);return opened.ui;
    }finally{if(ticket===generation)opening=null;}
   })();
  },
  /** A scheduler tick opens once, then executes a fresh round on later ticks. */
  async sync(next:string):Promise<Port|null>{
   const existing=identity===next?session:null,ticket=generation;
   const ui=await product.start(next);
   if(existing&&ticket===generation&&session===existing)await existing.sync?.();
   return ui;
  },
  stop,
  get active(){return session!==null;},
 };
 return product;
}

/** Product actions share the existing v1 cloud writer lease. Snapshots can purge
 * expired recovery metadata, so they use the same lease as mutations. */
export function leasedSyncV2Session<Port extends object>(session:SyncV2ProductSession<Port>,exclusive:<T>(work:()=>Promise<T>)=>Promise<T>):SyncV2ProductSession<Port>{
 const ui=new Proxy(session.ui,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;if(key==='subscribe')return value.bind(target);return (...args:unknown[])=>exclusive(async()=>value.apply(target,args));}});
 return {ui,sync:session.sync?()=>exclusive(()=>session.sync!()):undefined,close:()=>session.close()};
}
