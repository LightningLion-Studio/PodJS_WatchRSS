import {phoneNotice} from './phone-notice';
import { WatchAccountStore } from './store';
import type { WatchAccountState, AccountClientOptions } from './types';
import {httpFailedBeforeSend} from '../cloud/transport';
import { utf8Encode, utf8Decode } from '../cloud/types';

// The server keeps only the immediate parent's unused response for 30 seconds.
const REFRESH_RECOVERY_WINDOW_MS=20_000;
const REFRESH_CALL_TIMEOUT_MS=10_000;
// Let a connect timeout surface before the host's unclassified call deadline.
const REFRESH_CONNECT_TIMEOUT_MS=8_000;
const WATCH_RELOGIN_MESSAGE='需要重新登录，请用手机重新同步账号';
export class WatchLoginExpiredError extends Error { constructor(message='登录已过期，请用手机重新同步账号'){super(message);} }
class WatchTokenRefreshError extends Error {
  constructor(readonly status:number){super(`手表令牌刷新失败：HTTP ${status}`);}
}
/** Stateless refresh also used under the logout lock: never saves a session or recursively clears it. */
export async function refreshWatchAccount(state:WatchAccountState,options:AccountClientOptions,now:()=>number=Date.now,beforeDispatch?:()=>void):Promise<WatchAccountState>{
  if(state.needsRelogin)throw new WatchLoginExpiredError(WATCH_RELOGIN_MESSAGE);
  if(!state.watchRefreshToken||(state.refreshTokenExpiresAtMillis>0&&state.refreshTokenExpiresAtMillis<=now()))throw new WatchLoginExpiredError();
  const r=await options.transport.request({method:'POST',url:options.backendBaseUrl.replace(/\/$/,'')+'/functions/v1/account/watch-token/refresh',headers:{accept:'application/json','content-type':'application/json; charset=utf-8',...(options.appVersion?{'X-WatchRSS-App-Version':options.appVersion}:{})},body:utf8Encode(JSON.stringify({refreshToken:state.watchRefreshToken})),...(beforeDispatch?{beforeDispatch,callTimeoutMs:REFRESH_CALL_TIMEOUT_MS,timeoutMs:REFRESH_CONNECT_TIMEOUT_MS}:{})});
  if(r.status<200||r.status>=300)throw new WatchTokenRefreshError(r.status);
  const j=JSON.parse(utf8Decode(r.body));
  if(typeof j.watchAccessToken!=='string'||!j.watchAccessToken||typeof j.watchRefreshToken!=='string'||!j.watchRefreshToken)throw Error('无效手表令牌刷新响应');
  return {...state,phoneMasked:typeof j.phoneMasked==='string'&&j.phoneMasked.includes('*')?j.phoneMasked:state.phoneMasked,watchDeviceToken:j.watchAccessToken,tokenExpiresAtMillis:Number(j.accessTokenExpiresAt),watchRefreshToken:j.watchRefreshToken,refreshTokenExpiresAtMillis:Number(j.refreshTokenExpiresAt),entitlement:{plan:j.entitlement?.plan||'free',active:j.entitlement?.active===true,expiresAtMillis:Number(j.entitlement?.expiresAt||0),features:Array.isArray(j.entitlement?.features)?j.entitlement.features.map(String):[]},updatedAtMillis:now()};
}

