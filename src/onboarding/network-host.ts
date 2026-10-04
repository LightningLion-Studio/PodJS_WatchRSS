import {discovery,onNetworkChange} from '@podjs/framework/services';
import {observeInternet} from './network.ts';
import type {InternetStatus} from './state.ts';
export function observeHostInternet(listener:(status:InternetStatus)=>void):()=>void {
 return observeInternet({snapshot:()=>discovery.networkSnapshot(),subscribe:(changed,error)=>onNetworkChange(changed,error)},listener);
}
