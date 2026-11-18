import {discovery,onInternetAvailabilityChange} from '@podjs/framework/services';
import {observeInternet,type SnapshotOrder,type NetworkSnapshot} from './network.ts';
import type {InternetStatus} from './state.ts';
export function observeHostInternet(listener:(status:InternetStatus,order?:SnapshotOrder)=>void,read?:()=>Promise<NetworkSnapshot>,onNetworkInvalidated?:()=>void):()=>void {
 return observeInternet({
  snapshot:read??(()=>discovery.networkSnapshot()),
  subscribe:(changed,error)=>onInternetAvailabilityChange(()=>{onNetworkInvalidated?.();changed();},error),
 },listener,read!==undefined);
}
