import type {PublicationDeadline} from '../cloud/publication-deadline';
import {sha256Hex} from '@podjs/framework/crypto';
import type {SnapshotCrypto} from '../cloud/codec';
import type {CloudBlobStore} from '../cloud/cache';
import type {SigningPort} from './signing';
import type {ApprovedKey} from './head-pins';
import type {WatchProjectionStore} from './store';
import {fromWire} from './business';
import {canonical,digest,jsonBytes,parseCanonicalJson,type Scope} from './protocol';
import {BodyChannelHttp} from './body-channel-http';
import {prepareCarrier,openCarrier,verifyCarrier,carrierBodyRevision,bodyObjectName,type BodyBinding,type Carrier,type BodyKind} from './body-channel-codec';
import type {BodyResolver} from './publisher';
import {SyncV2Error} from './http';
import {businessBodyWitness,sameIndependentIdentity,tombstoneBodyDescription} from './body-binding';
import type {BookState} from '../books/protocol';
type LocalBodyWitness={size:number;sha256:string};
export interface BodyChannelRepository {
 /** Hashes an installed, validated package without loading it into the guest. */
 readBookWitness?(id:string,expected:Pick<BookState,'bookId'|'fingerprint'|'chapterCount'|'instanceId'|'lifecycle'>):Promise<LocalBodyWitness|undefined>;
 read(kind:BodyKind,id:string):Promise<Uint8Array|undefined>;
 /** Validates frozen book identity/fingerprint before any file installation. */
 validate(kind:BodyKind,id:string,value:Record<string,any>,bytes:Uint8Array):Promise<void>;
 install(kind:BodyKind,id:string,bytes:Uint8Array,expectedTargetSha256?:string|null,deadline?:PublicationDeadline):Promise<void>;
}
/** The v2 row carries a hash-bound placeholder, not a P3 recipe or cloud-ready. */
const bodyFields=['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'];
export function independentBodyResolver(repository:BodyChannelRepository,fallback:BodyResolver,onPending?:(code:string)=>void):BodyResolver{return async(entry,existing)=>{
 const tombstone=tombstoneBodyDescription(entry.candidate,existing);if(tombstone)return tombstone;
 const kind=entry.candidate.meta.kind;if(kind!=='book'&&kind!=='asset')return fallback(entry,existing);
 const prior=existing?.candidate??existing,description=existing?.manifest??existing?.row;
 const same=prior&&description&&description.bodyRevision!=null&&prior.state.payload.deleted!==true&&sameIndependentIdentity(kind,entry.candidate,prior),keep=()=>Object.fromEntries(bodyFields.map(k=>[k,description[k]])) as any;
 if(same&&description.recipeOid)return keep();
 try{
  if(kind==='book'&&repository.readBookWitness){
   const value=fromWire(kind,entry.candidate.meta.payload,entry.candidate.state.payload);
   const witness=await repository.readBookWitness(entry.candidate.meta.logicalId,value as any);
   if(!witness){if(same)return keep();onPending?.('body_channel_source_missing');throw Error('body_channel_source_missing');}
   if(witness.size>64*1024*1024){onPending?.('body_channel_capacity_pending');throw Error('body_channel_source_missing');}
   const bodyRevision=carrierBodyRevision(kind,entry.entityKey,witness.sha256);if(same&&description.bodyRevision===bodyRevision)return keep();
   return {bodyRevision,promiseId:bodyRevision,recipeOid:null,opaqueContentId:null,contentBytes:null};
  }
  const raw=await repository.read(kind,entry.candidate.meta.logicalId);
  if(!raw){if(same)return keep();onPending?.('body_channel_source_missing');throw Error('body_channel_source_missing');}
  await repository.validate(kind,entry.candidate.meta.logicalId,fromWire(kind,entry.candidate.meta.payload,entry.candidate.state.payload),raw);
  const bodyRevision=carrierBodyRevision(kind,entry.entityKey,sha256Hex(raw));if(same&&description.bodyRevision===bodyRevision)return keep();
  return {bodyRevision,promiseId:bodyRevision,recipeOid:null,opaqueContentId:null,contentBytes:null};
 }catch(error){if(['feature_disabled','cloud_account_busy','cloud_sync_suspended','body_channel_source_missing'].includes((error as Error).message))throw error;if(same)return keep();onPending?.((error as Error).message==='body_channel_capacity_pending'?'body_channel_capacity_pending':'body_channel_source_missing');throw Error('body_channel_source_missing');}
};}
class BodyRetryDeferred extends Error {}
const fatalBodyCheck=(code:string)=>['feature_disabled','cloud_account_busy','cloud_sync_suspended','choice_stale','window_expired','AUTH_REVOKED'].includes(code);
/** Every source comes from an already authenticated current account tree.
 * Carrier success never advances a business ACK or rewrites a v2 row. */
