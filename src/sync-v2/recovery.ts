/** N07 local-only recovery. Recovery ciphertext never leaves the local store. */
import {ContentSha256} from '@podjs/framework/content-sha256';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import type {Statement} from '@podjs/framework/sql-projection';
import type {Resource} from '@podjs/framework/resource-journal';
import {canonical,digest,jsonBytes,parseCanonicalJson,bytes,hexId,oid,exact,uint,nextD64,compareD64,type Kind} from './protocol';
import {toWire} from './business';
import {checkCapture,type Capture,type SyncState} from './state';
import type {WatchProjectionStore,LocalCipher} from './store';
import type {WatchSpaceStore} from './space-store';
import {SEVEN_DAYS} from './eviction';
export type RecoveryValue={kind:Kind;value:Record<string,any>;bodyRefs:string[]};
export type RecoveryDelta={version:2;changes:({id:string;kind:'set';value:Record<string,any>}|{id:string;kind:'remove'})[];editBase:SyncState['editBase'];bodyRefs:string[]};
export type RecoveryCopy={copyId:string;header:any;nonce:string;ciphertext:string};
export type RecoveryPin={copyId:string;bodyRefs:string[];expiresAtMillis:number};
export type RecoveryEditPin={editId:string;localChangeRevision:string;copy:RecoveryCopy};
export type RecoveryFile={oid:string;path:string;offset:number;length:number;storedBytes:number};
export interface RecoveryPort {
 /** Independent per-account/repo local key. Never the cloud content key. */
 cipher:LocalCipher;randomId:()=>Promise<string>;trustedNow:()=>number|null;
 /** Must authenticate recipe edges/AEAD and return the exact necessary closure.
  * Raw bytes are hashed again below, before a recovery copy can be committed. */
 source:(refs:string[],changes:RecoveryDelta['changes'])=>Promise<{oid:string;size:number;read:(offset:number,length:number)=>Promise<Uint8Array>}[]>;
 /** Reserves worst-case persistent quota, released after commit or failure. */
 reserve:(bytes:number)=>Promise<()=>Promise<void>>;
 /** Authenticated CURRENT business rows + fresh SignedAvailability for every
  * necessary recipe/blob closure. No upload/lease/custody receipt can substitute. */
 acknowledge?:(delta:RecoveryDelta,read:(ref:string)=>Promise<Uint8Array[]>,check?:()=>Promise<void>)=>Promise<{expiresAtMillis:number}>;
}
/** Recovery uses the authenticated v2 business representation: fractional
 * runtime reading progress is stored as exact integer micros, per section 14. */
