import {watchAppVersion} from '../core/app-version';

/** Feed the native relay the same version value as account/cloud requests. */
export function pairingHostArgs(method:string,args:Record<string,unknown>){
 return method==='provision.start'?{...args,appVersion:watchAppVersion}:args;
}