export class WatchBodyChannel {
 constructor(private readonly o:{http:BodyChannelHttp;scope:Scope;projection:WatchProjectionStore;crypto:SnapshotCrypto;signer:SigningPort;author:()=>Promise<{deviceId:string;alias:string}>;approved:(id:string)=>Promise<ApprovedKey>;key:(v:number)=>Promise<Uint8Array>;currentKey:()=>Promise<{key:Uint8Array;version:number}>;files:CloudBlobStore;root:string;repository:BodyChannelRepository;localReceiving?:(binding:BodyBinding)=>Promise<boolean>;receivedFromPeer?:(binding:BodyBinding,sha256:string)=>Promise<boolean>;check:()=>Promise<void>;now?:()=>number;yieldControl?:()=>Promise<void>}){}
 private now(){return (this.o.now??Date.now)();}
 private async current(entry:any,anchor:any){
  await this.o.check();const state=await this.o.projection.readState(),head=state.cloud?.current;
  if(state.pendingChoice||!state.account||head?.commitOid!==state.account.oid||canonical({commitOid:state.account.oid,revision:state.account.revision,rollbackGeneration:state.account.generation})!==canonical(anchor))throw Error('choice_stale');
  const now=await this.o.projection.cloudRow(head.treeRoot,entry.row.entityKey);
  if(!now||now.row.deleted||canonical(now)!==canonical(entry))throw Error('body_revision_changed');
 }
 async hasWork(){
  const state=await this.o.projection.readState(),head=state.cloud?.current;if(state.pendingChoice||!state.account||head?.commitOid!==state.account.oid)return false;
  let after='';for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)return false;if(page.some((entry:any)=>['book','asset'].includes(entry.meta.kind)&&!entry.row.deleted&&!entry.row.recipeOid))return true;after=page.at(-1).row.entityKey;}
 }
 /** Existing P6 random placeholders need a hash binding even when their
  * business metadata has not changed. Preserve all existing P3 recipes. */
 async needsPublication(){
  const state=await this.o.projection.readState(),head=state.cloud?.current;if(state.pendingChoice||state.cloud?.pendingPublish||!state.account||head?.commitOid!==state.account.oid)return false;
  let after='';for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)return false;
   for(const entry of page){const kind=entry.meta.kind;if(!['book','asset'].includes(kind)||entry.row.deleted||entry.row.recipeOid)continue;
    const c=await this.o.projection.readCandidate(entry.row.entityKey);if(!c||businessBodyWitness(kind,fromWire(kind,c.meta.payload,c.state.payload))!==businessBodyWitness(kind,fromWire(kind,entry.meta.payload,entry.state.payload)))continue;
    try{
     const id=entry.meta.logicalId,value=fromWire(kind,entry.meta.payload,entry.state.payload);
     let hash:string;
     if(kind==='book'&&this.o.repository.readBookWitness){
      const witness=await this.o.repository.readBookWitness(id,value as BookState);
      if(!witness||witness.size>64*1024*1024)continue;
      hash=witness.sha256;
     }else{
      const raw=await this.o.repository.read(kind,id);if(!raw)continue;
      await this.o.repository.validate(kind,id,value,raw);hash=sha256Hex(raw);
     }
     if(carrierBodyRevision(kind,entry.row.entityKey,hash)!==entry.row.bodyRevision){
      const carriers=await this.o.http.list(entry.row.entityKey,entry.row.bodyRevision);
      if(!carriers.carriers.length)return true;
     }
    }catch{await this.o.check();}
   }after=page.at(-1).row.entityKey;
  }
 }
 async sync(expiresAtMillis?:number){
  await this.o.check();const state=await this.o.projection.readState(),head=state.cloud?.current;
  if(state.pendingChoice||!state.account||head?.commitOid!==state.account.oid)return {pending:0,errors:[] as string[]};
  const anchor={commitOid:state.account.oid,revision:state.account.revision,rollbackGeneration:state.account.generation};let after='',pending=0;const errors:string[]=[];
  for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)break;
   for(const entry of page){if(!['book','asset'].includes(entry.meta.kind)||entry.row.deleted||entry.row.recipeOid)continue;
    try{await this.syncEntry(entry,anchor,expiresAtMillis);}
    catch(error){await this.o.check();pending++;const code=String((error as Error).message);
     if(error instanceof SyncV2Error&&error.retryable){
      const path=this.retryPath(entry),old=await this.o.files.read(path),previous=old?parseCanonicalJson(old):null;
      const attempts=Math.min(32,(previous?.attempts??0)+1),delay=error.retryAfterMillis!==null&&error.retryAfterMillis>0?error.retryAfterMillis:Math.min(1800000,30000*2**(attempts-1)),until=this.now()+delay;
      if(!Number.isSafeInteger(until))throw Error('counter_exhausted');await this.o.files.writeAtomic(path,jsonBytes({version:1,code:error.code,until,attempts}));
     }if(!errors.includes(code))errors.push(code);
    }
   }after=page.at(-1).row.entityKey;
  }return {pending,errors};
 }
 private retryPath(entry:any){return this.o.root+'/'+entry.row.entityKey+'/'+entry.row.bodyRevision+'/retry.json';}
 private async syncEntry(entry:any,anchor:any,expiresAtMillis?:number){
  const checkWindow=()=>{if(expiresAtMillis!==undefined&&this.now()>expiresAtMillis)throw Error('window_expired');};
  const deadline=expiresAtMillis===undefined?undefined:{expiresAtMillis,check:checkWindow};
  const {meta,row}=entry,kind=meta.kind as BodyKind,id=meta.logicalId,binding:BodyBinding={kind,logicalId:id,entityKey:row.entityKey,bodyRevision:row.bodyRevision},value=fromWire(kind,meta.payload,entry.state.payload);
  if(value.deleted)throw Error('body_revision_changed');checkWindow();await this.current(entry,anchor);checkWindow();
  const path=this.o.root+'/'+binding.entityKey+'/'+binding.bodyRevision,retry=await this.o.files.read(path+'/retry.json');
  if(retry){const v=parseCanonicalJson(retry);if(typeof v.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v.code)||!Number.isSafeInteger(v.until)||v.attempts!==undefined&&(!Number.isSafeInteger(v.attempts)||v.attempts<0||v.attempts>32))throw Error('invalid_schema');if(v.until>this.now())throw new BodyRetryDeferred(v.code);}
  const readLocal=async()=>{
   let raw:Uint8Array|undefined,witness:LocalBodyWitness|undefined;
   if(kind==='book'&&this.o.repository.readBookWitness){
    witness=await this.o.repository.readBookWitness(id,value as BookState);
   }else{
    raw=await this.o.repository.read(kind,id);
    if(raw){
     await this.o.repository.validate(kind,id,value,raw);
     witness={sha256:sha256Hex(raw),size:raw.length};
    }
   }
   if(!witness)return;
   if(witness.size>64*1024*1024)throw Error('body_channel_capacity_pending');
   if(carrierBodyRevision(kind,row.entityKey,witness.sha256)!==row.bodyRevision)throw Error('body_revision_changed');
   return {witness,raw};
  };
  let localFailure:unknown;
  const clearRetry=async()=>{if(retry)await this.o.files.writeAtomic(this.retryPath(entry),jsonBytes({version:1,code:'none',until:0,attempts:0}));};
  const findLocal=async()=>{
   try{return await readLocal();}
   catch(error){
    const code=(error as Error).message;if(fatalBodyCheck(code)||code==='body_channel_capacity_pending')throw error;
    localFailure=error;
   }
  };
  let local=await findLocal(),cursor='',last:unknown;
  for(;;){
   checkWindow();const page=await this.o.http.list(row.entityKey,row.bodyRevision,cursor);
   // A v1 commit can finish while the control request is in flight.
   checkWindow();local??=await findLocal();checkWindow();
   for(const c of page.carriers){
    try{
     if(local){
      // The signed ready descriptor is a backup check. The authenticated row
      // and our installed bytes already satisfy the local download need.
      await verifyCarrier(c.descriptor,this.o.scope,binding,this.o.signer,await this.carrierPublicKey(c.descriptor));
      const key=await this.o.key(c.descriptor.body.keyVersion);
      try{if(key.length!==32)throw Error('key_unavailable');}finally{key.fill(0);}
     }else{
      await this.receive(entry,anchor,c.descriptor,path,checkWindow,deadline);
     }
    }catch(error){
     last=error;
     if(fatalBodyCheck((error as Error).message)||(error as Error).message==='body_channel_bluetooth_pending')throw error;
     continue;
    }
    await clearRetry();
    if(local){
     await this.current(entry,anchor);checkWindow();const latest=await readLocal();checkWindow();
     if(latest?.witness.sha256!==local.witness.sha256||latest.witness.size!==local.witness.size)throw Error('body_revision_changed');
    }
    return;
   }
   if(page.nextAfter===null)break;
   cursor=page.nextAfter;
  }
  if(await this.o.localReceiving?.(binding))throw Error('body_channel_bluetooth_pending');
  if(last||!local)throw last??localFailure??Error('body_channel_pending');
  if(await this.o.receivedFromPeer?.(binding,local.witness.sha256))throw Error('body_channel_source_pending');
  let raw=local.raw;
  if(!raw){
   raw=await this.o.repository.read(kind,id);
   if(!raw||raw.length!==local.witness.size||sha256Hex(raw)!==local.witness.sha256)throw Error('body_revision_changed');
   await this.o.repository.validate(kind,id,value,raw);
  }
  let descriptor:Carrier|undefined;const key=await this.o.currentKey();
  try{
   const journal=await this.o.files.read(path+'/pending.json');
   if(journal){const candidate=parseCanonicalJson(journal) as Carrier;if(canonical(candidate.body.anchor)===canonical(anchor)&&candidate.body.keyVersion===key.version)descriptor=candidate;}
   if(!descriptor){
    const author=await this.o.author(),prepared=await prepareCarrier({crypto:this.o.crypto,signer:this.o.signer,alias:author.alias,authorDeviceId:author.deviceId,scope:this.o.scope,anchor,binding,key:key.key,keyVersion:key.version,objects:[{name:bodyObjectName(kind,id),bytes:raw,compress:false}]});
    for(const [hash,data]of prepared.objects)await this.o.files.writeAtomic(path+'/'+hash,data);
    descriptor=prepared.descriptor;await this.o.files.writeAtomic(path+'/pending.json',jsonBytes(descriptor));
   }
  }finally{key.key.fill(0);}
  await this.current(entry,anchor);checkWindow();
  if(await this.o.localReceiving?.(binding))throw Error('body_channel_bluetooth_pending');
  if(await this.o.receivedFromPeer?.(binding,local.witness.sha256))throw Error('body_channel_source_pending');
  const latest=await readLocal();checkWindow();
  if(latest?.witness.sha256!==local.witness.sha256||latest.witness.size!==local.witness.size)throw Error('body_revision_changed');
  await this.o.http.upload(descriptor,async hash=>{const b=await this.o.files.read(path+'/'+hash);checkWindow();if(!b)throw Error('closure_incomplete');return b;});await clearRetry();await this.current(entry,anchor);checkWindow();
 }
 private async carrierPublicKey(descriptor:Carrier){
  const key=await this.o.approved(descriptor.body.authorDeviceId);
  if(key.deviceId!==descriptor.body.authorDeviceId)throw Error('signature_invalid');
  return key.publicKey;
 }
 private async receive(entry:any,anchor:any,descriptor:Carrier,path:string,checkWindow:()=>void,deadline?:PublicationDeadline){
  const binding={entityKey:entry.row.entityKey,bodyRevision:entry.row.bodyRevision,kind:entry.meta.kind,logicalId:entry.meta.logicalId};
  const checkTransfer=async()=>{
   checkWindow();
   if(await this.o.localReceiving?.(binding))throw Error('body_channel_bluetooth_pending');
   checkWindow();
  };
  await checkTransfer();
  const decoded=await openCarrier({descriptor,scope:this.o.scope,binding,crypto:this.o.crypto,signer:this.o.signer,publicKey:await this.carrierPublicKey(descriptor),key:this.o.key,yieldControl:async()=>{await this.o.check();await this.o.yieldControl?.();checkWindow();},read:async(hash,size)=>{await checkTransfer();return this.o.http.download(descriptor.body.carrierId,hash,size,this.o.files,path+'/'+hash,checkTransfer);}});
  const raw=decoded.get(bodyObjectName(binding.kind,binding.logicalId))!;
  const value=fromWire(entry.meta.kind,entry.meta.payload,entry.state.payload);
  await this.o.repository.validate(binding.kind,binding.logicalId,value,raw);
  const incomingHash=sha256Hex(raw);
  // Recheck the installed original after the download, before publication.
  await this.current(entry,anchor);
  let installedHash:string|undefined;
  try{
   if(binding.kind==='book'&&this.o.repository.readBookWitness){
    installedHash=(await this.o.repository.readBookWitness(binding.logicalId,value as BookState))?.sha256;
   }else{
    const old=await this.o.repository.read(binding.kind,binding.logicalId);
    if(old)installedHash=sha256Hex(old);
   }
  }catch(error){if(binding.kind!=='book'||(error as Error).message!=='cloud_book_package_changed')throw error;}
  checkWindow();
  if(installedHash===incomingHash)return;
  if(binding.kind==='book'&&installedHash)throw Error('body_revision_changed');
  await this.current(entry,anchor);await checkTransfer();
  await this.o.repository.install(binding.kind,binding.logicalId,raw,null,deadline);await this.current(entry,anchor);checkWindow();
 }
}
