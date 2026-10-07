import {DailyCounterStore} from '@podjs/framework/telemetry';
import type {DiagnosticStorage} from './diagnostic-log.ts';
export type {DailyTelemetrySnapshot} from '@podjs/framework/telemetry';
export interface AccountSyncTelemetry {recordSyncAccount():void|Promise<void>;backlogCount():number|Promise<number>}
export type UsageEvent='app_opened'|'release_oobe_opened'|'screen_opened'|'screen_duration'|'sync_received'|'feed_refreshed'|'article_read_started'|'article_read_finished'|'video_played'|'sync_account';
/** Keep the existing M2 storage key and native cumulative rollup policy. */
export class SyncAccountTelemetry extends DailyCounterStore implements AccountSyncTelemetry {
  constructor(storage:DiagnosticStorage,now:()=>number=Date.now){super(storage,{key:'watchrss.sync.account-telemetry.v1',utcOffsetMinutes:480,retentionDays:7,successEvents:['sync_received','sync_account']},now);}
  recordSyncAccount(){this.record('sync_account');}
}
