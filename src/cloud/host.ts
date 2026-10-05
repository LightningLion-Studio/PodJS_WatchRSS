import {hostOperation} from '@podjs/framework/services';
import {debugGate,initializeDebugBuild} from '../debug/host';
import {createCloudHostPorts} from './host-ports';
import type {CloudClientOptions,HttpTransport} from './types';
export const cloudHostPorts=createCloudHostPorts(<T>(method:string,args:Record<string,unknown>)=>{debugGate.require();return hostOperation<T>(method,args).result;},debugGate);
export async function createHostCloudFoundation(userId:string,deviceId:string,http:HttpTransport,options:CloudClientOptions){
 if(!await initializeDebugBuild())return undefined;
 return cloudHostPorts.foundation(userId,deviceId,http,options);
}
