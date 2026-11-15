import {VerifiedChunkStore,type ObjectLease,type VerifiedObject,type VerifiedPublication} from '@podjs/framework/verified-chunk-store';
import {encodeBase64} from '@podjs/framework/bytes';
import {frameBytes} from '../wire-frame-size';
import {ResumeStore,validateGraph,type Job,type ReceiptBoundary} from './store';
import {D,offerDigest,preparationDigest,selectionDigest,requestDigest,planDigest,descriptor,pageDigest,objectsRoot,receiptsRoot,completion} from './digests';
import {ACTION,VERSION,CHUNK_BYTES,RETENTION,HARD_LIMITS,LIMIT_KEYS,resumeError,ResumeError,fail,exact,row,capability,binding,envelope,hex,utf8,hash,b64,strictJson,sorted,type Row,type Capability,type Selection,type Snapshot,type ObjectDescriptor,type BeginPayload,type Binding,type Envelope,type AppliedReceipt,type Completion} from './wire';
import type {SyncFrameConnection} from '../session';

export interface ResumeSourcePlan {objects:readonly ObjectDescriptor[];read(object:ObjectDescriptor,index:number):Promise<Uint8Array>}
export interface ResumePorts {
 store:ResumeStore;chunks:VerifiedChunkStore;capability:Capability;
 accountScope:string;phoneDeviceId:string;watchDeviceId:string;connectionId:string;
 /** Holds the application's existing account-mutation lease through commit. */
 authorize<T>(run:()=>Promise<T>):Promise<T>;
 sleep(milliseconds:number):{result:Promise<void>;cancel():void};
 check():void;randomId():Promise<string>;
 freeze():Promise<{witness:Snapshot;inventory:unknown}>;
 source(witness:Snapshot,selection:Selection):Promise<ResumeSourcePlan>;
 apply(job:Job,object:ObjectDescriptor,path:string,boundary:ReceiptBoundary):Promise<void>;
 publish?(lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor):Promise<VerifiedPublication>;
 supportsRange?(p:BeginPayload):Promise<boolean>;
 applied?():void;
 diagnostic?(error:unknown):void;
}
const nativeObject=(o:ObjectDescriptor):VerifiedObject=>({id:o.objectId,size:o.size,sha256:o.sha256,chunkHashes:o.chunkHashes});
const sameSnapshot=(a:Snapshot,b:Snapshot)=>a.snapshotId===b.snapshotId&&a.manifestDigest===b.manifestDigest&&a.fromExclusive===b.fromExclusive&&a.toInclusive===b.toInclusive;
const terminal=(j:Job)=>j.state==='COMPLETE'||j.state==='CANCELLED';
type Offer={request:Envelope;payload:Row;watchSnapshot:Snapshot;digest:string;result:Row};
/** A single reader dispatches both requests and responses. Source pumps never
 * read the stream, and no v14 ACK is generated or consumed inside this owner.
 */
