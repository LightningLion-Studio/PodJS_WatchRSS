/** Explicit P3B controller. No timers, startup registration, or UI text. */
import {ContentSha256} from '@podjs/framework/content-sha256';
import type {Statement} from '@podjs/framework/sql-projection';
import {eligible} from './eviction';
import {WatchSpaceStore,type CachedBody} from './space-store';
import {signedAvailability} from './service-key';
import {canonical,digest,hexId,oid,uint} from './protocol';
import type {WatchContentHttp} from './content-http';
import type {WatchProjectionStore} from './store';
import type {SyncState} from './state';
export interface SpaceProofInput {accountOid:string;blobOids:string[];recipeOid:string;entityKey:string;bodyRevision:string;scope:unknown;keyVersion:number;authenticated:boolean;}
export interface SpacePorts {
 /** Authenticated current row + previously decrypted/verified local recipe. */
 localProof:(body:CachedBody)=>Promise<SpaceProofInput>;
 remote:WatchContentHttp;projection:WatchProjectionStore;
 capacity:()=>Promise<number|null>;trustedNow:()=>number|null;monotonic?:()=>number;
 detach?:(body:CachedBody)=>Promise<Statement[]>;
 event?:(event:{type:'space-insufficient';needed:number;freed:number})=>void;
}
export class WatchSpaceV2 {
 private active=false;
 constructor(readonly store:WatchSpaceStore,readonly ports:SpacePorts){}
 async runWindow(requiredFree:number,budgetMillis=1000){if(this.active)return {status:'busy',freed:0,scanned:0};this.active=true;try{return await this.run(requiredFree,budgetMillis);}finally{this.active=false;}}
 private async run(requiredFree:number,budgetMillis:number){
  uint(requiredFree);if(!await this.store.enabled())return {status:'disabled',freed:0,scanned:0};
  const now=this.ports.trustedNow();if(!await this.store.trustedTime(now))return {status:'clock-unknown',freed:0,scanned:0};
  const available=await this.ports.capacity();if(available===null||!Number.isSafeInteger(available)||available<0)return {status:'space-unknown',freed:0,scanned:0};
  const needed=Math.max(0,requiredFree-available);if(!needed)return {status:'sufficient',freed:0,scanned:0};
  const clock=this.ports.monotonic??Date.now,start=clock();let freed=0,scanned=0,after='';
  // Resume durable deletions first. No source/body read occurs in this scan.
  freed+=await this.collectNeeded(needed-freed,start,budgetMillis,clock);
  while(freed<needed){if(clock()-start>=budgetMillis)return {status:'budget',freed,scanned};const page=await this.store.journal.page(after,32);if(!page.length)break;
   for(const row of page){after=row.sort;if(row.id.startsWith('recovery:'))continue;scanned++;if(clock()-start>=budgetMillis)return {status:'budget',freed,scanned};const body=await this.store.open(row);if(body.status!=='ready'||!eligible(body.item,now!))continue;
    const captured=await this.ports.projection.readState();let proof:any;
    try{proof=await this.authorize(body,captured,now!);}catch{continue;}
    const finalNow=this.ports.trustedNow();if(finalNow===null||finalNow<now!||finalNow>=proof.receipt.body.expiresAtMillis)return {status:'proof-expired',freed,scanned};
    const value=await this.store.seal(row.id,{...body,status:'placeholder',proof});
    // Business changes and opens are fenced by stateVersion + row revision.
    try{await this.ports.projection.controlUpdate(captured,{...captured},[...this.store.placeholder(row,value,now!),...await this.ports.detach?.(body)??[]]);}catch(error){if(/choice_stale|CHECK constraint failed/.test(String(error)))continue;throw error;}
    freed+=await this.collectNeeded(needed-freed,start,budgetMillis,clock);if(freed>=needed)break;
   }
  }
  if(freed<needed)this.ports.event?.({type:'space-insufficient',needed,freed});return {status:freed>=needed?'sufficient':'insufficient',freed,scanned};
 }
 /** Re-authenticate every resumed deletion. A persisted old receipt never
  * grants a later GC window permission to remove the last physical bytes. */
 private async collectNeeded(needed:number,start:number,budget:number,clock:()=>number){let freed=0;while(freed<needed&&clock()-start<budget){const result=await this.collect();freed+=result.freed;if(result.files<32)break;}return freed;}
 async collect(){return this.store.collect(async resources=>{
  const state=await this.ports.projection.readState(),ids:string[]=[],guards:Statement[]=[],checked=new Map<string,boolean>(),now=this.ports.trustedNow();let expires=Number.MAX_SAFE_INTEGER;
  for(const resource of resources){if(!resource.authority){ids.push(resource.id);continue;}
   if(!checked.has(resource.authority)){let accepted=false;const row=await this.store.journal.row(resource.authority);
    if(row&&now!==null&&await this.store.trustedTime(now)){const body=await this.store.open(row);if(body.status==='placeholder'&&eligible(body.item,now))try{const proof=await this.authorize(body,state,now);expires=Math.min(expires,proof.receipt.body.expiresAtMillis);guards.push(...this.store.journal.replace(row,row.value),this.store.guard(now),{sql:'DELETE FROM podjs_sql_cas_guard'});accepted=true;}catch{}}
    checked.set(resource.authority,accepted);
   }if(checked.get(resource.authority))ids.push(resource.id);
  }
  return {ids,commit:async statements=>{const current=this.ports.trustedNow();if(now===null||current===null||current<now||current>=expires)throw Error('proof_expired');await this.ports.projection.controlUpdate(state,{...state},[...guards,...statements]);}};
 });}
 private async authorize(body:CachedBody,state:SyncState,now:number){
  if(state.pendingChoice||!state.account)throw Error('choice_pending');const p=await this.ports.localProof(body),i=body.item;
  if(!p.authenticated||p.keyVersion<1||p.accountOid!==state.account.oid||p.entityKey!==i.entityKey||p.bodyRevision!==i.bodyRevision||p.recipeOid!==i.recipeOid||canonical(p.scope)!==canonical(i.scope))throw Error('closure_incomplete');
  hexId(p.entityKey,64);hexId(p.bodyRevision,32);oid(p.recipeOid,'recipe');if(p.blobOids.length>2048)throw Error('object_too_large');for(const id of p.blobOids)oid(id,'blob');
  // C17: /availability/check is the only network authorization. No lease/custody.
  const availability=await this.ports.remote.availability({...p});
  const current=this.ports.trustedNow();if(current===null||current<now)throw Error('clock_unknown');
  const receipt=availability.receipt,b=await signedAvailability(this.ports.remote.http.servicePin!,this.ports.remote.crypto,receipt,i.scope,p,current);
  if(b.status!=='cloud-ready'||b.expiresAtMillis<=current)throw Error('closure_incomplete');
  return {kind:'cloud-current',accountOid:p.accountOid,scope:i.scope,entityKey:i.entityKey,bodyRevision:i.bodyRevision,recipeOid:i.recipeOid,blobOidsHash:digest(p.blobOids),receipt};
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
