import {sha256Hex} from '@podjs/framework/crypto';
import type {SnapshotCrypto} from '../cloud/codec';
import type {CloudBlobStore} from '../cloud/cache';
import type {SigningPort} from './signing';
import type {ApprovedKey} from './head-pins';
import type {WatchProjectionStore} from './store';
import {fromWire} from './business';
import {canonical,digest,jsonBytes,parseCanonicalJson,type Scope} from './protocol';
import {BodyChannelHttp} from './body-channel-http';
import {prepareCarrier,openCarrier,carrierBodyRevision,bodyObjectName,type BodyBinding,type Carrier,type BodyKind} from './body-channel-codec';
import type {BodyResolver} from './publisher';
import {SyncV2Error} from './http';
import {businessBodyWitness,sameIndependentIdentity,tombstoneBodyDescription} from './body-binding';
export interface BodyChannelRepository {
 read(kind:BodyKind,id:string):Promise<Uint8Array|undefined>;
 /** Validates frozen book identity/fingerprint before any file installation. */
 validate(kind:BodyKind,id:string,value:Record<string,any>,bytes:Uint8Array):Promise<void>;
 install(kind:BodyKind,id:string,bytes:Uint8Array,expectedTargetSha256?:string|null):Promise<void>;
}
/** The v2 row carries a hash-bound placeholder, not a P3 recipe or cloud-ready. */
const bodyFields=['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'];
export function independentBodyResolver(repository:BodyChannelRepository,fallback:BodyResolver,onPending?:(code:string)=>void):BodyResolver{return async(entry,existing)=>{
 const tombstone=tombstoneBodyDescription(entry.candidate,existing);if(tombstone)return tombstone;
 const kind=entry.candidate.meta.kind;if(kind!=='book'&&kind!=='asset')return fallback(entry,existing);
 const prior=existing?.candidate??existing,description=existing?.manifest??existing?.row;
 const same=prior&&description&&description.bodyRevision!=null&&prior.state.payload.deleted!==true&&sameIndependentIdentity(kind,entry.candidate,prior),keep=()=>Object.fromEntries(bodyFields.map(k=>[k,description[k]])) as any;
 if(same&&description.recipeOid)return keep();
 try{const raw=await repository.read(kind,entry.candidate.meta.logicalId);
 if(!raw){if(same)return keep();onPending?.('body_channel_source_missing');throw Error('body_channel_source_missing');}
 await repository.validate(kind,entry.candidate.meta.logicalId,fromWire(kind,entry.candidate.meta.payload,entry.candidate.state.payload),raw);
 const bodyRevision=carrierBodyRevision(kind,entry.entityKey,sha256Hex(raw));if(same&&description.bodyRevision===bodyRevision)return keep();
 return {bodyRevision,promiseId:bodyRevision,recipeOid:null,opaqueContentId:null,contentBytes:null};
 }catch(error){if(['feature_disabled','cloud_account_busy','cloud_sync_suspended','body_channel_source_missing'].includes((error as Error).message))throw error;if(same)return keep();onPending?.((error as Error).message==='body_channel_capacity_pending'?'body_channel_capacity_pending':'body_channel_source_missing');throw Error('body_channel_source_missing');}
};}
class BodyRetryDeferred extends Error {}
/** Every source comes from an already authenticated current account tree.
 * Carrier success never advances a business ACK or rewrites a v2 row. */
