/** C22/C27 independent observations. These records never become accepted pins. */
import {authenticatePath,type ApprovedKey,type Pins} from './head-pins';
import {canonical,exact,jsonBytes,oid,digest,type Scope} from './protocol';
import {sameScope} from './wire';
import {objectOid} from './sealed';
import {verifyCommit,type SigningPort} from './signing';
import type {WatchContentStore} from './content-store';
import type {WatchProjectionStore} from './store';
import type {LocalProofSession} from './local-proof';
export class LocalWitnessStore {
 constructor(private readonly records:WatchContentStore,private readonly projection:WatchProjectionStore,private readonly scope:Scope,private readonly crypto:SigningPort,private readonly approved:(id:string)=>Promise<ApprovedKey>){}
 async receive(value:any,session:LocalProofSession){
  if(!session.verified)throw Error('proof_invalid');exact(value,['scope','head','headers']);sameScope(value.scope,this.scope);sameScope(session.hello.scope,this.scope);oid(value.head,'commit');
  if(!session.hello.features.includes('witness')||!session.peerFeatures.includes('witness'))throw Error('feature_missing');
  if(!Array.isArray(value.headers)||value.headers.length<1||value.headers.length>64||jsonBytes(value).length>262144)throw Error('object_too_large');
  const copy=JSON.parse(canonical(value)),headers=new Map<string,any>();
  for(const h of copy.headers){exact(h,['commitOid','headerOid','body','signature']);oid(h.commitOid,'commit');oid(h.headerOid,'commit-header');if(headers.has(h.commitOid))throw Error('invalid_schema');
   const key=await this.approved(h.body?.authorDeviceId);if(key.deviceId!==h.body.authorDeviceId)throw Error('member_unknown');await verifyCommit(this.crypto,key.publicKey,{body:h.body,signature:h.signature},h.commitOid,this.scope);if(objectOid('commit-header',jsonBytes({body:h.body,signature:h.signature}))!==h.headerOid)throw Error('hash_mismatch');headers.set(h.commitOid,h);
  }
  if(!headers.has(copy.head)||!session.verified)throw Error('proof_invalid');const before=await this.projection.readStableState(),pins:Pins=JSON.parse(canonical(before.cloud?.pins??{accountOid:before.lastSeenAccountOid,authors:{},seenOids:[]}));
  let continuity:string='extends-pin';try{await authenticatePath(this.crypto,this.scope,copy.head,pins,async id=>{const h=headers.get(id);if(h)return h;const saved=await this.projection.readHeader(id);if(saved)return saved;throw Error('ref_continuity_unavailable');},this.approved);}catch(e){const code=(e as Error).message;if(!['ref_continuity_unavailable','replay_detected'].includes(code))throw e;continuity=code;}
  if(!session.verified)throw Error('proof_invalid');const id='witness:'+session.peerDeviceId+':'+copy.head,prior=await this.records.get(id);if(prior){if(digest(prior.value.witness)!==digest(copy))throw Error('idempotency_conflict');return {accepted:true};}
  const next=JSON.parse(canonical(before));if(continuity!=='extends-pin')next.cloud={...next.cloud,witnessConflict:{head:copy.head,code:continuity}};
  await this.projection.controlUpdateStable(before,next,await this.records.prepareMany([{id,value:{witness:copy,continuity},expected:null}]));return {accepted:true};
 }
}
