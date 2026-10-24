import { WatchAccountStore } from './store';
import type { WatchAccountState, AccountClientOptions } from './types';
import { utf8Encode, utf8Decode } from '../cloud/types';

export class WatchLoginExpiredError extends Error { constructor(){super('登录已过期，请用手机重新同步账号');} }
class WatchTokenRefreshError extends Error {
  constructor(readonly status:number){super(`手表令牌刷新失败：HTTP ${status}`);}
}
/** Stateless refresh also used under the logout lock: never saves a session or recursively clears it. */
export async function refreshWatchAccount(state:WatchAccountState,options:AccountClientOptions,now:()=>number=Date.now):Promise<WatchAccountState>{
  if(!state.watchRefreshToken||(state.refreshTokenExpiresAtMillis>0&&state.refreshTokenExpiresAtMillis<=now()))throw new WatchLoginExpiredError();
  const r=await options.transport.request({method:'POST',url:options.backendBaseUrl.replace(/\/$/,'')+'/functions/v1/account/watch-token/refresh',headers:{accept:'application/json','content-type':'application/json; charset=utf-8',...(options.appVersion?{'X-WatchRSS-App-Version':options.appVersion}:{})},body:utf8Encode(JSON.stringify({refreshToken:state.watchRefreshToken}))});
  if(r.status<200||r.status>=300)throw new WatchTokenRefreshError(r.status);
  const j=JSON.parse(utf8Decode(r.body));
  if(typeof j.watchAccessToken!=='string'||!j.watchAccessToken||typeof j.watchRefreshToken!=='string'||!j.watchRefreshToken)throw Error('无效手表令牌刷新响应');
  return {...state,watchDeviceToken:j.watchAccessToken,tokenExpiresAtMillis:Number(j.accessTokenExpiresAt),watchRefreshToken:j.watchRefreshToken,refreshTokenExpiresAtMillis:Number(j.refreshTokenExpiresAt),entitlement:{plan:j.entitlement?.plan||'free',active:j.entitlement?.active===true,expiresAtMillis:Number(j.entitlement?.expiresAt||0),features:Array.isArray(j.entitlement?.features)?j.entitlement.features.map(String):[]},updatedAtMillis:now()};
}

export class WatchTokenManager {
  constructor(private readonly store:WatchAccountStore,private readonly options:AccountClientOptions,private readonly now:()=>number=()=>Date.now()){}
  async freshAccessToken(forceRefresh=false,rejectedAccessToken?:string):Promise<string>{return(await this.freshAccount(forceRefresh,rejectedAccessToken)).watchDeviceToken;}
  async freshAccount(forceRefresh=false,rejectedAccessToken?:string):Promise<WatchAccountState>{
    const state=await this.store.read();if(!state)throw Error('手表尚未绑定腕上RSS账号');
    if(rejectedAccessToken&&rejectedAccessToken!==state.watchDeviceToken)forceRefresh=false;
    if(!forceRefresh&&state.tokenExpiresAtMillis>this.now()+60000)return state;
    if(!state.watchRefreshToken||(state.refreshTokenExpiresAtMillis>0&&state.refreshTokenExpiresAtMillis<=this.now()))throw new WatchLoginExpiredError();
    return this.refresh(state);
  }
  async logout():Promise<void>{await this.store.clear();}
  private async refresh(state:WatchAccountState):Promise<WatchAccountState>{
    try{return await this.store.refresh(state,current=>refreshWatchAccount(current,this.options,this.now),error=>error instanceof WatchTokenRefreshError&&error.status===401);}
    catch(error){
      const current=await this.store.read();
      // A newer committed pair wins over an old request's rejection.
      if(current?.userId===state.userId&&current.backendBaseUrl===state.backendBaseUrl&&current.watchRefreshToken!==state.watchRefreshToken)return current;
      throw error;
    }
  }
}
