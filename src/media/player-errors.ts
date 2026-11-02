import type {BenchmarkFields,FailureCode,FailureStage} from '@podjs/framework/benchmark';
/** Inspect messages only inside this boundary; output is a fixed enum, never text. */
export function playerFailureCode(error:unknown):FailureCode{
 const e=error as {code?:unknown;message?:unknown;name?:unknown}|null,code=String(e?.code??''),text=String(e?.message??'');
 if(/cancel|abort/i.test(code+' '+text))return 'cancelled';
 if(/stale video session/i.test(text))return 'stale';
 if(text==='old_media_cache_cleanup_failed')return 'cache_error';
 if(/^Invalid Douyin (snapshot|playback item)$|^Missing Douyin playback item$/.test(text))return 'storage_error';
 if(/unknown_video_session/.test(text))return 'session_missing';
 if(/video_not_(ready|prewarmed)/.test(text))return 'not_ready';
 if(/video_surface/.test(text))return 'surface_error';
 if(/session_limit|decoder_limit|resource_exhausted|OutOfMemory/.test(code+' '+text))return 'resource_exhausted';
 if(/playback_recovery_exhausted/.test(text))return 'recovery_exhausted';
 const allowed:FailureCode[]=['decode_error','decoder_init','format_error','surface_error','invalid_argument','permission_denied','not_ready','timeout','network_error','cdn_error','restricted','source_expired','prepare_failed','video_session_error','video_error','cache_error','storage_error','service_closed','host_error'];
 return allowed.includes(code as FailureCode)?code as FailureCode:'unknown';
}
export function playerFailureFields(error:unknown,stage:FailureStage):BenchmarkFields{
 const e=error as {name?:unknown}|null,name=String(e?.name??'');
 return {failure_origin:'guest',failure_stage:stage,failure_code:playerFailureCode(error),exception_kind:name==='HostServiceError'?'host_service':name==='TypeError'||name==='RangeError'?'illegal_argument':error instanceof Error?'error':'unknown'};
}
export function formatPlayerFailure(code:FailureCode):string{
 if(code==='network_error'||code==='cdn_error')return '网络连接失败，请检查网络后重试';
 if(code==='decode_error'||code==='decoder_init'||code==='format_error')return '视频解码失败，请重试';
 if(code==='resource_exhausted')return '播放器资源不足，请重试';
 if(code==='surface_error')return '视频画面创建失败，请重试';
 if(code==='timeout')return '播放器准备超时，请重试';
 return '视频播放失败，请重试';
}
/** State is diagnostic only; unknown host states never become free text. */
export function closedPlayerState(value:unknown):NonNullable<BenchmarkFields['player_state']>{
 const states=['idle','preparing','buffering','ready','playing','paused','ended','stopped','error','unknown'];
 return typeof value==='string'&&states.includes(value)?value as NonNullable<BenchmarkFields['player_state']>:'unknown';
}
