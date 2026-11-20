import type {SqlCancellationCheck} from '../core/types';
import {unhex} from '@podjs/framework/crypto';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import type {WatchAccountIdentity,WatchAccountStore} from '../account/store';
import type {SqlLibrarySessionRepository} from '../sync/library-repository';
import type {AfterReadingAck} from '../books/reading-delta';
import type {JsonObject} from '../sync/protocol';
import type {CloudHostRequest} from '../cloud/host-ports';
import {readCloudSecure} from '../cloud/secure-read';
import {ProjectionGate,SYNC_V2_PRODUCT} from './gate';
import {localProjectionCipher} from './host';
import {idCommitment} from './identity';
import type {LegacyBodySource} from './legacy-body';
import {accountKeyPrefix} from './product';
import {canonical,canonicalLegacy,digest,parseCanonicalJson,bytes,validateScope} from './protocol';
import {accountIdFromUserId} from './signing';
import {WatchProjectionStore,type SourceRecord} from './store';
import {noteAssetMime} from './note-assets';

export interface LocalTransferInput {
 peer:string;
 version:1|2|14;
 cursor:string|(()=>string);
 records:SourceRecord[];
 body?:LegacyBodySource;
 /** Retained wire semantics that cannot be projected as entity fields. */
 wire?:()=>string;
 check?:()=>void;
 reserveBody?:(size:number)=>Promise<void>;
}
export type LocalTransferWrite=((input:LocalTransferInput)=>Promise<void>) & {transferFence?:(reading?:boolean)=>Promise<string>};
export type BoundLocalTransferIntake=(<T>(apply:(check:LocalTransferWrite)=>Promise<T>)=>Promise<T>) & {
 capture?:(requireAccount?:boolean)=>Promise<BoundLocalTransferIntake>;
};
export type LocalTransferIntake=<T>(account:WatchAccountIdentity|null,deviceId:string,apply:(check:LocalTransferWrite)=>Promise<T>)=>Promise<T>;
export type NoteAssetIntake=((input:{cursor:string;logicalId:string;body:LegacyBodySource},apply:()=>Promise<void>)=>Promise<void>) & {
 capture?:()=>Promise<NoteAssetIntake>;
};

type LibraryAccountStore=Pick<WatchAccountStore,'withLibraryAccount'>&Partial<Pick<WatchAccountStore,'librarySessionGeneration'>>&{read():Promise<WatchAccountIdentity|null>};
const noProtection:LocalTransferWrite=async()=>{};
const accountFence=(account:WatchAccountIdentity|null)=>canonical(account?[account.backendBaseUrl,account.userId]:null);
export function watchLegacyTransferIntake(accountStore:LibraryAccountStore,deviceId:()=>Promise<string>,intake:LocalTransferIntake):BoundLocalTransferIntake{
 const bind=(account:WatchAccountIdentity|null):BoundLocalTransferIntake=>apply=>
  accountStore.withLibraryAccount(account,async()=>account?intake(account,await deviceId(),apply):apply(noProtection));
 const run:BoundLocalTransferIntake=async apply=>SYNC_V2_PRODUCT.syncV2?bind(await accountStore.read())(apply):apply(noProtection);
 if(SYNC_V2_PRODUCT.syncV2)run.capture=async requireAccount=>{
  const epoch=accountStore.librarySessionGeneration?.(),account=await accountStore.read();
  if(requireAccount&&!account)throw Error('AUTH_REVOKED');
  const captured=bind(account),readFence=async(protect:LocalTransferWrite)=>{
   if(accountStore.librarySessionGeneration?.()!==epoch)throw Error('AUTH_REVOKED');
   return protect.transferFence?.();
  };
  const stamp=await captured(readFence);
  return apply=>captured(async protect=>{
   if(await readFence(protect)!==stamp)throw Error('BUSINESS_REJECTED');
   return apply(protect);
  });
 };
 return run;
}

/** Order v1 book writes and applied ACKs by account, then writer, then library queue. */
export function watchBookSyncAction(
 getRepository:()=>Promise<Pick<SqlLibrarySessionRepository,'syncBooks'|'deviceId'>>,
 accountStore:LibraryAccountStore,
 intake:LocalTransferIntake,
){
 return async(request:JsonObject,session?:object,afterAck?:AfterReadingAck,cancel?:SqlCancellationCheck)=>{
  const repository=await getRepository();cancel?.();
  if(!SYNC_V2_PRODUCT.syncV2||request.phase==='pull')return repository.syncBooks(request,session,afterAck,undefined,cancel);
  const epoch=accountStore.librarySessionGeneration?.(),account=await accountStore.read();
  const run=<T>(apply:(protect:LocalTransferWrite)=>Promise<T>):Promise<T>=>accountStore.withLibraryAccount(account,async()=>{
   if(accountStore.librarySessionGeneration?.()!==epoch)throw Error('AUTH_REVOKED');
   return account?intake(account,await repository.deviceId(),apply):apply(noProtection);
  });
  const fence=async(protect:LocalTransferWrite)=>canonical([accountFence(account),epoch??null,await protect.transferFence?.(true)??null]);
  return run(async protect=>{
   cancel?.();
   const reading=request.phase==='readingSummary'||request.phase==='readingCommit';
   const stamp=reading?await fence(protect):undefined;
   const defer:AfterReadingAck|undefined=afterAck&&request.phase==='readingCommit'?commit=>afterAck(async()=>{
    if(accountFence(await accountStore.read())!==accountFence(account))throw Error('AUTH_REVOKED');
    await run(async current=>{
     if(await fence(current)!==stamp)throw Error('BUSINESS_REJECTED');
     cancel?.();await commit();
    });
   }):afterAck;
   return repository.syncBooks(request,session,defer,protect,cancel,stamp);
  });
 };
}

