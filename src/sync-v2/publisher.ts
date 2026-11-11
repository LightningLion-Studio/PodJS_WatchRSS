/** Durable index publication journal. No body worker or account-choice apply. */
import {sameBusinessRevision} from './business-revision';
import {checkedResumeOffset} from './resume';
import {canonical,jsonBytes,parseCanonicalJson,bytes,hexId,oid,exact,checkD64,compareD64,nextD64,digest,uint,type Scope} from './protocol';
import {hex} from '@podjs/framework/crypto';
import {b64,unb64,indexRow,sameScope} from './wire';
import {sealV2,objectOid,type EnvelopeCrypto} from './sealed';
import {signCommit,signControl,verifyCommit,type SigningPort} from './signing';
import {fromWire} from './business';
import {readConflicts,conflictNeutral,noteEditDigest} from './notes-conflict';
import {conflictSet,mergeConflicts} from './note-conflict-set';
import {buildTree,updateTree} from './merkle';
import {PAGE_BYTES,type WatchProjectionStore} from './store';
import {choiceCurrent,publicationCurrent,queuedReadOnly,type SyncState} from './state';
import {SyncV2Http,SyncV2Error} from './http';
import {openV2} from './sealed';
import {NOTE_SEGMENTS_FEATURE,NOTE_TEXT_BUDGET,STATE_LIMIT,sealSegmentedNote,segmentedClosureBudget,type PriorSegments} from './note-segments';
import {encodeBase64,base64ToBytes} from '@podjs/framework/bytes';
import type {Statement} from '@podjs/framework/sql-projection';
const copy=<T>(x:T):T=>JSON.parse(canonical(x));
export interface BodyManifest {bodyRevision:string;promiseId:string|null;recipeOid:string|null;opaqueContentId:string|null;contentBytes:number|null;}
export type BodyResolver=(entry:any,existing:any)=>Promise<BodyManifest|null>;
/** Authenticated segment objects retained with a decoded cloud row (25.7). */
export const storedSegments=(segments:PriorSegments)=>({noteRevision:segments.noteRevision,objects:segments.objects.map(o=>({oid:o.oid,sealed:encodeBase64(o.sealed)}))});
const priorSegments=(row:any):PriorSegments|null=>row?.segments?{noteRevision:row.segments.noteRevision,objects:row.segments.objects.map((o:any)=>({oid:o.oid,sealed:base64ToBytes(o.sealed)}))}:null;
export interface PublisherOptions {noteSegments?:boolean;noteTextBudget?:number}
/** A failed original-result lookup preserves the immutable pending request. */
export class PublicationLookupUnavailable extends Error {constructor(readonly cause:unknown){super((cause as Error).message);}}
export class WatchIndexPublisher {
 private flushing?:Promise<any>;
 private preparing?:string;
 /** Count of the last preparation's new and reused segment objects. */
 segmentStats={uploaded:0,reused:0};
 constructor(private readonly store:WatchProjectionStore,private readonly http:SyncV2Http,private readonly crypto:EnvelopeCrypto&SigningPort,private readonly keys:import('./sealed').ObjectKeys,private readonly now:()=>number=Date.now,private readonly resolveBody?:BodyResolver,private readonly options:PublisherOptions={}){}
 /** 25.8 write gate: local opt-in AND the backend's advertised feature. A
  * client without the opt-in cannot segment; that export is object_too_large. */
 private async segmentsWritable(){if(this.options.noteSegments!==true)throw Error('object_too_large');const caps=await this.http.capabilities();if(!Array.isArray(caps.features)||!caps.features.includes(NOTE_SEGMENTS_FEATURE))throw Error('feature_disabled');}
 /** Seals one state. Ordinary states and short notes keep the rc6 path. A long
  * note is segmented under its durable binding; the binding statement commits
  * with the publication journal (25.3). */
 private async sealState(entityKey:string,c:any,existing:any,alias:string,objects:Map<string,Uint8Array>,bindings:Statement[]){
  const raw=jsonBytes(c.state);
  if(c.meta.kind!=='note'||raw.length<=STATE_LIMIT){const sealed=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'state',this.keys.version,raw);objects.set(sealed.oid,sealed.bytes);const refs=jsonBytes(await signControl(this.crypto,alias,'wrss.sync.v2/state-refs-sign',{scope:this.http.scope,stateOid:sealed.oid,segmentOids:[]}));objects.set(objectOid('state-refs',refs),refs);return sealed.oid;}
  await this.segmentsWritable();
  const life=c.state.payload.deleted===true?'deleted':'live',saved=await this.store.noteBinding(entityKey),prior=priorSegments(existing);
  // Local durable binding first (never replaced by a remote one); otherwise adopt
  // the current authenticated row of the same life; otherwise a fresh CSPRNG value.
  const revision=saved?(saved.life===life&&saved.revision?saved.revision:hex(await this.crypto.random(16))):(life==='live'&&prior&&existing.row.deleted===false?prior.noteRevision:hex(await this.crypto.random(16)));
  if(!saved||saved.revision!==revision||saved.life!==life)bindings.push(await this.store.noteBindingStatement(entityKey,{revision,life}));
  const out=await sealSegmentedNote(c.state,revision,{
   seal:plain=>sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'state',this.keys.version,plain),
   signRefs:async(stateOid,segmentOids)=>jsonBytes(await signControl(this.crypto,alias,'wrss.sync.v2/state-refs-sign',{scope:this.http.scope,stateOid,segmentOids})),
   open:async(id,sealed)=>{const opened=await openV2(this.crypto,this.keys.id,this.keys.readContentKey??this.keys.content,this.http.scope,id,sealed);if(!this.keys.readContentKey&&opened.header.keyVersion!==this.keys.version||opened.header.type!=='state')throw Error('unsupported_feature');return opened;},
  },prior,this.options.noteTextBudget??NOTE_TEXT_BUDGET);
  for(const [id,bytes]of out.objects)objects.set(id,bytes);this.segmentStats.uploaded+=out.uploadedSegments;this.segmentStats.reused+=out.reusedSegments;return out.stateOid;
 }
 private async ownHeader(id:string){
  const stored=await this.store.readHeader(id);if(stored)return stored;
  const page=await this.http.json('GET','/account/ancestry?head='+encodeURIComponent(id)+'&stop=null&limit=1');
  if(page.head!==id||page.headers?.[0]?.commitOid!==id)throw Error('ref_continuity_unavailable');return {body:page.headers[0].body,signature:page.headers[0].signature};
 }
 /** Reserve the author sequence before any signing. Crashes may leave gaps. */
 async prepare(deviceId:string,alias:string,own:{commitOid:string|null;revision:string},requestId:string){
  if(!this.http.indexWrite)throw Error('feature_disabled');await this.http.capabilities();hexId(deviceId,32);hexId(requestId,32);checkD64(own.revision);if(own.commitOid!==null)oid(own.commitOid,'commit');
  let before=await this.store.readState();if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if(before.pendingChoice)throw Error('choice_pending');if(before.account&&before.editBase.generation!==before.account.generation)throw Error('rollback_conflict');
  const saved=before.cloud??{deviceSequence:'0',current:null,pins:{accountOid:null,authors:{},seenOids:[]},headers:{},cursor:'0',pendingPublish:null};if(saved.pendingPublish||saved.preparingPublication)throw Error('publication_pending');
  const checkpoint=await this.store.checkpoint();if(checkpoint?.phase!=='complete'||!sameBusinessRevision(checkpoint.businessRevision,before.businessRevision))throw Error('projection_incomplete');
  let sequence=saved.deviceSequence??'0';if(own.commitOid){const value=await this.ownHeader(own.commitOid),publicKey=b64(await this.crypto.signingKey(alias));const body=await verifyCommit(this.crypto,publicKey,value,own.commitOid,this.http.scope);if(body.authorDeviceId!==deviceId)throw Error('signature_invalid');if(compareD64(body.deviceSequence,sequence)>0)sequence=body.deviceSequence;}
  sequence=nextD64(sequence);const reserved=copy(before);reserved.cloud={...saved,deviceSequence:sequence};await this.store.controlUpdate(before,reserved);before=reserved;
  // F2: only index rows are kept across entities. Decoded rows, candidates and
  // sealed objects are read or staged one bounded page/entity at a time.
  const objects=new Map<string,Uint8Array>(),rows=new Map<string,any>(),changedRows:any[]=[],bindings:Statement[]=[],root=saved.current?.treeRoot??null;this.segmentStats={uploaded:0,reused:0};
  let staged=false,heldEdits=false;const stage=async()=>{let held=0;for(const raw of objects.values())held+=raw.length;if(held<=PAGE_BYTES)return;staged=true;await this.store.stageUpload(requestId,objects);objects.clear();};
  try{
  if(root){let after='';for(;;){const page=await this.store.cloudRows(root,after,32,PAGE_BYTES);if(!page.length)break;for(const r of page){if(!r.unopenable)fromWire(r.meta.kind,r.meta.payload,r.state.payload);rows.set(r.row.entityKey,r.row);}after=page.at(-1).row.entityKey;}}
  let after='';for(;;){const page=await this.store.candidatePage(after,32,PAGE_BYTES);if(!page.length)break;for(const entry of page){
   const existing=root?await this.store.cloudRow(root,entry.entityKey):null;
   // F1: a row this device cannot open is carried back unchanged (same OIDs);
   // R2: a local change against its quarantine baseline is held as unsent.
   if(existing?.unopenable){if(Object.hasOwn(before.cloud?.unopenableBaselines??{},entry.entityKey)&&before.cloud.unopenableBaselines[entry.entityKey]!==noteEditDigest(entry.candidate))heldEdits=true;continue;}
   const c=copy(entry.candidate);fromWire(c.meta.kind,c.meta.payload,c.state.payload);
   if(existing&&c.meta.kind==='note'){
    if(existing.meta.kind!=='note'||existing.meta.logicalId!==c.meta.logicalId)throw Error('identity_conflict');
    const context={entityKey:entry.entityKey,noteId:c.meta.logicalId},local=readConflicts(c.state,context,['note-conflicts.v1']),remote=readConflicts(existing.state,context,['note-conflicts.v1']);
    if(local||remote){c.state.payload.noteConflicts=mergeConflicts(context.noteId,local??conflictSet(context.noteId,[]),remote??conflictSet(context.noteId,[]));c.state.requiredFeatures=[...new Set([...c.state.requiredFeatures,'note-conflicts.v1'])].sort();}
   }
   const body=this.resolveBody?await this.resolveBody(entry,existing):null;
   if(existing&&(!body||['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].every(k=>canonical((body as any)[k])===canonical(existing.row[k])))&&canonical(existing.meta)===canonical(c.meta)&&canonical(conflictNeutral(existing.state))===canonical(conflictNeutral(c.state))&&existing.row.addedAtMillis===c.addedAtMillis)continue;
   if(c.state.noteSegments.length)throw Error('unsupported_feature');
   const meta=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'meta',this.keys.version,jsonBytes(c.meta)),state={oid:await this.sealState(entry.entityKey,c,existing,alias,objects,bindings)};objects.set(meta.oid,meta.bytes);
   const hasBody=['article','book','asset'].includes(c.meta.kind),old=rows.get(entry.entityKey),bodyRevision=hasBody?hex(await this.crypto.random(16)):null,promiseId=hasBody?hex(await this.crypto.random(16)):null;
   const row={entityKey:entry.entityKey,metaOid:meta.oid,stateOid:state.oid,addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,bodyRevision,promiseId,recipeOid:null,opaqueContentId:null,contentBytes:null,requiredFeatures:[],...(body??{})};
   // No unproved field merge: an advanced account must be reconciled by the frozen
   // business adapter before replacing an overlapping authenticated row.
   if(old&&before.account&&before.editBase.accountOid!==before.account.oid)throw Error('merge_unavailable');
   indexRow(row);rows.set(entry.entityKey,row);changedRows.push(row);
   await stage();
  }after=page.at(-1)!.entityKey;}
  const tree=root?await updateTree(this.http.scope,root,id=>this.http.object(id),changedRows):buildTree(this.http.scope,[...rows.values()]);for(const [id,raw]of tree.nodes)objects.set(id,raw);
  const now=this.now(),body={version:2,scope:this.http.scope,authorDeviceId:deviceId,deviceSequence:sequence,previousOwnCommit:own.commitOid,mergedParents:[],treeRoot:tree.oid,requiredFeatures:[],createdAtMillis:now,observedRefs:[],indexComplete:true,accountParent:before.account?.oid??null,rollbackGeneration:before.rollbackGeneration,operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null}},commit=await signCommit(this.crypto,alias,body);
  objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
  const common={version:2,scope:this.http.scope,newCommitOid:commit.oid,requestId,issuedAtMillis:now,expiresAtMillis:now+300000};
  const account=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/account/current',expectedOid:before.account?.oid??null,expectedRevision:before.account?.revision??'0'}),device=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/devices/'+deviceId+'/index',expectedOid:own.commitOid,expectedRevision:own.revision});
  const total=await this.store.stageUpload(requestId,objects).then(()=>this.store.uploadCount(requestId));staged=true;const latest=await this.store.readState();if(!choiceCurrent(latest,{accountOid:before.account?.oid??null,accountRevision:before.account?.revision??'0',localChangeRevision:before.localChangeRevision})||latest.pendingChoice)throw Error('choice_stale');
  const next=copy(latest);next.cloud={...latest.cloud,pendingPublish:{requestId,commitOid:commit.oid,commit:{body:commit.body,signature:commit.signature},treeRoot:tree.oid,request:{account,device,relayGrant:null},capturedLocalRevision:before.localChangeRevision,phase:'queued',...(heldEdits?{heldEdits:true}:{})}};
  await this.store.controlUpdate(latest,next,bindings);return {commitOid:commit.oid,objects:total,rows:rows.size,deviceSequence:sequence,segments:{...this.segmentStats}};
  }catch(error){if(staged)await this.store.dropUpload(requestId).catch(()=>{});throw error;}
 }
 /** Size the FINAL roots, public refs and canonical tree before reserving an
  * author sequence. Unproved reuse is charged at identity's worst-case size. */
 preflightRecords(records:any[]){let wireBytes=0;const rows:any[]=[];for(const entry of records){const c=entry.candidate;fromWire(c.meta.kind,c.meta.payload,c.state.payload);if(c.state.noteSegments.length)throw Error('unsupported_feature');if(c.meta.kind==='note')readConflicts(c.state,{entityKey:entry.entityKey,noteId:c.meta.logicalId},['note-conflicts.v1']);
  const meta=jsonBytes(c.meta),state=jsonBytes(c.state);if(meta.length>262144)throw Error('object_too_large');
  if(state.length>262144){if(c.meta.kind!=='note'||this.options.noteSegments!==true)throw Error('object_too_large');const closure=segmentedClosureBudget(c.state,'0'.repeat(32),this.http.scope,this.options.noteTextBudget??NOTE_TEXT_BUDGET)!;wireBytes+=meta.length+4120+closure.bytes;}
  else{wireBytes+=meta.length+state.length+8240;wireBytes+=jsonBytes({body:{scope:this.http.scope,stateOid:'state:sha256:'+('0'.repeat(64)),segmentOids:[]},signature:'A'.repeat(86)}).length;}
  const row={entityKey:entry.entityKey,metaOid:'meta:sha256:'+('0'.repeat(64)),stateOid:'state:sha256:'+('0'.repeat(64)),addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,requiredFeatures:[],bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null,...entry.manifest};indexRow(row);rows.push(row);if(!Number.isSafeInteger(wireBytes))throw Error('object_too_large');
 }const tree=buildTree(this.http.scope,rows);for(const raw of tree.nodes.values())wireBytes+=raw.length;wireBytes+=16384;if(!Number.isSafeInteger(wireBytes))throw Error('object_too_large');return {wireBytes,rows:rows.length};}
 /** Explicit P5 publication. The complete selected snapshot is compiled before
  * upload. Internal writes carry an exact expected state; unrelated writes fail. */
 async prepareExplicit(input:{kind:'rollback'|'resolve-local'|'resolve-merge';expected:SyncState;deviceId:string;alias:string;own:{commitOid:string|null;revision:string};requestId:string;records:any[];target?:{oid:string;treeRoot:string};mergedParents?:string[];legacyKey?:string;applyPlan?:import('@podjs/framework/sql-program').SqlProgramRef}){
  if(!this.http.indexWrite||input.kind==='rollback'&&!this.http.historyRestore||input.kind!=='rollback'&&!this.http.choiceApply)throw Error('feature_disabled');
  await this.http.capabilities();let before=await this.store.readStableState();if(canonical(before)!==canonical(input.expected))throw Error('choice_stale');
  if(!before.account||before.cloud?.pins?.accountOid!==before.account.oid)throw Error('choice_stale');if(before.cloud?.pendingPublish||before.cloud?.preparingPublication)throw Error('publication_pending');if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');
  this.preflightRecords(input.records);const {deviceId,alias,own,requestId}=input;hexId(deviceId,32);hexId(requestId,32);checkD64(own.revision);
  let sequence=before.cloud?.deviceSequence??'0';if(own.commitOid){const signed=await this.store.readHeader(own.commitOid)??await this.ownHeader(own.commitOid);const body=await verifyCommit(this.crypto,b64(await this.crypto.signingKey(alias)),signed,own.commitOid,this.http.scope);if(body.authorDeviceId!==deviceId)throw Error('signature_invalid');if(compareD64(body.deviceSequence,sequence)>0)sequence=body.deviceSequence;}
  sequence=nextD64(sequence);const reserved=copy(before);reserved.cloud={...reserved.cloud,deviceSequence:sequence,preparingPublication:{kind:input.kind,requestId,...(input.applyPlan?{applyPlan:input.applyPlan}:{}),capturedLocalRevision:before.localChangeRevision}};const checks:any[]=[];if(input.applyPlan){checks.push({sql:"INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM podjs_sql_programs WHERE binding=? AND id=? AND status='ready' AND root=?) THEN 1 ELSE 0 END",params:[input.applyPlan.binding,input.applyPlan.id,input.applyPlan.root]},{sql:'DELETE FROM podjs_sql_cas_guard'});const r=(input.applyPlan as any).reservation;if(r)checks.push({sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM podjs_resource_quota WHERE binding=? AND id=? AND bytes=?) THEN 1 ELSE 0 END',params:[r.binding,r.id,r.bytes]},{sql:'DELETE FROM podjs_sql_cas_guard'});}await this.store.controlUpdate(before,reserved,checks);before=reserved;this.preparing=requestId;try{
  const objects=new Map<string,Uint8Array>(),decoded:any[]=[],bindings:Statement[]=[];this.segmentStats={uploaded:0,reused:0};
  for(const entry of input.records){
   const c=entry.candidate;fromWire(c.meta.kind,c.meta.payload,c.state.payload);if(c.state.noteSegments.length)throw Error('unsupported_feature');
   if(input.kind==='rollback'){indexRow(entry.row);decoded.push({row:entry.row,meta:c.meta,state:c.state});continue;}
   const existing=before.cloud?.current?.treeRoot?await this.store.cloudRow(before.cloud.current.treeRoot,entry.entityKey):null;
   if(existing?.unopenable){decoded.push(existing);continue;}
   const metaSame=existing&&canonical(existing.meta)===canonical(c.meta),stateSame=existing&&canonical(conflictNeutral(existing.state))===canonical(conflictNeutral(c.state));
   const manifestSame=existing&&['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].every(k=>canonical(entry.manifest?.[k]??null)===canonical(existing.row[k]));
   if(metaSame&&stateSame&&manifestSame&&existing.row.addedAtMillis===c.addedAtMillis){decoded.push(existing);continue;}
   let metaOid=existing?.row.metaOid,stateOid=existing?.row.stateOid;
   if(!metaSame){const sealed=await sealV2(this.crypto,this.keys.id,this.keys.content,this.http.scope,'meta',this.keys.version,jsonBytes(c.meta));metaOid=sealed.oid;objects.set(sealed.oid,sealed.bytes);}
   if(!stateSame)stateOid=await this.sealState(entry.entityKey,c,existing,alias,objects,bindings);
   // A kept state OID keeps the received state form (and its segments) in the cache.
   const row={entityKey:entry.entityKey,metaOid,stateOid,addedAtMillis:c.addedAtMillis,rowSequence:entry.rowSequence,deleted:c.state.payload.deleted===true,requiredFeatures:[],bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null,...entry.manifest};indexRow(row);decoded.push(stateSame?{row,meta:c.meta,state:existing.state,...(existing.segments?{segments:existing.segments}:{})}:{row,meta:c.meta,state:c.state});
  }
  // R3: every quarantined row of the current tree travels back unchanged, also
  // when the selected records do not name it (no local note): no choice deletes it.
  const root=before.cloud?.current?.treeRoot;if(input.kind!=='rollback'&&root){const held=new Set(decoded.map(r=>r.row.entityKey));let after='';for(;;){const page=await this.store.cloudRows(root,after,32,PAGE_BYTES);if(!page.length)break;for(const r of page)if(r.unopenable&&!held.has(r.row.entityKey))decoded.push(r);after=page.at(-1).row.entityKey;}}
  const tree=input.kind==='rollback'?{oid:input.target!.treeRoot,nodes:new Map<string,Uint8Array>()}:buildTree(this.http.scope,decoded.map(r=>r.row));for(const [id,raw]of tree.nodes)objects.set(id,raw);
  const now=this.now(),generation=input.kind==='rollback'?nextD64(before.rollbackGeneration):before.rollbackGeneration,parents=[...new Set(input.kind==='rollback'?[input.target!.oid]:input.mergedParents??[])].filter(id=>id!==own.commitOid).sort();
  // A generation-zero concurrency choice has no rollback barrier to resolve.
  // Keep the explicit local capture/apply journal and both original CAS fences;
  // only its wire operation uses the existing normal CommitBody grammar.
  const normalChoice=input.kind!=='rollback'&&generation==='0';
  const body={version:2,scope:this.http.scope,authorDeviceId:deviceId,deviceSequence:sequence,previousOwnCommit:own.commitOid,mergedParents:parents,treeRoot:tree.oid,requiredFeatures:[],createdAtMillis:now,observedRefs:[],indexComplete:true,accountParent:before.account!.oid,rollbackGeneration:generation,operation:{kind:normalChoice?'normal':input.kind,rollbackTarget:input.kind==='rollback'?input.target!.oid:null,resolvesGeneration:input.kind==='rollback'||normalChoice?null:generation}},commit=await signCommit(this.crypto,alias,body);objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
  const common={version:2,scope:this.http.scope,newCommitOid:commit.oid,requestId,issuedAtMillis:now,expiresAtMillis:now+300000},account=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/account/current',expectedOid:before.account!.oid,expectedRevision:before.account!.revision}),device=await signControl(this.crypto,alias,'wrss.sync.v2/ref-update-sign',{...common,ref:'refs/devices/'+deviceId+'/index',expectedOid:own.commitOid,expectedRevision:own.revision});
  before=await this.store.stageCloudRows(tree.oid,decoded,before);before=(await this.store.stageUpload(requestId,objects,before))!;
  if(before.cloud.preparingPublication?.requestId!==requestId)throw Error('choice_stale');const next=copy(before);next.cloud.preparingPublication=null;next.cloud.pendingPublish={explicit:true,kind:input.kind,...(input.applyPlan?{applyPlan:input.applyPlan}:{}),...(input.legacyKey?{legacyKey:input.legacyKey}:{}),guardVersion:nextD64(before.stateVersion),requestId,commitOid:commit.oid,commit:{body:commit.body,signature:commit.signature},treeRoot:tree.oid,rowCount:decoded.length,request:{account,device,relayGrant:null},capturedLocalRevision:before.localChangeRevision,phase:'queued'};
  await this.store.controlUpdate(before,next,bindings);return {commitOid:commit.oid,objects:objects.size,rows:decoded.length,deviceSequence:sequence,segments:{...this.segmentStats}};}finally{this.preparing=undefined;}
 }
 private async pending(){const before=await this.store.readState(),plan=before.cloud?.pendingPublish;if(before.cloud?.witnessConflict)throw Error('ref_continuity_unavailable');if(!plan)throw Error('publication_missing');if(queuedReadOnly(before))throw Error('feature_disabled');if(before.cloud?.blockedCommitOid)throw Error('unsupported_feature');if((before.pendingChoice&&!plan.explicit)||!publicationCurrent(before,plan))throw Error('choice_stale');return {before,plan};}
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
 private async resumeResult(requestId:string){try{return await this.http.requestResult(requestId);}catch(error){throw new PublicationLookupUnavailable(error);}}
 private async flushOnce(){
  await this.http.capabilities();const state=await this.store.readState(),queued=state.cloud?.pendingPublish;
  if(queued?.explicit){if(queued.phase==='confirmed')return queued.result;const saved=await this.resumeResult(queued.requestId);if(saved.status==='succeeded')return this.accept(queued,saved.response);if(saved.status!=='unknown'||saved.response!==null)throw Error('invalid_schema');}
  const {plan}=await this.pending(),known=await this.resumeResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  if(plan.phase==='conflicted')throw new SyncV2Error('ref_conflict',true);
  if(this.now()>plan.request.account.body.expiresAtMillis+30000)throw Error('publication_expired');
  const window=await this.http.negotiate([],[]);if(plan.explicit&&!publicationCurrent({...await this.store.readState(),account:{oid:window.account.commitOid,revision:window.account.revision,generation:window.account.rollbackGeneration}},plan))throw Error('choice_stale');let after='';for(;;){const page=await this.store.uploadBatch(plan.requestId,after);if(!page.length)break;const upload=page.filter(o=>!o.oid.startsWith('state-refs:'));
  if(!upload.length){after=page.at(-1)!.oid;continue;}
  const have=await this.http.json('POST','/objects/have-want',{scope:this.http.scope,windowId:window.windowId,oids:upload.map(o=>o.oid)});
  if(have.windowId!==window.windowId||!Array.isArray(have.objects)||have.objects.length!==upload.length||have.objects.some((s:any,i:number)=>s.oid!==upload[i]!.oid))throw Error('invalid_schema');
  const progress: {savedReceipt:any;offset:number}[]=[];
  for(let index=0;index<upload.length;index++){const object=upload[index]!,status=have.objects[index],savedReceipt=await this.store.uploadReceipt(plan.requestId,object.oid);if(savedReceipt&&savedReceipt.totalBytes!==object.bytes.length)throw Error('hash_mismatch');let offset=0;
   if(status.status==='present'||status.status==='partial'){if(status.totalBytes!==object.bytes.length)throw Error('hash_mismatch');await this.http.servicePin!.receipt(this.crypto,status.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),status.status==='present');offset=status.durableOffset;if(offset!==status.receipt.body.durableOffset||status.status==='partial'&&offset>=object.bytes.length)throw Error('invalid_schema');checkedResumeOffset(savedReceipt?.durableOffset??0,offset,object.bytes.length);await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,status.receipt);}
   else if(status.status!=='missing'||status.totalBytes!==null||status.durableOffset!==0||status.receipt!==null)throw Error('invalid_schema');
   checkedResumeOffset(savedReceipt?.durableOffset??0,offset,object.bytes.length);progress.push({savedReceipt,offset});
  }
  const wanted=upload.filter((o,i)=>have.objects[i].status!=='present'),reservationObjects=wanted.map(o=>({oid:o.oid,totalBytes:o.bytes.length}));
  const reserve=async(requestId:string)=>this.http.json('POST','/objects/reserve',{scope:this.http.scope,requestId,channel:'control',objects:reservationObjects,leaseMillis:600000});
  let reservation:any;if(wanted.length){reservation=await reserve(digest([plan.requestId,'reserve-batch',reservationObjects]).slice(0,32));uint(reservation.expiresAtMillis);if(reservation.expiresAtMillis<=this.now())reservation=await reserve(hex(await this.crypto.random(16)));uint(reservation.expiresAtMillis);if(reservation.expiresAtMillis<=this.now())throw Error('reservation_expired');hexId(reservation.reservationId,32);if(!Array.isArray(reservation.objects)||reservation.objects.length!==wanted.length||reservation.objects.some((r:any,i:number)=>r.oid!==wanted[i]!.oid||r.totalBytes!==wanted[i]!.bytes.length))throw Error('offset_conflict');}
  for(let index=0;index<upload.length;index++){const object=upload[index]!,status=have.objects[index],savedReceipt=progress[index]!.savedReceipt;let offset=progress[index]!.offset;if(status.status==='present')continue;
   for(;offset<object.bytes.length;){await this.pending();const part=object.bytes.subarray(offset,offset+65536);this.http.requestGuard?.();await this.store.consumeUploadReplay(object.oid,object.bytes.length,savedReceipt?.durableOffset??0,offset,part.length);const r=await this.http.putPart(object.oid,offset,reservation.reservationId,digest([plan.requestId,object.oid,offset]).slice(0,32),part);await this.http.servicePin!.receipt(this.crypto,r.receipt,this.http.scope,object.oid,object.bytes.length,this.now());if(r.durableOffset!==offset+part.length||r.receipt.body.durableOffset!==r.durableOffset)throw Error('offset_conflict');offset=r.durableOffset;await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,r.receipt);}
   const complete=await this.http.json('POST','/objects/'+encodeURIComponent(object.oid)+'/complete',{scope:this.http.scope,reservationId:reservation.reservationId,requestId:digest([plan.requestId,'complete',object.oid]).slice(0,32),totalBytes:object.bytes.length});await this.http.servicePin!.receipt(this.crypto,complete.receipt,this.http.scope,object.oid,object.bytes.length,this.now(),true);await this.store.confirmUploadReceipt(plan.requestId,object.oid,object.bytes.length,complete.receipt);
  }after=page.at(-1)!.oid;}
  // 25.9: every segment table is registered before any parent that lists it.
  for(const parents of [false,true]){let refsAfter='';for(;;){const page=await this.store.uploadPage(plan.requestId,refsAfter,1);if(!page.length)break;for(const item of page)if(item.oid.startsWith('state-refs:')){const refs=parseCanonicalJson(item.bytes);if((refs?.body?.segmentOids?.length>0)!==parents)continue;await this.pending();await this.http.json('POST','/state-refs',refs);}refsAfter=page.at(-1)!.oid;}}
  await this.pending();let result;try{result=await this.http.publish(plan.request);}catch(error){
   if(error instanceof SyncV2Error&&error.code==='ref_conflict'){const before=await this.store.readState();if(before.cloud?.pendingPublish?.requestId===plan.requestId){const next=copy(before);next.cloud.pendingPublish.phase='conflicted';await this.store.publicationUpdate(before,next);}}throw error;
  }return this.accept(plan,result);
 }
 /** Call only after the authenticated reader observes the latest head. An
  * unknown result alone cannot retire a request: its authenticated account
  * CAS or its captured local business edits must also be superseded. Accepted requests finish through the original journal. */
 async reconcileStalePublication(){
  if(this.flushing)throw Error('publication_pending');
  const original=await this.store.readState(),plan=original.cloud?.pendingPublish;
  if(!plan?.explicit)return {detached:false};
  const known=await this.resumeResult(plan.requestId);
  if(known.status==='succeeded'){await this.accept(plan,known.response);return {detached:false};}
  if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  const before=await this.store.readState(),current=before.cloud?.pendingPublish;if(current?.requestId!==plan.requestId)throw Error('choice_stale');
  // A success recorded while this lookup waited wins over its older unknown.
  if(current.phase==='confirmed')return {detached:false};
  if(!before.account||before.cloud?.pins?.accountOid!==before.account.oid)throw Error('ref_continuity_unavailable');
  if(publicationCurrent(before,current))return {detached:false};
  const next=copy(before);next.cloud.pendingPublish=null;
  next.cloud.detachedPublications={...next.cloud.detachedPublications,[plan.requestId]:{...current,phase:'detached',outcome:'unknown'}};
  if(before.hasUnsentEdits||before.pendingChoice)next.pendingChoice={generation:before.account.generation,inboxKeys:before.pendingChoice?.inboxKeys??[],accountOid:before.account.oid,accountRevision:before.account.revision,selectedLocalChangeRevision:before.localChangeRevision};
  await this.store.observationUpdate(before,next);if(current.applyPlan)await this.store.releasePlanReservation(current.applyPlan);
  return {detached:true};
 }
 /** Detach an obsolete user intent without deleting its signed request or
  * receipts. Unknown may still succeed: detached intents are queried, never sent.
  * A later observation remains fenced by the normal account/state CAS. */
 async detachPublication(force=false){
  if(this.flushing)throw Error('publication_pending');const original=await this.store.readState(),building=original.cloud?.preparingPublication;if(building){if(!force&&this.preparing===building.requestId)return {detached:false};const next=copy(original);next.cloud.preparingPublication=null;next.cloud.detachedPublications={...next.cloud.detachedPublications,[building.requestId]:{...building,phase:'detached',outcome:'not-sent'}};await this.store.controlUpdate(original,next);if(building.applyPlan)await this.store.releasePlanReservation(building.applyPlan);return {detached:true,requestId:building.requestId,outcome:'not-sent'};}const plan=original.cloud?.pendingPublish;if(!plan?.explicit)return {detached:false};
  const stale=!publicationCurrent(original,plan);
  if(!force&&!stale)return {detached:false};const known=await this.resumeResult(plan.requestId);if(!['succeeded','unknown'].includes(known.status)||known.status==='unknown'&&known.response!==null)throw Error('invalid_schema');
  const before=await this.store.readState();if(before.cloud?.pendingPublish?.requestId!==plan.requestId)throw Error('choice_stale');
  const next=copy(before);next.cloud.pendingPublish=null;next.cloud.detachedPublications={...next.cloud.detachedPublications,[plan.requestId]:{...plan,phase:'detached',outcome:known.status,...(known.status==='succeeded'?{result:known.response}:{})}};
  await this.store.observationUpdate(before,next);if(plan.applyPlan)await this.store.releasePlanReservation(plan.applyPlan);return {detached:true,requestId:plan.requestId,outcome:known.status};
 }
 async reconcileDetached(){
  const s=await this.store.readState(),out=[];for(const [id,plan]of Object.entries(s.cloud?.detachedPublications??{}) as [string,any][]){
   if(plan.outcome==='succeeded'||plan.outcome==='not-sent'){out.push({requestId:id,outcome:plan.outcome});continue;}const known=await this.http.requestResult(id);if(!['succeeded','unknown'].includes(known.status)||known.status==='unknown'&&known.response!==null)throw Error('invalid_schema');
   if(known.status==='succeeded'){const before=await this.store.readState(),next=copy(before);if(next.cloud.detachedPublications?.[id]){next.cloud.detachedPublications[id]={...next.cloud.detachedPublications[id],outcome:'succeeded',result:known.response};await this.store.observationUpdate(before,next);}}out.push({requestId:id,outcome:known.status});
  }return out;
 }
 /** Only a definitive CAS rejection permits retiring a journal. Authenticate the
  * new account before retiring it; never change expected refs on a signed request.
  * Candidate edits and reserved author sequences survive the retry. */
 async retryAfterConflict(refresh:()=>Promise<void>,awaitChoice=false){
  if(this.flushing)throw Error('publication_pending');let before=await this.store.readState(),plan=before.cloud?.pendingPublish;
  if(!plan||plan.phase!=='conflicted')throw Error('publication_pending');
  let known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')return this.accept(plan,known.response);if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  await refresh();before=await this.store.readState();
  if(before.cloud?.pendingPublish?.requestId!==plan.requestId||before.cloud.pendingPublish.phase!=='conflicted'||before.localChangeRevision!==plan.capturedLocalRevision||before.pendingChoice&&!awaitChoice)throw Error('choice_stale');
  if(!before.account||before.cloud.pins.accountOid!==before.account.oid||before.account.generation!==before.rollbackGeneration||before.editBase.generation!==before.rollbackGeneration)throw Error('rollback_conflict');
  if(before.account.oid===plan.request.account.body.expectedOid&&before.account.revision===plan.request.account.body.expectedRevision)throw Error('ref_conflict');
  known=await this.http.requestResult(plan.requestId);if(known.status==='succeeded')throw Error('choice_stale');if(known.status!=='unknown'||known.response!==null)throw Error('invalid_schema');
  const next=copy(before);next.cloud.pendingPublish=null;
  if(awaitChoice&&before.hasUnsentEdits)next.pendingChoice={generation:before.account.generation,inboxKeys:before.pendingChoice?.inboxKeys??[],accountOid:before.account.oid,accountRevision:before.account.revision,selectedLocalChangeRevision:before.localChangeRevision};
  await this.store.finishUpload(before,next,plan.requestId);
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
  if(plan.explicit){const before=await this.store.readState(),next=copy(before);if(before.cloud?.pendingPublish?.requestId!==plan.requestId)throw Error('choice_stale');next.cloud.pendingPublish={...next.cloud.pendingPublish,phase:'confirmed',result};await this.store.observationUpdate(before,next);return result;}
  // R2: a local change of a quarantined note is not uploaded; it stays unsent
  // until the next pull keeps it as a new note.
  const {before}=await this.pending(),next=copy(before);next.hasUnsentEdits=plan.heldEdits===true;next.acknowledgedLocalChangeRevision=plan.capturedLocalRevision;next.editBase={accountOid:plan.commitOid,generation:before.rollbackGeneration};next.cloud={...next.cloud,pendingPublish:null,lastPublication:{commitOid:plan.commitOid,localRevision:plan.capturedLocalRevision,result}};await this.store.finishUpload(before,next,plan.requestId,plan.commit?plan:undefined);return result;
 }
}
