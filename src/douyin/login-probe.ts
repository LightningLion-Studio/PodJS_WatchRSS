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
      try{
        const config=await resolveDouyinRequestConfig(ports.requestConfig),profile=douyinRequestProfile(config);
        const params={...profile.params,is_new_notice:config.isNewNotice??'1',need_social_count:config.needSocialCount??'1'};
        if(cancelled)return 'unknown';
        const signature=await signer.sign({...params});if(cancelled)return 'unknown';
        const query=Object.entries({...params,a_bogus:signature}).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const response=await ports.transport.request({method:'GET',url:`https://www.douyin.com${DOUYIN_LOGIN_PROBE_PATH}?${query}`,headers:{...profile.headers,Cookie:cookie,Accept:'application/json'},timeoutMs:Math.min(5000,timeoutMs),readTimeoutMs:Math.min(5000,timeoutMs),acceptHttpErrors:true});
        if(cancelled||response.status!==200)return 'unknown';
        const code=await readDouyinStatusCode(await decodeMediaText(response.body));
        return cancelled?'unknown':code===0?'authenticated':code===8?'unauthenticated':'unknown';
      }catch{return 'unknown';}
    })();
    return {result,cancel(){cancelled=true;}};
  };
}
