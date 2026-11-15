import type {SqlDatabase,SqlParams} from '../../core/types';
import {D,appliedReceipt,completion,descriptor,objectsRoot,pageDigest,receiptsRoot} from './digests';
import {fail,RETENTION,utf8,sorted,exact,hex,type Envelope,type BeginPayload,type ObjectDescriptor,type AppliedReceipt,type Outcome,type Completion,type Snapshot,type Row} from './wire';
export type Statement={sql:string;params?:SqlParams};
export interface ReceiptBoundary {before:Statement[];after(outcome:Outcome):Statement[]}
export type JobState='PLANNING'|'READY'|'TRANSFERRING'|'APPLIED'|'COMPLETE'|'CANCELLED';
export interface Job {scope:string;jobId:string;planDigest:string;description:BeginPayload;state:JobState;connectionId:string;epoch:number;expiresAt:number;nextPage:number;completion:Completion|null;lease:Row|null;role:'receiver'|'source'}
const lanes=new WeakMap<SqlDatabase,Promise<unknown>>();
const parse=<T>(value:unknown):T=>{try{return JSON.parse(String(value)) as T;}catch{fail('JOURNAL_CORRUPT');}};
/** Auxiliary tables live in the SAME business database. The single writer lane
 * spans native staging and the final business commit, including every connection.
 * Cross-process account changes additionally share WatchAccountStore's lease.
 */
