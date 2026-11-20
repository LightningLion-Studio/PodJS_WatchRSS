import {unhex} from '@podjs/framework/crypto';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import type {WatchAccountIdentity} from '../account/store';
import type {CloudHostRequest} from '../cloud/host-ports';
import {readCloudSecure} from '../cloud/secure-read';
import {ProjectionGate,SYNC_V2_PRODUCT} from './gate';
import {localProjectionCipher} from './host';
import {idCommitment} from './identity';
import type {LegacyBodySource} from './legacy-body';
import {accountKeyPrefix} from './product';
import {canonical,digest,parseCanonicalJson,bytes,validateScope} from './protocol';
import {accountIdFromUserId} from './signing';
import {WatchProjectionStore,type SourceRecord} from './store';
import {noteAssetMime} from './note-assets';

export interface LocalTransferInput {
 peer:string;
 version:1|2|14;
 cursor:string;
 records:SourceRecord[];
 body?:LegacyBodySource;
 check?:()=>void;
 reserveBody?:(size:number)=>Promise<void>;
}
export type LocalTransferWrite=(input:LocalTransferInput)=>Promise<void>;
export type BoundLocalTransferIntake=<T>(apply:(check:LocalTransferWrite)=>Promise<T>)=>Promise<T>;
export type LocalTransferIntake=<T>(account:WatchAccountIdentity|null,deviceId:string,apply:(check:LocalTransferWrite)=>Promise<T>)=>Promise<T>;
export type NoteAssetIntake=(input:{cursor:string;logicalId:string;body:LegacyBodySource},apply:()=>Promise<void>)=>Promise<void>;

export function noteAssetIntake(intake:BoundLocalTransferIntake,version:1|2,peer:string,check:()=>void):NoteAssetIntake{
 return (input,apply)=>intake(async protect=>{
  const id=input.logicalId;
  const value={assetId:id,mime:noteAssetMime(id),originalFilename:id,updatedAt:0,sourceDeviceId:peer,deleted:false,deletedAt:0};
  await protect({peer,version,cursor:input.cursor,records:[{kind:'asset',logicalId:id,value}],body:input.body,check});
  check();await apply();
 });
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
    return await apply(async input=>{input.check?.();if(await store.protectLocalInput({...input,reserveBody}))throw Error('BUSINESS_REJECTED');});
   }finally{key.fill(0);await gate.close();}
  }finally{await host('cloud.release',{});}
 };
}
