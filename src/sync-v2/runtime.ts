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
import {WatchIndexPublisher} from './publisher';
import {SyncV2Http,type Session} from './http';
import {hex} from '@podjs/framework/crypto';
import {canonical,exact} from './protocol';
import {sameScope} from './wire';
export function watchSyncV2(options:{enabled?:boolean;indexWrite?:boolean;origin:string;local:ReturnType<typeof watchLocalProjection>;host:CloudHostRequest;transport:HttpTransport;session:()=>Promise<Session>;bootstrap:()=>Promise<{accountId:string;syncV2:unknown;devices:ApprovedLegacyDevice[]}>;identity:()=>Promise<{idKeyHex:string;scope:any}>;contentKey:()=>Promise<{key:Uint8Array;version:number}>;now?:()=>number}){
 let opened:Promise<any>|undefined;const now=options.now??Date.now;
 return {async open(){if(options.enabled!==true)return null;return opened??=(async()=>{
  const local=await options.local.open();if(!local)throw Error('feature_disabled');const session=await options.session(),accountId=accountIdFromUserId(session.userId),identity=await options.identity();sameScope(identity.scope,session.scope);const content=await options.contentKey(),keys={id:unhex(identity.idKeyHex),content:content.key,version:content.version},crypto=createSyncV2Crypto(options.host);
  const secure={get:(key:string)=>readCloudSecure(options.host,key),async compareAndSet(key:string,expected:string|null,value:string){const result=await options.host<{updated:boolean}>('secure.compareAndSet',{key,expected,value});if(typeof result.updated!=='boolean')throw Error('secure_store_corrupt');return result.updated;}},pin=new WatchServiceKeyPin(secure,accountId,options.bootstrap),http=new SyncV2Http(options.transport,options.origin,session.scope,options.session,options.indexWrite??false,pin),authors=new WatchSigningKeys(http,crypto,keys.id,async()=>{const approved=await options.bootstrap();if(approved.accountId!==accountId)throw Error('cloud_account_busy');return approved.devices;}),signer=new WatchSigningIdentity(secure,crypto,accountId,session.scope,keys.id);
  await http.capabilities();const reader=new WatchCloudIndex(local.store,http,crypto,keys,async deviceId=>authors.get(deviceId),async(window)=>{const response=await http.json('GET','/checkpoint');exact(response,['version','scope','body','signature']);const checkpoint=await pin.checkpoint(crypto,{body:response.body,signature:response.signature},session.scope,now());if(canonical(checkpoint.account)!==canonical(window.account)||checkpoint.serverRevision!==window.serverRevision)throw Error('ref_conflict');},now),publisher=new WatchIndexPublisher(local.store,http,crypto,keys,now);
  return {http,reader,publisher,async pull(){const window=await http.negotiate([],['note-conflicts.v1']);await authors.refresh(window.windowId);return reader.pull(window);},async publish(){
   const current=await local.store.readState();if(current.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(current.pendingChoice)throw Error('choice_pending');
   const window=await http.negotiate([],[]),revision=await authors.refresh(window.windowId),identity=await signer.register(http,revision,now()),own=window.refs.find((ref:any)=>ref.deviceId===identity.deviceId),requestId=hex(await crypto.random(16));
   await publisher.prepare(identity.deviceId,identity.alias,{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},requestId);return publisher.flush();
  }};
 })().catch(error=>{opened=undefined;throw error;});}};
}
