import {hostOperation,delay} from '@podjs/framework/services';
import {hasCapability} from '@podjs/framework/watch';
import {getLibrarySyncRepository} from '../services';
import {summaryAccountStore} from '../llm/runtime';
import {installationId} from '../telemetry/host';
import {initializeCloudHost,cloudHostPorts} from '../cloud/host';
import {createCloudTransport} from '../cloud/transport';
import {createCloudAuthorization} from '../cloud/authorization';
import {cloudGate} from '../cloud/gate';
import {WatchSetupHandler} from '../onboarding/watch-setup';
import type {PairingPorts} from './mini-program-pairing';
/** Host bridge only; factory creation and page opening perform no account registration. */
export function miniProgramPairingHostPorts():PairingPorts{
 return{op:(method,args)=>hostOperation(method,args),available:()=>hasCapability('net.ble.provision' as Parameters<typeof hasCapability>[0]),identity:async()=>({deviceId:await(await getLibrarySyncRepository()).deviceId(),installId:await installationId()}),now:Date.now,after:(ms,fn)=>{const task=delay(ms);void task.result.then(fn,()=>{});return()=>task.cancel();},handler:async({deviceId,installId,active,confirm,pairing})=>{
  if(!await initializeCloudHost())throw Error('client_upgrade_required');const http=createCloudTransport(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,cloudGate);
  const scope=async(userId:string)=>{if(!active())throw Error('配对已取消');const account=await summaryAccountStore.read();if(!account||account.userId!==userId)throw Error('account_changed');const assertCurrent=async()=>{if(!active())throw Error('配对已取消');const now=await summaryAccountStore.read();if(!now||now.userId!==account.userId||now.backendBaseUrl!==account.backendBaseUrl)throw Error('account_changed');};const foundation=cloudHostPorts.foundation(userId,deviceId,http,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,assertCurrent});return createCloudAuthorization({...foundation,userId,deviceId,crypto:foundation.v2Crypto,assertCurrent});};
  const prepareKeys=(userId:string)=>cloudHostPorts.foundation(userId,deviceId,http,{baseUrl:'https://sly-data-plane.watchrss.cn',accessToken:''}).keys;
  return new WatchSetupHandler({deviceId,installId,active,confirm,pairing,now:Date.now,crypto:cloudHostPorts.v2Crypto,readAccount:()=>summaryAccountStore.read(),saveAccount:account=>summaryAccountStore.save(account),publicKey:userId=>prepareKeys(userId).publicKeySpki(userId,deviceId),registerSelf:async account=>{await(await scope(account.userId)).registerSelf();},verifiedReady:async userId=>(await scope(userId)).verifiedReady(),currentKeyVersion:async userId=>{
   const authorization=await scope(userId);if(!await authorization.verifiedReady())return 0;return authorization.currentKeyVersion();
  },trust:async userId=>(await scope(userId)).trust(),acceptDelivery:async(userId,envelopes,trust,attestation)=>(await scope(userId)).acceptDelivery(userId,envelopes,trust,attestation)});
 }};
}
