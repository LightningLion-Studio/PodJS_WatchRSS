import type {CloudSyncFailureStage} from './failure';
/** Closed categories only: never serialize errors, paths, IDs, URLs or payloads. */
export type CloudFormatFailure='none'|'busy'|'transport'|'authorization'|'conflict'|'capacity'|'storage'|'gate'|'format'|'suspended'|'server'|'timeout'|'concurrent-library-change'|'runtime'|'other';
export function cloudFormatFailure(error:unknown,status=0):CloudFormatFailure {
 const value=error&&typeof error==='object'?error as {code?:unknown;message?:unknown;status?:unknown}:{};
 const message=typeof value.message==='string'?value.message:'';
 const code=typeof value.code==='string'?value.code:'';
 const n=typeof value.status==='number'?value.status:status;
 if(/cloud_sync_suspended|cloud_operation_superseded/.test(message+' '+code))return 'suspended';
 if(['cloud_writer_busy','cloud_account_busy'].includes(code)||['cloud_writer_busy','cloud_account_busy'].includes(message)||/^account_busy(?::|$)/.test(message)||message==='Cloud lease already owned')return 'busy';
 if(code.startsWith('cloud_account_')||message==='cloud_account_expired'||message==='cloud_account_changed')return 'authorization';
 if(code==='cloud_sync_deadline_exceeded'||/cloud_sync_deadline_exceeded|\b(?:timed? ?out|deadline|SocketTimeoutException)\b/i.test(message))return 'timeout';
 if(code==='cloud_snapshot_progress_stalled'||message==='cloud_snapshot_progress_stalled')return 'runtime';
 if(code==='cloud_host_capability_unavailable'||message==='cloud_host_capability_unavailable')return 'runtime';
 if(code==='library_busy'||/Local library changed/.test(message))return 'concurrent-library-change';
 if(/setTimeout is not defined|Can't find variable: setTimeout/.test(message))return 'runtime';
 if(['secure_quota','secure_store_too_large','secure_read_failed','secure_store_corrupt'].includes(code)||['secure_quota','secure_store_too_large','secure_read_failed','secure_store_corrupt'].includes(message))return 'storage';
 if(code==='ENOSPC'||/ENOSPC|SQLITE_FULL|database or disk is full/.test(message))return 'storage';
 if(code==='r48_write_feature_disabled'||/cloud_format_(?:write|migration)_disabled/.test(message))return 'gate';
 if(n===401||n===403||/device_session_revoked/.test(code))return 'authorization';
 if(code==='library_owner_mismatch'||/^library_owner_mismatch(?::|$)/.test(message)||n===409)return 'conflict';
 if(code==='cloud_snapshot_unit_capacity'||message==='cloud_snapshot_unit_capacity')return 'capacity';
 if(n===413||n===429||/cloud_(?:format_capacity|quota_exceeded)/.test(message+' '+code))return 'capacity';
 if(n===426)return 'format';
 if(n>=500&&n<=599)return 'server';
 if(/cloud_format_|cloud_entry_ref_/.test(message))return 'format';
 if(/SQLite|SQLITE_/.test(message))return 'runtime';
 if(/^cloud_sync_(?:network)_failed$/.test(code))return 'transport';
 if(/^cloud_sync_[a-z_]+_failed$/.test(code)||/^host_(?:timer_unavailable|query_row_limit|query_bytes_limit)$/.test(code))return 'runtime';
 return 'other';
}
export interface CloudFormatHttpMetric {
 event:'format-http';operation:'capabilities'|'reserve'|'upload'|'complete';
 status:number;success:boolean;category:CloudFormatFailure;durationMillis:number;
 /** Request body submitted to transport, not a claim of bytes delivered on wire. */
 submittedBytes:number;responseBytes:number;
}
export interface CloudFormatSyncMetric {
 event:'format-sync';outcome:'complete'|'deferred'|'failed'|'superseded';
 category:CloudFormatFailure;durationMillis:number;
 cleanupCode?:string;stage?:CloudSyncFailureStage;code?:string;method?:string;recordCode?:string;recordStage?:import('./record-diagnostic').RecordFailureStage;
}

export type CloudFormatDiagnostic=CloudFormatHttpMetric|CloudFormatSyncMetric;
/** Diagnostics cannot affect account, publication or retry state. */
export function emitCloudFormat(sink:((value:string)=>void)|undefined,value:CloudFormatDiagnostic){try{sink?.(JSON.stringify(value));}catch{}}
