import {appLogger} from '../logs/app-logger.ts';
import {playerFailureCode} from '../media/player-errors.ts';
import {emitSavedIssue} from './saved-issue-events.ts';
import type {DouyinSavedEntry} from './types.ts';

export type ResolutionFacts={httpStatus?:number;apiStatus?:number;requestReason?:string;detailShape?:'video'|'note'|'ad'|'missing'|'invalid'};
export type ResolutionObservation=ResolutionFacts&{ok:boolean;code?:string;source?:string;forceRefresh:boolean};
export type SavedAgeBucket='under_7d'|'7_to_14d'|'14_to_30d'|'over_30d'|'unknown';
const DAY=86400000;
let sequence=0;
const codes=['NOT_LOGGED_IN','PLAYBACK_FAILED','REQUEST_FAILED','PARSE_FAILED','UNSUPPORTED','CANCELLED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE'];
const reasons=['success','http','api_status','forbidden','timeout','network','cancelled','signing','cooldown','client_limit','decode','challenge','blocked','empty'];
export function savedAgeBucket(ageMs:number|undefined):SavedAgeBucket{
 if(ageMs===undefined||!Number.isFinite(ageMs)||ageMs<0)return 'unknown';
 return ageMs<7*DAY?'under_7d':ageMs<14*DAY?'7_to_14d':ageMs<30*DAY?'14_to_30d':'over_30d';
}
export function savedPlaybackContext(entries:DouyinSavedEntry[],id:string){
 const own=entries.filter(e=>e.item.awemeId===id),favorite=own.find(e=>e.kind==='favorite'),later=own.find(e=>e.kind==='watchLater');
 // Favorite age is the question being investigated; watch-later has an independent timestamp.
 return {kind:favorite&&later?'both':favorite?'favorite':later?'watchLater':'none',savedAtMillis:(favorite??later)?.savedAtMillis} as const;
}
/** One user opening, including all same-item retries. No URL, platform/account ID,
 * title, headers, response body, or arbitrary exception text reaches the log. */
export class DouyinSavedPlaybackDiagnostic{
 readonly attempt=++sequence;
 private closed=false;
 private played=false;
 private resolveFailed=false;
 private failed=false;
 private recovered=false;
 private recovering=false;
 private cancelled=false;
 private issueReported=false;
 private lastResolutionCode='unknown';
 private issueContext?:{itemId:string;savedAtMillis?:number};
 private refreshCount=0;
 private started:number;
 constructor(context:{kind:string;savedAtMillis?:number;url:string;itemId?:string},private now:()=>number=Date.now){
  this.started=now();
  if((context.kind==='favorite'||context.kind==='both')&&context.itemId)this.issueContext={itemId:context.itemId,savedAtMillis:context.savedAtMillis};
  const age=Number.isSafeInteger(context.savedAtMillis)&&context.savedAtMillis!>0&&context.savedAtMillis!<=this.started?this.started-context.savedAtMillis!:undefined;
  const explicit=/[?&](?:x-expires|expires|deadline)=(\d{9,10})(?:&|$)/i.exec(context.url);
  this.emit('open',{kind:['favorite','watchLater','both','none'].includes(context.kind)?context.kind:'unknown',ageBucket:savedAgeBucket(age),ageDays:age===undefined?-1:Math.floor(age/DAY),savedUrlExpiry:explicit?(Number(explicit[1])*1000<=this.started?'expired':'unexpired'):'unknown'});
 }
 private emit(stage:string,fields:Record<string,string|number|boolean>={}){
  if(this.closed)return;
  try{appLogger.i('DouyinSavedPlayback',JSON.stringify({version:1,attempt:this.attempt,stage,elapsedMs:Math.max(0,this.now()-this.started),...fields}));}catch{/* Diagnostics never change playback. */}
 }
 resolution(phase:'initial'|'refresh',value:ResolutionObservation){
  if(!value.ok)this.lastResolutionCode=codes.includes(value.code??'')?value.code!:'unknown';
  if(phase==='refresh')this.refreshCount++;
  if(!value.ok&&value.code==='CANCELLED')this.cancelled=true;
  else if(!value.ok)this.resolveFailed=true;
  this.emit('resolve',{phase,ok:value.ok===true,forceRefresh:value.forceRefresh===true,code:value.ok?'OK':codes.includes(value.code??'')?value.code!:'UNKNOWN',source:value.source==='network'?'network':value.source==='feed-cache'?'feed-cache':'unknown',httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus!>=100&&value.httpStatus!<=599?value.httpStatus!:0,apiStatus:Number.isSafeInteger(value.apiStatus)?value.apiStatus!:-1,requestReason:reasons.includes(value.requestReason??'')?value.requestReason!:'unknown',detailShape:['video','note','ad','missing','invalid'].includes(value.detailShape??'')?value.detailShape!:'unknown'});
 }
 address(phase:'initial'|'recovery',previous:string|undefined,next:string|undefined){this.emit('address',{phase,changed:previous&&next?(previous===next?'no':'yes'):'unknown'});}
 playbackFailure(error:unknown){
  const code=playerFailureCode(error);if(this.closed||code==='cancelled'||code==='stale')return;
  this.failed=true;this.recovering=false;
  this.issue('player',code);
  const value=error as {status?:unknown;httpStatus?:unknown}|null,status=value?.status??value?.httpStatus;
  this.emit('failure',{code:playerFailureCode(error),httpStatus:typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:0});
 }
 recovery(manual:boolean){this.recovering=true;this.emit('recovery',{manual});}
 recoveryError(){this.recovering=false;this.emit('recovery_error');}
 private issue(stage:'player'|'resolve',code:string){if(this.closed||this.issueReported||this.cancelled||!this.issueContext)return;this.issueReported=true;emitSavedIssue(this.issueContext,{atMillis:this.now(),stage,code});}
 openError(){this.resolveFailed=true;this.emit('open_error');this.issue('resolve',this.lastResolutionCode);}
 firstFrame(){
  if(this.played&&!this.recovering)return;
  this.played=true;
  const recovered=this.failed&&this.recovering;
  this.recovered ||= recovered;
  this.emit('first_frame',{recovered,refreshCount:this.refreshCount});this.recovering=false;
 }
 end(){
  if(this.closed)return;
  this.emit('end',{outcome:this.played?'played':this.cancelled||this.recovering?'abandoned':this.failed?'playback_failed':this.resolveFailed?'resolve_failed':'abandoned',recovered:this.recovered,refreshCount:this.refreshCount});this.closed=true;
 }
 abandon(){this.cancelled=true;this.end();}
}
