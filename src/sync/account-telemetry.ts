import type {DiagnosticStorage} from './diagnostic-log.ts';

export interface AccountSyncTelemetry {
  recordSyncAccount():void|Promise<void>;
  backlogCount():number|Promise<number>;
}
export interface DailyTelemetrySnapshot {
  day:string; eventCounts:Record<string,number>; screenOpenCounts:Record<string,number>;
  screenDurationMs:Record<string,number>; appForegroundMs:number; syncSuccessCount:number; syncFailureCount:number;
}
export type UsageEvent='app_opened'|'release_oobe_opened'|'screen_opened'|'screen_duration'|'sync_received'|'feed_refreshed'|'article_read_started'|'article_read_finished'|'video_played'|'sync_account';
const KEY='watchrss.sync.account-telemetry.v1';
const DAY=86_400_000;
const empty=(day:string):DailyTelemetrySnapshot=>({day,eventCounts:{},screenOpenCounts:{},screenDurationMs:{},appForegroundMs:0,syncSuccessCount:0,syncFailureCount:0});
const counts=(value:Record<string,number>={})=>Object.fromEntries(Object.entries(value).map(([key,n])=>[key,Math.max(0,Number(n)||0)]));
/** Native daily cumulative rollups. Reuses M2's key and upgrades old rows on read.
 * Uploaded days remain in the backlog. Pruning happens only on capture. */
export class SyncAccountTelemetry implements AccountSyncTelemetry {
  constructor(protected readonly storage:DiagnosticStorage,private readonly now:()=>number=Date.now){}
  snapshots():DailyTelemetrySnapshot[] {
    try{return (JSON.parse(this.storage.get(KEY)??'[]') as DailyTelemetrySnapshot[])
      .filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.day)&&Number.isFinite(Date.parse(row.day)))
      .map(row=>({...empty(row.day),eventCounts:counts(row.eventCounts),screenOpenCounts:counts(row.screenOpenCounts),screenDurationMs:counts(row.screenDurationMs),appForegroundMs:Number(row.appForegroundMs)||0,syncSuccessCount:Number(row.syncSuccessCount)||0,syncFailureCount:Number(row.syncFailureCount)||0}))
      .sort((a,b)=>a.day.localeCompare(b.day));}catch{return [];}
  }
  record(event:UsageEvent,properties:{screen?:string;durationMs?:number}={}):void {
    const shifted=this.now()+8*60*60*1000;
    const day=new Date(shifted).toISOString().slice(0,10);
    const oldest=new Date(shifted-6*DAY).toISOString().slice(0,10);
    const snapshots=this.snapshots().filter(row=>row.day>=oldest);
    let today=snapshots.find(row=>row.day===day);
    if(!today){today=empty(day);snapshots.push(today);}
    const increment=(map:Record<string,number>,key:string,n=1)=>{Object.defineProperty(map,key,{value:(Object.hasOwn(map,key)?map[key]:0)+n,enumerable:true,writable:true,configurable:true});};
    increment(today.eventCounts,event);
    const screen=properties.screen, duration=Math.max(0,Math.trunc(properties.durationMs??0))||0;
    if(event==='screen_opened'&&screen?.trim())increment(today.screenOpenCounts,screen);
    if(event==='screen_duration'){
      if(screen?.trim()&&duration>0)increment(today.screenDurationMs,screen,duration);
      today.appForegroundMs+=duration;
    }
    if(event==='sync_received'||event==='sync_account')today.syncSuccessCount++;
    this.storage.set(KEY,JSON.stringify(snapshots.sort((a,b)=>a.day.localeCompare(b.day))));
  }
  recordSyncAccount():void {this.record('sync_account');}
  backlogCount():number{return this.snapshots().length;}
}
