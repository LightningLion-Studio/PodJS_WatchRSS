import type {AccountCloudStatus} from '../account/status';
// A display-only boundary; no runtime import and no IO at module initialization.
let provider:(()=>AccountCloudStatus|undefined)|undefined;
const observers=new Set<()=>void>();
export function readCloudAccountStatus(){return provider?.();}
export function subscribeCloudAccountStatus(observer:()=>void){observers.add(observer);return ()=>{observers.delete(observer);};}
export function notifyCloudAccountStatus(){for(const fn of observers)try{fn();}catch{}}
export function connectCloudAccountStatus(read:()=>AccountCloudStatus|undefined){provider=read;notifyCloudAccountStatus();return ()=>{if(provider===read)provider=undefined;notifyCloudAccountStatus();};}
