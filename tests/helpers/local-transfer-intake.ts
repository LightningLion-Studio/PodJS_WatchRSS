import {hex} from '@podjs/framework/crypto';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import type {CloudHostRequest} from '../../src/cloud/host-ports';
import {ProjectionGate} from '../../src/sync-v2/gate';
import {localProjectionCipher} from '../../src/sync-v2/host';
import {idCommitment} from '../../src/sync-v2/identity';
import {watchLocalTransferIntake} from '../../src/sync-v2/local-transfer-intake';
import {accountKeyPrefix} from '../../src/sync-v2/product';
import {canonical,digest} from '../../src/sync-v2/protocol';
import {accountIdFromUserId} from '../../src/sync-v2/signing';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {account as rollback,scope,idKey,productCipherHost} from '../sync-v2/fixture';

export async function localTransferIntakeFixture(db:ProjectionSql,account:{backendBaseUrl:string;userId:string},deviceId:string){
 const {host:crypt}=productCipherHost();
 const accountId=accountIdFromUserId(account.userId),accountScope=canonical([account.backendBaseUrl,account.userId]);
 const slot=accountKeyPrefix(account.backendBaseUrl,account.userId)+'syncv2.watchrss.syncv2.identity.'+digest({accountId,scope});
 const record=canonical({status:'installed',scope,idKeyHex:hex(idKey),idKeyCommitment:idCommitment(idKey)});
 await crypt('secure.compareAndSet',{key:slot,expected:null,value:record});
 let leased=false;
 const host:CloudHostRequest=async<T>(method:string,args:Record<string,unknown>)=>{
  if(method==='cloud.acquire'){if(leased)throw Error('double lease');leased=true;return {acquired:true} as T;}
  if(method==='cloud.release'){leased=false;return null as T;}
  if(method==='file.stat')return {usableBytes:2*1024*1024*1024} as T;
  if(method==='secure.get'&&args.offset!==undefined){
   const value=await crypt(method,args);
   return (value==null?{exists:false}:{exists:true,offset:0,totalChars:value.length,value}) as T;
  }
  return crypt(method,args);
 };
 const store=new WatchProjectionStore(db,localProjectionCipher(crypt,accountScope),new ProjectionGate(true),scope,accountIdFromUserId(deviceId),idKey);
 await store.initialize();
 return {store,intake:watchLocalTransferIntake(db,host),account,deviceId,leased:()=>leased,
  async rollback(){
   await store.observe(rollback,async()=>({authors:{},parents:{}}));
   const observed=await store.readState();
   await store.controlUpdate(observed,{...observed,editBase:{accountOid:rollback.oid,generation:rollback.generation},pendingChoice:null,hasUnsentEdits:false,acknowledgedLocalChangeRevision:observed.localChangeRevision});
   await db.transaction([{sql:'UPDATE syncv2_control SET enabled=0 WHERE id=1'}]);
  },
 };
}
