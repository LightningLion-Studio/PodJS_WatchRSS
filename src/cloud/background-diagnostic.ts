import {repositoryStages} from '../sync/repository-work';
import type {CloudHostRequest} from './host-ports';
import {cloudDiagnosticHostMethod} from './host-capability';
const stages=new Set('export identity projection canonicalJSON hash ack-diff encode push checkpoint retire apply-metadata apply-books reading-candidates reading-merge state-read state-validate projection-load original-load replay-unit checkpoint-skip open pull interactions reapply flush decoding merging applied guard lease_acquire network session_open owner bootstrap content device keys run'.split(' '));
for(const stage of repositoryStages)stages.add(stage);
const categories=new Set('none busy transport authorization conflict capacity storage gate format suspended server timeout concurrent-library-change runtime other'.split(' '));
const codes=new Set(['cloud_sync_deadline_exceeded','cloud_sync_suspended','cloud_operation_superseded','cloud_snapshot_progress_stalled','cloud_host_capability_unavailable']);
const events=new Set(['library-work','records-work','records-replay','records-stage','records-failed','format-sync','format-http']);
const numbers='attempt definitionChanged generationChanged ownedTriggersChanged revisionTriggersChanged durationMillis units batchRows documents keyMillis decodeMillis hashMillis applyMillis elapsedMillis decryptions projectionDecryptions retired submittedBytes responseBytes status'.split(' ');
/** Closed/numeric schema only. One in-flight append; no unbounded shutdown queue. */
export function backgroundDiagnostics(host:CloudHostRequest){
 let pending:{line:string;key?:string;fields?:Record<string,unknown>}[]=[],active:Promise<void>|undefined,last=-Infinity,dropped=0;
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
 const report=(text:string)=>{try{const value=JSON.parse(text),event=events.has(value.event)?value.event:typeof value.decryptions==='number'?'records-pull':undefined;if(!event)return;const safe:Record<string,unknown>={event};if(categories.has(value.category))safe.category=value.category;if(codes.has(value.code))safe.code=value.code;const method=cloudDiagnosticHostMethod(value.method);if(method)safe.method=method;for(const key of numbers)if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)safe[key]=value[key];if(stages.has(value.stage))safe.stage=value.stage;if(['revision','projection','action','validation'].includes(value.reason))safe.reason=value.reason;if(['library','books','bookReading','reader','notes','account','usage'].includes(value.domain))safe.domain=value.domain;if(['pull','flush','interactions'].includes(value.lane))safe.lane=value.lane;if(['complete','failed','started','paused','deferred','superseded'].includes(value.outcome))safe.outcome=value.outcome;if(typeof value.cached==='boolean')safe.cached=value.cached;const key=event==='library-work'?String(safe.stage)+':'+String(safe.domain??''):undefined;if(key){const at=pending.findIndex(row=>row.key===key);if(at>=0){const previous=pending.splice(at,1)[0].fields!;if(safe.outcome!=='started')for(const field of ['definitionChanged','generationChanged','ownedTriggersChanged','revisionTriggersChanged'])if(safe[field]===undefined&&previous[field]!==undefined)safe[field]=previous[field];}}
 pending.push({line:new Date().toISOString()+' [I] CloudRecords '+JSON.stringify(safe)+'\n',key,fields:key?safe:undefined});if(pending.length>128){const at=pending.findIndex(row=>!row.key);pending.splice(at<0?0:at,1);dropped++;}void send();}catch{}};
 // At most the existing append plus one bounded final append, even on timeout.
 return {report,async flush(){if(active)await active;await send(true);pending=[];}};
}
