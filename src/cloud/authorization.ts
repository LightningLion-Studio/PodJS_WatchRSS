import type {WatchCloudClient} from './client';
import type {WatchCloudKeyManager} from './keys';
import type {WatchCloudStateStore} from './state';
import type {CloudKeyEnvelope,CloudTrust} from './types';
import type {V2Crypto} from './v2';
import {WatchCloudApproval} from './approval';
/** UI-independent adapter shared by the Lead's QR page and requester approval page.
 * bootstrap is always read from the signed-in backend, never trusted from QR input. */
export function createCloudAuthorization(p:{userId:string;deviceId:string;client:WatchCloudClient;keys:WatchCloudKeyManager;state:WatchCloudStateStore;invalidate():Promise<void>;assertCurrent():Promise<void>;crypto:V2Crypto}){
 async function register(keyVersion:number){await p.assertCurrent();try{await p.client.registerDevice(p.deviceId,'手表 · WatchRSS',await p.keys.publicKeySpki(p.userId,p.deviceId),keyVersion);}catch(error){if(String(error).includes('device_key_conflict'))throw Error('device_key_conflict: 重新登记本机');throw error;}}
 async function bootstrap(reactivate=false){await p.assertCurrent();const b=await p.client.bootstrap();await p.assertCurrent();if(await p.state.acceptEpoch(b.libraryEpoch)){await p.invalidate();throw Error('library_epoch_mismatch');}p.client.setEpoch(b.libraryEpoch);const d=b.devices.find(d=>d.deviceId===p.deviceId);if(d?.revokedAt){await p.invalidate();if(!reactivate)throw Error('device_revoked');await register(b.keyVersionFloor+1);const fresh=await p.client.bootstrap();await p.assertCurrent();if(fresh.libraryEpoch!==b.libraryEpoch||fresh.devices.some(d=>d.deviceId===p.deviceId&&d.revokedAt))throw Error('device_reactivation_failed');return fresh;}return b;}
 const verifiedReady=async()=>{const b=await bootstrap(),d=b.devices.find(d=>d.deviceId===p.deviceId);return await p.keys.acceptBootstrap(p.userId,p.deviceId,b.keyEnvelopes,b,d?.attestation&&d.attestationKeyVersion?{keyVersion:d.attestationKeyVersion,mac:d.attestation}:undefined)==='ready';};
 return {
 publicKey:async()=>p.keys.publicKeySpki(p.userId,p.deviceId),trust:()=>bootstrap(),verifiedReady,currentKeyVersion:()=>p.keys.currentKeyVersion(p.userId),
 acceptDelivery:async(_userId:string,envelopes:CloudKeyEnvelope[],_qrTrust:CloudTrust,attestation:{keyVersion:number;mac:string})=>{const b=await bootstrap();await p.assertCurrent();return p.keys.acceptDelivery(p.userId,p.deviceId,envelopes,b,attestation);},
 /** R20: UI must obtain explicit agreement before revoking the active local registration. */
 async reregister(confirmed:boolean){if(!confirmed)throw Error('device_reregistration_requires_confirmation');const b=await bootstrap();await p.assertCurrent();await p.client.revokeDevice(p.deviceId);await p.assertCurrent();await p.invalidate();await register(b.keyVersionFloor+1);const fresh=await bootstrap();if(!fresh.devices.some(d=>d.deviceId===p.deviceId&&!d.revokedAt))throw Error('device_reactivation_failed');return fresh;},
 async approval(changed?:(s:import('./approval').ApprovalStatus)=>void){const trust=await bootstrap(true);if(!trust.devices.some(d=>d.deviceId===p.deviceId))await register(trust.keyVersionFloor+1);return new WatchCloudApproval({userId:p.userId,deviceId:p.deviceId,trust,crypto:p.crypto,client:p.client,keys:p.keys,assertCurrent:p.assertCurrent,now:Date.now,changed});},
 };
}
