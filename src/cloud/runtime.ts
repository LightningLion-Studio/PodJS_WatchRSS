import {clearAccountCloud,revokeAccountCloud} from '../account/cloud-cleanup';
import {WatchAccountStore} from '../account/store';
import {WatchTokenManager} from '../account/token';
import {WatchCloudLibraryAdapter,type CloudLibraryRepository} from './library';
import {WatchCloudSyncService} from './service';
import {createCloudHostPorts,type CloudHostRequest} from './host-ports';
import {createCloudTransport} from './transport';
import {cloudDisabled,type CloudGuard} from './guard';
import {stableArticleId,type SyncTextPort} from '../sync/local-manifest';
import {watchAppVersion} from '../core/app-version';
/** Same coordinator and writer lease in foreground and verified background guest. */
export function createCloudRuntime(host:CloudHostRequest,repository:()=>Promise<CloudLibraryRepository&{deviceId():Promise<string>}>,guard:CloudGuard=cloudDisabled,accountStore?:WatchAccountStore,onChanged?:()=>void){
 const ports=createCloudHostPorts(host,guard),transport=createCloudTransport(host,guard);
 const accounts=accountStore??new WatchAccountStore({revokeCloudScope:state=>revokeAccountCloud(host,state),clearCloudScope:state=>clearAccountCloud(host,state),get:async key=>(await ports.store.get(key))??null,set:ports.store.set,remove:async key=>{await host('secure.delete',{key});}});
 const service=new WatchCloudSyncService({
  network:async()=>{guard.require();const n=await host<{active:boolean;validated:boolean;wifi:boolean;metered?:boolean}>('discovery.networkSnapshot',{});return {...n,metered:n.metered!==false};},
  hash:ports.crypto.sha256,uuid:async()=>{const b=await ports.crypto.random(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;},
  exclusive:async action=>{guard.require();if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)throw Error('云同步正在其他进程运行');try{await ports.cleanupCrypto();return await action();}finally{await host('cloud.release',{});}},
  open:async()=>{
   guard.require();const stored=await accounts.read();if(!stored)return undefined;
   const assertCurrent=async()=>{guard.require();const current=await accounts.read();if(!current||current.userId!==stored.userId||current.backendBaseUrl!==stored.backendBaseUrl)throw Error('账号已变更');};
   const tokens=new WatchTokenManager(accounts,{backendBaseUrl:stored.backendBaseUrl,transport,appVersion:watchAppVersion});
   await accounts.assertLibraryOwner(stored);
   const account=stored.watchRefreshToken?await tokens.freshAccount():stored;await assertCurrent();if(account.tokenExpiresAtMillis>0&&account.tokenExpiresAtMillis<=Date.now())throw Error("登录已过期，请从手机重新同步账号");
   const repo=await repository(),deviceId=await repo.deviceId();
   const foundation=ports.foundation(account.userId,deviceId,transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion,assertCurrent,onUnauthorized:async()=>{const current=await accounts.read();if(current?.userId===account.userId&&current.backendBaseUrl===account.backendBaseUrl)await accounts.clear(current);},
    refreshToken:async force=>{await assertCurrent();const next=account.watchRefreshToken?await tokens.freshAccount(force):await accounts.read();if(!next)throw Error('账号已解绑');await assertCurrent();return next.watchDeviceToken;}});
   const text:SyncTextPort['parseUri']=value=>host('uri.parse',{value});
   return {...foundation,userId:account.userId,deviceId,displayName:'手表 · WatchRSS',assertCurrent,assertUpload:async()=>{await assertCurrent();await accounts.assertLibraryOwner(account);},
    library:new WatchCloudLibraryAdapter({cloudSnapshot:full=>{guard.require();return repo.cloudSnapshot(full);},mergeCloud:async(...args)=>{await assertCurrent();return repo.mergeCloud(...args);}},deviceId,{...ports.crypto,stableId:url=>stableArticleId(url,text,ports.crypto)},guard)};
  },onChanged,
 },guard);
 return {service,accounts};
}
