import {pairingSas,type V2Crypto} from '../cloud/v2';
import {utf8Encode} from '../cloud/types';
import type {WatchAccountState} from '../account/types';
import type {CloudTrust,CloudKeyEnvelope} from '../cloud/types';
import {parseAccountSyncRequest,type AccountUriParse} from '../sync/account-actions';
export interface SetupPorts {
 deviceId:string;installId:string;now():number;active():boolean;confirm(label:string,sas:string):Promise<boolean>;pairing:{sessionId:string;secret:Uint8Array};crypto:Pick<V2Crypto,'hmac'>;
 readAccount():Promise<WatchAccountState|null>;saveAccount(state:WatchAccountState):Promise<void>;
 /** R28: use the saved watch credentials, bootstrap then self-register before returning bound. */
 registerSelf(state:WatchAccountState):Promise<void>;publicKey(userId:string):Promise<string>;
 /** Must fetch authenticated bootstrap, compare epoch, commitments and own attestation. */
 verifiedReady(userId:string):Promise<boolean>;
 /** Highest version in the locally verified chain, never the incoming payload version. */
 currentKeyVersion(userId:string):Promise<number>;
 trust(userId:string):Promise<CloudTrust>;
 acceptDelivery(userId:string,envelopes:CloudKeyEnvelope[],trust:CloudTrust,attestation:{keyVersion:number;mac:string}):Promise<unknown>;
 parseBackend?:AccountUriParse;
}
/** QR channel authentication covers the batch; readiness always comes from verified cloud trust. */
export class WatchSetupHandler {
 private userId='';private saved=false;private ready=false;
 constructor(private p:SetupPorts){}
 private check(){if(!this.p.active())throw Error('配对已取消');}
 async handle(r:Record<string,any>):Promise<Record<string,unknown>>{
  this.check();const p=this.p;
  if(r.action==='prepare'){if(this.userId||typeof r.userId!=='string'||!/^[-a-fA-F0-9]{36}$/.test(r.userId))throw Error('配对账号无效');const old=await p.readAccount();this.check();if(old&&old.userId!==r.userId)throw Error('account_switch_rejected: 请先退出原账号');const sas=await pairingSas(p.crypto,p.pairing.secret,p.pairing.sessionId,r.userId);this.check();if(!await p.confirm(String(r.phoneMasked||'当前账号').slice(0,24),sas))throw Error('配对未确认');this.check();this.userId=r.userId;return{success:true,userId:this.userId,deviceId:p.deviceId,publicKeySpki:await p.publicKey(this.userId)};}
  if(r.action==='configure'){if(!this.userId||this.saved)throw Error('请先确认配对');const state=await parseAccountSyncRequest(r,p.parseBackend);this.check();if(state.userId!==this.userId||state.installId!==p.installId||state.backendBaseUrl!=='https://sly-data-plane.watchrss.cn'||state.tokenExpiresAtMillis<=p.now()||!state.watchRefreshToken)throw Error('账号与配对目标不一致');const old=await p.readAccount();if(old&&old.userId!==state.userId)throw Error('account_switch_rejected');await p.saveAccount(state);this.check();await p.registerSelf(state);this.check();this.saved=true;this.ready=await p.verifiedReady(this.userId);this.check();return{success:true,bound:true,userId:this.userId,deviceId:p.deviceId,cloudReady:this.ready};}
  if(r.action==='key'){if(!this.saved||r.userId!==this.userId)throw Error('账号尚未绑定');this.ready=false;if(typeof r.payload!=='string')throw Error('client_upgrade_required');if(utf8Encode(r.payload).length>14*1024)throw Error('pairing_payload_too_large: 请使用审批 v2');const delivery=JSON.parse(r.payload);if(!Array.isArray(delivery.envelopes)||!delivery.attestation)throw Error('invalid_pairing_payload');const envelopes=delivery.envelopes.map((x:any)=>{const e=x.envelope;if(!e||x.keyVersion!==e.keyVersion)throw Error('invalid_pairing_payload');return e;});const trust=await p.trust(this.userId);this.check();await p.acceptDelivery(this.userId,envelopes,trust,delivery.attestation);this.check();this.ready=await p.verifiedReady(this.userId);this.check();if(!this.ready)throw Error('waiting_approval');const keyVersion=await p.currentKeyVersion(this.userId);this.check();if(!Number.isSafeInteger(keyVersion)||keyVersion<1)throw Error('waiting_approval');return{success:true,deviceId:p.deviceId,keyVersion,cloudReady:true};}
  if(r.action==='finish'){if(!this.saved)throw Error('手表配置尚未完成');this.ready=await p.verifiedReady(this.userId);this.check();if(r.cloudReady&&!this.ready)throw Error('waiting_approval');return{success:true,deviceId:p.deviceId,cloudReady:this.ready};}
  throw Error('不支持的配置操作');
 }
}
