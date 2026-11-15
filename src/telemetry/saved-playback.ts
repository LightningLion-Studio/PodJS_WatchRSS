import {CaptureUploadScheduler} from '@podjs/framework/telemetry';
import {sha256Hex} from '@podjs/framework/crypto';
import {utf8Encode,type HttpTransport} from '../cloud/types.ts';
import type {WatchAccountState} from '../account/types.ts';
import type {DiagnosticStorage} from '../sync/diagnostic-log.ts';
import type {SavedIssueContext,SavedIssueOccurrence} from '../douyin/saved-issue-events.ts';

type Event={
 eventId:string;collectionKey:string;occurredAtMs:number;ageMs:number|null;
 stage:'resolve'|'player';code:string;appVersion:string;
};
type Pending={userId:string;baseUrl:string;event:Event};
interface Ports{
 readAccount():Promise<WatchAccountState|null>;
 freshAccount():Promise<WatchAccountState>;
 randomId():Promise<string>;
 transport:HttpTransport;
 delay(ms:number):Promise<unknown>;
 version:string;
 appVersion:string;
}
const KEY='watchrss.telemetry.saved-playback-issues.v1';
const RETENTION_MS=31*86400000,MAX_AGE=631152000000;
const CODES=[
 'NOT_LOGGED_IN','PLAYBACK_FAILED','REQUEST_FAILED','PARSE_FAILED','UNSUPPORTED',
 'RATE_LIMITED','TEMPORARILY_UNAVAILABLE','source_expired','restricted','network_error',
 'cdn_error','decode_error','decoder_init','format_error','surface_error','timeout',
 'prepare_failed','resource_exhausted','recovery_exhausted','storage_error','cache_error',
 'not_ready','invalid_argument','permission_denied','session_missing','video_session_error',
 'video_error','service_closed','host_error','unknown',
];

/** Account-scoped durable events. Event UUIDs make retries idempotent; a scoped
 * collection digest finds the first observed failure without transmitting a video ID. */
export class SavedPlaybackIssueTelemetry{
 private tail:Promise<unknown>=Promise.resolve();
 private readonly scheduler:CaptureUploadScheduler;
 constructor(private storage:DiagnosticStorage,private ports:Ports,private now=Date.now){
  this.scheduler=new CaptureUploadScheduler(ports.delay,()=>this.upload());
 }
 private read():Pending[]{
  try{
   const rows=JSON.parse(this.storage.get(KEY)??'[]');
   return Array.isArray(rows)?rows.filter(r=>typeof r?.userId==='string'&&
    typeof r?.baseUrl==='string'&&typeof r?.event?.eventId==='string'):[];
  }catch{return [];}
 }
 private write(rows:Pending[]){this.storage.set(KEY,JSON.stringify(rows));}
 private reportable(){
  const rows=this.read(),kept=rows.filter(r=>r.event.occurredAtMs>=this.now()-RETENTION_MS);
  if(kept.length!==rows.length)this.write(kept);
  return kept;
 }
 capture(context:SavedIssueContext,value:SavedIssueOccurrence):Promise<void>{
  // Read ownership now, before waiting behind another capture's storage/crypto work.
  const account=this.ports.readAccount().catch(()=>null);
  const work=this.tail.catch(()=>{}).then(async()=>{
   const owner=await account;
   if(!owner||!context.itemId)return;
   const baseUrl=owner.backendBaseUrl.replace(/\/+$/,''),saved=context.savedAtMillis;
   const age=Number.isSafeInteger(saved)&&saved!>0&&saved!<=value.atMillis?value.atMillis-saved!:null;
   const event:Event={
    eventId:await this.ports.randomId(),
    collectionKey:sha256Hex(utf8Encode(JSON.stringify([
     'local-douyin-favorite-v1',baseUrl,owner.userId,context.itemId,saved??null,
    ]))),
    occurredAtMs:value.atMillis,ageMs:age!==null&&age<=MAX_AGE?age:null,
    stage:value.stage,code:CODES.includes(value.code)?value.code:'unknown',
    appVersion:this.ports.version,
   };
   const rows=this.reportable();
   // Never silently evict a still-reportable event to add another.
   if(rows.length>=1000)throw Error('saved_issue_queue_capacity');
   rows.push({userId:owner.userId,baseUrl,event});
   this.write(rows);
   this.scheduler.capture();
  });
  this.tail=work;
  return work;
 }
 retryPending(){this.scheduler.capture();}
 backlogCount(){return this.read().length;}
 private async upload(){
  await this.tail.catch(()=>{});
  const account=await this.ports.freshAccount(),baseUrl=account.backendBaseUrl.replace(/\/+$/,'');
  for(;;){
   const batch=this.reportable().filter(r=>r.userId===account.userId&&r.baseUrl===baseUrl).slice(0,50);
   if(!batch.length)return;
   const current=await this.ports.readAccount();
   if(current?.userId!==account.userId||current.backendBaseUrl.replace(/\/+$/,'')!==baseUrl)return;
   const response=await this.ports.transport.request({
    method:'POST',url:baseUrl+'/functions/v1/douyin-saved-playback-issues',
    headers:{Authorization:`Bearer ${account.watchDeviceToken}`,
     'X-WatchRSS-App-Version':this.ports.appVersion,'content-type':'application/json; charset=utf-8'},
    body:utf8Encode(JSON.stringify({events:batch.map(r=>r.event)})),
   });
   if(response.status<200||response.status>=300)return;
   const ids=new Set(batch.map(r=>r.event.eventId));
   // Captures can append during the request; remove only acknowledged IDs.
   this.write(this.read().filter(r=>r.userId!==account.userId||r.baseUrl!==baseUrl||!ids.has(r.event.eventId)));
  }
 }
}