export class WatchTokenManager {
  constructor(private readonly store:WatchAccountStore,private readonly options:AccountClientOptions,private readonly now:()=>number=()=>Date.now()){}
  async freshAccessToken(forceRefresh=false,rejectedAccessToken?:string):Promise<string>{return(await this.freshAccount(forceRefresh,rejectedAccessToken)).watchDeviceToken;}
  async freshAccount(forceRefresh=false,rejectedAccessToken?:string):Promise<WatchAccountState>{
    const state=await this.store.read();if(!state)throw Error('手表尚未绑定腕上RSS账号');
    if(rejectedAccessToken&&rejectedAccessToken!==state.watchDeviceToken)forceRefresh=false;
    if(!state.needsRelogin&&!forceRefresh&&state.tokenExpiresAtMillis>this.now()+60000)return state;
    if(!state.needsRelogin&&(!state.watchRefreshToken||(state.refreshTokenExpiresAtMillis>0&&state.refreshTokenExpiresAtMillis<=this.now())))throw new WatchLoginExpiredError();
    return this.refreshAccount(state);
  }
  private requestProfile(state:WatchAccountState,beforeDispatch?:()=>void){
    return this.options.transport.request({method:'GET',url:this.options.backendBaseUrl.replace(/\/$/,'')+'/functions/v1/account/profile',headers:{accept:'application/json',authorization:'Bearer '+state.watchDeviceToken},beforeDispatch});
  }
  async refreshProfile():Promise<WatchAccountSafetyProfile>{
    const state=await this.freshAccount();
    const r=await this.requestProfile(state);
    if(r.status===401)throw new WatchLoginExpiredError();
    if(r.status<200||r.status>=300)throw Error('账号信息刷新失败');
    const data=JSON.parse(utf8Decode(r.body));if(data.userId!==state.userId||typeof data.phoneMasked!=='string'||!data.phoneMasked.includes('*'))throw Error('账号信息响应无效');
    const current=await this.store.read();if(!current||current.userId!==state.userId||current.backendBaseUrl!==state.backendBaseUrl||current.watchRefreshToken!==state.watchRefreshToken)throw Error('账号已变更，请重试');
    if(data.phoneMasked!==current.phoneMasked)await this.store.save({...current,phoneMasked:data.phoneMasked},current);
    return {userId:state.userId,phoneMasked:data.phoneMasked,pendingPhoneChange:phoneNotice(data.pendingPhoneChange)};
  }
  async cancelPhoneAppeal(id:string):Promise<WatchAccountSafetyProfile>{
    if(!/^[A-Za-z0-9-]{1,128}$/.test(id))throw Error('换绑请求无效');const state=await this.freshAccount();
    const r=await this.options.transport.request({method:'POST',url:this.options.backendBaseUrl.replace(/\/$/,'')+'/functions/v1/account/phone/appeals/'+id+'/cancel',headers:{authorization:'Bearer '+state.watchDeviceToken,'content-type':'application/json'},body:utf8Encode('{}')});
    if(r.status<200||r.status>=300||JSON.parse(utf8Decode(r.body)).status!=='cancelled')throw Error('取消尚未确认，请刷新核对');
    const current=await this.store.read();if(!current||current.userId!==state.userId||current.backendBaseUrl!==state.backendBaseUrl)throw Error('账号已变更，请重试');return this.refreshProfile();
  }
  async logout():Promise<void>{await this.store.clear();}
  /** Rotate a captured token pair or reuse the newer pair committed under the account lease. */
  async refreshAccount(state:WatchAccountState,poll?:{beforeDispatch():void}):Promise<WatchAccountState>{
    try{return await this.store.refresh(state,async(current,attempt)=>{
      poll?.beforeDispatch();
      const recovering=attempt.startedAt!==undefined;
      const startedAt=attempt.startedAt??this.now();
      const windowOpen=()=>{
        const elapsed=this.now()-startedAt;
        return elapsed>=0&&elapsed<REFRESH_RECOVERY_WINDOW_MS;
      };
      const relogin=async()=>{
        await attempt.requireRelogin();
        throw new WatchLoginExpiredError(WATCH_RELOGIN_MESSAGE);
      };
      if(current.needsRelogin){
        // Old builds also set this flag for TLS failures. Authentication with
        // the current access token proves the server has not rotated this pair.
        if(current.tokenExpiresAtMillis>0&&current.tokenExpiresAtMillis<=this.now())return relogin();
        const profile=await this.requestProfile(current,poll?.beforeDispatch);
        if(profile.status<200||profile.status>=300||JSON.parse(utf8Decode(profile.body))?.userId!==current.userId)return relogin();
        await attempt.clear();
        const {needsRelogin,...verified}=current;
        return verified;
      }
      if(recovering&&!windowOpen())return relogin();
      // Write ahead of dispatch so a killed guest cannot lose a possible
      // rotation. A confirmed pre-send failure removes its own marker.
      if(!recovering)await attempt.record(startedAt);

      let dispatched=false;
      const rotate=()=>refreshWatchAccount(current,this.options,this.now,()=>{
        poll?.beforeDispatch();
        if(!windowOpen())throw Error('refresh_dispatch_window_closed');
        dispatched=true;
      });
      const ambiguous=(error:unknown)=>{
        if(!dispatched)return false;
        // A gateway can replace the receipt after the upstream commits the
        // rotation. Direct 503 maintenance retains ordinary backoff.
        if(error instanceof WatchTokenRefreshError)return [408,500,502,504].includes(error.status);
        return !httpFailedBeforeSend(error);
      };
      try{return await rotate();}
      catch(error){
        if(error instanceof WatchTokenRefreshError&&error.status===401)throw error;
        if(!recovering&&!ambiguous(error)){
          await attempt.clear();
          throw error;
        }
        if(!windowOpen())return relogin();
        if(recovering)throw error;
      }

      try{return await rotate();}
      catch(error){
        if(error instanceof WatchTokenRefreshError&&error.status===401)throw error;
        if(!windowOpen())return relogin();
        throw error;
      }
    },error=>error instanceof WatchTokenRefreshError&&error.status===401);}
    catch(error){
      const current=await this.store.read();
      // A newer committed pair wins over an old request's rejection.
      if(current?.userId===state.userId&&current.backendBaseUrl===state.backendBaseUrl&&current.installId===state.installId&&current.watchRefreshToken!==state.watchRefreshToken)return current;
      throw error;
    }
  }
}

export interface WatchAccountSafetyProfile {userId:string;phoneMasked:string;pendingPhoneChange:import("./phone-notice").PendingPhoneChange|null;}
