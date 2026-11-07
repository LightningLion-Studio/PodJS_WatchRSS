/** Durable index publication journal. No body worker or account-choice apply. */
import {sameBusinessRevision} from './business-revision';
import {checkedResumeOffset} from './resume';
import {canonical,jsonBytes,parseCanonicalJson,bytes,hexId,oid,exact,checkD64,compareD64,nextD64,digest,uint,type Scope} from './protocol';
import {hex} from '@podjs/framework/crypto';
import {b64,unb64,indexRow,sameScope} from './wire';
import {sealV2,objectOid,type EnvelopeCrypto} from './sealed';
import {signCommit,signControl,verifyCommit,type SigningPort} from './signing';
import {fromWire} from './business';
import {readConflicts} from './notes-conflict';
import {conflictSet,mergeConflicts} from './note-conflict-set';
import {buildTree,updateTree} from './merkle';
import type {WatchProjectionStore} from './store';
import type {SyncState} from './state';
import {SyncV2Http,SyncV2Error} from './http';
const copy=<T>(x:T):T=>JSON.parse(canonical(x));
export interface BodyManifest {bodyRevision:string;promiseId:string|null;recipeOid:string|null;opaqueContentId:string|null;contentBytes:number|null;}
export type BodyResolver=(entry:any,existing:any)=>Promise<BodyManifest|null>;
export class WatchIndexPublisher {
 private flushing?:Promise<any>;
 constructor(private readonly store:WatchProjectionStore,private readonly http:SyncV2Http,private readonly crypto:EnvelopeCrypto&SigningPort,private readonly keys:{id:Uint8Array;content:Uint8Array;version:number},private readonly now:()=>number=Date.now,private readonly resolveBody?:BodyResolver){}
 private async ownHeader(id:string){
  const stored=await this.store.readHeader(id);if(stored)return stored;
  const page=await this.http.json('GET','/account/ancestry?head='+encodeURIComponent(id)+'&stop=null&limit=1');
  if(page.head!==id||page.headers?.[0]?.commitOid!==id)throw Error('ref_continuity_unavailable');return {body:page.headers[0].body,signature:page.headers[0].signature};
 }
 /** Reserve the author sequence before any signing. Crashes may leave gaps. */
 async prepare(deviceId:string,alias:string,own:{commitOid:string|null;revision:string},requestId:string){
  if(!this.http.indexWrite)throw Error('feature_disabled');await this.http.capabilities();hexId(deviceId,32);hexId(requestId,32);checkD64(own.revision);if(own.commitOid!==null)oid(own.commitOid,'commit');
  let before=await this.store.readState();if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(before.pendingChoice)throw Error('choice_pending');if(before.account&&before.editBase.generation!==before.account.generation)throw Error('rollback_conflict');
  const saved=before.cloud??{deviceSequence:'0',current:null,pins:{accountOid:null,authors:{},seenOids:[]},headers:{},cursor:'0',pendingPublish:null};if(saved.pendingPublish)throw Error('publication_pending');
  const checkpoint=await this.store.checkpoint();if(checkpoint?.phase!=='complete'||!sameBusinessRevision(checkpoint.businessRevision,before.businessRevision))throw Error('projection_incomplete');
  let sequence=saved.deviceSequence??'0';if(own.commitOid){const value=await this.ownHeader(own.commitOid),publicKey=b64(await this.crypto.signingKey(alias));const body=await verifyCommit(this.crypto,publicKey,value,own.commitOid,this.http.scope);if(body.authorDeviceId!==deviceId)throw Error('signature_invalid');if(compareD64(body.deviceSequence,sequence)>0)sequence=body.deviceSequence;}
  sequence=nextD64(sequence);const reserved=copy(before);reserved.cloud={...saved,deviceSequence:sequence};await this.store.controlUpdate(before,reserved);before=reserved;
  const objects=new Map<string,Uint8Array>(),rows=new Map<string,any>(),currentRows=new Map<string,any>(),changedRows:any[]=[];
  if(saved.current?.treeRoot){let after='';for(;;){const page=await this.store.cloudRows(saved.current.treeRoot,after,32);if(!page.length)break;for(const r of page){fromWire(r.meta.kind,r.meta.payload,r.state.payload);rows.set(r.row.entityKey,r.row);currentRows.set(r.row.entityKey,r);}after=page.at(-1).row.entityKey;}}
  let after='';for(;;){const page=await this.store.candidatePage(after,32);if(!page.length)break;for(const entry of page){
   const c=copy(entry.candidate),existing=currentRows.get(entry.entityKey);fromWire(c.meta.kind,c.meta.payload,c.state.payload);
   if(existing&&c.meta.kind==='note'){
    if(existing.meta.kind!=='note'||existing.meta.logicalId!==c.meta.logicalId)throw Error('identity_conflict');
    const context={entityKey:entry.entityKey,noteId:c.meta.logicalId},local=readConflicts(c.state,context,['note-conflicts.v1']),remote=readConflicts(existing.state,context,['note-conflicts.v1']);
    if(local||remote){c.state.payload.noteConflicts=mergeConflicts(context.noteId,local??conflictSet(context.noteId,[]),remote??conflictSet(context.noteId,[]));c.state.requiredFeatures=[...new Set([...c.state.requiredFeatures,'note-conflicts.v1'])].sort();}
   }
   const body=this.resolveBody?await this.resolveBody(entry,existing):null;
   if(existing&&(!body||['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].every(k=>canonical((body as any)[k])===canonical(existing.row[k])))&&canonical(existing.meta)===canonical(c.meta)&&canonical(existing.state)===canonical(c.state)&&existing.row.addedAtMillis===c.addedAtMillis)continue;
   const meta=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'meta',this.keys.version,jsonBytes(c.meta)),state=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'state',this.keys.version,jsonBytes(c.state));
   if(c.state.noteSegments.length)throw Error('unsupported_feature');objects.set(meta.oid,meta.bytes);objects.set(state.oid,state.bytes);
   const refs=await signControl(this.crypto,alias,'wrss.sync.v2/state-refs-sign',{scope:this.http.scope,stateOid:state.oid,segmentOids:[]}),refsRaw=jsonBytes(refs);objects.set(objectOid('state-refs',refsRaw),refsRaw);
   const hasBody=['article','book','asset'].includes(c.meta.kind),old=rows.get(entry.entityKey),bodyRevision=hasBody?hex(await this.crypto.random(16)):null,promiseId=hasBody?hex(await this.crypto.random(16)):null;
   const row={entityKey:entry.entityKey,metaOid:meta.oid,stateOid:state.oid,addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,bodyRevision,promiseId,recipeOid:null,opaqueContentId:null,contentBytes:null,requiredFeatures:[],...(body??{})};
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
 /** Explicit P5 publication. The complete selected snapshot is compiled before
  * upload. Internal writes carry an exact expected state; unrelated writes fail. */
 async prepareExplicit(input:{kind:'rollback'|'resolve-local'|'resolve-merge';expected:SyncState;deviceId:string;alias:string;own:{commitOid:string|null;revision:string};requestId:string;records:any[];target?:{oid:string;treeRoot:string};mergedParents?:string[];legacyKey?:string}){
  if(!this.http.indexWrite||input.kind==='rollback'&&!this.http.historyRestore||input.kind!=='rollback'&&!this.http.choiceApply)throw Error('feature_disabled');
  await this.http.capabilities();let before=await this.store.readStableState();if(canonical(before)!==canonical(input.expected))throw Error('choice_stale');
  if(!before.account||before.cloud?.pins?.accountOid!==before.account.oid)throw Error('choice_stale');if(before.cloud?.pendingPublish)throw Error('publication_pending');if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');
  const {deviceId,alias,own,requestId}=input;hexId(deviceId,32);hexId(requestId,32);checkD64(own.revision);
  let sequence=before.cloud?.deviceSequence??'0';if(own.commitOid){const signed=await this.store.readHeader(own.commitOid)??await this.ownHeader(own.commitOid);const body=await verifyCommit(this.crypto,b64(await this.crypto.signingKey(alias)),signed,own.commitOid,this.http.scope);if(body.authorDeviceId!==deviceId)throw Error('signature_invalid');if(compareD64(body.deviceSequence,sequence)>0)sequence=body.deviceSequence;}
  sequence=nextD64(sequence);const reserved=copy(before);reserved.cloud={...reserved.cloud,deviceSequence:sequence};await this.store.controlUpdate(before,reserved);before=reserved;
  const objects=new Map<string,Uint8Array>(),decoded:any[]=[];
  for(const entry of input.records){
   const c=entry.candidate;fromWire(c.meta.kind,c.meta.payload,c.state.payload);if(c.state.noteSegments.length)throw Error('unsupported_feature');
   if(input.kind==='rollback'){indexRow(entry.row);decoded.push({row:entry.row,meta:c.meta,state:c.state});continue;}
   const meta=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'meta',this.keys.version,jsonBytes(c.meta)),state=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'state',this.keys.version,jsonBytes(c.state));objects.set(meta.oid,meta.bytes);objects.set(state.oid,state.bytes);
   const refs=await signControl(this.crypto,alias,'wrss.sync.v2/state-refs-sign',{scope:this.http.scope,stateOid:state.oid,segmentOids:[]}),raw=jsonBytes(refs);objects.set(objectOid('state-refs',raw),raw);
   const row={entityKey:entry.entityKey,metaOid:meta.oid,stateOid:state.oid,addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,requiredFeatures:[],bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null,...entry.manifest};indexRow(row);decoded.push({row,meta:c.meta,state:c.state});
  }
  const tree=input.kind==='rollback'?{oid:input.target!.treeRoot,nodes:new Map<string,Uint8Array>()}:buildTree(this.http.scope,decoded.map(r=>r.row));for(const [id,raw]of tree.nodes)objects.set(id,raw);
  const now=this.now(),generation=input.kind==='rollback'?nextD64(before.rollbackGeneration):before.rollbackGeneration,parents=[...new Set(input.kind==='rollback'?[input.target!.oid]:input.mergedParents??[])].filter(id=>id!==own.commitOid).sort();
  const body={version:2,scope:this.http.scope,authorDeviceId:deviceId,deviceSequence:sequence,previousOwnCommit:own.commitOid,mergedParents:parents,treeRoot:tree.oid,requiredFeatures:[],createdAtMillis:now,observedRefs:[],indexComplete:true,accountParent:before.account!.oid,rollbackGeneration:generation,operation:{kind:input.kind,rollbackTarget:input.kind==='rollback'?input.target!.oid:null,resolvesGeneration:input.kind==='rollback'?null:generation}},commit=await signCommit(this.crypto,alias,body);objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
  const common={version:2,scope:this.http.scope,newCommitOid:commit.oid,requestId,issuedAtMillis:now,expiresAtMillis:now+300000},account=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/account/current',expectedOid:before.account!.oid,expectedRevision:before.account!.revision}),device=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/devices/'+deviceId+'/index',expectedOid:own.commitOid,expectedRevision:own.revision});
  before=await this.store.stageCloudRows(tree.oid,decoded,before);before=(await this.store.stageUpload(requestId,objects,before))!;
  const next=copy(before);next.cloud.pendingPublish={explicit:true,kind:input.kind,...(input.legacyKey?{legacyKey:input.legacyKey}:{}),guardVersion:nextD64(before.stateVersion),requestId,commitOid:commit.oid,commit:{body:commit.body,signature:commit.signature},treeRoot:tree.oid,rowCount:decoded.length,request:{account,device,relayGrant:null},capturedLocalRevision:before.localChangeRevision,phase:'queued'};
  await this.store.controlUpdate(before,next);return {commitOid:commit.oid,objects:objects.size,rows:decoded.length,deviceSequence:sequence};
 }
 private async pending(){const before=await this.store.readState(),plan=before.cloud?.pendingPublish;if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(!plan)throw Error('publication_missing');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if((before.pendingChoice&&!plan.explicit)||plan.guardVersion!==undefined&&plan.guardVersion!==before.stateVersion||plan.capturedLocalRevision!==before.localChangeRevision||plan.request.account.body.expectedOid!==(before.account?.oid??null)||plan.request.account.body.expectedRevision!==(before.account?.revision??'0'))throw Error('choice_stale');return {before,plan};}
 /** A response-lost retry queries the original request ID before touching refs. */
 flush(){return this.flushing??=this.flushOnce().finally(()=>{this.flushing=undefined;});}
 /** C29: poll using the author's own cloud session. An unknown relay outcome
  * keeps the original journal and never uploads or re-signs any object. */
 async reconcileRelayResult(){
  if(this.flushing)throw Error('publication_pending');
  const poll=async()=>{await this.http.capabilities();const state=await this.store.readState(),queued=state.cloud?.pendingPublish;if(queued?.explicit){if(queued.phase==='confirmed')return queued.result;const saved=await this.http.requestResult(queued.requestId);if(saved.status==='succeeded')return this.accept(queued,saved.response);if(saved.status!=='unknown'||saved.response!==null)throw Error('invalid_schema');}const {plan}=await this.pending(),known=await this.http.requestResult(plan.requestId);
   if(known.status==='succeeded')return this.accept(plan,known.response);
   if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');return null;};
  return this.flushing=poll().finally(()=>{this.flushing=undefined;});
 }
 private async flushOnce(){
  await this.http.capabilities();const state=await this.store.readState(),queued=state.cloud?.pendingPublish;
  if(queued?.explicit){if(queued.phase==='confirmed')return queued.result;const saved=await this.http.requestResult(queued.requestId);if(saved.status==='succeeded')return this.accept(queued,saved.response);if(saved.status!=='unknown'||saved.response!==null)throw Error('invalid_schema');}
  const {plan}=await this.pending(),known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  if(this.now()>plan.request.account.body.expiresAtMillis+30000)throw Error('publication_expired');
  const window=await this.http.negotiate([],[]);if(plan.explicit&&(window.account.commitOid!==plan.request.account.body.expectedOid||window.account.revision!==plan.request.account.body.expectedRevision||window.account.rollbackGeneration!==(plan.kind==='rollback'?String(BigInt(plan.commit.body.rollbackGeneration)-1n):plan.commit.body.rollbackGeneration)))throw Error('choice_stale');let after='';for(;;){const page=await this.store.uploadPage(plan.requestId,after,1);if(!page.length)break;for(const object of page){
   if(object.oid.startsWith('state-refs:'))continue;
   const have=await this.http.json('POST','/objects/have-want',{scope:this.http.scope,windowId:window.windowId,oids:[object.oid]});const status=have.objects?.[0];if(status?.oid!==object.oid)throw Error('invalid_schema');const savedReceipt=await this.store.uploadReceipt(plan.requestId,object.oid);if(savedReceipt&&savedReceipt.totalBytes!==object.bytes.length)throw Error('hash_mismatch');let offset=0;
   if(status.status==='present'||status.status==='partial'){await this.http.servicePin!.receipt(this.crypto,status.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),status.status==='present');offset=status.durableOffset;if(offset!==status.receipt.body.durableOffset)throw Error('invalid_schema');checkedResumeOffset(savedReceipt?.durableOffset??0,offset,object.bytes.length);await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,status.receipt);if(status.status==='present')continue;}
   else if(status.status!=='missing')throw Error('invalid_schema');
   checkedResumeOffset(savedReceipt?.durableOffset??0,offset,object.bytes.length);
   const reserve=async(requestId:string)=>this.http.json('POST','/objects/reserve',{scope:this.http.scope,requestId,channel:'control',objects:[{oid:object.oid,totalBytes:object.bytes.length}],leaseMillis:600000});
   let reservation=await reserve(digest([plan.requestId,'reserve',object.oid]).slice(0,32));uint(reservation.expiresAtMillis);
   // Request replay preserves the original lease deadline. Renew the lease with
   // a fresh reservation ID, while retaining the signed publication and bytes.
   if(reservation.expiresAtMillis<=this.now())reservation=await reserve(hex(await this.crypto.random(16)));
   uint(reservation.expiresAtMillis);if(reservation.expiresAtMillis<=this.now())throw Error('reservation_expired');hexId(reservation.reservationId,32);
   if(reservation.objects?.[0]?.oid!==object.oid||reservation.objects[0].totalBytes!==object.bytes.length)throw Error('offset_conflict');
   for(;offset<object.bytes.length;){await this.pending();const part=object.bytes.subarray(offset,offset+65536);this.http.requestGuard?.();await this.store.consumeUploadReplay(object.oid,object.bytes.length,savedReceipt?.durableOffset??0,offset,part.length);const r=await this.http.putPart(object.oid,offset,reservation.reservationId,digest([plan.requestId,object.oid,offset]).slice(0,32),part);await this.http.servicePin!.receipt(this.crypto,r.receipt,this.http.scope,object.oid,object.bytes.length,this.now());if(r.durableOffset!==offset+part.length||r.receipt.body.durableOffset!==r.durableOffset)throw Error('offset_conflict');offset=r.durableOffset;await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,r.receipt);}
   const complete=await this.http.json('POST','/objects/'+encodeURIComponent(object.oid)+'/complete',{scope:this.http.scope,reservationId:reservation.reservationId,requestId:digest([plan.requestId,'complete',object.oid]).slice(0,32),totalBytes:object.bytes.length});await this.http.servicePin!.receipt(this.crypto,complete.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),true);await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,complete.receipt);
  }after=page.at(-1)!.oid;}
  let refsAfter='';for(;;){const page=await this.store.uploadPage(plan.requestId,refsAfter,1);if(!page.length)break;for(const item of page)if(item.oid.startsWith('state-refs:')){await this.pending();await this.http.json('POST','/state-refs',parseCanonicalJson(item.bytes));}refsAfter=page.at(-1)!.oid;}
  await this.pending();let result;try{result=await this.http.publish(plan.request);}catch(error){
   if(error instanceof SyncV2Error&&error.code==='ref_conflict'){const before=await this.store.readState();if(before.cloud?.pendingPublish?.requestId===plan.requestId){const next=copy(before);next.cloud.pendingPublish.phase='conflicted';await this.store.publicationUpdate(before,next);}}throw error;
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
  if(result?.version!==2)throw Error('invalid_schema');sameScope(result.scope,this.http.scope);const a=result.account,d=result.device;if(a?.commitOid!==plan.commitOid||d?.commitOid!==plan.commitOid||d?.ref!==plan.request.device.body.ref||a.revision!==nextD64(plan.request.account.body.expectedRevision)||d.revision!==nextD64(plan.request.device.body.expectedRevision)||a.rollbackGeneration!==(plan.explicit?plan.commit.body.rollbackGeneration:(await this.store.readState()).rollbackGeneration))throw Error('invalid_schema');checkD64(result.serverRevision);
  if(plan.explicit){const before=await this.store.readState(),next=copy(before);if(before.cloud?.pendingPublish?.requestId!==plan.requestId)throw Error('choice_stale');next.cloud.pendingPublish={...next.cloud.pendingPublish,phase:'confirmed',result};if(before.cloud.pendingPublish.guardVersion===before.stateVersion)await this.store.publicationUpdate(before,next);else await this.store.controlUpdate(before,next);return result;}
  const {before}=await this.pending(),next=copy(before);next.hasUnsentEdits=false;next.acknowledgedLocalChangeRevision=plan.capturedLocalRevision;next.editBase={accountOid:plan.commitOid,generation:before.rollbackGeneration};next.cloud={...next.cloud,pendingPublish:null,lastPublication:{commitOid:plan.commitOid,localRevision:plan.capturedLocalRevision,result}};await this.store.finishUpload(before,next,plan.requestId);return result;
 }
}