export class WatchBodyChannel {
 constructor(private readonly o:{http:BodyChannelHttp;scope:Scope;projection:WatchProjectionStore;crypto:SnapshotCrypto;signer:SigningPort;author:()=>Promise<{deviceId:string;alias:string}>;approved:(id:string)=>Promise<ApprovedKey>;key:(v:number)=>Promise<Uint8Array>;currentKey:()=>Promise<{key:Uint8Array;version:number}>;files:CloudBlobStore;root:string;repository:BodyChannelRepository;check:()=>Promise<void>;now?:()=>number;yieldControl?:()=>Promise<void>}){}
 private now(){return (this.o.now??Date.now)();}
 private async current(entry:any,anchor:any){
  await this.o.check();const state=await this.o.projection.readState(),head=state.cloud?.current;
  if(!state.account||head?.commitOid!==state.account.oid||canonical({commitOid:state.account.oid,revision:state.account.revision,rollbackGeneration:state.account.generation})!==canonical(anchor))throw Error('choice_stale');
  const now=await this.o.projection.cloudRow(head.treeRoot,entry.row.entityKey);
  if(!now||now.row.deleted||canonical(now)!==canonical(entry))throw Error('body_revision_changed');
 }
 async hasWork(){
  const state=await this.o.projection.readState(),head=state.cloud?.current;if(!state.account||head?.commitOid!==state.account.oid)return false;
  let after='';for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)return false;if(page.some((entry:any)=>['book','asset'].includes(entry.meta.kind)&&!entry.row.deleted&&!entry.row.recipeOid))return true;after=page.at(-1).row.entityKey;}
 }
 /** Existing P6 random placeholders need a hash binding even when their
  * business metadata has not changed. Preserve all existing P3 recipes. */
 async needsPublication(){
  const state=await this.o.projection.readState(),head=state.cloud?.current;if(state.pendingChoice||state.cloud?.pendingPublish||!state.account||head?.commitOid!==state.account.oid)return false;
  let after='';for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)return false;
   for(const entry of page){const kind=entry.meta.kind;if(!['book','asset'].includes(kind)||entry.row.deleted||entry.row.recipeOid)continue;
    const c=await this.o.projection.readCandidate(entry.row.entityKey);if(!c||businessBodyWitness(kind,fromWire(kind,c.meta.payload,c.state.payload))!==businessBodyWitness(kind,fromWire(kind,entry.meta.payload,entry.state.payload)))continue;
    try{const raw=await this.o.repository.read(kind,entry.meta.logicalId);if(!raw)continue;await this.o.repository.validate(kind,entry.meta.logicalId,fromWire(kind,entry.meta.payload,entry.state.payload),raw);if(carrierBodyRevision(kind,entry.row.entityKey,sha256Hex(raw))!==entry.row.bodyRevision){const carriers=await this.o.http.list(entry.row.entityKey,entry.row.bodyRevision);if(!carriers.carriers.length)return true;}}catch{await this.o.check();}
   }after=page.at(-1).row.entityKey;
  }
 }
 async sync(){
  await this.o.check();const state=await this.o.projection.readState(),head=state.cloud?.current;
  if(!state.account||head?.commitOid!==state.account.oid)return {pending:0,errors:[] as string[]};
  const anchor={commitOid:state.account.oid,revision:state.account.revision,rollbackGeneration:state.account.generation};let after='',pending=0;const errors:string[]=[];
  for(;;){const page=await this.o.projection.cloudRows(head.treeRoot,after,16,262144);if(!page.length)break;
   for(const entry of page){if(!['book','asset'].includes(entry.meta.kind)||entry.row.deleted||entry.row.recipeOid)continue;
    try{await this.syncEntry(entry,anchor);const retry=this.retryPath(entry),old=await this.o.files.read(retry);if(old)await this.o.files.writeAtomic(retry,jsonBytes({version:1,code:'none',until:0,attempts:0}));}
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
 private async syncEntry(entry:any,anchor:any){
  const {meta,row}=entry,kind=meta.kind as BodyKind,id=meta.logicalId,binding:BodyBinding={kind,logicalId:id,entityKey:row.entityKey,bodyRevision:row.bodyRevision},value=fromWire(kind,meta.payload,entry.state.payload);
  if(value.deleted)throw Error('body_revision_changed');await this.current(entry,anchor);
  const path=this.o.root+'/'+binding.entityKey+'/'+binding.bodyRevision,retry=await this.o.files.read(path+'/retry.json');
  if(retry){const v=parseCanonicalJson(retry);if(typeof v.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v.code)||!Number.isSafeInteger(v.until)||v.attempts!==undefined&&(!Number.isSafeInteger(v.attempts)||v.attempts<0||v.attempts>32))throw Error('invalid_schema');if(v.until>this.now())throw new BodyRetryDeferred(v.code);}
  const raw=await this.o.repository.read(kind,id);
  if(raw){
   await this.o.repository.validate(kind,id,value,raw);
   if(carrierBodyRevision(kind,row.entityKey,sha256Hex(raw))!==row.bodyRevision)throw Error('body_revision_changed');
   // A verified matching carrier avoids duplicate randomized uploads after
   // restart. Foreign bytes are read only through the authenticated mapper.
   let cursor='';for(;;){const page=await this.o.http.list(row.entityKey,row.bodyRevision,cursor);
    for(const c of page.carriers){try{await this.receive(entry,anchor,c.descriptor,path,false);return;}catch(error){if(['feature_disabled','cloud_account_busy','cloud_sync_suspended','choice_stale'].includes((error as Error).message))throw error;}}
    if(page.nextAfter===null)break;cursor=page.nextAfter;
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
   await this.current(entry,anchor);await this.o.http.upload(descriptor,async hash=>{const b=await this.o.files.read(path+'/'+hash);if(!b)throw Error('closure_incomplete');return b;});await this.current(entry,anchor);return;
  }
  let cursor='',last:unknown;for(;;){const page=await this.o.http.list(row.entityKey,row.bodyRevision,cursor);
   for(const c of page.carriers){try{await this.receive(entry,anchor,c.descriptor,path,true);return;}catch(error){last=error;if(['feature_disabled','cloud_account_busy','cloud_sync_suspended','choice_stale'].includes((error as Error).message))throw error;}}
   if(page.nextAfter===null)break;cursor=page.nextAfter;
  }throw last??Error('body_channel_pending');
 }
 private async receive(entry:any,anchor:any,descriptor:Carrier,path:string,install:boolean){
  const binding={entityKey:entry.row.entityKey,bodyRevision:entry.row.bodyRevision,kind:entry.meta.kind,logicalId:entry.meta.logicalId},key=await this.o.approved(descriptor.body.authorDeviceId);
  if(key.deviceId!==descriptor.body.authorDeviceId)throw Error('signature_invalid');
  const decoded=await openCarrier({descriptor,scope:this.o.scope,binding,crypto:this.o.crypto,signer:this.o.signer,publicKey:key.publicKey,key:this.o.key,yieldControl:async()=>{await this.o.check();await this.o.yieldControl?.();},read:(hash,size)=>this.o.http.download(descriptor.body.carrierId,hash,size,this.o.files,path+'/'+hash)});
  const raw=decoded.get(bodyObjectName(binding.kind,binding.logicalId))!;await this.o.repository.validate(binding.kind,binding.logicalId,fromWire(entry.meta.kind,entry.meta.payload,entry.state.payload),raw);
  await this.current(entry,anchor);
  if(install){
   // Preserve concurrent offline bytes even when the account row is unchanged.
   const old=await this.o.repository.read(binding.kind,binding.logicalId);if(binding.kind==='book'&&old&&sha256Hex(old)!==sha256Hex(raw))throw Error('body_revision_changed');
   await this.o.repository.install(binding.kind,binding.logicalId,raw,old&&sha256Hex(old)===sha256Hex(raw)?sha256Hex(old):null);await this.current(entry,anchor);
  }
 }
}
