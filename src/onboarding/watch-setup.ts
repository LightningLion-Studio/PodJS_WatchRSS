import {pairingSas,type V2Crypto} from '../cloud/v2';
import {utf8Encode} from '../cloud/types';
import type {WatchAccountState} from '../account/types';
import type {CloudTrust,CloudKeyEnvelope} from '../cloud/types';
import {parseAccountSyncRequest,type AccountUriParse} from '../sync/account-actions';
export type PairingDecision='pending'|'confirmed'|'rejected';
export interface PairingConfirmation {phone:PairingDecision;watch:PairingDecision}
export interface PairingReplacementReceipt {released:true;cleared:true}
export interface SetupPorts {
 messageSequenceMax?:number;
 replacementAvailable?:boolean;
 confirmationChanged?(state:PairingConfirmation,accountConflict:boolean):void;
 replaceAccount?(target:{userId:string;deviceId:string;installId:string;sessionId:string;check():void}):Promise<PairingReplacementReceipt>;
 deviceId:string;installId:string;now():number;active():boolean;confirm(label:string,sas:string):Promise<boolean>;pairing:{sessionId:string;secret:Uint8Array};crypto:Pick<V2Crypto,'hmac'>;
 libraryOwnerConflict?(userId:string):Promise<boolean>;
 readAccount():Promise<WatchAccountState|null>;saveAccount(state:WatchAccountState):Promise<void>;
 /** Recheck the owned relay before committing credentials; no tokens leave the host. */
 checkSession():Promise<void>;
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
 private confirmation?:Promise<boolean>;
 private fatalCode='';private ux=false;private consent=false;private accountConflict=false;private publicKeySpki='';
 private decisions:PairingConfirmation={phone:'pending',watch:'pending'};
 private confirmationDeadline=0;private replacement?:Record<string,unknown>;
 private replacing?:Promise<Record<string,unknown>>;
 private publish(){if(this.ux)this.p.confirmationChanged?.({...this.decisions},this.accountConflict);}
 private identity(){return{userId:this.userId,deviceId:this.p.deviceId,installId:this.p.installId,publicKeySpki:this.publicKeySpki};}
 private both(){return this.decisions.phone==='confirmed'&&this.decisions.watch==='confirmed';}
 private requireConsent(){this.check();if(!this.consent)throw Error('pairing_upgrade_required');if(!this.both())throw Error('pairing_confirmation_required');}
 constructor(private p:SetupPorts){}
 private check(){if(this.fatalCode)throw Error(this.fatalCode);if(!this.p.active())throw Error('配对已取消');if(this.ux&&!this.saved&&!this.both()&&this.confirmationDeadline&&this.p.now()>=this.confirmationDeadline)throw Error('pairing_confirmation_expired');}
 async handle(r:Record<string,any>):Promise<Record<string,unknown>>{
  this.check();const p=this.p;
  if(r.action==='prepare'){
   if(this.userId||typeof r.userId!=='string'||!/^[-a-fA-F0-9]{36}$/.test(r.userId))throw Error('配对账号无效');
   if(r.pairingUxVersion!==undefined&&r.pairingUxVersion!==1)throw Error('pairing_upgrade_required');
   if(r.pairingUxVersion===1&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.userId))throw Error('pairing_invalid_target');
   this.ux=r.pairingUxVersion===1;this.consent=this.ux&&p.messageSequenceMax===255;
   this.userId=r.userId;
   const old=await p.readAccount();this.check();this.accountConflict=!!old&&old.userId!==this.userId||!!await p.libraryOwnerConflict?.(this.userId);this.check();if(this.accountConflict&&!this.ux)throw Error('account_switch_rejected: 请先退出原账号');
   const sas=await pairingSas(p.crypto,p.pairing.secret,p.pairing.sessionId,this.userId),publicKeySpki=await p.publicKey(this.userId);this.check();
   // R43: start the unchanged SAS UI, but only configure waits for its answer.
   this.publicKeySpki=publicKeySpki;this.confirmationDeadline=p.now()+90000;
   this.confirmation=Promise.resolve(p.confirm(String(r.phoneMasked||'当前账号').slice(0,24),sas)).then(value=>{this.decisions.watch=value===true?'confirmed':'rejected';this.publish();return value===true;},()=>{this.decisions.watch='rejected';this.publish();return false;});
   this.publish();
   return{success:true,...this.identity(),...(this.ux?{pairingUxVersion:1,capabilities:{pairingConfirmV1:this.consent,pairingReplaceAccountV1:this.consent&&p.replacementAvailable===true&&!!p.replaceAccount},...(this.consent?{messageSequenceMax:255}:{}),confirmation:{...this.decisions},accountConflict:this.accountConflict}:{})};
  }
  if(r.action==='pairingStatus'){
   if(!this.userId||r.userId!==this.userId||!this.ux||!this.consent)throw Error('pairing_upgrade_required');
   if(!['pending','confirmed','rejected'].includes(r.decision))throw Error('pairing_invalid_decision');
   if(r.decision==='rejected')this.decisions.phone='rejected';
   else if(r.decision==='confirmed'&&this.decisions.phone!=='rejected')this.decisions.phone='confirmed';
   this.publish();
   const rejected=this.decisions.phone==='rejected'||this.decisions.watch==='rejected';
   return{success:!rejected,action:'pairingStatus',...this.identity(),confirmation:{...this.decisions},accountConflict:this.accountConflict,...(rejected?{errorCode:'pairing_rejected'}:{})};
  }
  if(r.action==='replaceAccount'){
   this.requireConsent();
   if(r.userId!==this.userId||r.confirmClearLocal!==true)throw Error('pairing_clear_consent_required');
   if(!p.replacementAvailable||!p.replaceAccount)throw Error('pairing_replacement_unavailable');
   if(this.saved)throw Error('pairing_already_bound');
   if(this.replacement)return this.replacement;
   if(this.replacing)return this.replacing;
   const target={userId:this.userId,deviceId:p.deviceId,installId:p.installId,sessionId:p.pairing.sessionId,check:()=>this.requireConsent()};
   const run=(async()=>{
    await p.checkSession();this.requireConsent();
    const result=await p.replaceAccount!(target);this.requireConsent();
    if(result.released!==true||result.cleared!==true)throw Error('pairing_release_unverified');
    const account=await p.readAccount();this.requireConsent();if(account&&account.userId!==this.userId)throw Error('pairing_release_unverified');
    const current=await p.publicKey(this.userId);this.requireConsent();if(current!==this.publicKeySpki){this.fatalCode='pairing_identity_changed';throw Error(this.fatalCode);}
    this.accountConflict=false;this.publish();
    return this.replacement={success:true,action:'replaceAccount',...this.identity(),released:true,cleared:true};
   })();this.replacing=run;try{return await run;}finally{if(this.replacing===run)this.replacing=undefined;}
  }
  if(r.action==='configure'){
   if(this.ux){this.requireConsent();if(this.accountConflict)throw Error('pairing_replacement_required');}
   if(!this.confirmation||this.saved)throw Error('请先确认配对');
   const state=await parseAccountSyncRequest(r,p.parseBackend);this.check();
   if(state.userId!==this.userId||state.installId!==p.installId||state.backendBaseUrl!=='https://sly-data-plane.watchrss.cn'||state.tokenExpiresAtMillis<=p.now()||!state.watchRefreshToken)throw Error('账号与配对目标不一致');
   if(!await this.confirmation)throw Error('配对未确认');this.check();
   const old=await p.readAccount();this.check();if(old&&old.userId!==state.userId)throw Error('account_switch_rejected');
   await p.checkSession();this.check();if(state.tokenExpiresAtMillis<=p.now())throw Error('账号凭据已过期');
   // Saving is the durable commit boundary; both local agreement and relay liveness precede it.
   await p.saveAccount(state);this.check();await p.registerSelf(state);this.check();this.saved=true;this.ready=await p.verifiedReady(this.userId);this.check();
   return{success:true,bound:true,userId:this.userId,deviceId:p.deviceId,cloudReady:this.ready};
  }
  if(r.action==='key'){if(this.ux)this.requireConsent();if(!this.saved||r.userId!==this.userId)throw Error('账号尚未绑定');this.ready=false;if(typeof r.payload!=='string')throw Error('client_upgrade_required');if(utf8Encode(r.payload).length>14*1024)throw Error('pairing_payload_too_large: 请使用审批 v2');const delivery=JSON.parse(r.payload);if(!Array.isArray(delivery.envelopes)||!delivery.attestation)throw Error('invalid_pairing_payload');const envelopes=delivery.envelopes.map((x:any)=>{const e=x.envelope;if(!e||x.keyVersion!==e.keyVersion)throw Error('invalid_pairing_payload');return e;});const trust=await p.trust(this.userId);this.check();await p.acceptDelivery(this.userId,envelopes,trust,delivery.attestation);this.check();this.ready=await p.verifiedReady(this.userId);this.check();if(!this.ready)throw Error('waiting_approval');const keyVersion=await p.currentKeyVersion(this.userId);this.check();if(!Number.isSafeInteger(keyVersion)||keyVersion<1)throw Error('waiting_approval');return{success:true,deviceId:p.deviceId,keyVersion,cloudReady:true};}
  if(r.action==='finish'){if(!this.saved)throw Error('手表配置尚未完成');this.ready=await p.verifiedReady(this.userId);this.check();if(r.cloudReady&&!this.ready)throw Error('waiting_approval');return{success:true,deviceId:p.deviceId,cloudReady:this.ready};}
  throw Error('不支持的配置操作');
 }
}