export function recoveryBusiness(kind:Kind,value:Record<string,any>){
 let input=value;if(Object.hasOwn(value,'readingProgressMicros')){if(Object.hasOwn(value,'readingProgress'))throw Error('invalid_schema');uint(value.readingProgressMicros,1000000);input={...value,readingProgress:value.readingProgressMicros/1000000};delete input.readingProgressMicros;}
 const wire=toWire(kind,input);return {...wire.meta,...wire.state};
}
export function recoveryDelta(local:Record<string,RecoveryValue>,cloud:Record<string,RecoveryValue>,editBase:SyncState['editBase'],capturedKeys?:string[]):RecoveryDelta {
 const keys=capturedKeys??[...new Set([...Object.keys(local),...Object.keys(cloud)])],changes:RecoveryDelta['changes']=[],refs=new Set<string>();
 if(new Set(keys).size!==keys.length)throw Error('invalid_schema');
 for(const id of [...keys].sort()){
  hexId(id,64);const l=local[id],c=cloud[id];for(const entry of [l,c])if(entry){exact(entry,['kind','value','bodyRefs']);recoveryBusiness(entry.kind,entry.value);if(!Array.isArray(entry.bodyRefs))throw Error('invalid_schema');}
  if(canonical(l?{kind:l.kind,value:recoveryBusiness(l.kind,l.value)}:null)===canonical(c?{kind:c.kind,value:recoveryBusiness(c.kind,c.value)}:null))continue;
  if(l){changes.push({id,kind:'set',value:recoveryBusiness(l.kind,l.value)});for(const ref of l.bodyRefs){oid(ref,ref.split(':')[0]);if(!/^(recipe|blob):/.test(ref))throw Error('invalid_oid');refs.add(ref);}}
  else if(c)changes.push({id,kind:'remove'});
 }
 return {version:2,changes,editBase:{...editBase},bodyRefs:[...refs].sort()};
}
export class WatchRecovery {
 constructor(readonly projection:WatchProjectionStore,readonly cache:WatchSpaceStore,readonly ports:RecoveryPort){}
 async setKeep(enabled:boolean){const state=await this.projection.readState();await this.projection.controlUpdate(state,{...state,keepDiscardedLocalChanges7Days:enabled});}
 private async seal(header:any,value:any):Promise<RecoveryCopy>{const sealed=JSON.parse(await this.ports.cipher.seal(canonical(header),value));if(typeof sealed.nonceBase64!=='string'||typeof sealed.ciphertextBase64!=='string')throw Error('invalid_local_cipher');return {copyId:header.copyId,header,nonce:sealed.nonceBase64,ciphertext:sealed.ciphertextBase64};}
 async read(copy:RecoveryCopy):Promise<RecoveryDelta>{hexId(copy.copyId,32);if(copy.header.copyId!==copy.copyId||copy.header.domain!=='wrss.sync.v2/local-recovery'||copy.header.binding!==this.cache.binding)throw Error('authentication_required');return this.ports.cipher.open(canonical(copy.header),canonical({nonceBase64:copy.nonce,ciphertextBase64:copy.ciphertext}));}
 private async checkRecords(state:SyncState){
  const copies=state.recoveryCopies??[],pins=state.recoveryPins??[],ids=new Set<string>();if(copies.length!==pins.length)throw Error('recovery_inconsistent');
  for(const c of copies){hexId(c.copyId,32);if(ids.has(c.copyId)||c.copyId!==c.header.copyId)throw Error('recovery_inconsistent');ids.add(c.copyId);const pin=pins.filter(p=>p.copyId===c.copyId);if(pin.length!==1||pin[0].expiresAtMillis!==c.header.expiresAtMillis||c.header.expiresAtMillis!==c.header.createdAtMillis+SEVEN_DAYS)throw Error('recovery_inconsistent');const delta=await this.read(c);if(canonical(delta.bodyRefs)!==canonical(pin[0].bodyRefs))throw Error('recovery_inconsistent');}
  const edits=new Set<string>();for(const p of state.recoveryEditPins??[]){if(edits.has(p.editId)||p.editId!==digest({copyId:p.copy.copyId,revision:p.localChangeRevision})||compareD64(p.localChangeRevision,state.localChangeRevision)>0)throw Error('recovery_inconsistent');edits.add(p.editId);await this.read(p.copy);if(!await this.cache.journal.row('edit-recovery:'+p.editId))throw Error('recovery_inconsistent');}
 }
 /** The caller supplies already prepared business apply/ACK statements. All
  * changes, recovery reference and pins commit under the captured stateVersion.
  * This entry must be invoked only after explicit choices/cloud confirmation. */
 async applyCloud(input:{capture:Capture;local:Record<string,RecoveryValue>;cloud:Record<string,RecoveryValue>;capturedKeys?:string[];explicitCloudChoice:true;next:SyncState;statements:Statement[]}){
  if(input.explicitCloudChoice!==true)throw Error('choice_pending');const before=await this.projection.readState();checkCapture(before,input.capture);await this.checkRecords(before);
  const next={...input.next,recoveryCopies:[...before.recoveryCopies??[]],recoveryPins:[...before.recoveryPins??[]],recoveryClock:before.recoveryClock??0,recoveryEditPins:[...before.recoveryEditPins??[]]};
  // The caller cannot alter recovery references through next state.
  const delta=recoveryDelta(input.local,input.cloud,before.editBase,input.capturedKeys);
  if(!before.keepDiscardedLocalChanges7Days||!delta.changes.length){await this.projection.controlUpdate(before,next,input.statements);return null;}
  const now=this.ports.trustedNow();if(now===null||!Number.isSafeInteger(now)||now<(before.recoveryClock??0)||now>Number.MAX_SAFE_INTEGER-SEVEN_DAYS)throw Error('clock_unknown');
  const copyId=await this.ports.randomId();hexId(copyId,32);if(next.recoveryCopies.some(c=>c.copyId===copyId)||next.recoveryPins.some(p=>p.copyId===copyId))throw Error('idempotency_conflict');
  const sources=await this.ports.source(delta.bodyRefs,delta.changes);if(canonical(sources.map(s=>s.oid).sort())!==canonical(delta.bodyRefs))throw Error('closure_incomplete');
  let worst=jsonBytes(delta).length*3+16384;for(const source of sources){uint(source.size);if(source.size>266264)throw Error('object_too_large');worst+=source.size*3+16384;}
  const release=await this.ports.reserve(worst),resources:Resource[]=[],files:RecoveryFile[]=[];let committed=false;
  try{
   for(const source of sources){const hash=new ContentSha256();for(let at=0;at<source.size;at+=65536){const length=Math.min(65536,source.size-at),part=await source.read(at,length);if(part.length!==length)throw Error('closure_incomplete');hash.update(part);
     const id=digest({copyId,oid:source.oid,offset:at}),path=this.cache.binding+'/'+id+'.recovery',aad=canonical({domain:'wrss.sync.v2/local-recovery-body',binding:this.cache.binding,copyId,oid:source.oid,offset:at,length}),sealed=await this.ports.cipher.seal(aad,{dataBase64:encodeBase64(part)}),data=bytes(sealed);
     const resource={id,path,bytes:data.length};await this.cache.register([resource]);resources.push(resource);
     await this.cache.files.publish(path,data);const [roundtrip]=await this.cache.files.read([{path,offset:0,length:data.length}]);if(canonical(parseCanonicalJson(roundtrip))!==sealed)throw Error('storage_error');await this.ports.cipher.open(aad,sealed);
     files.push({oid:source.oid,path,offset:at,length,storedBytes:data.length});
    }if(source.oid.split(':sha256:')[1]!==hash.finish())throw Error('hash_mismatch');
   }
   const header={domain:'wrss.sync.v2/local-recovery',version:2,binding:this.cache.binding,copyId,createdAtMillis:now,expiresAtMillis:now+SEVEN_DAYS,localChangeRevision:before.localChangeRevision,accountOid:input.capture.accountOid},copy=await this.seal(header,delta);
   if(canonical(await this.read(copy))!==canonical(delta))throw Error('storage_error');
   // Body files are durable before state CAS. Uncommitted files carry no pin.
   next.recoveryCopies.push(copy);next.recoveryPins.push({copyId,bodyRefs:delta.bodyRefs,expiresAtMillis:header.expiresAtMillis});next.recoveryClock=now;
   const bodyRecord=await this.cache.cipher.seal(this.cache.aad('recovery-files:'+copyId),files),statements=[this.cache.journal.insert('recovery:'+copyId,'z:'+copyId,bodyRecord),...this.cache.journal.attach('recovery:'+copyId,resources.map(r=>r.id)),...input.statements];
   await this.projection.controlUpdate(before,next,statements);committed=true;return copy;
  }finally{await this.cache.unstage(resources);await release();if(!committed)try{await this.cache.collect();}catch{}}
 }
 /** Trusted time watermark is durable. Expiry removes ciphertext references and
  * pins at one CAS. Physical release follows the committed reference deletion. */
 async purgeRecovery(trustedNow:number|null){
  const before=await this.projection.readStableState();await this.checkRecords(before);if(trustedNow===null||!Number.isSafeInteger(trustedNow)||trustedNow<(before.recoveryClock??0))return {purged:0};
  const expired=(before.recoveryCopies??[]).filter(c=>c.header.expiresAtMillis<=trustedNow),ids=new Set(expired.map(c=>c.copyId));
  const next={...before,recoveryClock:trustedNow,recoveryCopies:(before.recoveryCopies??[]).filter(c=>!ids.has(c.copyId)),recoveryPins:(before.recoveryPins??[]).filter(p=>!ids.has(p.copyId))};
  const statements:Statement[]=[];for(const id of ids){statements.push(this.cache.journal.detach('recovery:'+id),{sql:'DELETE FROM podjs_resource_rows WHERE binding=? AND id=?',params:[this.cache.binding,'recovery:'+id]});}
  await this.projection.controlUpdateStable(before,next,statements);await this.releaseAcknowledgedEdits();const freed=await this.cache.collect();return {purged:expired.length,...freed};
 }
 /** Explicit user restore creates new pending edits under the current account.
  * The prepare callback returns SQL only; it must not mutate before the CAS. */
 async restoreAsEdits(copyId:string,prepare:(delta:RecoveryDelta)=>Promise<Statement[]>){
  const before=await this.projection.readState();await this.checkRecords(before);const copy=before.recoveryCopies?.find(c=>c.copyId===copyId);if(!copy||!before.account)throw Error('object_missing');const delta=await this.read(copy);
  for(const ref of delta.bodyRefs)await this.readBody(copy,ref);
  const statements=await prepare(delta),revision=nextD64(before.localChangeRevision),next={...before,localChangeRevision:revision,hasUnsentEdits:true,recoveryEditPins:[...before.recoveryEditPins??[]],editBase:before.hasUnsentEdits||before.pendingChoice?before.editBase:{accountOid:before.account.oid,generation:before.account.generation}};
  if(delta.bodyRefs.length){
   const row=await this.cache.journal.row('recovery:'+copyId);if(!row)throw Error('object_missing');
   const files:RecoveryFile[]=await this.cache.cipher.open(this.cache.aad('recovery-files:'+copyId),row.value),editId=digest({copyId,revision});
   // The descriptor retains the original copyId/AAD. It survives expiry of the
   // seven-day copy, independently of any other restore of that same copy.
   next.recoveryEditPins.push({editId,localChangeRevision:revision,copy});
   statements.push(...this.cache.journal.replace(row,row.value),this.cache.journal.insert('edit-recovery:'+editId,'z:edit:'+editId,row.value));
   for(let at=0;at<files.length;at+=32)statements.push(...this.cache.journal.attach('edit-recovery:'+editId,files.slice(at,at+32).map(f=>digest({copyId,oid:f.oid,offset:f.offset}))));
  }
  await this.projection.controlUpdate(before,next,statements);return delta.changes.length;
 }
 /** Explicit durable source for the restored edit, including after N07 expiry. */
 async readEditBody(editId:string,ref:string){const pin=(await this.projection.readStableState()).recoveryEditPins?.find(p=>p.editId===editId);if(!pin)throw Error('object_missing');return this.readPinnedBody(pin.copy,ref,'edit-recovery:'+editId);}
 async readBody(copy:RecoveryCopy,ref:string){
  if(await this.cache.journal.row('recovery:'+copy.copyId))return this.readPinnedBody(copy,ref,'recovery:'+copy.copyId);
  const pin=(await this.projection.readStableState()).recoveryEditPins?.find(p=>canonical(p.copy)===canonical(copy));if(!pin)throw Error('object_missing');return this.readEditBody(pin.editId,ref);
 }
 /** Only an uploaded revision AND current cloud closure acknowledgement can
  * retire an edit owner. Expiry and clearing hasUnsentEdits alone cannot. */
 async releaseAcknowledgedEdits(){
  if(!this.ports.acknowledge)return {released:0};let released=0;const initial=await this.projection.readStableState();await this.checkRecords(initial);
  for(const pin of initial.recoveryEditPins??[]){
   const before=await this.projection.readStableState();if(before.pendingChoice||before.hasUnsentEdits||!before.account||compareD64(before.acknowledgedLocalChangeRevision??'0',pin.localChangeRevision)<0)continue;
   if(!before.recoveryEditPins?.some(p=>canonical(p)===canonical(pin)))continue;
   const now=this.ports.trustedNow();if(now===null||!Number.isSafeInteger(now)||now<(before.recoveryClock??0))continue;
   const check=async()=>{if(canonical(before)!==canonical(await this.projection.readStableState()))throw Error('choice_stale');};
   let proof:{expiresAtMillis:number};try{proof=await this.ports.acknowledge(await this.read(pin.copy),ref=>this.readEditBody(pin.editId,ref),check);}catch{continue;}
   const current=this.ports.trustedNow();if(current===null||!Number.isSafeInteger(current)||current<now||!Number.isSafeInteger(proof.expiresAtMillis)||current>=proof.expiresAtMillis)continue;
   await this.projection.controlUpdateStable(before,{...before,recoveryEditPins:before.recoveryEditPins.filter(p=>p.editId!==pin.editId)},[
    this.cache.journal.detach('edit-recovery:'+pin.editId),{sql:'DELETE FROM podjs_resource_rows WHERE binding=? AND id=?',params:[this.cache.binding,'edit-recovery:'+pin.editId]},
   ]);released++;
  }return {released};
 }
 private async readPinnedBody(copy:RecoveryCopy,ref:string,owner:string){
  const delta=await this.read(copy);if(!delta.bodyRefs.includes(ref))throw Error('object_missing');const row=await this.cache.journal.row(owner);if(!row)throw Error('object_missing');const files:RecoveryFile[]=await this.cache.cipher.open(this.cache.aad('recovery-files:'+copy.copyId),row.value),hash=new ContentSha256(),parts:Uint8Array[]=[];
  for(const f of files.filter(f=>f.oid===ref).sort((a,b)=>a.offset-b.offset)){const [data]=await this.cache.files.read([{path:f.path,offset:0,length:f.storedBytes}]),aad=canonical({domain:'wrss.sync.v2/local-recovery-body',binding:this.cache.binding,copyId:copy.copyId,oid:ref,offset:f.offset,length:f.length}),opened=await this.ports.cipher.open(aad,canonical(parseCanonicalJson(data))),part=decodeBase64(opened.dataBase64);if(part.length!==f.length||f.offset!==parts.reduce((n,p)=>n+p.length,0))throw Error('hash_mismatch');parts.push(part);hash.update(part);}
  if(ref.split(':sha256:')[1]!==hash.finish())throw Error('hash_mismatch');return parts;
 }
}
