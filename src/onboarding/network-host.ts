import {discovery,onInternetAvailabilityChange,type NetworkChange} from '@podjs/framework/services';
import {observeInternet,type InternetListener,type NetworkSnapshot} from './network.ts';
export function observeHostInternet(listener:InternetListener,read?:()=>Promise<NetworkSnapshot>,onNetworkInvalidated?:(connectionChanged:boolean)=>void):()=>void {
 return observeInternet({
  snapshot:read??(()=>discovery.networkSnapshot()),
  subscribe:(changed,error)=>{
   let sawDefaultAvailable=false;
   return onInternetAvailabilityChange((event?:NetworkChange)=>{
    // Registration reports the current default network as available once.
    // A later availability event means Android selected a new default.
    const available=event?.source==='default'&&event.reason==='available';
    const lost=event?.source==='default'&&event.reason==='lost';
    onNetworkInvalidated?.(lost||(available&&sawDefaultAvailable));
    sawDefaultAvailable ||= available;
    changed();
   },error);
  },
 },listener,read!==undefined);
}
