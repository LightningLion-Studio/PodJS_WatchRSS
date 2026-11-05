/** Durable index publication journal. No body worker or account-choice apply. */
import {canonical,jsonBytes,parseCanonicalJson,bytes,hexId,oid,exact,checkD64,compareD64,nextD64,digest,uint,type Scope} from './protocol';
import {hex} from '@podjs/framework/crypto';
import {b64,unb64,indexRow,sameScope} from './wire';
import {sealV2,objectOid,type EnvelopeCrypto} from './sealed';
import {signCommit,signControl,verifyCommit,type SigningPort} from './signing';
import {readConflicts} from './notes-conflict';
import {conflictSet,mergeConflicts} from './note-conflict-set';
import {buildTree,updateTree} from './merkle';
import type {WatchProjectionStore} from './store';
import type {SyncState} from './state';
import {SyncV2Http,SyncV2Error} from './http';
const copy=<T>(x:T):T=>JSON.parse(canonical(x));
export class WatchIndexPublisher {
 private flushing?:Promise<any>;
 constructor(private readonly store:WatchProjectionStore,private readonly http:SyncV2Http,private readonly crypto:EnvelopeCrypto&SigningPort,private readonly keys:{id:Uint8Array;content:Uint8Array;version:number},private readonly now:()=>number=Date.now){}
 /** Reserve the author sequence before any signing. Crashes may leave gaps. */
 async prepare(deviceId:string,alias:string,own:{commitOid:string|null;revision:string},requestId:string){
  if(!this.http.indexWrite)throw Error('feature_disabled');await this.http.capabilities();hexId(deviceId,32);hexId(requestId,32);checkD64(own.revision);if(own.commitOid!==null)oid(own.commitOid,'commit');
  let before=await this.store.readState();if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(before.pendingChoice)throw Error('choice_pending');if(before.account&&before.editBase.generation!==before.account.generation)throw Error('rollback_conflict');
  const saved=before.cloud??{deviceSequence:'0',current:null,pins:{accountOid:null,authors:{},seenOids:[]},headers:{},cursor:'0',pendingPublish:null};if(saved.pendingPublish)throw Error('publication_pending');
  if((await this.store.checkpoint())?.phase!=='complete')throw Error('projection_incomplete');
  let sequence=saved.deviceSequence??'0';if(own.commitOid){const value=parseCanonicalJson(await this.http.object(own.commitOid)),publicKey=b64(await this.crypto.signingKey(alias));const body=await verifyCommit(this.crypto,publicKey,value,own.commitOid,this.http.scope);if(body.authorDeviceId!==deviceId)throw Error('signature_invalid');if(compareD64(body.deviceSequence,sequence)>0)sequence=body.deviceSequence;}
  sequence=nextD64(sequence);const reserved=copy(before);reserved.cloud={...saved,deviceSequence:sequence};await this.store.controlUpdate(before,reserved);before=reserved;
  const objects=new Map<string,Uint8Array>(),rows=new Map<string,any>(),currentRows=new Map<string,any>(),changedRows:any[]=[];
  if(saved.current?.treeRoot){let after='';for(;;){const page=await this.store.cloudRows(saved.current.treeRoot,after,32);if(!page.length)break;for(const r of page){rows.set(r.row.entityKey,r.row);currentRows.set(r.row.entityKey,r);}after=page.at(-1).row.entityKey;}}
  let after='';for(;;){const page=await this.store.candidatePage(after,32);if(!page.length)break;for(const entry of page){
   const c=copy(entry.candidate),existing=currentRows.get(entry.entityKey);
   if(existing&&c.meta.kind==='note'){
    if(existing.meta.kind!=='note'||existing.meta.logicalId!==c.meta.logicalId)throw Error('identity_conflict');
    const context={entityKey:entry.entityKey,noteId:c.meta.logicalId},local=readConflicts(c.state,context,['note-conflicts.v1']),remote=readConflicts(existing.state,context,['note-conflicts.v1']);
    if(local||remote){c.state.payload.noteConflicts=mergeConflicts(context.noteId,local??conflictSet(context.noteId,[]),remote??conflictSet(context.noteId,[]));c.state.requiredFeatures=[...new Set([...c.state.requiredFeatures,'note-conflicts.v1'])].sort();}
   }
   if(existing&&canonical(existing.meta)===canonical(c.meta)&&canonical(existing.state)===canonical(c.state)&&existing.row.addedAtMillis===c.addedAtMillis)continue;
   const meta=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'meta',this.keys.version,jsonBytes(c.meta)),state=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'state',this.keys.version,jsonBytes(c.state));
   if(c.state.noteSegments.length)throw Error('unsupported_feature');objects.set(meta.oid,meta.bytes);objects.set(state.oid,state.bytes);
   const refs=await signControl(this.crypto,alias,'wrss.sync.v2/state-refs-sign',{scope:this.http.scope,stateOid:state.oid,segmentOids:[]}),refsRaw=jsonBytes(refs);objects.set(objectOid('state-refs',refsRaw),refsRaw);
   const hasBody=['article','book','asset'].includes(c.meta.kind),old=rows.get(entry.entityKey),bodyRevision=hasBody?hex(await this.crypto.random(16)):null,promiseId=hasBody?hex(await this.crypto.random(16)):null;
   const row={entityKey:entry.entityKey,metaOid:meta.oid,stateOid:state.oid,addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,bodyRevision,promiseId,recipeOid:null,opaqueContentId:null,contentBytes:null,requiredFeatures:[]};
   // No unproved field merge: an advanced account must be reconciled by the frozen
   // business adapter before replacing an overlapping authenticated row.
   if(old&&before.account&&before.editBase.accountOid!==before.account.oid)throw Error('merge_unavailable');
   indexRow(row);rows.set(entry.entityKey,row);changedRows.push(row);
  }after=page.at(-1)!.entityKey;}
  const tree=saved.current?.treeRoot?await updateTree(this.http.scope,saved.current.treeRoot,id=>this.http.object(id),changedRows):buildTree(this.http.scope,[...rows.values()]);for(const [id,raw]of tree.nodes)objects.set(id,raw);
  const now=this.now(),body={version:2,scope:this.http.scope,authorDeviceId:deviceId,deviceSequence:sequence,previousOwnCommit:own.commitOid,mergedParents:[],treeRoot:tree.oid,requiredFeatures:[],createdAtMillis:now,observedRefs:[],indexComplete:true,accountParent:before.account?.oid??null,rollbackGeneration:before.rollbackGeneration,operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null}},commit=await signCommit(this.crypto,alias,body);
  objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
  const common={version:2,scope:this.http.scope,newCommitOid:commit.oid,requestId,issuedAtMillis:now,expiresAtMillis:now+300000};
  const account=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/account/current',expectedOid:before.account?.oid??null,expectedRevision:before.account?.revision??'0'}),device=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/devices/'+deviceId+'/index',expectedOid:own.commitOid,expectedRevision:own.revision});
  await this.store.stageUpload(requestId,objects);const latest=await this.store.readState();if(latest.localChangeRevision!==before.localChangeRevision||canonical(latest.account)!==canonical(before.account)||latest.pendingChoice)throw Error('choice_stale');
  const next=copy(latest);next.cloud={...latest.cloud,pendingPublish:{requestId,commitOid:commit.oid,treeRoot:tree.oid,request:{account,device,relayGrant:null},capturedLocalRevision:before.localChangeRevision,phase:'queued'}};
  await this.store.controlUpdate(latest,next);return {commitOid:commit.oid,objects:objects.size,rows:rows.size,deviceSequence:sequence};
 }
 private async pending(){const before=await this.store.readState(),plan=before.cloud?.pendingPublish;if(!plan)throw Error('publication_missing');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(before.pendingChoice||plan.capturedLocalRevision!==before.localChangeRevision||plan.request.account.body.expectedOid!==(before.account?.oid??null)||plan.request.account.body.expectedRevision!==(before.account?.revision??'0'))throw Error('choice_stale');return {before,plan};}
 /** A response-lost retry queries the original request ID before touching refs. */
 flush(){return this.flushing??=this.flushOnce().finally(()=>{this.flushing=undefined;});}
 private async flushOnce(){
  await this.http.capabilities();const {plan}=await this.pending(),known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  if(this.now()>plan.request.account.body.expiresAtMillis+30000)throw Error('publication_expired');
  const window=await this.http.negotiate([],[]);let after='';for(;;){const page=await this.store.uploadPage(plan.requestId,after,1);if(!page.length)break;for(const object of page){
   if(object.oid.startsWith('state-refs:'))continue;
   const have=await this.http.json('POST','/objects/have-want',{scope:this.http.scope,windowId:window.windowId,oids:[object.oid]});const status=have.objects?.[0];if(status?.oid!==object.oid)throw Error('invalid_schema');let offset=0;
   if(status.status==='present'||status.status==='partial'){await this.http.servicePin!.receipt(this.crypto,status.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),status.status==='present');offset=status.durableOffset;if(offset!==status.receipt.body.durableOffset)throw Error('invalid_schema');if(status.status==='present')continue;}
   else if(status.status!=='missing')throw Error('invalid_schema');
   const reserve=async(requestId:string)=>this.http.json('POST','/objects/reserve',{scope:this.http.scope,requestId,channel:'control',objects:[{oid:object.oid,totalBytes:object.bytes.length}],leaseMillis:600000});
   let reservation=await reserve(digest([plan.requestId,'reserve',object.oid]).slice(0,32));uint(reservation.expiresAtMillis);
   // Request replay preserves the original lease deadline. Renew the lease with
   // a fresh reservation ID, while retaining the signed publication and bytes.
   if(reservation.expiresAtMillis<=this.now())reservation=await reserve(hex(await this.crypto.random(16)));
   uint(reservation.expiresAtMillis);if(reservation.expiresAtMillis<=this.now())throw Error('reservation_expired');hexId(reservation.reservationId,32);
   if(reservation.objects?.[0]?.oid!==object.oid||reservation.objects[0].totalBytes!==object.bytes.length||reservation.objects[0].durableOffset!==offset)throw Error('offset_conflict');
   for(;offset<object.bytes.length;){await this.pending();const part=object.bytes.subarray(offset,offset+65536),r=await this.http.putPart(object.oid,offset,reservation.reservationId,digest([plan.requestId,object.oid,offset]).slice(0,32),part);await this.http.servicePin!.receipt(this.crypto,r.receipt,this.http.scope,object.oid,object.bytes.length,this.now());if(r.durableOffset!==offset+part.length||r.receipt.body.durableOffset!==r.durableOffset)throw Error('offset_conflict');offset=r.durableOffset;}
   const complete=await this.http.json('POST','/objects/'+encodeURIComponent(object.oid)+'/complete',{scope:this.http.scope,reservationId:reservation.reservationId,requestId:digest([plan.requestId,'complete',object.oid]).slice(0,32),totalBytes:object.bytes.length});await this.http.servicePin!.receipt(this.crypto,complete.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),true);
  }after=page.at(-1)!.oid;}
  let refsAfter='';for(;;){const page=await this.store.uploadPage(plan.requestId,refsAfter,1);if(!page.length)break;for(const item of page)if(item.oid.startsWith('state-refs:')){await this.pending();await this.http.json('POST','/state-refs',parseCanonicalJson(item.bytes));}refsAfter=page.at(-1)!.oid;}
  await this.pending();let result;try{result=await this.http.publish(plan.request);}catch(error){
   if(error instanceof SyncV2Error&&error.code==='ref_conflict'){const before=await this.store.readState();if(before.cloud?.pendingPublish?.requestId===plan.requestId){const next=copy(before);next.cloud.pendingPublish.phase='conflicted';await this.store.controlUpdate(before,next);}}throw error;
  }return this.accept(plan,result);
 }
 /** Only a definitive CAS rejection permits retiring a journal. Authenticate the
  * new account before retiring it; never change expected refs on a signed request.
  * Candidate edits and reserved author sequences survive the retry. */
 async retryAfterConflict(refresh:()=>Promise<void>){
  if(this.flushing)throw Error('publication_pending');let before=await this.store.readState(),plan=before.cloud?.pendingPublish;
  if(!plan||plan.phase!=='conflicted')throw Error('publication_pending');
  let known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  await refresh();before=await this.store.readState();
  if(before.cloud?.pendingPublish?.requestId!==plan.requestId||before.cloud.pendingPublish.phase!=='conflicted'||before.localChangeRevision!==plan.capturedLocalRevision||before.pendingChoice)throw Error('choice_stale');
  if(!before.account||before.cloud.pins.accountOid!==before.account.oid||before.account.generation!==before.rollbackGeneration||before.editBase.generation!==before.rollbackGeneration)throw Error('rollback_conflict');
  if(before.account.oid===plan.request.account.body.expectedOid&&before.account.revision===plan.request.account.body.expectedRevision)throw Error('ref_conflict');
  known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')throw Error('choice_stale');if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  const next=copy(before);next.cloud.pendingPublish=null;await this.store.finishUpload(before,next,plan.requestId);
 }
 /** An expired unknown outcome is not a response-loss acknowledgement. Resolve
  * the original request before and after refreshing, then retire only its journal.
  * The caller creates a new request; candidate data is never removed here. */
 async retryExpired(refresh:()=>Promise<void>){
  if(this.flushing)throw Error('publication_pending');const original=await this.store.readState(),plan=original.cloud?.pendingPublish;
  if(!plan||this.now()<=plan.request.account.body.expiresAtMillis+30000)throw Error('publication_pending');
  let known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  await refresh();const before=await this.store.readState();
  if(before.cloud?.pendingPublish?.requestId!==plan.requestId||before.localChangeRevision!==plan.capturedLocalRevision||before.pendingChoice)throw Error('choice_stale');
  if(before.account&&before.cloud?.pins?.accountOid!==before.account.oid||before.editBase.generation!==before.rollbackGeneration||plan.request.account.body.scope.contentGeneration!==this.http.scope.contentGeneration)throw Error('rollback_conflict');
  known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')throw Error('choice_stale');if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  const next=copy(before);next.cloud.pendingPublish=null;await this.store.finishUpload(before,next,plan.requestId);
 }
 private async accept(plan:any,result:any){
  if(result?.version!==2)throw Error('invalid_schema');sameScope(result.scope,this.http.scope);const a=result.account,d=result.device;if(a?.commitOid!==plan.commitOid||d?.commitOid!==plan.commitOid||d?.ref!==plan.request.device.body.ref||a.revision!==nextD64(plan.request.account.body.expectedRevision)||d.revision!==nextD64(plan.request.device.body.expectedRevision)||a.rollbackGeneration!==(await this.store.readState()).rollbackGeneration)throw Error('invalid_schema');checkD64(result.serverRevision);
  const {before}=await this.pending(),next=copy(before);next.hasUnsentEdits=false;next.acknowledgedLocalChangeRevision=plan.capturedLocalRevision;next.editBase={accountOid:plan.commitOid,generation:before.rollbackGeneration};next.cloud={...next.cloud,pendingPublish:null,lastPublication:{commitOid:plan.commitOid,localRevision:plan.capturedLocalRevision,result}};await this.store.finishUpload(before,next,plan.requestId);return result;
 }
}
