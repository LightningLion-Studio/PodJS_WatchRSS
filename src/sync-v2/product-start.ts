/** 26.4 P6-10 product lifecycle. One owner per account identity:
 * - switch off, or bootstrap without a syncV2 announcement: no runtime, no v2
 *   request, no local write, no UI port;
 * - on: open once after the v1 account and its keys are ready, then install
 *   the UI port;
 * - the only unmount point is stop() (logout, account switch, dispose). */
export interface SyncV2ProductSession<Port> {ui:Port;close():Promise<void>}
export interface SyncV2ProductOptions<Port> {
 /** SYNC_V2_PRODUCT.syncV2 (src/sync-v2/gate.ts). */
 enabled:boolean;
 /** True only when the v1 bootstrap carries the syncV2 announcement (P6-11). */
 announced:()=>Promise<boolean>;
 open:()=>Promise<SyncV2ProductSession<Port>|null>;
 install:(port:Port|undefined)=>void;
}
export function watchSyncV2Product<Port>(options:SyncV2ProductOptions<Port>){
 let generation=0,identity:string|null=null,session:SyncV2ProductSession<Port>|null=null,opening:Promise<Port|null>|null=null;
 const stop=async()=>{generation++;identity=null;opening=null;const closing=session;session=null;options.install(undefined);await closing?.close();};
 return {
  /** Idempotent per account identity; a new identity first unmounts the old one. */
  async start(next:string):Promise<Port|null>{
   if(options.enabled!==true)return null;
   if(identity!==next){if(identity!==null||session)await stop();identity=next;}
   if(session)return session.ui;
   const ticket=generation;
   return opening??=(async()=>{
    try{
     if(!await options.announced()||ticket!==generation)return null;
     const opened=await options.open();if(!opened)return null;
     if(ticket!==generation){await opened.close();return null;}
     session=opened;options.install(opened.ui);return opened.ui;
    }finally{if(ticket===generation)opening=null;}
   })();
  },
  stop,
  get active(){return session!==null;},
 };
}
