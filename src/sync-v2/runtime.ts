import {WatchAccountControl,type AccountControlOptions} from './account-control';
/** Explicit P2 factory for isolated integration. No application startup hook. */
import {createSyncV2Crypto,unhex} from '@podjs/framework/crypto';
import {readCloudSecure} from '../cloud/secure-read';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {HttpTransport} from '../cloud/types';
import type {watchLocalProjection} from './index';
import {accountIdFromUserId} from './signing';
import {WatchServiceKeyPin} from './service-key';
import {WatchSigningIdentity} from './signing-store';
import {WatchSigningKeys,type ApprovedLegacyDevice} from './signing-keys';
import {WatchCloudIndex} from './cloud-index';
import {watchContentV2} from './content-runtime';
import {WatchIndexPublisher,type BodyResolver} from './publisher';
import {SyncV2Http,type Session,type OriginPolicy} from './http';
import type {TrustedClock} from './trusted-time';
import {hex} from '@podjs/framework/crypto';
import {canonical,exact} from './protocol';
import type {ObjectKeys} from './sealed';
import {sameScope} from './wire';
/** `noteSegments` (default off) lets this client read and, when the backend
 * also advertises note-segments.v1, write rc7 segmented notes (25.8). */
export function watchSyncV2(options:{enabled?:boolean;noteSegments?:boolean;indexWrite?:boolean;historyRestore?:boolean;choiceApply?:boolean;bodyResolver?:BodyResolver;origin:string;local:ReturnType<typeof watchLocalProjection>;host:CloudHostRequest;transport:HttpTransport;session:()=>Promise<Session>;bootstrap:()=>Promise<{accountId:string;syncV2:unknown;devices:ApprovedLegacyDevice[]}>;identity:()=>Promise<{idKeyHex:string;scope:any}>;contentKey:()=>Promise<{key:Uint8Array;version:number}>;contentKeyAt?:import('./sealed').ContentKeyResolver;now?:()=>number;originPolicy?:OriginPolicy;clock?:TrustedClock}){
 let opened:Promise<any>|undefined,ownedKeys:ObjectKeys|undefined;let destroyed=false;const destroy=()=>{destroyed=true;opened=undefined;ownedKeys?.id.fill(0);ownedKeys?.content.fill(0);ownedKeys=undefined;};const now=options.now??Date.now,segments=options.noteSegments===true;
 return {destroy,async open(){if(destroyed)throw Error('feature_disabled');if(options.enabled!==true)return null;return opened??=(async()=>{
  const local=await options.local.open();if(!local)throw Error('feature_disabled');const session=await options.session(),accountId=accountIdFromUserId(session.userId),identity=await options.identity();sameScope(identity.scope,session.scope);const content=await options.contentKey(),keys={id:unhex(identity.idKeyHex),content:content.key,version:content.version,readContentKey:options.contentKeyAt},crypto=createSyncV2Crypto(options.host);
  ownedKeys=keys;if(destroyed){destroy();throw Error('feature_disabled');}
  const secure={get:(key:string)=>readCloudSecure(options.host,key),async compareAndSet(key:string,expected:string|null,value:string){const result=await options.host<{updated:boolean}>('secure.compareAndSet',{key,expected,value});if(typeof result.updated!=='boolean')throw Error('secure_store_corrupt');return result.updated;}},pin=new WatchServiceKeyPin(secure,accountId,options.bootstrap),http=new SyncV2Http(options.transport,options.origin,session.scope,options.session,options.indexWrite??false,pin,false,false,options.historyRestore??false,options.choiceApply??false,options.originPolicy),authors=new WatchSigningKeys(http,crypto,keys.id,async()=>{const approved=await options.bootstrap();if(approved.accountId!==accountId)throw Error('cloud_account_busy');return approved.devices;}),signer=new WatchSigningIdentity(secure,crypto,accountId,session.scope,keys.id);
  http.requestGuard=()=>{if(destroyed)throw Error('feature_disabled');};
  await http.capabilities();const reader=new WatchCloudIndex(local.store,http,crypto,keys,async deviceId=>authors.get(deviceId),async(window)=>{const response=window.checkpoint?{version:2,scope:session.scope,...window.checkpoint}:await http.json('GET','/checkpoint');exact(response,['version','scope','body','signature']);const checkpoint=await pin.checkpoint(crypto,{body:response.body,signature:response.signature},session.scope,now());options.clock?.observe(response.body.issuedAtMillis);if(canonical(checkpoint.account)!==canonical(window.account)||checkpoint.serverRevision!==window.serverRevision)throw Error('ref_conflict');},now,()=>local.rebuild(),{noteSegments:segments}),publisher=new WatchIndexPublisher(local.store,http,crypto,keys,now,options.bodyResolver,{noteSegments:segments});
  let accountControl:WatchAccountControl|undefined;let contentOpen:ReturnType<ReturnType<typeof watchContentV2>['open']>|undefined,contentBinding:string|undefined;
  return {destroy,http,reader,publisher,approved:async(id:string)=>authors.get(id),async refreshTrustedTime(){const response=await http.json('GET','/checkpoint');exact(response,['version','scope','body','signature']);const checkpoint=await pin.checkpoint(crypto,{body:response.body,signature:response.signature},session.scope,now());options.clock?.observe(checkpoint.issuedAtMillis);return checkpoint;},signingDeviceId:()=>signer.registeredDeviceId(),signingStatus:()=>signer.status(),accountControl(ports:Pick<AccountControlOptions,'business'|'recovery'|'trustedNow'|'preserveStalePublication'>){return accountControl=new WatchAccountControl({...ports,store:local.store,http,reader,publisher:new WatchIndexPublisher(local.store,http,crypto,keys,()=>{const n=ports.trustedNow();if(n===null)throw Error('clock_unknown');return n;},options.bodyResolver,{noteSegments:segments}),crypto,approved:async id=>authors.get(id),rebuildProjection:()=>local.rebuild(),resolveBody:options.bodyResolver,historyRestore:options.historyRestore,choiceApply:options.choiceApply,author:async()=>{const window=await http.negotiate([],[]),revision=await authors.refresh(window.windowId),identity=await signer.register(http,revision,ports.trustedNow()??(()=>{throw Error('clock_unknown');})()),own=window.refs.find((r:any)=>r.deviceId===identity.deviceId);return {deviceId:identity.deviceId,alias:identity.alias,own:{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'}};}});},async content(business:Pick<Parameters<typeof watchContentV2>[0],'enabled'|'authBinding'|'source'|'sessions'|'allowChargingCellular'|'metric'>){
   if(business.enabled!==true)return null;if(options.indexWrite!==true)throw Error('feature_disabled');
   if(contentOpen&&contentBinding!==business.authBinding)throw Error('body_revision_changed');contentBinding=business.authBinding;
   return contentOpen??=(async()=>{const window=await http.negotiate([],[]),revision=await authors.refresh(window.windowId),author=await signer.register(http,revision,now());
    return watchContentV2({...business,origin:options.origin,originPolicy:options.originPolicy,host:options.host,session:options.session,servicePin:pin,keys,alias:author.alias,now,
     approved:async id=>authors.get(id),refreshApproved:async id=>{await authors.refresh(id);},assertCurrent:async()=>{
      const current=await options.session();if(accountIdFromUserId(current.userId)!==accountId)throw Error('cloud_account_busy');sameScope(current.scope,session.scope);
     }}).open();})().catch(error=>{contentOpen=undefined;throw error;});
  },async refreshAccount(){const window=await http.negotiate([],segments?['note-conflicts.v1','note-segments.v1']:['note-conflicts.v1']);await authors.refresh(window.windowId);return reader.pull(window);},async pull(){const window=await http.negotiate([],segments?['note-conflicts.v1','note-segments.v1']:['note-conflicts.v1']);await authors.refresh(window.windowId);return accountControl?accountControl.follow(window):reader.pull(window);},async publish(){
   const current=await local.store.readState();if(current.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(current.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(current.pendingChoice)throw Error('choice_pending');
   const window=await http.negotiate([],[]),revision=await authors.refresh(window.windowId),identity=await signer.register(http,revision,now()),own=window.refs.find((ref:any)=>ref.deviceId===identity.deviceId),requestId=hex(await crypto.random(16));
   await publisher.prepare(identity.deviceId,identity.alias,{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},requestId);return publisher.flush();
  }};
 })().catch(error=>{opened=undefined;destroy();throw error;});}};
}
