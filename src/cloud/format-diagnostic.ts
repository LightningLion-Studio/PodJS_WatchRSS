/** Closed categories only: never serialize errors, paths, IDs, URLs or payloads. */
export type CloudFormatFailure='none'|'transport'|'authorization'|'conflict'|'capacity'|'storage'|'gate'|'format'|'suspended'|'server'|'timeout'|'concurrent-library-change'|'runtime'|'other';
export function cloudFormatFailure(error:unknown,status=0):CloudFormatFailure {
 const value=error&&typeof error==='object'?error as {code?:unknown;message?:unknown;status?:unknown}:{};
 const message=typeof value.message==='string'?value.message:'';
 const code=typeof value.code==='string'?value.code:'';
 const n=typeof value.status==='number'?value.status:status;
 if(code==='cloud_sync_deadline_exceeded'||/cloud_sync_deadline_exceeded|\b(?:timed? ?out|deadline|SocketTimeoutException)\b/i.test(message))return 'timeout';
 if(code==='library_busy'||/Local library changed/.test(message))return 'concurrent-library-change';
 if(/setTimeout is not defined|Can't find variable: setTimeout/.test(message))return 'runtime';
 if(code==='ENOSPC'||/ENOSPC|SQLITE_FULL|database or disk is full/.test(message))return 'storage';
 if(/cloud_sync_suspended|cloud_operation_superseded/.test(message))return 'suspended';
 if(code==='r48_write_feature_disabled'||/cloud_format_(?:write|migration)_disabled/.test(message))return 'gate';
 if(n===401||n===403||/device_session_revoked/.test(code))return 'authorization';
 if(n===409)return 'conflict';
 if(n===413||n===429||/cloud_(?:format_capacity|quota_exceeded)/.test(message+' '+code))return 'capacity';
 if(n>=500&&n<=599)return 'server';
 if(/cloud_format_|cloud_entry_ref_/.test(message))return 'format';
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
 code?:string;recordCode?:string;recordStage?:import('./record-diagnostic').RecordFailureStage;
}

export type CloudFormatDiagnostic=CloudFormatHttpMetric|CloudFormatSyncMetric;
/** Diagnostics cannot affect account, publication or retry state. */
export function emitCloudFormat(sink:((value:string)=>void)|undefined,value:CloudFormatDiagnostic){try{sink?.(JSON.stringify(value));}catch{}}
