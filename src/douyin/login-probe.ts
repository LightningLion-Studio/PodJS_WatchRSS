import {douyinRequestDiagnostic,douyinRetryAfter} from './request-diagnostics.ts';
import {isDouyinHtmlChallenge} from './parser.ts';
import {mediaRequestFailure} from './errors.ts';
import type {HttpTransport} from '../cloud/types.ts';
import {decodeMediaText} from '../media/text.ts';
import type {Douyin403Options,DouyinLoginProbeResult} from './auth403.ts';
import {douyinRequestProfile,resolveDouyinRequestConfig,type DouyinRequestConfigSource} from './request-config.ts';
import {ABogusSigner} from './signing.ts';
import type {DouyinSigner} from './types.ts';
import {readDouyinStatusCode} from './parser.ts';

export const DOUYIN_LOGIN_PROBE_PATH='/aweme/v1/web/notice/count/';
/** Verified notice/count contract: only HTTP 200 + numeric 0/8 is definitive.
 * No recursive get(), retry, logout or cooldown here; the generation policy owns them. */
export function createDouyinLoginProbe(ports:{transport:HttpTransport;signer?:DouyinSigner;requestConfig?:DouyinRequestConfigSource}):NonNullable<Douyin403Options['probe']> {
  const signer=ports.signer??new ABogusSigner();
  return ({cookie,timeoutMs})=>{
    let cancelled=false;
    const result=(async():Promise<DouyinLoginProbeResult>=>{
      const observed:Parameters<typeof douyinRequestDiagnostic>[0]={category:'auth_probe',http_status:0,douyin_status_code:-1,challenge:false,signing_ok:false,cookie_present:!!cookie,retry_after_ms:0,error_code:'signing'};
      try{
        const config=await resolveDouyinRequestConfig(ports.requestConfig),profile=douyinRequestProfile(config);
        const params={...profile.params,is_new_notice:config.isNewNotice??'1',need_social_count:config.needSocialCount??'1'};
        if(cancelled)return 'unknown';
        const signature=await signer.sign({...params});observed.signing_ok=true;if(cancelled)return 'unknown';
        const query=Object.entries({...params,a_bogus:signature}).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const response=await ports.transport.request({method:'GET',url:`https://www.douyin.com${DOUYIN_LOGIN_PROBE_PATH}?${query}`,headers:{...profile.headers,Cookie:cookie,Accept:'application/json'},timeoutMs:Math.min(5000,timeoutMs),readTimeoutMs:Math.min(5000,timeoutMs),acceptHttpErrors:true});
        observed.http_status=response.status;observed.retry_after_ms=douyinRetryAfter(response.headers);
        const body=await decodeMediaText(response.body);observed.challenge=isDouyinHtmlChallenge(body);
        const code=await readDouyinStatusCode(body);observed.douyin_status_code=code??-1;
        observed.error_code=cancelled?'cancelled':observed.challenge?'challenge':response.status===403?'forbidden':response.status!==200?'http':!body.trim()?'empty':body==='blocked'?'blocked':code===0?'success':'api_status';
        if(cancelled||response.status!==200)return 'unknown';
        return cancelled?'unknown':code===0?'authenticated':code===8?'unauthenticated':'unknown';
      }catch(error){observed.error_code=cancelled?'cancelled':!observed.signing_ok?'signing':mediaRequestFailure(error).category;observed.http_status=mediaRequestFailure(error).status??observed.http_status;return 'unknown';}
      finally{if(cancelled)observed.error_code='cancelled';douyinRequestDiagnostic(observed);}
    })();
    return {result,cancel(){cancelled=true;}};
  };
}
