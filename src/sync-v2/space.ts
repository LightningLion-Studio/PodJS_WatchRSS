/** Explicit P3B controller. No timers, startup registration, or UI text. */
import {ResourceCollectionError} from '@podjs/framework/resource-journal';
import {ContentSha256} from '@podjs/framework/content-sha256';
import type {Statement} from '@podjs/framework/sql-projection';
import {eligible,nextEligibilityChange} from './eviction';
import {WatchSpaceStore,type CachedBody,type SpaceRound,type Examined} from './space-store';
import {signedAvailability} from './service-key';
import {canonical,digest,hexId,oid,uint,nextD64} from './protocol';
import type {WatchContentHttp} from './content-http';
import type {WatchProjectionStore} from './store';
import type {SyncState} from './state';
import type {PeerCustodyStore} from './peer-custody';
export interface SpaceProofInput {accountOid:string;blobOids:string[];recipeOid:string;entityKey:string;bodyRevision:string;scope:unknown;keyVersion:number;authenticated:boolean;}
export interface SpacePorts {
 /** Persistent-state read-only: current row + verified local recipe. No key/pin
  * initialization, reconciliation or cache publication. HTTP scratch belongs
  * to the bounded host pool; every request must await the supplied guard. */
 localProof:(body:CachedBody,check?:()=>Promise<void>)=>Promise<SpaceProofInput>;
 remote:WatchContentHttp;projection:WatchProjectionStore;
 peerCustody?:PeerCustodyStore;
 capacity:()=>Promise<number|null>;trustedNow:()=>number|null;monotonic?:()=>number;
 /** Prepare SQL only; the controller commits it with its round/state guards. */
 detach?:(body:CachedBody)=>Promise<Statement[]>;
 event?:(event:{type:'space-insufficient';needed:number;freed:number})=>void;
}
export class WatchSpaceV2 {
 private active=false;
 constructor(readonly store:WatchSpaceStore,readonly ports:SpacePorts){}
 async runWindow(requiredFree:number,budgetMillis=1000){if(this.active)return {status:'busy',freed:0,scanned:0};this.active=true;try{return await this.run(requiredFree,budgetMillis);}finally{this.active=false;}}
 private async run(requiredFree:number,budgetMillis:number){
  uint(requiredFree);if(!await this.store.enabled())return {status:'disabled',freed:0,scanned:0};
  const now=this.ports.trustedNow();if(!await this.store.timeValid(now))return {status:'clock-unknown',freed:0,scanned:0};
  let freed=0,scanned=0,session:SpaceRound;
  try{session=await this.store.beginRound(now!);}catch(error){if((error as Error).message==='round_stale')return {status:'candidates-changed',freed,scanned};throw error;}
  const clock=this.ports.monotonic??Date.now,start=clock();let pending:Examined[]=[];
  const flush=async()=>{if(pending.length){await this.store.markExamined(session,pending);pending=[];}};
  const finish=async(status:string)=>{await this.store.endRound(session);return {status,freed,scanned};};
  try{
   const available=await this.ports.capacity();if(available===null||!Number.isSafeInteger(available)||available<0)return await finish('space-unknown');
   const needed=Math.max(0,requiredFree-available);if(!needed)return await finish('sufficient');
   await this.collectNeeded(needed-freed,start,budgetMillis,clock,session,bytes=>{freed+=bytes;});
   while(freed<needed){
    if(clock()-start>=budgetMillis){await flush();return {status:'budget',freed,scanned};}
    const page=await this.store.uncheckedPage(session,now!,32);if(!page.length){const result=await finish('insufficient');this.ports.event?.({type:'space-insufficient',needed,freed});return result;}
    let first=true;for(const row of page){
     if(!first&&clock()-start>=budgetMillis){await flush();return {status:'budget',freed,scanned};}first=false;scanned++;
     const body=await this.store.open(row),checked={entityKey:row.id,version:row.revision,validUntil:body.status==='ready'?nextEligibilityChange(body.item,now!):null};
     if(body.status!=='ready'||!eligible(body.item,now!)){pending.push(checked);continue;}
     const captured=await this.ports.projection.readStableState();let proof:any;
     try{proof=await this.authorize(body,captured,now!,session);}catch{pending.push(checked);continue;}
     const finalNow=this.ports.trustedNow();if(finalNow===null||finalNow<now!||finalNow>=proof.validUntil)return await finish('proof-expired');
     const value=await this.store.seal(row.id,{...body,status:'placeholder',proof});
     try{await this.ports.projection.controlUpdateStable(captured,{...captured},[
      ...this.store.examineStatements(session,pending),...this.store.headGuard(session,row,finalNow),
      ...this.store.placeholder(row,value,finalNow),...await this.ports.detach?.(body)??[],
      ...this.store.examineStatements(session,[{entityKey:row.id,version:nextD64(row.revision),validUntil:null}]),
     ]);pending=[];}catch(error){if(/choice_stale|CHECK constraint failed/.test(String(error))){await flush();return {status:'candidates-changed',freed,scanned};}throw error;}
     await this.collectNeeded(needed-freed,start,budgetMillis,clock,session,bytes=>{freed+=bytes;});if(freed>=needed)return await finish('sufficient');
    }await flush();
   }return await finish('sufficient');
  }catch(error){if(/^(round_stale|choice_stale)$/.test((error as Error).message))return {status:'candidates-changed',freed,scanned};throw error;}
 }
 /** Re-authenticate every resumed deletion. A persisted old receipt never
  * grants a later GC window permission to remove the last physical bytes. */
 private async collectNeeded(needed:number,start:number,budget:number,clock:()=>number,session:SpaceRound,onFreed:(bytes:number)=>void){
  let completed=0;const record=(bytes:number)=>{completed+=bytes;onFreed(bytes);};
  while(completed<needed&&clock()-start<budget){let result;try{result=await this.collect(session);}catch(error){if(error instanceof ResourceCollectionError)record(error.completed.freed);throw error;}record(result.freed);if(result.files<32)break;}
 }
 async collect(session?:SpaceRound){
  // Invalid requests do no work in authorizers, including clock/key persistence.
  if(session&&!await this.store.isCurrentRound(session))throw Error('round_stale');
  return this.store.collect(async resources=>{
   let state=await this.ports.projection.readStableState();const ids:string[]=[],guards:Statement[]=[],checked=new Map<string,boolean>(),now=this.ports.trustedNow();let expires=Number.MAX_SAFE_INTEGER,hasAuthority=false;
   if(now===null||!await this.store.timeValid(now))throw Error('clock_unknown');
   for(const resource of resources){if(!resource.authority){ids.push(resource.id);continue;}
    if(!checked.has(resource.authority)){let accepted=false;const row=await this.store.journal.row(resource.authority);
     if(row){const body=await this.store.open(row);if(body.status==='placeholder'&&eligible(body.item,now))try{const proof=await this.authorize(body,state,now,session);expires=Math.min(expires,proof.validUntil);guards.push(...this.store.rowGuard(row));accepted=true;}catch{}}
     checked.set(resource.authority,accepted);hasAuthority ||=accepted;
    }if(checked.get(resource.authority))ids.push(resource.id);
   }
   return {ids,commit:async statements=>{
    const current=this.ports.trustedNow();if(current===null||!Number.isSafeInteger(current)||current<now||current>=expires)throw Error('proof_expired');const next={...state};
    try{await this.ports.projection.controlUpdateStable(state,next,[
     ...session?this.store.roundGuard(session):[],
     this.store.timeGuard(current),{sql:'DELETE FROM podjs_sql_cas_guard'},
     ...hasAuthority?[this.store.guard(current),{sql:'DELETE FROM podjs_sql_cas_guard'}]:[],
     ...guards,...statements,this.store.advanceClock(current),
    ]);state=next;}catch(error){if(session&&/choice_stale|CHECK constraint failed/.test(String(error)))throw Error('round_stale');throw error;}
   }};
  }).catch(error=>{if(session&&!(error instanceof ResourceCollectionError)&&/choice_stale|CHECK constraint failed/.test(String(error)))throw Error('round_stale');throw error;});
 }
 private async authorize(body:CachedBody,state:SyncState,now:number,session?:SpaceRound){
  const check=async()=>{if(session&&!await this.store.isCurrentRound(session))throw Error('round_stale');if(canonical(state)!==canonical(await this.ports.projection.readStableState()))throw Error('choice_stale');};
  await check();
  if(state.pendingChoice||!state.account)throw Error('choice_pending');const p=await this.ports.localProof(body,check),i=body.item;
  if(!p.authenticated||p.keyVersion<1||p.accountOid!==state.account.oid||p.entityKey!==i.entityKey||p.bodyRevision!==i.bodyRevision||p.recipeOid!==i.recipeOid||canonical(p.scope)!==canonical(i.scope))throw Error('closure_incomplete');
  hexId(p.entityKey,64);hexId(p.bodyRevision,32);oid(p.recipeOid,'recipe');if(p.blobOids.length>2048)throw Error('object_too_large');for(const id of p.blobOids)oid(id,'blob');
  // C19: a durable peer pin is independent of an online cloud receipt.
  // Local-received/applied receipts never enter this authorizer.
  if(this.ports.peerCustody){try{const proof=await this.ports.peerCustody.authorize({...p,scope:i.scope},check);await check();return proof;}catch{await check();}}
  await check();const availability=await this.ports.remote.availability({...p},true,check);
  await check();const current=this.ports.trustedNow();if(current===null||current<now)throw Error('clock_unknown');
  const receipt=availability.receipt,b=await signedAvailability(this.ports.remote.http.servicePin!,this.ports.remote.crypto,receipt,i.scope,p,current,true);
  if(b.status!=='cloud-ready'||b.expiresAtMillis<=current)throw Error('closure_incomplete');
  return {kind:'cloud-current',accountOid:p.accountOid,scope:i.scope,entityKey:i.entityKey,bodyRevision:i.bodyRevision,recipeOid:i.recipeOid,blobOidsHash:digest(p.blobOids),receipt,validUntil:b.expiresAtMillis};
 }
 /** Download into fresh immutable resources. Whole plaintext hash must match
  * before the same stable metadata is attached again. */
 async restore(id:string,download:(body:CachedBody)=>Promise<{resources:{id:string;path:string;bytes:number}[];read:(offset:number,length:number)=>Promise<Uint8Array>;size:number}>){
  const row=await this.store.journal.row(id);if(!row)throw Error('object_missing');const body=await this.store.open(row);if(body.status!=='placeholder')return;
  const next=await download(body),hash=new ContentSha256();uint(next.size);if(next.size!==body.item.localBytes)throw Error('hash_mismatch');
  for(let at=0;at<next.size;at+=65536){const n=Math.min(65536,next.size-at),part=await next.read(at,n);if(part.length!==n)throw Error('hash_mismatch');hash.update(part);}
  if(hash.finish()!==body.plaintextSha256)throw Error('hash_mismatch');
  try{for(let at=0;at<next.resources.length;at+=32)await this.store.register(next.resources.slice(at,at+32));
  const statements=[...this.store.journal.replace(row,await this.store.seal(id,{...body,status:'ready'})),...this.store.journal.attach('body:'+id,next.resources.map(r=>r.id))];await this.store.journal.db.transaction(statements);}finally{await this.store.unstage(next.resources);}
 }
}
