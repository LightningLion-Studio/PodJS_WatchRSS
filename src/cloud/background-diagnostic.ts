import {RESTORE_CPU_STAGES} from './cpu-phases';
import {cpuWorkTicket,type CpuWorkMetric} from '@podjs/framework/cpu-work';
import {repositoryStages} from '../sync/repository-work';
import type {CloudHostRequest} from './host-ports';
import {cloudDiagnosticHostMethod} from './host-capability';
import {SNAPSHOT_DEFER_CODES} from './snapshot-deferral';
const stages=new Set('secure-read secure-write decrypt encrypt file-read file-write file-commit transform host checkpoint-read checkpoint-write checkpoint-range-piece checkpoint-invalid download chunk object overlay inventory manifest source-hash inflate plan export identity projection canonicalJSON hash ack-diff encode push checkpoint retire apply-metadata apply-books reading-candidates reading-index reading-merge state-read state-validate projection-load original-load replay-unit checkpoint-skip open pull interactions reapply flush decoding merging applied guard lease_acquire network session_open owner bootstrap content device keys run'.split(' '));
for(const stage of repositoryStages)stages.add(stage);
const categories=new Set('none busy transport authorization conflict capacity storage gate format suspended server timeout concurrent-library-change runtime other'.split(' '));
const codes=new Set(['request_too_large','cloud_sync_deadline_exceeded','cloud_sync_suspended','cloud_operation_superseded','cloud_snapshot_progress_stalled','cloud_host_capability_unavailable',...SNAPSHOT_DEFER_CODES]);
const events=new Set(['restore_progress','snapshot-work','window-unit','library-work','records-work','records-replay','records-stage','records-failed','format-sync','format-http']);
const numbers='version ready full headsTotal headsDone downloadTotal downloadDone downloadTotalBytes downloadDoneBytes decompressTotal decompressDone decompressTotalBytes decompressDoneBytes applyTotal applyDone applyTotalBytes applyDoneBytes projectionTotal projectionDone projectionTotalBytes projectionDoneBytes objectIndex chunkIndex remainingMillis bytes completedUnits queries queryMillis transactions transactionMillis hashes hashMillis attempt definitionChanged generationChanged ownedTriggersChanged revisionTriggersChanged durationMillis units batchRows documents keyMillis decodeMillis hashMillis applyMillis elapsedMillis decryptions projectionDecryptions retired submittedBytes responseBytes status'.split(' ');
/** Closed/numeric schema only. One in-flight append; no unbounded shutdown queue. */
export function backgroundDiagnostics(host:CloudHostRequest){
 let pending:{line:string;key?:string;fields?:Record<string,unknown>}[]=[],active:Promise<void>|undefined,last=-Infinity,dropped=0;
 const cpuStages=new Set<string>(RESTORE_CPU_STAGES),cpuPending=new Map<string,CpuWorkMetric>(),cpuLast=new Map<string,{at:number;outcome:string}>();let cpuDrain:Promise<void>|undefined;
 const flushCpu=():Promise<void>=>{
  if(cpuDrain)return cpuDrain.then(()=>cpuPending.size?flushCpu():undefined);
  if(!cpuPending.size)return Promise.resolve();
  cpuDrain=(async()=>{while(cpuPending.size){const batch=[...cpuPending.values()];cpuPending.clear();const lines=batch.map(row=>new Date().toISOString()+' [I] CloudCPU '+JSON.stringify(row)+'\n');for(let at=0;at<lines.length;){let text='';while(at<lines.length&&text.length+lines[at].length<=6500)text+=lines[at++];try{await host('log.append',{path:'app_log.txt',text,maxBytes:5*1024*1024});}catch{/* Metrics cannot change restore. */}}}})().finally(()=>{cpuDrain=undefined;});return cpuDrain;
 };
 const cpu=(metric:CpuWorkMetric):void|Promise<void>=>{if(!metric||!cpuStages.has(metric.stage)||!['bytes','chars','items'].includes(metric.scale)||!Number.isInteger(metric.sizeClass)||metric.sizeClass<0||metric.sizeClass>5||!Number.isFinite(metric.elapsedMillis)||metric.elapsedMillis<0||!['started','progress','complete','failed'].includes(metric.outcome))return;
  const trace=(globalThis as {__podCpuTrace?:(stage:number,scale:number,band:number,elapsed:number,outcome:number,ticket:number)=>boolean}).__podCpuTrace;
  if(typeof trace==='function'){try{trace(RESTORE_CPU_STAGES.indexOf(metric.stage as typeof RESTORE_CPU_STAGES[number]),['bytes','chars','items'].indexOf(metric.scale),metric.sizeClass,Math.min(300000,Math.floor(metric.elapsedMillis)),['started','progress','complete','failed'].indexOf(metric.outcome),cpuWorkTicket(metric));}catch{/* Native trace is optional metadata. */}return;}
  const now=Date.now(),last=cpuLast.get(metric.stage);if(last&&now-last.at<5000&&!(['started','progress'].includes(last.outcome)&&['complete','failed'].includes(metric.outcome)))return;
  cpuLast.set(metric.stage,{at:now,outcome:metric.outcome});cpuPending.set(metric.stage,{event:'cpu-work',stage:metric.stage,scale:metric.scale,sizeClass:metric.sizeClass,elapsedMillis:Math.min(300000,Math.floor(metric.elapsedMillis)),outcome:metric.outcome});return flushCpu();
 };

 const send=(force=false)=>{if(active)return active;if(!pending.length||!force&&Date.now()-last<5000)return Promise.resolve();
  // Keep the latest closed library stage even when a fast complete run floods
  // the bounded records queue before its five-second append interval.
  const selected=new Set<number>();let size=0;
  for(const priority of [true,false])for(let i=pending.length-1;i>=0;i--){const row=pending[i];if(!!row.key!==priority||size+row.line.length>6500)continue;selected.add(i);size+=row.line.length;}
  let lines=pending.filter((_r,i)=>selected.has(i)).map(r=>r.line).join('');
  dropped+=pending.length-selected.size;pending=[];
  if(dropped){lines=new Date().toISOString()+' [I] CloudRecords '+JSON.stringify({event:'records-diagnostics',dropped})+'\n'+lines;dropped=0;}
  last=Date.now();active=(async()=>{try{await host('log.append',{path:'app_log.txt',text:lines,maxBytes:5*1024*1024});}catch{/* Diagnostics cannot alter the restore. */}})().finally(()=>{active=undefined;});return active;
 };
 const report=(text:string)=>{try{const value=JSON.parse(text);if(value.event==='cpu-work'){void cpu(value);return;}const event=events.has(value.event)?value.event:typeof value.decryptions==='number'?'records-pull':undefined;if(!event)return;const safe:Record<string,unknown>={event};if(event==='restore_progress'){for(const key of numbers.slice(0,21))if(Number.isSafeInteger(value[key])&&value[key]>=0)safe[key]=value[key];pending=pending.filter(row=>row.key!=='restore_progress');pending.push({line:new Date().toISOString()+' [I] CloudRecords '+JSON.stringify(safe)+'\n',key:'restore_progress',fields:safe});void send();return;}if(categories.has(value.category))safe.category=value.category;if(codes.has(value.code))safe.code=value.code;const method=cloudDiagnosticHostMethod(value.method);if(method)safe.method=method;for(const key of numbers)if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)safe[key]=value[key];if(stages.has(value.stage))safe.stage=value.stage;if(['revision','projection','action','validation'].includes(value.reason))safe.reason=value.reason;if(['library','books','bookReading','reader','notes','account','usage'].includes(value.domain))safe.domain=value.domain;if(['pull','flush','interactions'].includes(value.lane))safe.lane=value.lane;if(['complete','failed','started','paused','deferred','superseded'].includes(value.outcome))safe.outcome=value.outcome;if(typeof value.cached==='boolean')safe.cached=value.cached;const key=event==='restore_progress'?'restore_progress':event==='window-unit'?'window-unit':event==='snapshot-work'?'snapshot-work':event==='library-work'?String(safe.stage)+':'+String(safe.domain??''):undefined;if(key){const at=pending.findIndex(row=>row.key===key);if(at>=0){const previous=pending.splice(at,1)[0].fields!;if(safe.outcome!=='started')for(const field of ['definitionChanged','generationChanged','ownedTriggersChanged','revisionTriggersChanged'])if(safe[field]===undefined&&previous[field]!==undefined)safe[field]=previous[field];}}
 pending.push({line:new Date().toISOString()+' [I] CloudRecords '+JSON.stringify(safe)+'\n',key,fields:key?safe:undefined});if(pending.length>128){const at=pending.findIndex(row=>!row.key);pending.splice(at<0?0:at,1);dropped++;}void send();}catch{}};
 // At most the existing append plus one bounded final append, even on timeout.
 return {report,cpu,flushCpu,async flush(){await flushCpu();if(active)await active;await send(true);pending=[];}};
}
