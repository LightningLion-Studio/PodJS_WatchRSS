/** C23 author-side delegation. Never gives the phone an author bearer token. */
import {canonical,exact,hexId,uint,jsonBytes,parseCanonicalJson,type Scope} from './protocol';
import {sameScope,sorted} from './wire';
import {anyObjectOid} from './local-objects';
import {verifyCommit,verifySigned,signControl,type SigningPort} from './signing';
import type {ApprovedKey} from './head-pins';
import type {WatchProjectionStore} from './store';
export class WatchRelayAuthor {
 constructor(private readonly options:{enabled?:boolean;scope:Scope;deviceId:string;alias:string;store:WatchProjectionStore;crypto:SigningPort;approved:(id:string)=>Promise<ApprovedKey>;cloudAuthorization:()=>Promise<void>;now:()=>number}){}
 async grant(relayDeviceId:string,objectOids:string[],grantId:string){
  const o=this.options;if(o.enabled!==true)throw Error('feature_disabled');hexId(relayDeviceId,32);hexId(grantId,32);hexId(o.deviceId,32);if(relayDeviceId===o.deviceId)throw Error('invalid_schema');sorted(objectOids,512,anyObjectOid);const objects=[...objectOids];
  await o.cloudAuthorization();const author=await o.approved(o.deviceId),relay=await o.approved(relayDeviceId);if(author.deviceId!==o.deviceId||relay.deviceId!==relayDeviceId)throw Error('member_unknown');
  const before=await o.store.readStableState(),plan=before.cloud?.pendingPublish;if(!plan||before.pendingChoice||before.cloud?.witnessConflict)throw Error('publication_missing');
  const ref=plan.request?.device;exact(ref,['body','signature']);sameScope(ref.body.scope,o.scope);if(ref.body.ref!=='refs/devices/'+o.deviceId+'/index'||ref.body.newCommitOid!==plan.commitOid)throw Error('signature_invalid');await verifySigned(o.crypto,author.publicKey,'wrss.sync.v2/ref-update-sign',ref.body,ref.signature);
  let commit:any,after='';const available=new Set<string>();for(;;){const page=await o.store.uploadPage(plan.requestId,after,1);if(!page.length)break;for(const entry of page){available.add(entry.oid);if(entry.oid===plan.commitOid)commit=parseCanonicalJson(entry.bytes);}after=page.at(-1)!.oid;}
  if(objects.some(id=>!available.has(id)))throw Error('object_missing');if(!commit)throw Error('object_missing');const b=await verifyCommit(o.crypto,author.publicKey,commit,plan.commitOid,o.scope);if(b.authorDeviceId!==o.deviceId)throw Error('signature_invalid');
  const now=o.now();uint(now);const body={version:2,scope:o.scope,authorDeviceId:o.deviceId,relayDeviceId,ref:ref.body.ref,commitOid:plan.commitOid,objectOids:objects,expiresAtMillis:now+600000,grantId};uint(body.expiresAtMillis);
  await o.cloudAuthorization();await o.approved(o.deviceId);await o.approved(relayDeviceId);if(canonical(before)!==canonical(await o.store.readStableState()))throw Error('choice_stale');
  const relayGrant=await signControl(o.crypto,o.alias,'wrss.sync.v2/relay-grant-sign',body);
  // Recheck after signing: a revocation or cloud logout cannot race delivery.
  await o.cloudAuthorization();await o.approved(o.deviceId);await o.approved(relayDeviceId);if(canonical(before)!==canonical(await o.store.readStableState()))throw Error('choice_stale');
  return {commit,device:JSON.parse(canonical(ref)),account:JSON.parse(canonical(plan.request.account)),relayGrant};
 }
}
