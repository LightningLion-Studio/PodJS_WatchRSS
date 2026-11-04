import {delay} from '@podjs/framework/services';
import {observeCpuWork} from '@podjs/framework/cpu-work';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {setServiceDiagnostics} from '@podjs/framework/service-trace';
import {idleHit,idleHost,idleWork,takeIdleCounts,timerSite} from './idle-counters';
import {sqlRequestSite} from './sql-sites';
let installed=false;
/** One bounded numeric message per 30 seconds, using a native timer wake. */
export function installIdleDiagnostics(){
 if(installed)return;installed=true;
 observeCpuWork(metric=>{if(metric.outcome==='complete'||metric.outcome==='failed')idleWork(metric.stage,metric.elapsedMillis);});
 setServiceDiagnostics({request(method,args){idleHost(method);if(method.startsWith('sql.'))return sqlRequestSite(args);if(method==='runtime.delay'){idleHit(60);return timerSite(args.milliseconds);}return 0;},completed(method,site,ok){idleHit(105);if(method==='runtime.delay'&&ok)idleHit(site?70+site:79);}});
 const timers=globalThis as unknown as Record<string,any>;
 for(const [name,id] of [['setTimeout',90],['setInterval',91]] as const){const original=timers[name];if(typeof original==='function')try{timers[name]=function(handler:unknown,ms?:unknown,...args:unknown[]){return typeof handler==='function'?original.call(this,function(this:unknown,...values:unknown[]){idleHit(id);return handler.apply(this,values);},ms,...args):original.call(this,handler,ms,...args);};}catch{/* A read-only timer is left intact. */}}
 onFrame(()=>idleHit(1),()=>false);
 let last=Date.now();
 const flush=async()=>{for(;;){try{await delay(30000).result;}catch{return;}const now=Date.now(),elapsedMs=Math.min(300000,Math.max(0,now-last));last=now;
  try{(globalThis as {pod?:{emit(line:string):void}}).pod?.emit(JSON.stringify({t:'diagnostic.idleCounters',version:2,elapsedMs,counts:takeIdleCounts()}));}catch{/* Observations cannot affect application work. */}
 }};void flush();
}
