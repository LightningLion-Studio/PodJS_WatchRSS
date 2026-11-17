import {frameBytes} from '../wire-frame-size';
import {fail,integer,utf8,hash,envelope,completionResult,receiptResult,ResumeError,type BeginPayload,type Envelope,type ObjectDescriptor,type AppliedReceipt,type Completion,type Row} from './wire';
import {descriptor,objectsRoot,pageDigest,planDigest,requestDigest,appliedReceipt,receiptsRoot,completion} from './digests';
import {Grant} from './state';

/** Persistence adapter contract: all methods retain frozen IDs/receipts at least
 * 24h, make replay idempotent and perform check() at the final durable/SQL commit.
 * No native storage or business API is installed by this pure-logic card.
 */
export interface JobJournal {
 manifestPage(index:number,entries:readonly ObjectDescriptor[],check:()=>void):Promise<void>;
 verifyAndReservePeak(check:()=>void):Promise<void>;
 apply(objectId:string,makeReceipt:(outcome:'merged'|'retainedLocal'|'alreadyPresent')=>AppliedReceipt,check:()=>void):Promise<AppliedReceipt>;
 receipts():Promise<AppliedReceipt[]>;
 complete(value:Completion,check:()=>void):Promise<void>;
 cancel(reason:string):Promise<void>;
}
export interface JobCheckpoint {
 planDigest:string;state:'PLANNING'|'READY'|'COMPLETE'|'CANCELLED';nextPage:number;previous:string;bytes:number;
 ids:string[];dependencies:[string,string[]][];kinds:[string,string][];entities:string[];
 pages:[number,{hash:string;result:Row}][];completion:Completion|null;
}
export interface RegisteredManifest {objectCount:number;at(slot:number):Promise<ObjectDescriptor|null>}
/** Ordered manifest/lifecycle core. Keeps IDs/dependencies only, not chunk hashes.
 * A resumed journal restores a validated snapshot via a fresh instance and the
 * original manifest pages before admitting DATA; persistent facts remain in port.
 */
