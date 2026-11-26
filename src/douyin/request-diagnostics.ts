import {benchmark,type BenchmarkFields} from '@podjs/framework/benchmark';
import {appLogger} from '../logs/app-logger.ts';
import {isMediaDecodeMemoryPressure,type MediaDecodeProgress} from '../media/text.ts';

/** Inspect framing only. Inspect at most 256 padding bytes at each end. */
function bodyShape(bytes:Uint8Array){
 const at=(i:number)=>bytes[i]??-1,space=(b:number)=>b===32||b===9||b===10||b===13;
 if(at(0)===31&&at(1)===139)return 'gzip';
 if(at(0)===255&&at(1)===254||at(0)===254&&at(1)===255)return 'utf16';
 let start=at(0)===239&&at(1)===187&&at(2)===191?3:0;
 let end=bytes.length-1;
 for(let n=0;n<256&&space(at(start));n++)start++;
 for(let n=0;n<256&&space(at(end));n++)end--;
 if(start>end)return 'empty';
 if(at(start)===123)return at(end)===125?'json_object':'open_object';
 if(at(start)===91)return at(end)===93?'json_array':'open_array';
 return at(start)===60?'markup':'other';
}

export function decodeDiagnostic(bytes:Uint8Array,progress:MediaDecodeProgress,step:MediaDecodeProgress['step'],error:unknown){
 const e=error as {code?:unknown;message?:unknown;name?:unknown}|null;
 const reason=progress.recovered||isMediaDecodeMemoryPressure(error)?'memory':e?.code==='busy'?'busy':e?.code==='invalid_bytes'?'invalid_bytes':e?.code==='cancelled'||e?.name==='AbortError'?'cancelled':'other';
 if(progress.recovered)return {decode_step:step,decode_reason:reason,decode_recovered:true};
 return {decode_step:step,decode_reason:reason,body_shape:bodyShape(bytes),decode_offset:progress.offset,decode_portable:progress.portable};
}

/** Unknown HTTP = 0; absent/unreadable API status = -1. No arbitrary input is copied. */
export function douyinRequestDiagnostic(value:Required<Pick<BenchmarkFields,'category'|'http_status'|'douyin_status_code'|'challenge'|'signing_ok'|'cookie_present'|'retry_after_ms'|'error_code'>>&Pick<BenchmarkFields,'request_queue_ms'|'request_sign_ms'|'request_transport_ms'|'request_text_ms'|'request_status_ms'|'response_bytes'>,decode?:ReturnType<typeof decodeDiagnostic>) {
 const timing:BenchmarkFields={};
 for(const key of ['request_queue_ms', 'request_sign_ms', 'request_transport_ms', 'request_text_ms', 'request_status_ms', 'response_bytes'] as const){const n=value[key];if(Number.isSafeInteger(n)&&n!>=0&&n!<=(key==='response_bytes'?67108864:600000))timing[key]=n;}
 // The locked host benchmark only accepts its registered fields.
 if(decode)appLogger.i('DouyinDecode',JSON.stringify({category:value.category,...decode}));
 return benchmark.begin('douyin_request',{...timing,category:value.category,http_status:value.http_status,douyin_status_code:value.douyin_status_code,challenge:value.challenge,signing_ok:value.signing_ok,cookie_present:value.cookie_present,retry_after_ms:value.retry_after_ms,error_code:value.error_code});
}
export function douyinRetryAfter(headers:Record<string,string>,now=Date.now()):number {
 const raw=Object.entries(headers).find(([key])=>key.toLowerCase()==='retry-after')?.[1];if(!raw)return 0;
 const value=/^\d+$/.test(raw.trim())?Number(raw)*1000:Date.parse(raw)-now;
 return Number.isSafeInteger(value)&&value>0?value:0;
}
