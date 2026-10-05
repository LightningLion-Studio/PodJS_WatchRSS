import {defineBackgroundHandler} from '@podjs/framework/background-handler';
import {DebugGate} from '../debug/gate';
import {createCloudRuntime} from './runtime';
import {createBackgroundLibrary} from './background-library';
import type {CloudHostRequest} from './host-ports';
export default defineBackgroundHandler(async context=>{
 if(!context.request)return 'failure';
 const gate=new DebugGate();
 const raw:CloudHostRequest=(method,args)=>context.request!('debug.cloudHost',{method,args}) as Promise<any>;
 // This is the same app.buildInfo host method used by application.buildInfo().
 if(!await gate.initialize(()=>raw('app.buildInfo',{})))return 'success';
 const guard={require(){gate.require();if(context.isCancelled())throw Error('Cloud worker cancelled');}};
 const host:CloudHostRequest=(method,args)=>{if(method!=='cloud.release'&&method!=='file.delete')guard.require();return raw(method,args);};
 let library:ReturnType<typeof createBackgroundLibrary>|undefined;
 const runtime=createCloudRuntime(host,()=>library??=createBackgroundLibrary(host,async key=>{const r=await context.request!('kv.get',{key}) as {exists:boolean;value?:unknown};return r.exists?r.value:undefined;},guard),guard);
 if(!await runtime.accounts.read())return 'success';
 return await runtime.service.syncNow()?'success':'retry';
});