export class ResumeStore {
 private ready?:Promise<void>;
 private logical=Date.now();private injectedClock:boolean;
 readonly now:()=>number;
 constructor(readonly db:SqlDatabase,now?:()=>number){this.injectedClock=!!now;this.now=now??(()=>this.logical);}
 exclusive<T>(run:()=>Promise<T>):Promise<T>{const p=(lanes.get(this.db)??Promise.resolve()).then(run);lanes.set(this.db,p.catch(()=>{}));return p;}
 initialize(){return this.ready??=(async()=>{
  await this.db.transaction([
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_assets(storage_key TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(storage_key,sha256))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_guard(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1))'},
   {sql:'INSERT OR IGNORE INTO library_resume_guard VALUES(1,1)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_clock(id INTEGER PRIMARY KEY CHECK(id=1),logical INTEGER NOT NULL,elapsed INTEGER NOT NULL)'},
   {sql:"CREATE TABLE IF NOT EXISTS library_resume_jobs(scope TEXT NOT NULL,job_id TEXT NOT NULL,plan_digest TEXT NOT NULL,description TEXT NOT NULL,state TEXT NOT NULL,connection_id TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_page INTEGER NOT NULL DEFAULT 0,completion TEXT,lease TEXT,role TEXT NOT NULL,PRIMARY KEY(scope,job_id))"},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_objects(scope TEXT NOT NULL,job_id TEXT NOT NULL,object_id TEXT NOT NULL,ordinal INTEGER NOT NULL,description TEXT NOT NULL,receipt TEXT,PRIMARY KEY(scope,job_id,object_id),UNIQUE(scope,job_id,ordinal))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_requests(scope TEXT NOT NULL,job_id TEXT NOT NULL,peer TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT,PRIMARY KEY(scope,job_id,peer,request_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_pages(scope TEXT NOT NULL,job_id TEXT NOT NULL,page_index INTEGER NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,job_id,page_index))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_snapshots(scope TEXT NOT NULL,snapshot_id TEXT NOT NULL,witness TEXT NOT NULL,inventory TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,snapshot_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_prepare_requests(scope TEXT NOT NULL,connection_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,connection_id,request_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_preparations(scope TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,digest))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_resume_peer_ack(scope TEXT NOT NULL,job_id TEXT NOT NULL,completion TEXT NOT NULL,PRIMARY KEY(scope,job_id))'},
  ]);
  const clock=(await this.db.query('SELECT logical FROM library_resume_clock WHERE id=1'))[0];if(clock&&!this.injectedClock)this.logical=Number(clock.logical);
 })().catch(e=>{this.ready=undefined;throw e;});}
 /** Native elapsed time, not wall time, advances expiry. A reboot/backward
  * sample conservatively proves zero elapsed time and never expires early. */
 async observeClock(elapsed:number){if(this.injectedClock)return;if(!Number.isSafeInteger(elapsed)||elapsed<0)fail('LOCAL_IO');await this.initialize();const old=(await this.db.query('SELECT logical,elapsed FROM library_resume_clock WHERE id=1'))[0];this.logical=old?Number(old.logical)+Math.max(0,elapsed-Number(old.elapsed)):this.logical;await this.db.execute('INSERT OR REPLACE INTO library_resume_clock VALUES(1,?,?)',[this.logical,elapsed]);}
 async job(scope:string,id:string):Promise<Job|null>{await this.initialize();const r=(await this.db.query('SELECT * FROM library_resume_jobs WHERE scope=? AND job_id=?',[scope,id]))[0];if(!r)return null;return {scope,jobId:id,planDigest:String(r.plan_digest),description:parse(r.description),state:String(r.state) as JobState,connectionId:String(r.connection_id),epoch:Number(r.epoch),expiresAt:Number(r.expires_at),nextPage:Number(r.next_page),completion:r.completion===null?null:parse(r.completion),lease:r.lease===null?null:parse(r.lease),role:String(r.role) as Job['role']};}
 guard(job:Job):Statement{return {sql:'UPDATE library_resume_guard SET ok=CASE WHEN EXISTS(SELECT 1 FROM library_resume_jobs WHERE scope=? AND job_id=? AND epoch=? AND connection_id=? AND state!=\'CANCELLED\') THEN 1 ELSE 0 END WHERE id=1',params:[job.scope,job.jobId,job.epoch,job.connectionId]};}
 bind(job:Job,peer:string,request:Envelope,result:Row|null=null):Statement[]{return [
  {sql:'UPDATE library_resume_guard SET ok=CASE WHEN NOT EXISTS(SELECT 1 FROM library_resume_requests WHERE scope=? AND job_id=? AND peer=? AND request_id=? AND digest!=?) THEN 1 ELSE 0 END WHERE id=1',params:[job.scope,job.jobId,peer,request.requestId,request.requestDigest]},
  {sql:'INSERT OR IGNORE INTO library_resume_requests(scope,job_id,peer,request_id,digest,result) VALUES(?,?,?,?,?,?)',params:[job.scope,job.jobId,peer,request.requestId,request.requestDigest,result===null?null:JSON.stringify(result)]},
 ];}
 async checkBinding(job:Job,peer:string,r:Envelope):Promise<Row|null>{const row=(await this.db.query('SELECT digest,result FROM library_resume_requests WHERE scope=? AND job_id=? AND peer=? AND request_id=?',[job.scope,job.jobId,peer,r.requestId]))[0];if(row&&row.digest!==r.requestDigest)fail('REQUEST_CONFLICT');if(!row)await this.budget(768);return row?.result?parse(row.result):null;}
 async collect(scope:string,cleanup:(job:Job)=>Promise<void>):Promise<void>{
  // The caller holds the shared writer lane. No begin/apply can cross collection.
  const expired=await this.db.query('SELECT job_id FROM library_resume_jobs WHERE scope=? AND expires_at<?',[scope,this.now()]);
  for(const r of expired){const job=await this.job(scope,String(r.job_id));if(!job)continue;await cleanup(job);await this.db.transaction(['library_resume_requests','library_resume_pages','library_resume_objects','library_resume_peer_ack','library_resume_jobs'].map(table=>({sql:'DELETE FROM '+table+' WHERE scope=? AND job_id=?',params:[scope,job.jobId]})));}
  await this.db.transaction([{sql:'DELETE FROM library_resume_prepare_requests WHERE scope=? AND expires_at<?',params:[scope,this.now()]},{sql:'DELETE FROM library_resume_snapshots WHERE scope=? AND expires_at<? AND NOT EXISTS(SELECT 1 FROM library_resume_jobs j WHERE j.scope=library_resume_snapshots.scope)',params:[scope,this.now()]},{sql:'DELETE FROM library_resume_preparations WHERE scope=? AND expires_at<? AND NOT EXISTS(SELECT 1 FROM library_resume_jobs j WHERE j.scope=library_resume_preparations.scope)',params:[scope,this.now()]}]);
 }
 async bindPreparation(scope:string,connectionId:string,id:string,digest:string):Promise<void>{
  const old=(await this.db.query('SELECT digest FROM library_resume_prepare_requests WHERE scope=? AND connection_id=? AND request_id=?',[scope,connectionId,id]))[0];if(old){if(old.digest!==digest)fail('REQUEST_CONFLICT');await this.db.execute('UPDATE library_resume_prepare_requests SET expires_at=max(expires_at,?) WHERE scope=? AND connection_id=?',[this.now()+RETENTION,scope,connectionId]);return;}await this.budget(1024);await this.db.execute('INSERT INTO library_resume_prepare_requests VALUES(?,?,?,?,?)',[scope,connectionId,id,digest,this.now()+RETENTION]);
 }
 async saveSnapshot(scope:string,witness:Snapshot,inventory:unknown):Promise<void>{const encoded=JSON.stringify(inventory);if(utf8(encoded).length>16777216)fail('LIMIT_EXCEEDED');const old=(await this.db.query('SELECT witness,inventory FROM library_resume_snapshots WHERE scope=? AND snapshot_id=?',[scope,witness.snapshotId]))[0];if(old&&(JSON.stringify(parse(old.witness))!==JSON.stringify(witness)||String(old.inventory)!==encoded))fail('PLAN_CONFLICT');await this.budget(utf8(encoded).length+1024);await this.db.execute('INSERT OR IGNORE INTO library_resume_snapshots VALUES(?,?,?,?,?)',[scope,witness.snapshotId,JSON.stringify(witness),encoded,this.now()+RETENTION]);}
 async snapshot(scope:string,id:string):Promise<{witness:Snapshot;inventory:unknown}|null>{const r=(await this.db.query('SELECT witness,inventory,expires_at FROM library_resume_snapshots WHERE scope=? AND snapshot_id=?',[scope,id]))[0];if(!r||Number(r.expires_at)<this.now())return null;return {witness:parse(r.witness),inventory:parse(r.inventory)};}
 async preparation(scope:string,digest:string,body:Row):Promise<void>{await this.budget(utf8(JSON.stringify(body)).length+1024);await this.db.execute('INSERT OR IGNORE INTO library_resume_preparations VALUES(?,?,?,?)',[scope,digest,JSON.stringify(body),this.now()+RETENTION]);}
 async budget(extra:number):Promise<void>{
  // A conservative per-record allowance includes keys, indexes and receipts.
  // The native receiver's journal is independently capped at 16 MiB; the app's
  // 32 MiB logical maximum additionally reserves 16 MiB for SQL page/index overhead; native journal/rollback files use at most 16 MiB.
  const r=(await this.db.query(`SELECT
   (SELECT COALESCE(SUM(length(CAST(description AS BLOB))+4096),0) FROM library_resume_jobs)+
   (SELECT COALESCE(SUM(length(CAST(description AS BLOB))+4096),0) FROM library_resume_objects)+
   (SELECT COUNT(*)*1024 FROM library_resume_requests)+(SELECT COUNT(*)*1024 FROM library_resume_prepare_requests)+
   (SELECT COALESCE(SUM(length(CAST(inventory AS BLOB))+2048),0) FROM library_resume_snapshots)+
   (SELECT COALESCE(SUM(length(CAST(body AS BLOB))+2048),0) FROM library_resume_preparations) AS bytes`))[0];
  if(Number(r?.bytes??0)+extra>32*1024*1024)fail('STORAGE_PRESSURE');
 }
 async begin(scope:string,r:Envelope,p:BeginPayload,connectionId:string,epoch:number,lease:Row|null,role:Job['role']='receiver'):Promise<Job>{
  const old=await this.job(scope,r.jobId!);
  if(old){
   if(old.planDigest!==r.planDigest||old.role!==role||JSON.stringify(old.description.pageObjectCounts)!==JSON.stringify(p.pageObjectCounts))fail('JOB_CONFLICT');
   if(old.expiresAt<this.now())fail('EXPIRED');
   if(['COMPLETE','CANCELLED'].includes(old.state)&&p.intent==='create')fail('JOB_CONFLICT');
   if(p.intent==='create'&&old.connectionId!==connectionId)fail('JOB_CONFLICT');
   await this.checkBinding(old,p.direction==='phoneToWatch'?p.phoneDeviceId:p.watchDeviceId,r);
  }else{
   if(p.intent==='resume')fail('NOT_FOUND');
   const count=(await this.db.query("SELECT COUNT(*) AS n FROM library_resume_jobs WHERE state NOT IN ('COMPLETE','CANCELLED') AND expires_at>=?",[this.now()]))[0];
   if(Number(count?.n)>=p.selection.limits.maxActiveJobs)fail('WINDOW_FULL');
   // Reserve all descriptor, per-chunk bind and application-receipt overhead.
   await this.budget(utf8(JSON.stringify(p)).length+2048+p.objectCount*4096);
  }
  const state=old?.state??(p.objectCount===0?'READY':'PLANNING'),expiration=Math.max(old?.expiresAt??0,this.now()+RETENTION);
  await this.db.execute(`INSERT INTO library_resume_jobs(scope,job_id,plan_digest,description,state,connection_id,epoch,expires_at,next_page,completion,lease,role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(scope,job_id) DO UPDATE SET connection_id=excluded.connection_id,epoch=excluded.epoch,lease=excluded.lease,expires_at=excluded.expires_at`,[scope,r.jobId,r.planDigest,JSON.stringify(p),state,connectionId,epoch,expiration,old?.nextPage??0,old?.completion?JSON.stringify(old.completion):null,lease?JSON.stringify(lease):null,role]);
  const saved=(await this.job(scope,r.jobId!))!;await this.touch(saved);return saved;
 }
 async objects(job:Job):Promise<{descriptor:ObjectDescriptor;receipt:AppliedReceipt|null;ordinal:number}[]>{return (await this.db.query('SELECT object_id,description,receipt,ordinal FROM library_resume_objects WHERE scope=? AND job_id=? ORDER BY ordinal',[job.scope,job.jobId])).map(r=>({descriptor:descriptor(parse(r.description),job.description.selection.limits),receipt:this.receipt(job,String(r.object_id),r.receipt),ordinal:Number(r.ordinal)}));}
 async object(job:Job,id:string){const r=(await this.db.query('SELECT object_id,description,receipt FROM library_resume_objects WHERE scope=? AND job_id=? AND object_id=?',[job.scope,job.jobId,id]))[0];if(!r)fail();return {descriptor:descriptor(parse(r.description),job.description.selection.limits),receipt:this.receipt(job,id,r.receipt)};}
 private receipt(job:Job,id:string,raw:unknown):AppliedReceipt|null {
  if(raw===null)return null;
  try{const r=exact(JSON.parse(String(raw)),['jobId','planDigest','objectId','applyRequestId','applyRequestDigest','receiverDeviceId','resultDigest','outcome']) as unknown as AppliedReceipt;
   if(r.jobId!==job.jobId||r.planDigest!==job.planDigest||r.objectId!==id||r.receiverDeviceId!==(job.description.direction==='phoneToWatch'?job.description.watchDeviceId:job.description.phoneDeviceId)||!['merged','retainedLocal','alreadyPresent'].includes(r.outcome)||r.resultDigest!==D('wrss.library-resume.v1/applied',[r.jobId,r.planDigest,r.objectId,hex(r.applyRequestId,32),hex(r.applyRequestDigest),r.receiverDeviceId,r.outcome]))fail('RECEIPT_CONFLICT');return r;
  }catch{fail('RECEIPT_CONFLICT');}
 }
 async manifest(job:Job,r:Envelope,peer:string,p:Row):Promise<Row>{
  const index=Number(p.pageIndex),start=Number(p.startIndex),entries=(p.entries as unknown[]).map(e=>descriptor(e,job.description.selection.limits));
  if(entries.length!==job.description.pageObjectCounts[index]||start!==job.description.pageObjectCounts.slice(0,index).reduce((a,b)=>a+b,0)||utf8(JSON.stringify(r)).length>job.description.selection.limits.maxManifestPageBytes)fail('PLAN_CONFLICT');
  if(entries.some(e=>!job.description.selection.kinds.some(k=>k.kind===e.kind)))fail('UNSUPPORTED_KIND');
  const digest=pageDigest(job.planDigest,index,start,entries,String(p.previousPageDigest));if(digest!==p.pageDigest)fail('PLAN_CONFLICT');
  const old=(await this.db.query('SELECT digest,result FROM library_resume_pages WHERE scope=? AND job_id=? AND page_index=?',[job.scope,job.jobId,index]))[0];
  if(old){if(old.digest!==digest)fail('PLAN_CONFLICT');return parse(old.result);}
  if(job.state!=='PLANNING'||index!==job.nextPage)fail('PLAN_CONFLICT');
  const prior=index===0?'0'.repeat(64):String((await this.db.query('SELECT digest FROM library_resume_pages WHERE scope=? AND job_id=? AND page_index=?',[job.scope,job.jobId,index-1]))[0]?.digest);
  if(p.previousPageDigest!==prior)fail('PLAN_CONFLICT');
  const all=[...(await this.objects(job)).map(o=>o.descriptor),...entries];sorted(all.map(e=>e.objectId));
  const full=index+1===job.description.pageObjectCounts.length;
  if(all.reduce((n,o)=>n+utf8(JSON.stringify(o)).length,0)>job.description.selection.limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
  if(full){if(all.length!==job.description.objectCount||objectsRoot(all.map(e=>e.objectId))!==job.description.objectsRoot)fail('PLAN_CONFLICT');validateGraph(all);}
  const result={pageIndex:index,pageDigest:digest,nextManifestPage:index+1,manifestVerified:full,state:full?'READY':'PLANNING'};
  await this.budget(entries.reduce((n,e)=>n+utf8(JSON.stringify(e)).length+2048+e.chunkHashes.length*768,0));
  await this.db.transaction([this.guard(job),...this.bind(job,peer,r,result),...entries.map((o,i)=>({sql:'INSERT INTO library_resume_objects(scope,job_id,object_id,ordinal,description) VALUES(?,?,?,?,?)',params:[job.scope,job.jobId,o.objectId,start+i,JSON.stringify(o)]})),{sql:'INSERT INTO library_resume_pages VALUES(?,?,?,?,?)',params:[job.scope,job.jobId,index,digest,JSON.stringify(result)]},{sql:'UPDATE library_resume_jobs SET next_page=?,state=? WHERE scope=? AND job_id=?',params:[index+1,result.state,job.scope,job.jobId]}]);return result;
 }
 boundary(job:Job,r:Envelope,peer:string,oid:string,receiver:string):ReceiptBoundary{return {before:[this.guard(job),...this.bind(job,peer,r)],after:outcome=>{const receipt=appliedReceipt(r,oid,receiver,outcome);return [this.guard(job),{sql:'UPDATE library_resume_objects SET receipt=? WHERE scope=? AND job_id=? AND object_id=? AND receipt IS NULL',params:[JSON.stringify(receipt),job.scope,job.jobId,oid]},{sql:"UPDATE library_resume_jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM library_resume_objects WHERE scope=? AND job_id=? AND receipt IS NULL) THEN 'APPLIED' ELSE 'TRANSFERRING' END,expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",params:[job.scope,job.jobId,this.now()+RETENTION,job.scope,job.jobId]}];}};}
 async complete(job:Job,r:Envelope,peer:string,p:Row):Promise<Completion>{
  if(job.completion){if(p.receiptsRoot!==job.completion.receiptsRoot||p.objectCount!==job.completion.objectCount||p.ackToInclusive!==job.completion.ackToInclusive)fail('RECEIPT_CONFLICT');return job.completion;}
  const objects=await this.objects(job);if(objects.length!==job.description.objectCount||objects.some(o=>!o.receipt))fail('DEPENDENCIES_PENDING');
  const root=receiptsRoot(objects.map(o=>o.receipt!)),ack=(job.description.direction==='phoneToWatch'?job.description.phoneSnapshot:job.description.watchSnapshot).toInclusive;
  if(p.receiptsRoot!==root||p.objectCount!==objects.length||p.ackToInclusive!==ack)fail('RECEIPT_CONFLICT');
  // Product snapshots conservatively use range=0; positive windows must be
  // attested by the repository's full-range port before any such job is accepted.
  const result=completion(job.jobId,job.planDigest,objects.length,root,ack);
  const cursor:Statement[]=ack===0?[]:[{sql:'UPDATE library_resume_guard SET ok=CASE WHEN COALESCE((SELECT last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?),0)>=? THEN 1 ELSE 0 END WHERE id=1',params:[peer,(job.description.direction==='phoneToWatch'?job.description.phoneSnapshot:job.description.watchSnapshot).fromExclusive]},{sql:'INSERT INTO sync_peer_state(peer_device_id,last_local_seq_acked,last_remote_seq_applied,last_full_sync_at,last_protocol_version,updated_at) VALUES(?,0,?,0,14,?) ON CONFLICT(peer_device_id) DO UPDATE SET last_remote_seq_applied=max(last_remote_seq_applied,excluded.last_remote_seq_applied),updated_at=excluded.updated_at',params:[peer,ack,this.now()]}];
  await this.db.transaction([this.guard(job),...this.bind(job,peer,r,result as unknown as Row),...cursor,{sql:"UPDATE library_resume_jobs SET state='COMPLETE',completion=?,expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",params:[JSON.stringify(result),this.now()+RETENTION,job.scope,job.jobId]}]);return result;
 }
 async cancel(job:Job):Promise<Row>{if(job.state==='COMPLETE')return {state:'COMPLETE',alreadyComplete:true};await this.db.execute("UPDATE library_resume_jobs SET state='CANCELLED',expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",[this.now()+RETENTION,job.scope,job.jobId]);return {state:'CANCELLED',alreadyComplete:false};}
 async touch(job:Job){const until=this.now()+RETENTION;await this.db.transaction([{sql:'UPDATE library_resume_jobs SET expires_at=max(expires_at,?) WHERE scope=? AND job_id=?',params:[until,job.scope,job.jobId]},{sql:'UPDATE library_resume_snapshots SET expires_at=max(expires_at,?) WHERE scope=? AND snapshot_id IN (?,?)',params:[until,job.scope,job.description.phoneSnapshot.snapshotId,job.description.watchSnapshot.snapshotId]},{sql:'UPDATE library_resume_preparations SET expires_at=max(expires_at,?) WHERE scope=?',params:[until,job.scope]},{sql:'UPDATE library_resume_prepare_requests SET expires_at=max(expires_at,?) WHERE scope=? AND connection_id=?',params:[until,job.scope,job.connectionId]}]);}
 async savePeerAck(job:Job,result:Completion){await this.db.execute('INSERT INTO library_resume_peer_ack VALUES(?,?,?) ON CONFLICT(scope,job_id) DO UPDATE SET completion=excluded.completion',[job.scope,job.jobId,JSON.stringify(result)]);}
}
export function validateGraph(all:readonly ObjectDescriptor[]):void{
 const ids=new Map(all.map(o=>[o.objectId,o])),seen=new Set<string>(),visiting=new Set<string>(),business=new Set<string>();
 const visit=(id:string)=>{if(seen.has(id))return;if(visiting.has(id)||!ids.has(id))fail('PLAN_CONFLICT');visiting.add(id);for(const dep of ids.get(id)!.dependsOn)visit(dep);visiting.delete(id);seen.add(id);};
 for(const o of all){visit(o.objectId);const key=(o.kind.startsWith('article')?'article':o.kind)+'\0'+o.businessId;if(business.has(key))fail('PLAN_CONFLICT');business.add(key);}
}