export async function applyLegacyTransfer<T>(intake:BoundLocalTransferIntake|undefined,peer:string,operation:string,records:SourceRecord[],apply:()=>Promise<T>,check?:()=>void,wire?:()=>unknown):Promise<T>{
 if(!intake||!SYNC_V2_PRODUCT.syncV2||(!records.length&&!wire))return apply();
 return intake(async protect=>{
  const byIdentity=new Map<string,SourceRecord>();
  for(const record of records){
   if(record.logicalId&&bytes(record.logicalId).length<=1024)byIdentity.set(canonical([record.kind,record.logicalId]),record);
  }
  // Keep duplicates and wire-only identities verbatim in the encrypted entry.
  const raw=byIdentity.size===records.length?wire:()=>({payload:wire?.()??null,records});
  let wireText:string|undefined;
  const retained=raw?()=>wireText??=canonicalLegacy(raw()):undefined;
  const cursor=()=>digest([operation,digest(canonicalLegacy(records)),retained?digest(retained()):null]);
  await protect({peer,version:14,cursor,records:[...byIdentity.values()],check,wire:retained});
  check?.();return apply();
 });
}

export function noteAssetIntake(intake:BoundLocalTransferIntake,version:1|2,peer:string,check:()=>void):NoteAssetIntake{
 const run:NoteAssetIntake=(input,apply)=>intake(async protect=>{
  const id=input.logicalId;
  const value={assetId:id,mime:noteAssetMime(id),originalFilename:id,updatedAt:0,sourceDeviceId:peer,deleted:false,deletedAt:0};
  await protect({peer,version,cursor:input.cursor,records:[{kind:'asset',logicalId:id,value}],body:input.body,check});
  check();await apply();
 });
 if(intake.capture)run.capture=async()=>noteAssetIntake(await intake.capture!(true),version,peer,check);
 return run;
}

/** The local transfer already owns the account lease. Use a short cloud
 * writer lease to order its writes against an authenticated observation.
 * The offline store only opens an existing account-owned projection. */
export function watchLocalTransferIntake(db:ProjectionSql,host:CloudHostRequest):LocalTransferIntake{
 const secureHost:CloudHostRequest=<T>(method:string,args:Record<string,unknown>)=>method==='secure.get'&&args.offset===undefined
  ? readCloudSecure(host,String(args.key)) as Promise<T>
  : host<T>(method,args);
 return async(account,deviceId,apply)=>{
  const direct:LocalTransferWrite=async()=>{};
  if(!SYNC_V2_PRODUCT.syncV2||!account)return apply(direct);
  const lease=await host<{acquired:boolean}>('cloud.acquire',{localTransferOwner:true});
  if(!lease.acquired)throw Error('BUSY');
  try{
   if(!(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_control'")).length)return await apply(direct);
   const row=(await db.query('SELECT scope FROM syncv2_control WHERE id=1'))[0];
   if(!row)return await apply(direct);
   const scope=parseCanonicalJson(bytes(String(row.scope)));validateScope(scope);
   const {backendBaseUrl,userId}=account,accountId=accountIdFromUserId(userId),accountScope=canonical([backendBaseUrl.replace(/\/+$/,''),userId]);
   const slot=accountKeyPrefix(backendBaseUrl,userId)+'syncv2.watchrss.syncv2.identity.'+digest({accountId,scope});
   const saved=await readCloudSecure(host,slot);
   if(!saved)throw Error('BUSINESS_REJECTED');
   const installed=parseCanonicalJson(bytes(saved));
   if(installed.status!=='installed'||canonical(installed.scope)!==String(row.scope))throw Error('BUSINESS_REJECTED');
   const key=unhex(installed.idKeyHex),gate=new ProjectionGate(true);
   try{
    if(idCommitment(key)!==installed.idKeyCommitment)throw Error('BUSINESS_REJECTED');
    const store=new WatchProjectionStore(db,localProjectionCipher(secureHost,accountScope),gate,scope,accountIdFromUserId(deviceId),key,async()=>{
     if(await readCloudSecure(host,slot)!==saved)throw Error('AUTH_REVOKED');
    },{localIntake:true});
    const reserveBody=async(size:number)=>{
     const capacity=await host<{usableBytes?:number}>('file.stat',{path:'books'});
     if((capacity.usableBytes??0)<size*2+1048576)throw Error('STORAGE_PRESSURE');
    };
    const protect:LocalTransferWrite=async input=>{input.check?.();if(await store.protectLocalInput({...input,reserveBody}))throw Error('BUSINESS_REJECTED');};
    protect.transferFence=reading=>store.localTransferFence(reading);
    return await apply(protect);
   }finally{key.fill(0);await gate.close();}
  }finally{await host('cloud.release',{});}
 };
}
