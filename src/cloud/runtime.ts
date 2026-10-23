import {withAccountLease} from '../account/lease';
import {WatchCloudRecords} from './records';
import {clearAccountCloud,revokeAccountCloud} from '../account/cloud-cleanup';
import {WatchAccountStore} from '../account/store';
import {WatchTokenManager} from '../account/token';
import {WatchCloudLibraryAdapter,type CloudLibraryRepository} from './library';
import {CloudApprovalController} from './approval-controller';
import {createCloudAuthorization} from './authorization';
import {WatchCloudSyncService} from './service';
import {createCloudHostPorts,type CloudHostRequest} from './host-ports';
import {createCloudTransport} from './transport';
import {cloudDisabled,type CloudGuard} from './guard';
import {legacyWebArticleId} from './rss-identity';
import {watchAppVersion} from '../core/app-version';
/** Same coordinator and writer lease in foreground and verified background guest. */
export function createCloudRuntime(host:CloudHostRequest,repository:()=>Promise<CloudLibraryRepository&{deviceId():Promise<string>}>,guard:CloudGuard=cloudDisabled,accountStore?:WatchAccountStore,onChanged?:()=>void){
 const ports=createCloudHostPorts(host,guard),transport=createCloudTransport(host,guard);
 const accounts=accountStore??new WatchAccountStore({exclusive:action=>withAccountLease(host,action),revokeCloudScope:state=>revokeAccountCloud(host,state),clearCloudScope:state=>clearAccountCloud(host,state),get:async key=>(await ports.store.get(key))??null,set:ports.store.set,remove:async key=>{await host('secure.delete',{key});}});
 const openSession=async()=>{
   guard.require();const stored=await accounts.read();if(!stored)return undefined;
   const assertCurrent=async()=>{guard.require();const current=await accounts.read();if(!current||current.userId!==stored.userId||current.backendBaseUrl!==stored.backendBaseUrl)throw Error('账号已变更');};
   const tokens=new WatchTokenManager(accounts,{backendBaseUrl:stored.backendBaseUrl,transport,appVersion:watchAppVersion});
   const account=stored.watchRefreshToken?await tokens.freshAccount():stored;await assertCurrent();if(account.tokenExpiresAtMillis>0&&account.tokenExpiresAtMillis<=Date.now())throw Error("登录已过期，请从手机重新同步账号");
   const repo=await repository(),deviceId=await repo.deviceId();
   const foundation=ports.foundation(account.userId,deviceId,transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion:watchAppVersion,assertCurrent,refreshToken:async (force,rejectedAccessToken)=>{await assertCurrent();const next=account.watchRefreshToken?await tokens.freshAccount(force,rejectedAccessToken):await accounts.read();if(!next)throw Error('账号已解绑');await assertCurrent();return next.watchDeviceToken;}});
   const library=new WatchCloudLibraryAdapter({cloudReadingCandidates:repo.cloudReadingCandidates?()=>repo.cloudReadingCandidates!():undefined,cloudSnapshot:full=>{guard.require();return repo.cloudSnapshot(full);},mergeCloud:async(...args)=>{await assertCurrent();return repo.mergeCloud(...args);}},deviceId,{...ports.crypto,stableId:url=>legacyWebArticleId(url,ports.crypto.sha256)},guard);
   return {...foundation,userId:account.userId,deviceId,displayName:'手表 · WatchRSS',assertCurrent,assertUpload:async()=>{await assertCurrent();await accounts.assertLibraryOwner(account);},
    library,records:async(bootstrap:import('./types').CloudBootstrap,current:()=>Promise<void>)=>new WatchCloudRecords({userId:account.userId,epoch:bootstrap.libraryEpoch,anchorVersion:Math.min(...bootstrap.keyCommitments.map(c=>c.keyVersion)),version:await foundation.keys.currentKeyVersion(account.userId),crypto:{...ports.crypto,hmac:ports.v2Crypto.hmac},key:version=>foundation.keys.accountKey(account.userId,version),readState:()=>foundation.cache.records(account.userId),writeState:value=>foundation.cache.storeRecords(account.userId,value),get:async after=>{const page=await foundation.client.records(after,deviceId);if(page.libraryEpoch!==bootstrap.libraryEpoch){await foundation.invalidate();throw Error('library_epoch_mismatch');}if(page.keyVersionFloor!==bootstrap.keyVersionFloor||JSON.stringify(page.keyCommitments.map(c=>[c.keyVersion,c.commitment,c.rotationProof]))!==JSON.stringify(bootstrap.keyCommitments.map(c=>[c.keyVersion,c.commitment,c.rotationProof])))throw Error('cloud_key_commitment_mismatch');return page;},push:items=>foundation.client.pushRecords(items),refreshKeys:async()=>{await current();const b=await foundation.client.bootstrap();await current();if(b.libraryEpoch!==bootstrap.libraryEpoch){await foundation.invalidate();throw Error('library_epoch_mismatch');}const d=b.devices.find(d=>d.deviceId===deviceId);await foundation.keys.acceptBootstrap(account.userId,deviceId,b.keyEnvelopes,b,d?.attestation&&d.attestationKeyVersion?{keyVersion:d.attestationKeyVersion,mac:d.attestation}:undefined);},current,assertUpload:async()=>{await current();await accounts.assertLibraryOwner(account);},apply:documents=>library.applyRecords(documents),export:()=>library.exportRecords()})};

 };
 const service=new WatchCloudSyncService({
  network:async()=>{guard.require();const n=await host<{active:boolean;validated:boolean;wifi:boolean;metered?:boolean}>('discovery.networkSnapshot',{});return {...n,metered:n.metered!==false};},
  hash:ports.crypto.sha256,uuid:async()=>{const b=await ports.crypto.random(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;},
  exclusive:async action=>{guard.require();if(!(await host<{acquired:boolean}>('cloud.acquire',{})).acquired)throw Error('云同步正在其他进程运行');try{await ports.cleanupCrypto();return await action();}finally{await host('cloud.release',{});}},
  open:openSession,onChanged,
 },guard);
 const authorization=async()=>{const session=await openSession();return session&&createCloudAuthorization({...session,crypto:session.v2Crypto});};
 const approvals=new CloudApprovalController({open:authorization,sync:()=>service.syncNow(true)});
 return {service,accounts,approvals,async reregister(confirmed:boolean){if(!confirmed)throw Error('device_reregistration_requires_confirmation');const auth=await authorization();if(!auth)throw Error('account_missing');return auth.reregister(confirmed);},async resolveOwner(choice:'clear'|'merge',clearLocal?:()=>Promise<void>){const account=await accounts.read();if(!account)throw Error('account_missing');return accounts.resolveLibraryOwner(account,choice,clearLocal);}};
}
