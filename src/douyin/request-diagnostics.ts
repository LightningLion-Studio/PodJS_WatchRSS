import {benchmark,type BenchmarkFields} from '@podjs/framework/benchmark';
/** Unknown HTTP = 0; absent/unreadable API status = -1. No arbitrary input is copied. */
export function douyinRequestDiagnostic(value:Required<Pick<BenchmarkFields,'category'|'http_status'|'douyin_status_code'|'challenge'|'signing_ok'|'cookie_present'|'retry_after_ms'|'error_code'>>&Pick<BenchmarkFields,'request_queue_ms'|'request_sign_ms'|'request_transport_ms'|'request_text_ms'|'request_status_ms'|'response_bytes'>) {
 const timing:BenchmarkFields={};
 for(const key of ['request_queue_ms', 'request_sign_ms', 'request_transport_ms', 'request_text_ms', 'request_status_ms', 'response_bytes'] as const){const n=value[key];if(Number.isSafeInteger(n)&&n!>=0&&n!<=(key==='response_bytes'?67108864:600000))timing[key]=n;}
 return benchmark.begin('douyin_request',{...timing,category:value.category,http_status:value.http_status,douyin_status_code:value.douyin_status_code,challenge:value.challenge,signing_ok:value.signing_ok,cookie_present:value.cookie_present,retry_after_ms:value.retry_after_ms,error_code:value.error_code});
}
export function douyinRetryAfter(headers:Record<string,string>,now=Date.now()):number {
 const raw=Object.entries(headers).find(([key])=>key.toLowerCase()==='retry-after')?.[1];if(!raw)return 0;
 const value=/^\d+$/.test(raw.trim())?Number(raw)*1000:Date.parse(raw)-now;
 return Number.isSafeInteger(value)&&value>0?value:0;
}