export class JobLifecycle {
 private state:'PLANNING'|'READY'|'COMPLETE'|'CANCELLED'='PLANNING';private nextPage=0;private previous='0'.repeat(64);private bytes=0;
 private ids:string[]=[];private dependencies=new Map<string,string[]>();private kinds=new Map<string,string>();
 private pages=new Map<number,{hash:string;result:Row}>();private entities=new Set<string>();private done:Completion|null=null;
 private busy=false;private readonly begin:BeginPayload;private readonly plan:string;
 constructor(private readonly jobId:string,begin:BeginPayload,private readonly grant:Grant,private readonly journal:JobJournal,private readonly receiverDeviceId:string){
  this.begin=JSON.parse(JSON.stringify(begin));this.plan=planDigest(this.begin);
  if(this.begin.selection.limits.maxInFlightChunks!==1||this.begin.selection.limits.maxInFlightBytes!==65536)fail('CAPABILITY_MISMATCH');
  // phaseArgs validates exact fields and the selection commitment, including empty plans.
  requestDigest('0'.repeat(32),this.plan,'begin',this.begin as unknown as Row);
 }
 get snapshot(){return {state:this.state,nextManifestPage:this.nextPage,manifestVerified:this.state==='READY'};}
 private async stopOnError<T>(work:()=>Promise<T>):Promise<T> {
  try{return await work();}catch(e){if(!(e instanceof ResumeError)||e.wire().recovery==='STOP')this.grant.fence();throw e;}
 }
 /** Persist this snapshot atomically with the manifest page journal. */
 checkpoint():JobCheckpoint {
  return JSON.parse(JSON.stringify({planDigest:this.plan,state:this.state,nextPage:this.nextPage,previous:this.previous,bytes:this.bytes,ids:this.ids,dependencies:[...this.dependencies],kinds:[...this.kinds],entities:[...this.entities],pages:[...this.pages],completion:this.done}));
 }
 /** New authenticated connection only. Revalidate a READY reservation before data;
  * PLANNING resumes at its durable next page, including preadmission heartbeat. */
 async restore(value:JobCheckpoint):Promise<void> {return this.stopOnError(()=>this.restoreChecked(value));}
 private async restoreChecked(value:JobCheckpoint):Promise<void> {
  const c:JobCheckpoint=JSON.parse(JSON.stringify(value)),token=this.grant.token();this.grant.check(token);
  if(this.nextPage||this.ids.length||c.planDigest!==this.plan||integer(c.nextPage,this.begin.pageObjectCounts.length)!==c.nextPage||integer(c.bytes,this.begin.selection.limits.maxManifestBytes)!==c.bytes||c.ids.length!==this.begin.pageObjectCounts.slice(0,c.nextPage).reduce((a,b)=>a+b,0)||c.ids.some((id,i)=>i>0&&c.ids[i-1]!>=id))fail('JOURNAL_CORRUPT');
  this.nextPage=c.nextPage;this.previous=c.previous;this.bytes=c.bytes;this.ids=c.ids;this.dependencies=new Map(c.dependencies);this.kinds=new Map(c.kinds);this.entities=new Set(c.entities);this.pages=new Map(c.pages);
  if(this.dependencies.size!==this.ids.length||this.kinds.size!==this.ids.length||this.ids.some(id=>!this.dependencies.has(id)||!this.kinds.has(id))||this.pages.size!==c.nextPage)fail('JOURNAL_CORRUPT');
  if(c.state==='READY'||c.state==='COMPLETE'){
   if(c.ids.length!==this.begin.objectCount||objectsRoot(c.ids)!==this.begin.objectsRoot)fail('JOURNAL_CORRUPT');this.verifyDag();
   if(c.state==='READY'){await this.journal.verifyAndReservePeak(()=>this.grant.check(token));this.grant.check(token);}
  }
  if(c.state==='COMPLETE'){
   const d=completionResult(c.completion),expected=completion(this.jobId,this.plan,d.objectCount,d.receiptsRoot,d.ackToInclusive);
   if(d.objectCount!==this.begin.objectCount||d.ackToInclusive!==(this.begin.direction==='phoneToWatch'?this.begin.phoneSnapshot:this.begin.watchSnapshot).toInclusive||d.completionDigest!==expected.completionDigest)fail('JOURNAL_CORRUPT');this.done=d;
  }else if(c.completion!==null)fail('JOURNAL_CORRUPT');
  if(!['PLANNING','READY','COMPLETE','CANCELLED'].includes(c.state))fail('JOURNAL_CORRUPT');this.state=c.state;
 }
 private checkRequest(r:Envelope,phase:Envelope['phase']):()=>void {
  envelope(r);const token=this.grant.token();this.grant.check(token);
  if(r.type!=='request'||r.jobId!==this.jobId||r.phase!==phase||r.planDigest!==this.plan||r.epoch!==token.epoch||requestDigest(r.jobId,r.planDigest,r.phase,r.payload!)!==r.requestDigest)fail('REQUEST_CONFLICT');
  return ()=>this.grant.check(token);
 }
 async emptyPlan():Promise<void> {return this.stopOnError(()=>this.emptyPlanChecked());}
 private async emptyPlanChecked():Promise<void> {
  if(this.begin.objectCount!==0||this.begin.objectsRoot!==objectsRoot([])||this.state!=='PLANNING')fail('PLAN_CONFLICT');
  const t=this.grant.token();await this.journal.verifyAndReservePeak(()=>this.grant.check(t));this.grant.check(t);this.state='READY';
 }
 async manifest(r:Envelope):Promise<Row> {return this.stopOnError(()=>this.manifestChecked(r));}
 private async manifestChecked(r:Envelope):Promise<Row> {
  const check=this.checkRequest(r,'manifestPage');if(this.busy)fail('BUSY');
  const p=r.payload!,index=integer(p.pageIndex),start=integer(p.startIndex),entries=(p.entries as unknown[]).map(e=>descriptor(e,this.begin.selection.limits));
  const pageHash=hash(utf8(JSON.stringify([r.requestId,r.requestDigest,entries.map(o=>[o.objectId,o.metadataUtf8])]))),old=this.pages.get(index);
  if(old){if(old.hash!==pageHash)fail('REQUEST_CONFLICT');return {...old.result};}
  if(this.state!=='PLANNING')fail('MANIFEST_INCOMPLETE');
  if(index!==this.nextPage||start!==this.ids.length||entries.length!==this.begin.pageObjectCounts[index]||p.previousPageDigest!==this.previous||p.pageDigest!==pageDigest(this.plan,index,start,entries,this.previous))fail('PLAN_CONFLICT');
  const ids=[...this.ids,...entries.map(e=>e.objectId)];if(ids.some((id,i)=>i>0&&ids[i-1]!>=id))fail('PLAN_CONFLICT');
  const entities=new Set(this.entities);for(const o of entries){if(!this.begin.selection.kinds.some(k=>k.kind===o.kind))fail('UNSUPPORTED_KIND');const key=(o.kind.startsWith('article')?'article':o.kind)+':'+o.businessId;if(entities.has(key))fail('PLAN_CONFLICT');entities.add(key);}
  const pageBytes=utf8(JSON.stringify(entries)).length,nextBytes=this.bytes+pageBytes;
  if(nextBytes>this.begin.selection.limits.maxManifestBytes||frameBytes(r)+12>this.begin.selection.limits.maxManifestPageBytes)fail('LIMIT_EXCEEDED');
  this.busy=true;
  try{
   await this.journal.manifestPage(index,entries,check);check();
   this.entities=entities;this.ids=ids;this.bytes=nextBytes;this.nextPage++;this.previous=String(p.pageDigest);
   for(const o of entries){this.dependencies.set(o.objectId,[...o.dependsOn]);this.kinds.set(o.objectId,o.kind);}
   if(this.nextPage===this.begin.pageObjectCounts.length){
    if(ids.length!==this.begin.objectCount||objectsRoot(ids)!==this.begin.objectsRoot)fail('PLAN_CONFLICT');
    this.verifyDag();await this.journal.verifyAndReservePeak(check);check();this.state='READY';
   }
   const result={pageIndex:index,pageDigest:p.pageDigest,nextManifestPage:this.nextPage,manifestVerified:this.state==='READY',state:this.state};
   this.pages.set(index,{hash:pageHash,result});return result;
  }finally{this.busy=false;}
 }
 private verifyDag():void {
  const pending=new Map<string,number>(),children=new Map<string,string[]>();
  for(const [id,deps] of this.dependencies){
   pending.set(id,deps.length);
   for(const dep of deps){if(!this.dependencies.has(dep))fail('PLAN_CONFLICT');children.set(dep,[...(children.get(dep)??[]),id]);}
   const kind=this.kinds.get(id),required=kind==='readerResource'?'readerMetadata':null;
   if(required&&!deps.some(d=>this.kinds.get(d)===required))fail('PLAN_CONFLICT');
  }
  const ready=[...pending].filter(([,n])=>n===0).map(([id])=>id);let seen=0;
  while(ready.length){const id=ready.pop()!;seen++;for(const child of children.get(id)??[]){const n=pending.get(child)!-1;pending.set(child,n);if(!n)ready.push(child);}}
  if(seen!==pending.size)fail('PLAN_CONFLICT');
 }
 async apply(r:Envelope):Promise<Row> {return this.stopOnError(()=>this.applyChecked(r));}
 private async applyChecked(r:Envelope):Promise<Row> {
  const check=this.checkRequest(r,'apply');if(this.state!=='READY'||this.busy)fail('MANIFEST_INCOMPLETE');
  const id=String(r.payload!.objectId);if(!this.dependencies.has(id))fail('OBJECT_CONFLICT');this.busy=true;
  try{
   const receipt=await this.journal.apply(id,outcome=>appliedReceipt(r,id,this.receiverDeviceId,outcome),check);check();receiptResult(receipt);
   const expected=appliedReceipt(r,id,this.receiverDeviceId,receipt.outcome);
   if(JSON.stringify(receipt)!==JSON.stringify(expected)){
    if(Object.keys(expected).some(k=>expected[k as keyof AppliedReceipt]!==receipt[k as keyof AppliedReceipt]))fail('RECEIPT_CONFLICT');
   }
   return {state:'APPLIED',receipt};
  }finally{this.busy=false;}
 }
 async finish(r:Envelope):Promise<Completion> {return this.stopOnError(()=>this.finishChecked(r));}
 private async finishChecked(r:Envelope):Promise<Completion> {
  const check=this.checkRequest(r,'complete');if(this.done){const p=r.payload!;if(p.objectCount!==this.done.objectCount||p.receiptsRoot!==this.done.receiptsRoot||p.ackToInclusive!==this.done.ackToInclusive)fail('RECEIPT_CONFLICT');return {...this.done};}if(this.state!=='READY'||this.busy)fail('MANIFEST_INCOMPLETE');this.busy=true;
  try{
   const receipts=(await this.journal.receipts()).sort((a,b)=>a.objectId<b.objectId?-1:a.objectId>b.objectId?1:0);check();
   if(receipts.length!==this.ids.length||receipts.some((x,i)=>x.objectId!==this.ids[i]||x.jobId!==r.jobId||x.planDigest!==this.plan))fail('RECEIPT_CONFLICT');
   for(const receipt of receipts){receiptResult(receipt);const expected=appliedReceipt({jobId:receipt.jobId,planDigest:receipt.planDigest,requestId:receipt.applyRequestId,requestDigest:receipt.applyRequestDigest} as Envelope,receipt.objectId,this.receiverDeviceId,receipt.outcome);if(receipt.receiverDeviceId!==this.receiverDeviceId||receipt.resultDigest!==expected.resultDigest||receipt.applyRequestDigest!==requestDigest(this.jobId,this.plan,'apply',{objectId:receipt.objectId}))fail('RECEIPT_CONFLICT');}
   const root=receiptsRoot(receipts),p=r.payload!;
   if(p.objectCount!==this.ids.length||p.receiptsRoot!==root||p.ackToInclusive!==(this.begin.direction==='phoneToWatch'?this.begin.phoneSnapshot:this.begin.watchSnapshot).toInclusive)fail('RECEIPT_CONFLICT');
   const done=completion(r.jobId!,this.plan,this.ids.length,root,Number(p.ackToInclusive));await this.journal.complete(done,check);check();this.done=done;this.state='COMPLETE';return done;
  }finally{this.busy=false;}
 }
 async cancel(r:Envelope):Promise<Row> {
  this.checkRequest(r,'cancel');const complete=this.state==='COMPLETE';this.grant.fence();if(!complete)this.state='CANCELLED';await this.journal.cancel(String(r.payload!.reason));return {state:this.state,alreadyComplete:complete};
 }
}
