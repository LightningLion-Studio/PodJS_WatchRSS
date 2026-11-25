import type {HostOperation} from '@podjs/framework/services';
import {appLogger} from '../logs/app-logger.ts';
import type {InternetStatus} from './state.ts';
export interface SnapshotOrder {requested:number;captured?:number}
export interface NetworkSnapshot {defaultNetworkId?:string;snapshotSequence?:number;order?:SnapshotOrder;internetStatusOverride?:InternetStatus;active:boolean;internet:boolean;validated:boolean;wifi:boolean;cellular:boolean;bluetooth:boolean}
export function bluetoothTransport(snapshot:NetworkSnapshot):boolean|undefined {
 if(snapshot.internetStatusOverride==='checking')return undefined;
 if(snapshot.internetStatusOverride)return snapshot.internetStatusOverride==='bluetooth';
 return snapshot.active&&snapshot.bluetooth&&!snapshot.wifi&&!snapshot.cellular;
}
export type InternetListener=(status:InternetStatus,order?:SnapshotOrder,onBluetooth?:boolean,defaultNetworkId?:string)=>void;
export function internetAvailability(snapshot:NetworkSnapshot):InternetStatus {
 if(snapshot.internetStatusOverride)return snapshot.internetStatusOverride;
 if(!snapshot.active||!snapshot.internet||!snapshot.validated)return 'unavailable';
 if(snapshot.wifi||snapshot.cellular)return 'available';
 return snapshot.bluetooth?'bluetooth':'unavailable';
}
/** One sequence space for observation and on-demand reads in a route. */
export function orderNetworkSnapshots(read:()=>HostOperation<NetworkSnapshot>) {
 let requested=0;
 const snapshotWithOrder=()=>{
  const request=++requested;
  const operation=read();
  return {
   ...operation,
   result:operation.result.then(snapshot=>{
    const captured=snapshot.snapshotSequence;
    const order:SnapshotOrder={requested:request,captured:Number.isSafeInteger(captured)?captured:undefined};
    return {...snapshot,order};
   }),
  };
 };
 return Object.assign(snapshotWithOrder,{lastRequested:()=>requested});
}
export interface InternetPorts {
 snapshot():Promise<NetworkSnapshot>;
 subscribe(change:()=>void,error:()=>void):()=>void;
}
/** Re-read the active route on changes; a local Wi-Fi callback alone does not prove internet access. */
export function observeInternet(ports:InternetPorts,listener:InternetListener,reportSnapshots=false):()=>void {
 let stopped=false,running=false,dirty=false,last:InternetStatus='checking';
 const emit=(status:InternetStatus,snapshot?:NetworkSnapshot)=>{
  if(stopped)return;
  const changed=status!==last;
  last=status;
  if(changed)appLogger.i('InternetAvailabilityMonitor',`status=${status}`);
  // Recovery also reads snapshots on demand. A fresh observation can
  // supersede one of those reads even when this observer missed the outage.
  if(changed||snapshot&&reportSnapshots)listener(status,snapshot?.order,snapshot&&bluetoothTransport(snapshot),snapshot?.defaultNetworkId);
 };
 const refresh=()=>{
  if(stopped)return;
  dirty=true;
  if(running)return;
  running=true;
  void (async()=>{
   try{
    while(dirty&&!stopped){
     dirty=false;
     let snapshot:NetworkSnapshot,status:InternetStatus;
     try{snapshot=await ports.snapshot();status=internetAvailability(snapshot);}
     catch{if(!dirty)emit('checking');continue;}
     if(!dirty)emit(status,snapshot);
    }
   }finally{running=false;}
  })();
 };
 listener('checking');let unsubscribe:()=>void;try{unsubscribe=ports.subscribe(refresh,()=>emit('checking'));}catch(error){appLogger.e('InternetAvailabilityMonitor','Failed to register default network callback');throw error;}refresh();
 return ()=>{if(stopped)return;stopped=true;try{unsubscribe();}catch(error){appLogger.e("InternetAvailabilityMonitor","Failed to unregister default network callback");throw error;}};
}
