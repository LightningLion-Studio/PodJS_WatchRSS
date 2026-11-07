/** C19/C24: a signed persistent peer obligation, distinct from local ACKs. */
import {canonical,digest,exact,hexId,oid,uint,type Scope} from './protocol';
import {sameScope} from './wire';
import {verifySigned,type SigningPort} from './signing';
import type {ApprovedKey} from './head-pins';
import type {WatchContentStore} from './content-store';
import type {LocalProofSession} from './local-proof';
export type CustodyExpected={scope:Scope;entityKey:string;bodyRevision:string;recipeOid:string;blobOids:string[]};
export function custodyBody(b:any,scope:Scope){
 exact(b,['version','scope','pinId','holderDeviceId','claimantDeviceId','entityKey','bodyRevision','recipeOid','blobOidsHash','createdAtMillis']);
 sameScope(b.scope,scope);if(b.version!==2||b.holderDeviceId===b.claimantDeviceId)throw Error('invalid_schema');for(const f of ['pinId','holderDeviceId','claimantDeviceId','bodyRevision'])hexId(b[f],32);hexId(b.entityKey,64);hexId(b.blobOidsHash,64);oid(b.recipeOid,'recipe');uint(b.createdAtMillis);return b;
}
export class PeerCustodyStore {
 constructor(readonly store:WatchContentStore,readonly scope:Scope,readonly claimant:string,private readonly crypto:SigningPort,private readonly approved:(id:string)=>Promise<ApprovedKey>){hexId(claimant,32);}
 private async verify(value:any){
  exact(value,['body','signature']);const b=custodyBody(value.body,this.scope);if(b.claimantDeviceId!==this.claimant)throw Error('scope_mismatch');
  const key=await this.approved(b.holderDeviceId);if(key.deviceId!==b.holderDeviceId)throw Error('member_unknown');await verifySigned(this.crypto,key.publicKey,'wrss.sync.v2/custody-pin-sign',b,value.signature);return b;
 }
 async accept(value:any,session:LocalProofSession){
  if(!session.verified||session.hello.deviceId!==this.claimant)throw Error('proof_invalid');const copy=JSON.parse(canonical(value)),b=await this.verify(copy);if(!session.verified||session.peerDeviceId!==b.holderDeviceId||canonical(session.hello.scope)!==canonical(this.scope))throw Error('proof_invalid');
  const id='custody-id:'+b.pinId,old=await this.store.get(id);
  if(old){if(canonical(old.value.body)!==canonical(b))throw Error('idempotency_conflict');return old.value;}
  const valueId='custody-for:'+b.entityKey+':'+b.bodyRevision+':'+b.pinId,record={...copy,state:'active'};
  try{await this.store.putMany([{id,value:record,expected:null},{id:valueId,value:record,expected:null}]);}
  catch(e){const winner=await this.store.get(id);if(!winner)throw e;if(canonical(winner.value.body)!==canonical(b))throw Error('idempotency_conflict');return winner.value;}
  return record;
 }
 async authorize(expected:CustodyExpected,check?:()=>Promise<void>){
  sameScope(expected.scope,this.scope);hexId(expected.entityKey,64);hexId(expected.bodyRevision,32);oid(expected.recipeOid,'recipe');if(expected.blobOids.length>2048)throw Error('object_too_large');for(const id of expected.blobOids)oid(id,'blob');
  const prefix='custody-for:'+expected.entityKey+':'+expected.bodyRevision+':';let after='';
  for(;;){await check?.();const page=await this.store.page(after,32,prefix);if(!page.length)throw Error('custody_missing');for(const row of page){const record=row.value;if(record.state!=='active')continue;
    const b=await this.verify({body:record.body,signature:record.signature});if(b.recipeOid!==expected.recipeOid||b.blobOidsHash!==digest(expected.blobOids))continue;
    const authoritative=await this.store.get('custody-id:'+b.pinId);if(!authoritative||authoritative.value.state!=='active'||canonical(authoritative.value.body)!==canonical(b))throw Error('custody_missing');await check?.();
    return {kind:'peer-custody',scope:this.scope,entityKey:b.entityKey,bodyRevision:b.bodyRevision,recipeOid:b.recipeOid,receipt:{body:b,signature:record.signature},validUntil:Number.MAX_SAFE_INTEGER};
   }after=page.at(-1)!.id;}
 }
}
