import type {DiagnosticStorage} from './diagnostic-log.ts';

export interface AccountSyncTelemetry {
  recordSyncAccount():void|Promise<void>;
  backlogCount():number|Promise<number>;
}
interface DailyAccountSnapshot {day:string;eventCounts:{sync_account:number};syncSuccessCount:number}
const KEY='watchrss.sync.account-telemetry.v1';
const DAY=86_400_000;

/** The sync_account subset of native DailyTelemetryStore. No credentials or identities.
 * Backlog counts retained days, including uploaded days, not events or pending requests.
 * Global usage capture and telemetry-rollup uploads are separate from this store.
 */
export class SyncAccountTelemetry implements AccountSyncTelemetry {
  constructor(private readonly storage:DiagnosticStorage,private readonly now:()=>number=Date.now){}
  private read():DailyAccountSnapshot[] {
    const raw=this.storage.get(KEY);
    if(!raw)return [];
    return JSON.parse(raw) as DailyAccountSnapshot[];
  }
  recordSyncAccount():void {
    // Asia/Shanghai is UTC+08:00; account telemetry dates have no DST.
    const shifted=this.now()+8*60*60*1000;
    const day=new Date(shifted).toISOString().slice(0,10);
    const oldest=new Date(shifted-6*DAY).toISOString().slice(0,10);
    const snapshots=this.read().filter(row=>row.day>=oldest);
    let today=snapshots.find(row=>row.day===day);
    if(!today){today={day,eventCounts:{sync_account:0},syncSuccessCount:0};snapshots.push(today);}
    today.eventCounts.sync_account++;today.syncSuccessCount++;
    this.storage.set(KEY,JSON.stringify(snapshots.sort((a,b)=>a.day.localeCompare(b.day))));
  }
  backlogCount():number{return this.read().length;}
}
