import type {CloudHostRequest} from './host-ports';
import {cloudDiagnosticHostMethod} from './host-capability';
const stages=new Set('export identity projection canonicalJSON hash ack-diff encode push checkpoint retire apply-metadata apply-books reading-candidates reading-merge state-read state-validate projection-load original-load replay-unit checkpoint-skip open pull interactions reapply flush decoding merging applied guard lease_acquire network session_open owner bootstrap content device keys run'.split(' '));
const categories=new Set('none busy transport authorization conflict capacity storage gate format suspended server timeout concurrent-library-change runtime other'.split(' '));
const codes=new Set(['cloud_sync_deadline_exceeded','cloud_sync_suspended','cloud_operation_superseded','cloud_snapshot_progress_stalled','cloud_host_capability_unavailable']);
const events=new Set(['records-work','records-replay','records-stage','records-failed','format-sync','format-http']);
const numbers='durationMillis units batchRows documents keyMillis decodeMillis hashMillis applyMillis elapsedMillis decryptions projectionDecryptions retired submittedBytes responseBytes status'.split(' ');
/** Closed/numeric schema only. One in-flight append; no unbounded shutdown queue. */
export function backgroundDiagnostics(host:CloudHostRequest){
 let pending:string[]=[],active:Promise<void>|undefined,last=-Infinity,dropped=0;
 const send=(force=false)=>{if(active)return active;if(!pending.length||!force&&Date.now()-last<5000)return Promise.resolve();
  let lines='';while(pending.length&&lines.length+pending[pending.length-1].length<=6500)lines=pending.pop()+lines;
  dropped+=pending.length;pending=[];
  if(dropped){lines=new Date().toISOString()+' [I] CloudRecords '+JSON.stringify({event:'records-diagnostics',dropped})+'\n'+lines;dropped=0;}
  last=Date.now();active=(async()=>{try{await host('log.append',{path:'app_log.txt',text:lines,maxBytes:5*1024*1024});}catch{/* Diagnostics cannot alter the restore. */}})().finally(()=>{active=undefined;});return active;
 };
 const report=(text:string)=>{try{const value=JSON.parse(text),event=events.has(value.event)?value.event:typeof value.decryptions==='number'?'records-pull':undefined;if(!event)return;const safe:Record<string,unknown>={event};if(categories.has(value.category))safe.category=value.category;if(codes.has(value.code))safe.code=value.code;const method=cloudDiagnosticHostMethod(value.method);if(method)safe.method=method;for(const key of numbers)if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)safe[key]=value[key];if(stages.has(value.stage))safe.stage=value.stage;if(['pull','flush','interactions'].includes(value.lane))safe.lane=value.lane;if(['complete','failed','started','paused','deferred','superseded'].includes(value.outcome))safe.outcome=value.outcome;if(typeof value.cached==='boolean')safe.cached=value.cached;pending.push(new Date().toISOString()+' [I] CloudRecords '+JSON.stringify(safe)+'\n');if(pending.length>128){dropped+=pending.length-128;pending.splice(0,pending.length-128);}void send();}catch{}};
 // At most the existing append plus one bounded final append, even on timeout.
 return {report,async flush(){if(active)await active;await send(true);pending=[];}};
}