export class LibraryResumeConnection {
 readonly scope:string;
 private readonly offers=new Map<string,Offer>();
 private bindings:Binding[]=[];
 private selectedOffer?:Offer;
 private readonly begun=new Set<string>();
 private pending=new Map<string,{request:Envelope;resolve:(v:Envelope)=>void;reject:(e:unknown)=>void}>();
 private writes:Promise<void>=Promise.resolve();
 private sourceWork?:Promise<void>;
 private preparedSource?:ResumeSourcePlan;
 private readonly sourcePlans=new Map<string,BeginPayload>();
 private readonly sourceDescriptions=new Map<string,readonly ObjectDescriptor[]>();
 private stopped=false;
 private closeReason:unknown;
 constructor(private readonly ports:ResumePorts,private readonly connection:SyncFrameConnection){this.scope=D('wrss.library-resume.v1/storage',[ports.accountScope,ports.phoneDeviceId,ports.watchDeviceId]);}
 private check(){this.ports.check();if(this.stopped)throw this.closeReason??new ResumeError('USER_CANCELLED');}
 private write(value:Envelope):Promise<void>{const send=this.writes.then(async()=>{this.check();const job=value.jobId?await this.ports.store.job(this.scope,value.jobId):null;if(utf8(JSON.stringify(value)).length>(job?.description.selection.limits.maxFrameBytes??HARD_LIMITS.maxFrameBytes))fail('LIMIT_EXCEEDED');await this.connection.writeFrame(value as unknown as Row);});this.writes=send.catch(()=>{});return send;}
 private reply(r:Envelope,result:Row|null,epoch:number|null,error?:ResumeError):Envelope{const {payload,...base}=r;return {...base,type:'response',success:!error,result,...(error?{error:error.wire()}:{}),epoch};}
 async close(error:unknown=new ResumeError('USER_CANCELLED')){if(this.stopped)return;this.stopped=true;this.closeReason=error;for(const p of this.pending.values())p.reject(error);this.pending.clear();await this.ports.store.revokeConnection(this.ports.connectionId);await this.connection.close();}
 async run(first:Row):Promise<void>{
  let next:Row|undefined=first;
  try{await this.ports.store.exclusive(()=>this.ports.store.openConnection(this.ports.connectionId));for(;;){this.check();const input=next??await this.connection.readFrame(120000);next=undefined;const r=envelope(input);

    if(r.type==='response'){const limit=this.bindings.find(b=>b.jobId===r.jobId)?.selection.limits.maxFrameBytes??HARD_LIMITS.maxFrameBytes;if(frameBytes(input)>limit)fail('LIMIT_EXCEEDED');const p=this.pending.get(r.requestId);if(!p||r.phase!==p.request.phase||r.jobId!==p.request.jobId||r.planDigest!==p.request.planDigest||r.requestDigest!==p.request.requestDigest||r.phase!=='begin'&&r.epoch!==p.request.epoch)fail();if(r.success)this.validateAnswer(r,p.request);this.pending.delete(r.requestId);p.resolve(r);if(r.success&&r.result?.state==='COMPLETE'&&['begin','complete'].includes(r.phase)){await this.sourceWork;if(r.phase==='complete'&&await this.allTerminal())return;}continue;}
    let response:Envelope,after:(()=>void)|undefined;
    try{if(frameBytes(input)>HARD_LIMITS.maxFrameBytes)fail('LIMIT_EXCEEDED');if(requestDigest(r.jobId,r.planDigest,r.phase,r.payload!)!==r.requestDigest)fail('REQUEST_CONFLICT');
     const answer=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.handle(r)));this.check();response=this.reply(r,answer.result,answer.epoch);after=answer.after;
    }catch(e){this.ports.diagnostic?.(e);const error=resumeError(e);response=this.reply(r,null,r.epoch,error);await this.write(response);if(error.wire().recovery==='STOP')throw error;continue;}
    await this.write(response);after?.();
    if(['complete','cancel'].includes(r.phase)&&this.bindings.length&&await this.allTerminal()){await this.sourceWork;return;}
   }}catch(e){if(!this.stopped){if(!(e instanceof ResumeError)&&this.bindings.length&&await this.allTerminal())return;throw e;}}finally{await this.close(this.closeReason??new ResumeError('LOCAL_IO'));}
 }
 private async allTerminal(){for(const b of this.bindings){const j=await this.ports.store.job(this.scope,b.jobId);if(!j||!terminal(j))return false;}return true;}
 private async handle(r:Envelope):Promise<{result:Row;epoch:number|null;after?:()=>void}>{
  const p=r.payload!;
  if(r.phase==='prepare')return this.prepare(r);
  const b=this.bindings.find(v=>v.jobId===r.jobId);if(!b||!this.selectedOffer)fail('CAPABILITY_MISMATCH');
  if(r.phase==='begin')return this.begin(r,p as unknown as BeginPayload,b);
  const j=await this.ports.store.job(this.scope,r.jobId!);if(!j)fail('NOT_FOUND');
  if(j.planDigest!==r.planDigest)fail('JOB_CONFLICT');if(frameBytes(r)>j.description.selection.limits.maxFrameBytes)fail('LIMIT_EXCEEDED');
  if(j.connectionId!==this.ports.connectionId||j.epoch!==r.epoch)fail('STALE_EPOCH');
  if(j.expiresAt<this.ports.store.now())fail('EXPIRED');
  if(j.role!=='receiver'&&r.phase!=='cancel')fail();
  await this.ports.store.checkBinding(j,this.ports.phoneDeviceId,r);
  if(j.state==='CANCELLED'&&!['missing','cancel'].includes(r.phase))fail('JOB_CANCELLED');
  if(j.lease)await this.ports.chunks.check(j.lease as unknown as ObjectLease);
  let result:Row;
  switch(r.phase){
   case 'manifestPage':if(terminal(j))fail('PLAN_CONFLICT');result=await this.ports.store.manifest(j,r,this.ports.phoneDeviceId,p);break;
   case 'missing':result=await this.missing(j,p);await this.ports.store.db.transaction(this.ports.store.bind(j,this.ports.phoneDeviceId,r));break;
   case 'putChunk':result=await this.put(j,r);break;
   case 'apply':result=await this.apply(j,r);break;
   case 'complete':result=await this.ports.store.complete(j,r,this.ports.phoneDeviceId,p) as unknown as Row;break;
   case 'cancel':result=await this.ports.store.cancel(j,r,this.ports.phoneDeviceId);if(j.lease&&j.state!=='COMPLETE'){await this.ports.chunks.revokeWrites(j.lease as unknown as ObjectLease);for(const o of await this.ports.store.objects(j))await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),!o.receipt||!['noteAsset','readerResource'].includes(o.descriptor.kind));}break;
   default:fail();
  }
  await this.ports.store.touch(j);return {result,epoch:j.epoch};
 }
 private async prepare(r:Envelope):Promise<{result:Row;epoch:null;after?:()=>void}>{
  const p=r.payload!;await this.ports.store.bindPreparation(this.scope,this.ports.connectionId,r.requestId,r.requestDigest);
  if(p.step==='offer'){
   const cached=this.offers.get(r.requestId);if(cached)return {result:cached.result,epoch:null};
   if(this.offers.size>=4)fail('LIMIT_EXCEEDED');
   if(p.accountScope!==this.ports.accountScope)fail('ACCOUNT_MISMATCH');if(p.phoneDeviceId!==this.ports.phoneDeviceId||p.watchDeviceId!==this.ports.watchDeviceId)fail('PEER_MISMATCH');const phone=capability(p.phoneCapabilities);await this.ports.store.budget(0,Math.min(phone.limits.maxJournalBytes,this.ports.capability.limits.maxJournalBytes));
   let witness:Snapshot;
   if(p.watchSnapshot===null){const frozen=await this.ports.freeze();witness=frozen.witness;await this.ports.store.saveSnapshot(this.scope,witness,frozen.inventory);}
   else{witness=p.watchSnapshot as unknown as Snapshot;const old=await this.ports.store.snapshot(this.scope,witness.snapshotId);if(old&&!sameSnapshot(old.witness,witness))fail('PLAN_CONFLICT');}
   const digest=offerDigest(p,this.ports.capability,witness),result={step:'offer',watchCapabilities:this.ports.capability,watchSnapshot:witness,offerDigest:digest};
   this.offers.set(r.requestId,{request:r,payload:p,watchSnapshot:witness,digest,result});return {result:result as unknown as Row,epoch:null};
  }
  const offer=this.offers.get(String(p.offerRequestId));if(!offer)fail('CAPABILITY_MISMATCH');
  if(!Array.isArray(p.bindings))fail();const bs=(p.bindings as unknown[]).map(binding);if(bs.length<1||bs.length>2||new Set(bs.map(b=>b.jobId)).size!==bs.length||bs.some((b,i)=>i>0&&bs[i-1]!.direction>=b.direction))fail('CAPABILITY_MISMATCH');
  for(const b of bs){this.checkSelection(b,offer.payload.phoneCapabilities as unknown as Capability);const old=await this.ports.store.job(this.scope,b.jobId);if(old&&(old.description.direction!==b.direction||old.description.selectionDigest!==selectionDigest(b.selection)||!sameSnapshot(old.description.phoneSnapshot,offer.payload.phoneSnapshot as unknown as Snapshot)||!sameSnapshot(old.description.watchSnapshot,offer.watchSnapshot)))fail('JOB_CONFLICT');if(b.direction==='watchToPhone'&&b.intent==='resume'&&!old)fail('NOT_FOUND');}
  await this.ports.store.budget(0,Math.min(...bs.map(b=>b.selection.limits.maxJournalBytes)));const digest=preparationDigest(offer.digest,bs);if(digest!==p.preparationDigest)fail('PLAN_CONFLICT');
  if(this.bindings.length&&preparationDigest(this.selectedOffer!.digest,this.bindings)!==digest)fail('PLAN_CONFLICT');
  const reverse=bs.find(b=>b.direction==='watchToPhone');if(reverse?.intent==='create'){this.preparedSource=await this.ports.source(offer.watchSnapshot,reverse.selection);validateGraph(this.preparedSource.objects);for(const d of this.preparedSource.objects)descriptor(d,reverse.selection.limits);}
  await this.ports.store.preparation(this.scope,digest,{phoneSnapshot:offer.payload.phoneSnapshot,watchSnapshot:offer.watchSnapshot,bindings:bs,...(this.preparedSource?{sourceObjects:this.preparedSource.objects}:{})});
  this.bindings=bs;this.selectedOffer=offer;
  return {result:{step:'confirm',preparationDigest:digest},epoch:null,after:()=>{
   if(this.sourceWork||!bs.some(b=>b.direction==='watchToPhone'))return;
   this.sourceWork=this.sendSource(bs.find(b=>b.direction==='watchToPhone')!).catch(e=>{void this.close(e);throw e;});void this.sourceWork.catch(()=>{});
  }};
 }
 private checkSelection(b:Binding,phone:Capability){
  const watch=this.ports.capability;
  for(const k of b.selection.kinds){const w=watch.kinds.find(v=>v.kind===k.kind&&v.schemaVersion===k.schemaVersion),p=phone.kinds.find(v=>v.kind===k.kind&&v.schemaVersion===k.schemaVersion);if(!w||!p||!(b.direction==='phoneToWatch'?w.receive&&p.send:w.send&&p.receive))fail('CAPABILITY_MISMATCH');}
  for(const k of LIMIT_KEYS){const max=Math.min(watch.limits[k],phone.limits[k]);if(b.selection.limits[k]>max||b.intent==='create'&&b.selection.limits[k]!==max)fail('CAPABILITY_MISMATCH');}
 }
 private async begin(r:Envelope,p:BeginPayload,b:Binding){
  if(b.direction!=='phoneToWatch'||p.direction!==b.direction||p.accountScope!==this.ports.accountScope||p.phoneDeviceId!==this.ports.phoneDeviceId||p.watchDeviceId!==this.ports.watchDeviceId)fail('PEER_MISMATCH');
  if(frameBytes(r)>b.selection.limits.maxFrameBytes)fail('LIMIT_EXCEEDED');const offer=this.selectedOffer!;if(!sameSnapshot(p.phoneSnapshot,offer.payload.phoneSnapshot as unknown as Snapshot)||!sameSnapshot(p.watchSnapshot,offer.watchSnapshot)||p.selectionDigest!==selectionDigest(b.selection)||planDigest(p)!==r.planDigest)fail('PLAN_CONFLICT');
  if(!this.begun.has(b.jobId)&&p.intent!==b.intent)fail('JOB_CONFLICT');
  const old=await this.ports.store.job(this.scope,b.jobId);if(p.intent==='resume'&&!old)fail('NOT_FOUND');if(old&&old.planDigest!==r.planDigest)fail('JOB_CONFLICT');
  if(old&&old.expiresAt<this.ports.store.now())fail('EXPIRED');
  if(terminal(old??({state:'READY'} as Job))&&p.intent==='create')fail('JOB_CONFLICT');
  const source=p.phoneSnapshot;if(source.toInclusive!==0&&!await this.ports.supportsRange?.(p))fail('BUSINESS_REJECTED');
  await this.ports.store.preflightBegin(this.scope,b.jobId,p);const lease=await this.ports.chunks.acquire(D('wrss.library-resume.v1/native-scope',[this.scope,b.jobId]),this.ports.connectionId,!!old&&terminal(old),b.selection.limits);
  const job=await this.ports.store.begin(this.scope,r,p,this.ports.connectionId,lease.epoch,lease as unknown as Row);this.begun.add(b.jobId);
  await this.ports.store.db.transaction(this.ports.store.bind(job,this.ports.phoneDeviceId,r));await this.cleanupApplied(job);
  return {result:{disposition:old?'RESUMED':'CREATED',selectionDigest:p.selectionDigest,state:job.state,expiresAtMillis:job.expiresAt,nextManifestPage:job.nextPage,completion:job.completion},epoch:job.epoch};
 }
 private async cleanupApplied(j:Job,d?:ObjectDescriptor):Promise<void>{
  if(!j.lease)return;
  for(const o of d?[await this.ports.store.object(j,d.objectId)]:await this.ports.store.objects(j)){
   if(!o.receipt)continue;
   try{await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),!['noteAsset','readerResource'].includes(o.descriptor.kind));}catch(e){this.ports.diagnostic?.(e);}
  }
 }
 private async missing(j:Job,p:Row):Promise<Row>{
  await this.cleanupApplied(j);const items:Row[]=[],limit=Number(p.limit),base={state:j.state,nextManifestPage:j.nextPage,expiresAtMillis:j.expiresAt,completion:j.completion};
  if(limit===0||j.state==='CANCELLED')return {...base,items,next:null,done:true};
  if(j.state==='PLANNING')fail('MANIFEST_INCOMPLETE');if(limit>j.description.selection.limits.maxResultsPerPage)fail();
  const all=await this.ports.store.objects(j);let start=0,chunk=0;
  if(p.afterObjectId!==null){const index=all.findIndex(o=>o.descriptor.objectId===p.afterObjectId);if(index<0)fail();start=p.afterChunkIndex===null?index+1:index;chunk=p.afterChunkIndex===null?0:Number(p.afterChunkIndex);}
  let rangesLeft=j.description.selection.limits.maxRangesPerPage,next:Row|null=null;
  for(let i=start;i<all.length&&items.length<limit;i++){
   const o=all[i]!,d=o.descriptor;let state='APPLIED',ranges:number[][]=[];
   if(!o.receipt){const status=await this.ports.chunks.status(j.lease as unknown as ObjectLease,nativeObject(d));state=status.state;for(const n of status.missing.filter(n=>n>=chunk)){const tail=ranges[ranges.length-1];if(tail&&tail[1]===n)tail[1]=n+1;else ranges.push([n,n+1]);}}
   const take=ranges.slice(0,rangesLeft);rangesLeft-=take.length;items.push({objectId:d.objectId,state,missingRanges:take,receipt:o.receipt});chunk=0;
   if(take.length<ranges.length){if(!take.length){items.pop();next={afterObjectId:d.objectId,afterChunkIndex:ranges[0]![0]};}else next={afterObjectId:d.objectId,afterChunkIndex:take[take.length-1]![1]};break;}
   next=i+1<all.length?{afterObjectId:d.objectId,afterChunkIndex:null}:null;
   if(rangesLeft===0)break;
  }
  return {...base,items,next,done:next===null};
 }
 private async runnable(j:Job,d:ObjectDescriptor){for(const dep of d.dependsOn)if(!(await this.ports.store.object(j,dep)).receipt)fail('DEPENDENCIES_PENDING');}
 private async admit(j:Job,d:ObjectDescriptor){
  await this.cleanupApplied(j);
  const current=await this.ports.chunks.status(j.lease as unknown as ObjectLease,nativeObject(d));if(current.state!=='PENDING')return;
  let active=0;for(const o of await this.ports.store.objects(j)){if(o.receipt||o.descriptor.objectId===d.objectId)continue;const status=await this.ports.chunks.status(j.lease as unknown as ObjectLease,nativeObject(o.descriptor));if(status.state!=='PENDING')active++;}
  if(active>=j.description.selection.limits.maxInFlightObjects)fail('WINDOW_FULL');
 }
 private async put(j:Job,r:Envelope):Promise<Row>{
  if(j.state==='PLANNING')fail('MANIFEST_INCOMPLETE');const p=r.payload!,o=await this.ports.store.object(j,String(p.objectId)),d=o.descriptor,index=Number(p.chunkIndex),bytes=b64(p.dataBase64,CHUNK_BYTES);
  if(index>=d.chunkHashes.length||bytes.length!==Math.min(CHUNK_BYTES,d.size-index*CHUNK_BYTES)||hash(bytes)!==d.chunkHashes[index])fail('HASH_MISMATCH');
  if(o.receipt){await this.ports.store.db.transaction([this.ports.store.guard(j),...this.ports.store.bind(j,this.ports.phoneDeviceId,r)]);await this.cleanupApplied(j,d);return {objectId:d.objectId,chunkIndex:index,chunkState:null,objectState:'APPLIED',receipt:o.receipt};}
  if(terminal(j))fail('JOB_CANCELLED');await this.runnable(j,d);await this.admit(j,d);
  const status=await this.ports.chunks.stage(j.lease as unknown as ObjectLease,nativeObject(d),index,bytes,{id:r.requestId,digest:r.requestDigest});
  await this.ports.store.db.transaction([this.ports.store.guard(j),...this.ports.store.bind(j,this.ports.phoneDeviceId,r),{sql:"UPDATE library_resume_jobs SET state='TRANSFERRING' WHERE scope=? AND job_id=?",params:[j.scope,j.jobId]}]);
  return {objectId:d.objectId,chunkIndex:index,chunkState:'STAGED',objectState:status.state==='STAGED'?'STAGED':'PARTIAL',receipt:null};
 }
 private async apply(j:Job,r:Envelope):Promise<Row>{
  if(j.state==='PLANNING')fail('MANIFEST_INCOMPLETE');const o=await this.ports.store.object(j,String(r.payload!.objectId));if(o.receipt){await this.ports.store.db.transaction([this.ports.store.guard(j),...this.ports.store.bind(j,this.ports.phoneDeviceId,r)]);await this.cleanupApplied(j,o.descriptor);return {state:'APPLIED',receipt:o.receipt};}
  if(terminal(j))fail('JOB_CANCELLED');await this.runnable(j,o.descriptor);await this.admit(j,o.descriptor);
  const final=await (this.ports.publish?this.ports.publish(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),o.descriptor):this.ports.chunks.finalize(j.lease as unknown as ObjectLease,nativeObject(o.descriptor)));this.check();
  await this.ports.apply(j,o.descriptor,final.path,this.ports.store.boundary(j,r,this.ports.phoneDeviceId,o.descriptor.objectId,this.ports.watchDeviceId,()=>this.check()));this.check();
  const saved=await this.ports.store.object(j,o.descriptor.objectId);if(!saved.receipt)fail('RECEIPT_CONFLICT');
  // Business commit is authoritative. Cleanup is repeatable and cannot revoke it.
  try{await this.ports.chunks.release(j.lease as unknown as ObjectLease,nativeObject(o.descriptor),!['noteAsset','readerResource'].includes(o.descriptor.kind));}catch{}
  this.ports.applied?.();return {state:'APPLIED',receipt:saved.receipt};
 }
 private async request(phase:Envelope['phase'],job:string,plan:string,epoch:number|null,payload:Row,stable=true):Promise<Envelope>{
  const digest=requestDigest(job,plan,phase,payload),id=stable?D('wrss.library-resume.v1/source-request',[job,digest]).slice(0,32):await this.ports.randomId();
  const r:Envelope={action:ACTION,version:VERSION,phase,type:'request',jobId:job,planDigest:plan,epoch,requestId:id,requestDigest:digest,payload};
  for(;;){const answer=new Promise<Envelope>((resolve,reject)=>this.pending.set(id,{request:r,resolve,reject}));await this.write(r);const result=await answer;
  if(!result.success){const error=new ResumeError(String(result.error?.code));if(error.wire().recovery==='WAIT'){await this.ports.sleep(Number(result.error?.retryAfterMillis)).result;this.check();continue;}throw error;}return result;}
 }
 private async sendSource(b:Binding):Promise<void>{
  for(;;){try{return await this.transferSource(b);}catch(e){if(!(e instanceof ResumeError))throw e;const recovery=String(e.wire().recovery);if(recovery==='WAIT'){await this.ports.sleep(100).result;this.check();continue;}if(!['BEGIN','QUERY'].includes(recovery))throw e;this.check();b={...b,intent:'resume'};}}
 }
 private async transferSource(b:Binding):Promise<void>{
  const o=this.selectedOffer!,old=await this.ports.store.job(this.scope,b.jobId);let source:ResumeSourcePlan|undefined,p:BeginPayload;
  if(b.intent==='resume'){if(!old)fail('NOT_FOUND');p={...old.description,intent:'resume'};}
  else{source=this.preparedSource??await this.ports.source(o.watchSnapshot,b.selection);validateGraph(source.objects);const counts:number[]=[];let bytes=0,count=0;
   const pageBytes=Math.min(b.selection.limits.maxManifestPageBytes,b.selection.limits.maxFrameBytes);for(const object of source.objects){const n=utf8(JSON.stringify(object)).length;if(n+4096>pageBytes)fail('LIMIT_EXCEEDED');if(count&&(bytes+n+4096>pageBytes||count===b.selection.limits.maxManifestPageEntries)){counts.push(count);count=0;bytes=0;}count++;bytes+=n;}if(count)counts.push(count);
   p={intent:'create',accountScope:this.ports.accountScope,phoneDeviceId:this.ports.phoneDeviceId,watchDeviceId:this.ports.watchDeviceId,direction:'watchToPhone',phoneSnapshot:o.payload.phoneSnapshot as unknown as Snapshot,watchSnapshot:o.watchSnapshot,selection:b.selection,selectionDigest:selectionDigest(b.selection),objectCount:source.objects.length,objectsRoot:objectsRoot(source.objects.map(v=>v.objectId)),pageObjectCounts:counts};
  }
  this.sourcePlans.set(b.jobId,p);const plan=planDigest(p),beginId=D('wrss.library-resume.v1/source-request',[b.jobId,requestDigest(b.jobId,plan,'begin',p as unknown as Row)]).slice(0,32);
  const fake:Envelope={action:ACTION,version:1,phase:'begin',type:'request',jobId:b.jobId,planDigest:plan,epoch:null,requestId:beginId,requestDigest:requestDigest(b.jobId,plan,'begin',p as unknown as Row),payload:p as unknown as Row};
  // Persist source intent BEFORE sending a begin that the receiver may commit.
  let local=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.begin(this.scope,fake,p,this.ports.connectionId,old?.epoch??1,null,'source')));
  const began=await this.request('begin',b.jobId,plan,null,p as unknown as Row),epoch=Number(began.epoch),beginResult=began.result!;
  if(!Number.isSafeInteger(epoch)||epoch<1||beginResult.selectionDigest!==p.selectionDigest)fail('CAPABILITY_MISMATCH');
  local=await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.begin(this.scope,fake,{...p,intent:'resume'},this.ports.connectionId,epoch,null,'source')));
  if(beginResult.state==='CANCELLED'){await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));fail('JOB_CANCELLED');}
  if(beginResult.state==='COMPLETE'){await this.acceptCompletion(local,beginResult.completion as unknown as Completion);return;}
  try{source??=await this.ports.source(o.watchSnapshot,b.selection);}catch(e){const error=resumeError(e);if(error.code!=='SOURCE_CHANGED')throw error;await this.request('cancel',b.jobId,plan,epoch,{reason:'SOURCE_CHANGED'});await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));throw new ResumeError('SOURCE_CHANGED');}
  if(objectsRoot(source.objects.map(v=>v.objectId))!==p.objectsRoot)fail('SOURCE_CHANGED');this.sourceDescriptions.set(b.jobId,source.objects);
  let start=0,previous='0'.repeat(64);for(let index=0;index<p.pageObjectCounts.length;index++){
   const entries=source.objects.slice(start,start+p.pageObjectCounts[index]!);const digest=pageDigest(plan,index,start,entries,previous),payload={pageIndex:index,startIndex:start,previousPageDigest:previous,pageDigest:digest,entries};
   if(index>=Number(beginResult.nextManifestPage))await this.request('manifestPage',b.jobId,plan,epoch,payload);start+=entries.length;previous=digest;
  }
  // Re-query the receiver on every recovery. Bytes sent are never receipts.
  const observed=new Map<string,{descriptor:ObjectDescriptor;state:string;missing:number[][];receipt:AppliedReceipt|null}>();let cursor:Row={afterObjectId:null,afterChunkIndex:null,limit:b.selection.limits.maxResultsPerPage};
  for(;;){const result=(await this.request('missing',b.jobId,plan,epoch,cursor,false)).result!;for(const raw of result.items as Row[]){const d=source.objects.find(v=>v.objectId===raw.objectId);if(!d)fail('RECEIPT_CONFLICT');const item=observed.get(d.objectId)??{descriptor:d,state:String(raw.state),missing:[],receipt:null};item.missing.push(...raw.missingRanges as number[][]);item.receipt=raw.receipt as unknown as AppliedReceipt|null;observed.set(d.objectId,item);}if(result.done===true)break;cursor={...row(result.next),limit:b.selection.limits.maxResultsPerPage};}
  const applied=new Map<string,AppliedReceipt>();for(const [id,v]of observed)if(v.receipt){this.validateReceipt(v.receipt,b.jobId,plan,id);applied.set(id,v.receipt);}
  while(applied.size<source.objects.length){
   const ready=source.objects.filter(d=>!applied.has(d.objectId)&&d.dependsOn.every(id=>applied.has(id))).sort((a,b)=>a.objectId<b.objectId?-1:1);if(!ready.length)fail('PLAN_CONFLICT');
   for(const d of ready){const item=observed.get(d.objectId);if(!item)fail('RECEIPT_CONFLICT');for(const [from,to]of item.missing)for(let index=from;index<to;index++){this.check();let bytes:Uint8Array;try{bytes=await this.withHeartbeat(source.read(d,index),b.jobId,plan,epoch);}catch(e){this.ports.diagnostic?.(e);const error=resumeError(e);if(error.code!=='SOURCE_CHANGED')throw error;await this.request('cancel',b.jobId,plan,epoch,{reason:'SOURCE_CHANGED'});await this.ports.authorize(()=>this.ports.store.exclusive(()=>this.ports.store.cancel(local)));throw new ResumeError('SOURCE_CHANGED');}if(hash(bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');await this.request('putChunk',b.jobId,plan,epoch,{objectId:d.objectId,chunkIndex:index,dataBase64:encodeBase64(bytes)});}
    const result=(await this.request('apply',b.jobId,plan,epoch,{objectId:d.objectId})).result!,receipt=result.receipt as unknown as AppliedReceipt;this.validateReceipt(receipt,b.jobId,plan,d.objectId);applied.set(d.objectId,receipt);
   }
  }
  const root=receiptsRoot(source.objects.map(d=>applied.get(d.objectId)!));const done=(await this.request('complete',b.jobId,plan,epoch,{objectCount:p.objectCount,receiptsRoot:root,ackToInclusive:p.watchSnapshot.toInclusive})).result as unknown as Completion;if(done.receiptsRoot!==root)fail('RECEIPT_CONFLICT');await this.acceptCompletion(local,done);
 }
 private async withHeartbeat<T>(work:Promise<T>,job:string,plan:string,epoch:number):Promise<T>{
  let done=false;void work.finally(()=>{done=true;}).catch(()=>{});
  while(!done){const timer=this.ports.sleep(8000);try{await Promise.race([work.then(()=>{},()=>{}),timer.result]);}finally{timer.cancel();}if(!done)await this.request('missing',job,plan,epoch,{afterObjectId:null,afterChunkIndex:null,limit:0},false);}
  return work;
 }
 private validateAnswer(answer:Envelope,request:Envelope):void {
  const o=answer.result!,p=request.payload!;
  const descriptors=this.sourceDescriptions.get(request.jobId!)??[],description=this.sourcePlans.get(request.jobId!);
  if(description&&o.completion){const c=o.completion as unknown as Completion;if(c.objectCount!==description.objectCount||c.ackToInclusive!==description.watchSnapshot.toInclusive||c.completionDigest!==completion(request.jobId!,request.planDigest!,c.objectCount,c.receiptsRoot,c.ackToInclusive).completionDigest)fail('RECEIPT_CONFLICT');}
  const receipt=(value:unknown,id:string)=>this.validateReceipt(value as AppliedReceipt,request.jobId!,request.planDigest!,id);
  switch(request.phase){
   case 'prepare':if(o.step!==p.step||p.step==='confirm'&&o.preparationDigest!==p.preparationDigest)fail();break;
   case 'begin':{const d=p as unknown as BeginPayload;if(o.selectionDigest!==d.selectionDigest||Number(o.nextManifestPage)>d.pageObjectCounts.length||d.intent==='resume'&&o.disposition==='CREATED')fail();if(o.state==='COMPLETE'){const c=o.completion as unknown as Completion;if(c.objectCount!==d.objectCount||c.ackToInclusive!==d.watchSnapshot.toInclusive)fail('RECEIPT_CONFLICT');}break;}
   case 'manifestPage':if(o.pageIndex!==p.pageIndex||o.pageDigest!==p.pageDigest||o.nextManifestPage!==Number(p.pageIndex)+1)fail();break;
   case 'missing':{
    const local=this.bindings.find(b=>b.jobId===request.jobId)!.selection.limits,items=o.items as Row[];if(items.length>Number(p.limit)||Number(p.limit)===0&&(items.length||o.next!==null||!o.done)||Number(p.limit)>0&&o.state==='PLANNING')fail();let ranges=0;
    for(const item of items){const d=descriptors.find(d=>d.objectId===item.objectId);if(!d)fail('RECEIPT_CONFLICT');for(const range of item.missingRanges as number[][]){ranges++;if(range[1]!>d.chunkHashes.length)fail();}if(item.receipt)receipt(item.receipt,d.objectId);}if(ranges>local.maxRangesPerPage||items.length>local.maxResultsPerPage||Number(o.nextManifestPage)>(description?.pageObjectCounts.length??0))fail();if(o.next){const cursor=row(o.next),d=descriptors.find(d=>d.objectId===cursor.afterObjectId);if(!d||cursor.afterChunkIndex!==null&&Number(cursor.afterChunkIndex)>=d.chunkHashes.length)fail();}break;
   }
   case 'putChunk':if(o.objectId!==p.objectId||o.chunkIndex!==p.chunkIndex)fail();if(o.receipt)receipt(o.receipt,String(p.objectId));break;
   case 'apply':receipt(o.receipt,String(p.objectId));break;
   case 'complete':if(o.objectCount!==p.objectCount||o.receiptsRoot!==p.receiptsRoot||o.ackToInclusive!==p.ackToInclusive)fail('RECEIPT_CONFLICT');break;
   case 'cancel':break;
  }
 }
 private validateReceipt(r:AppliedReceipt,job:string,plan:string,id:string){exact(r,['jobId','planDigest','objectId','applyRequestId','applyRequestDigest','receiverDeviceId','resultDigest','outcome']);if(r.jobId!==job||r.planDigest!==plan||r.objectId!==id||r.receiverDeviceId!==this.ports.phoneDeviceId||!['merged','retainedLocal','alreadyPresent'].includes(r.outcome)||r.resultDigest!==D('wrss.library-resume.v1/applied',[r.jobId,r.planDigest,r.objectId,hex(r.applyRequestId,32),hex(r.applyRequestDigest),r.receiverDeviceId,r.outcome]))fail('RECEIPT_CONFLICT');}
 private async acceptCompletion(j:Job,c:Completion){if(!c||c.state!=='COMPLETE'||c.objectCount!==j.description.objectCount||c.ackToInclusive!==j.description.watchSnapshot.toInclusive||c.completionDigest!==completion(j.jobId,j.planDigest,c.objectCount,c.receiptsRoot,c.ackToInclusive).completionDigest)fail('RECEIPT_CONFLICT');await this.ports.authorize(()=>this.ports.store.exclusive(async()=>{const latest=await this.ports.store.job(j.scope,j.jobId);if(!latest||latest.connectionId!==this.ports.connectionId||latest.epoch!==j.epoch)fail('STALE_EPOCH');await this.ports.store.db.transaction([this.ports.store.guard(j),{sql:"UPDATE library_resume_jobs SET state='COMPLETE',completion=? WHERE scope=? AND job_id=?",params:[JSON.stringify(c),j.scope,j.jobId]},{sql:'INSERT OR REPLACE INTO library_resume_peer_ack VALUES(?,?,?)',params:[j.scope,j.jobId,JSON.stringify(c)]},{sql:'DELETE FROM library_resume_reservations WHERE scope=? AND job_id=?',params:[j.scope,j.jobId]}]);}));}
}
