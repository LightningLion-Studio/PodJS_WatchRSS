import {hostOperation} from '@podjs/framework/services';
import {cloudGate} from './gate';
import {createCloudHostPorts} from './host-ports';
import type {CloudClientOptions,HttpTransport} from './types';
export const cloudHostPorts=createCloudHostPorts(<T>(method:string,args:Record<string,unknown>)=>{cloudGate.require();return hostOperation<T>(method,args).result;},cloudGate);
export async function createHostCloudFoundation(userId:string,deviceId:string,http:HttpTransport,options:CloudClientOptions){
 if(!await initializeCloudHost())return undefined;
 return cloudHostPorts.foundation(userId,deviceId,http,options);
}

export function initializeCloudHost(){return cloudGate.initialize(()=>hostOperation('app.buildInfo',{}).result);}
