import {recordFailureDiagnostic} from './record-diagnostic';
/** Closed stage names only. The original exception stays in-process as cause;
 * diagnostics serialize only the code, stage, name and HTTP status. */
const stages=['guard','lease_acquire','cleanup','lease_release','network','session_open','account_read','account_current','owner','token','repository','bootstrap','content','device','keys','checkpoint','run'] as const;
export type CloudSyncFailureStage=typeof stages[number];
export function cloudFailureStage(error:unknown,fallback:CloudSyncFailureStage):CloudSyncFailureStage{const stage=(error as {stage?:unknown})?.stage;return stages.includes(stage as CloudSyncFailureStage)?stage as CloudSyncFailureStage:fallback;}
export function cloudSyncFailure(error:unknown,stage:CloudSyncFailureStage):unknown {
 if(JSON.parse(recordFailureDiagnostic(error)).code!=='unclassified')return error;
 const value=error&&typeof error==='object'?error as {message?:unknown;status?:unknown;cleanupCode?:unknown}:{};
 const result=Object.assign(new Error(typeof value.message==='string'?value.message:'cloud_sync_'+stage+'_failed',{cause:error}),{code:'cloud_sync_'+stage+'_failed',stage});
 if(typeof value.status==='number')Object.assign(result,{status:value.status});
 if(typeof value.cleanupCode==='string')Object.assign(result,{cleanupCode:value.cleanupCode});
 return result;
}
export async function cloudStage<T>(stage:CloudSyncFailureStage,action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){throw cloudSyncFailure(error,stage);}}

/** Preserve both failures without letting a release error replace ownership,
 * authorization or deadline. No exception text enters the cleanup diagnostic. */
export function cloudCleanupFailure(primary:unknown,cleanup:unknown){
 const value=primary&&typeof primary==='object'?primary as {message?:unknown;status?:unknown}:{};
 const diagnostic=JSON.parse(recordFailureDiagnostic(primary));
 return Object.assign(new Error(typeof value.message==='string'?value.message:'cloud_sync_failed',{cause:primary}),{code:diagnostic.code,...(diagnostic.method?{method:diagnostic.method}:{}),cleanupCode:JSON.parse(recordFailureDiagnostic(cleanup)).code,stage:cloudFailureStage(primary,'run'),...(typeof value.status==='number'?{status:value.status}:{})});
}
