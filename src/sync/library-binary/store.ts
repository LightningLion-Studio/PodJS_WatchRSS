import type {SqlDatabase,SqlParams} from '../../core/types';
import {bindingCapacity} from './receive-index';
import {frameBytes} from '../wire-frame-size';
import {D,appliedReceipt,completion,descriptor,objectsRoot,pageDigest,receiptsRoot,requestDigest} from './digests';
import {fail,RETENTION,utf8,sorted,exact,hex,type Envelope,type BeginPayload,type ObjectDescriptor,type AppliedReceipt,type Outcome,type Completion,type Snapshot,type Row} from './wire';
export type Statement={sql:string;params?:SqlParams};
export interface ReceiptBoundary {check?():void;transaction?(statements:Statement[]):Promise<void>;before:Statement[];after(outcome:Outcome):Statement[]}
export type JobState='PLANNING'|'READY'|'TRANSFERRING'|'APPLIED'|'COMPLETE'|'CANCELLED';
export interface Job {scope:string;jobId:string;planDigest:string;description:BeginPayload;state:JobState;connectionId:string;epoch:number;expiresAt:number;nextPage:number;completion:Completion|null;lease:Row|null;role:'receiver'|'source'}
const lanes=new WeakMap<SqlDatabase,Promise<unknown>>();
const parse=<T>(value:unknown):T=>{try{return JSON.parse(String(value)) as T;}catch{fail('JOURNAL_CORRUPT');}};
/** Auxiliary tables live in the SAME business database. The single writer lane
 * spans native staging and the final business commit, including every connection.
 * Cross-process account changes additionally share WatchAccountStore's lease.
 */
export class BinaryStore {
 private ready?:Promise<void>;
 private logical=Date.now();private injectedClock:boolean;private clockLane:Promise<void>=Promise.resolve();private lastElapsed?:number;
 readonly now:()=>number;
 readonly db:SqlDatabase;
 constructor(database:SqlDatabase,now?:()=>number){
  this.db={query:database.query.bind(database),execute:async(sql,params)=>{await this.db.transaction([{sql,params}]);},transaction:async statements=>{
   await database.execute('PRAGMA synchronous=FULL');
   await database.transaction([...statements,{sql:"UPDATE library_binary_guard SET ok=CASE WHEN (SELECT synchronous FROM pragma_synchronous)=2 THEN 1 ELSE 0 END WHERE id=1"}]);
  }};this.injectedClock=!!now;this.now=now??(()=>this.logical);}
 exclusive<T>(run:()=>Promise<T>):Promise<T>{const p=(lanes.get(this.db)??Promise.resolve()).then(run);lanes.set(this.db,p.catch(()=>{}));return p;}
 initialize(){return this.ready??=(async()=>{
  await this.db.transaction([
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_snapshot_refs(scope TEXT NOT NULL,job_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,PRIMARY KEY(scope,job_id,snapshot_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_snapshot_files(scope TEXT NOT NULL,snapshot_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(scope,snapshot_id,path))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_source_files(path TEXT PRIMARY KEY,bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_request_quota(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_cancellations(scope TEXT NOT NULL,job_id TEXT NOT NULL,reason TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,job_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_peaks(scope TEXT NOT NULL,job_id TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(scope,job_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_assets(storage_key TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(storage_key,sha256))'},
   {sql:"CREATE TABLE IF NOT EXISTS library_binary_book_states(scope TEXT NOT NULL,job_id TEXT NOT NULL,book_id TEXT NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(scope,job_id,book_id))"},
   {sql:"CREATE TABLE IF NOT EXISTS library_binary_book_files(scope TEXT NOT NULL,job_id TEXT NOT NULL,object_id TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,ready INTEGER NOT NULL,PRIMARY KEY(scope,job_id,object_id))"},
   {sql:"CREATE TABLE IF NOT EXISTS library_binary_book_pages(scope TEXT NOT NULL,job_id TEXT NOT NULL,book_id TEXT NOT NULL,page INTEGER NOT NULL,first_chapter INTEGER NOT NULL,last_chapter INTEGER NOT NULL,PRIMARY KEY(scope,job_id,book_id,page))"},
   {sql:"CREATE TABLE IF NOT EXISTS library_binary_book_chapters(scope TEXT NOT NULL,job_id TEXT NOT NULL,book_id TEXT NOT NULL,chapter INTEGER NOT NULL,PRIMARY KEY(scope,job_id,book_id,chapter))"},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_connections(connection_id TEXT PRIMARY KEY,revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),expires_at INTEGER NOT NULL)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_guard(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1))'},
   {sql:'INSERT OR IGNORE INTO library_binary_guard VALUES(1,1)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_clock(id INTEGER PRIMARY KEY CHECK(id=1),logical INTEGER NOT NULL,elapsed INTEGER NOT NULL)'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_reservations(scope TEXT NOT NULL,job_id TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(scope,job_id))'},
   {sql:"CREATE TABLE IF NOT EXISTS library_binary_jobs(scope TEXT NOT NULL,job_id TEXT NOT NULL,plan_digest TEXT NOT NULL,description TEXT NOT NULL,state TEXT NOT NULL,connection_id TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_page INTEGER NOT NULL DEFAULT 0,completion TEXT,lease TEXT,role TEXT NOT NULL,PRIMARY KEY(scope,job_id))"},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_objects(scope TEXT NOT NULL,job_id TEXT NOT NULL,object_id TEXT NOT NULL,ordinal INTEGER NOT NULL,description TEXT NOT NULL,receipt TEXT,PRIMARY KEY(scope,job_id,object_id),UNIQUE(scope,job_id,ordinal))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_requests(scope TEXT NOT NULL,job_id TEXT NOT NULL,peer TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT,PRIMARY KEY(scope,job_id,peer,request_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_pages(scope TEXT NOT NULL,job_id TEXT NOT NULL,page_index INTEGER NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,job_id,page_index))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_snapshots(scope TEXT NOT NULL,snapshot_id TEXT NOT NULL,witness TEXT NOT NULL,inventory TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,snapshot_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_prepare_requests(scope TEXT NOT NULL,connection_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,connection_id,request_id))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_preparations(scope TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,digest))'},
   {sql:'CREATE TABLE IF NOT EXISTS library_binary_peer_ack(scope TEXT NOT NULL,job_id TEXT NOT NULL,completion TEXT NOT NULL,PRIMARY KEY(scope,job_id))'},
  ]);
  const clock=(await this.db.query('SELECT logical FROM library_binary_clock WHERE id=1'))[0];if(clock&&!this.injectedClock)this.logical=Number(clock.logical);
 })().catch(e=>{this.ready=undefined;throw e;});}
 /** Native elapsed time, not wall time, advances expiry. A reboot/backward
  * sample conservatively proves zero elapsed time and never expires early. */
 observeClock(elapsed:number):Promise<void>{const next=this.clockLane.then(async()=>{if(this.injectedClock)return;if(!Number.isSafeInteger(elapsed)||elapsed<0)fail('LOCAL_IO');if(this.lastElapsed!==undefined&&elapsed<this.lastElapsed)return;this.lastElapsed=elapsed;await this.initialize();const old=(await this.db.query('SELECT logical,elapsed FROM library_binary_clock WHERE id=1'))[0];this.logical=old?Number(old.logical)+Math.max(0,elapsed-Number(old.elapsed)):this.logical;await this.db.execute('INSERT OR REPLACE INTO library_binary_clock VALUES(1,?,?)',[this.logical,elapsed]);});this.clockLane=next.catch(()=>{});return next;}
 async job(scope:string,id:string):Promise<Job|null>{await this.initialize();const r=(await this.db.query('SELECT * FROM library_binary_jobs WHERE scope=? AND job_id=?',[scope,id]))[0];if(!r)return null;return {scope,jobId:id,planDigest:String(r.plan_digest),description:parse(r.description),state:String(r.state) as JobState,connectionId:String(r.connection_id),epoch:Number(r.epoch),expiresAt:Number(r.expires_at),nextPage:Number(r.next_page),completion:r.completion===null?null:parse(r.completion),lease:r.lease===null?null:parse(r.lease),role:String(r.role) as Job['role']};}
 async openConnection(id:string){await this.initialize();await this.budget(512);await this.db.execute('INSERT OR IGNORE INTO library_binary_connections VALUES(?,0,?)',[id,this.now()+RETENTION]);}
 async revokeConnection(id:string){await this.initialize();await this.db.execute('UPDATE library_binary_connections SET revoked=1,expires_at=max(expires_at,?) WHERE connection_id=?',[this.now()+RETENTION,id]);}
 guard(job:Job,allowCancelled=false):Statement{return {sql:'UPDATE library_binary_guard SET ok=CASE WHEN EXISTS(SELECT 1 FROM library_binary_jobs WHERE scope=? AND job_id=? AND epoch=? AND connection_id=? AND (?=1 OR state!=\'CANCELLED\') AND EXISTS(SELECT 1 FROM library_binary_connections c WHERE c.connection_id=library_binary_jobs.connection_id AND c.revoked=0)) THEN 1 ELSE 0 END WHERE id=1',params:[job.scope,job.jobId,job.epoch,job.connectionId,allowCancelled?1:0]};}
 bind(job:Job,peer:string,request:Envelope,result:Row|null=null):Statement[]{return [
  {sql:'UPDATE library_binary_guard SET ok=CASE WHEN NOT EXISTS(SELECT 1 FROM library_binary_requests WHERE scope=? AND job_id=? AND peer=? AND request_id=? AND digest!=?) THEN 1 ELSE 0 END WHERE id=1',params:[job.scope,job.jobId,peer,request.requestId,request.requestDigest]},
  {sql:'INSERT OR IGNORE INTO library_binary_requests(scope,job_id,peer,request_id,digest,result) VALUES(?,?,?,?,?,?)',params:[job.scope,job.jobId,peer,request.requestId,request.requestDigest,result===null?null:JSON.stringify(result)]},
 ];}
 private requestQuota(job:Job,peer:string,r:Envelope):Statement[]{return [
  {sql:'INSERT OR IGNORE INTO library_binary_request_quota VALUES(1,0)'},
  {sql:'UPDATE library_binary_request_quota SET bytes=bytes+CASE WHEN EXISTS(SELECT 1 FROM library_binary_requests WHERE scope=? AND job_id=? AND peer=? AND request_id=?) THEN 0 ELSE 1024 END WHERE id=1',params:[job.scope,job.jobId,peer,r.requestId]},
  {sql:'UPDATE library_binary_guard SET ok=CASE WHEN (SELECT bytes FROM library_binary_request_quota WHERE id=1)<=? THEN 1 ELSE 0 END WHERE id=1',params:[Math.min(bindingCapacity(job.description.selection)*1024,job.description.selection.limits.maxJournalBytes-25165824)]},
  ...this.bind(job,peer,r),
 ];}
 async *receiveBindings(job:Job,peer:string):AsyncGenerator<Pick<Envelope,'requestId'|'requestDigest'>>{
  const limit=bindingCapacity(job.description.selection);
  let after='',count=0;
  for(;;){
   const rows=await this.db.query('SELECT request_id,digest FROM library_binary_requests WHERE scope=? AND job_id=? AND peer=? AND request_id>? ORDER BY request_id LIMIT 128',
    [job.scope,job.jobId,peer,after]);
   for(const r of rows){
    if(++count>limit)fail('JOURNAL_CORRUPT');
    after=hex(r.request_id,32);yield {requestId:after,requestDigest:hex(r.digest)};
   }
   if(rows.length<128)return;
  }
 }
 async boundRequest(job:Job,peer:string,r:Envelope,onReplay?:()=>void){
  const existing=(await this.db.query('SELECT digest,result FROM library_binary_requests WHERE scope=? AND job_id=? AND peer=? AND request_id=?',[job.scope,job.jobId,peer,r.requestId]))[0];
  if(existing&&existing.digest!==r.requestDigest)fail('REQUEST_CONFLICT');
  if(existing)onReplay?.();
  return existing;
 }
 async checkBinding(job:Job,peer:string,r:Envelope,rebindConnection?:string,onReplay?:()=>void):Promise<Row|null>{
  const existing=await this.boundRequest(job,peer,r,onReplay);
  if(!existing)await this.db.transaction([
   rebindConnection?{sql:'UPDATE library_binary_guard SET ok=CASE WHEN EXISTS(SELECT 1 FROM library_binary_connections WHERE connection_id=? AND revoked=0) AND EXISTS(SELECT 1 FROM library_binary_jobs WHERE scope=? AND job_id=? AND plan_digest=?) THEN 1 ELSE 0 END WHERE id=1',params:[rebindConnection,job.scope,job.jobId,r.planDigest]}:this.guard(job,true),
   ...this.requestQuota(job,peer,r),
  ]);
  return existing?.result?parse(existing.result):null;
 }
 commitChunks(job:Job,peer:string,requests:readonly Envelope[]):Promise<void>{
  return this.db.transaction([this.guard(job),...requests.flatMap(r=>this.requestQuota(job,peer,r)),...this.touchStatements(job)]);
 }
 async collect(scope:string,cleanup:(job:Job)=>Promise<void>):Promise<void>{
  const expired=await this.db.query('SELECT job_id FROM library_binary_jobs WHERE scope=? AND expires_at<? LIMIT 4',[scope,this.now()]);
  for(const r of expired){const job=await this.job(scope,String(r.job_id));if(!job)continue;await cleanup(job);await this.db.transaction(['library_binary_snapshot_refs','library_binary_peaks','library_binary_reservations','library_binary_requests','library_binary_pages','library_binary_objects','library_binary_peer_ack','library_binary_jobs'].map(table=>({sql:'DELETE FROM '+table+' WHERE scope=? AND job_id=?',params:[scope,job.jobId]})));}
  await this.db.transaction([
   {sql:'INSERT OR REPLACE INTO library_binary_request_quota SELECT 1,COUNT(*)*1024 FROM library_binary_requests'},
   {sql:'DELETE FROM library_binary_cancellations WHERE expires_at<?',params:[this.now()]},
   {sql:'DELETE FROM library_binary_connections WHERE expires_at<? AND NOT EXISTS(SELECT 1 FROM library_binary_jobs j WHERE j.connection_id=library_binary_connections.connection_id AND j.expires_at>=?)',params:[this.now(),this.now()]},
   {sql:'DELETE FROM library_binary_prepare_requests WHERE scope=? AND expires_at<?',params:[scope,this.now()]},
   {sql:"DELETE FROM library_binary_snapshots WHERE scope=? AND expires_at<? AND NOT EXISTS(SELECT 1 FROM library_binary_jobs j WHERE j.scope=library_binary_snapshots.scope AND EXISTS(SELECT 1 FROM library_binary_snapshot_refs r WHERE r.scope=j.scope AND r.job_id=j.job_id AND r.snapshot_id=library_binary_snapshots.snapshot_id))",params:[scope,this.now()]},
   {sql:'DELETE FROM library_binary_snapshot_files WHERE NOT EXISTS(SELECT 1 FROM library_binary_snapshots s WHERE s.scope=library_binary_snapshot_files.scope AND s.snapshot_id=library_binary_snapshot_files.snapshot_id)'},
   {sql:'DELETE FROM library_binary_preparations WHERE scope=? AND expires_at<? AND NOT EXISTS(SELECT 1 FROM library_binary_jobs j WHERE j.scope=library_binary_preparations.scope)',params:[scope,this.now()]},
  ]);
 }
 async bindPreparation(scope:string,connectionId:string,id:string,digest:string):Promise<void>{
  const old=(await this.db.query('SELECT digest FROM library_binary_prepare_requests WHERE scope=? AND connection_id=? AND request_id=?',[scope,connectionId,id]))[0];if(old){if(old.digest!==digest)fail('REQUEST_CONFLICT');await this.db.execute('UPDATE library_binary_prepare_requests SET expires_at=max(expires_at,?) WHERE scope=? AND connection_id=?',[this.now()+RETENTION,scope,connectionId]);return;}await this.budget(1024);await this.db.execute('INSERT INTO library_binary_prepare_requests VALUES(?,?,?,?,?)',[scope,connectionId,id,digest,this.now()+RETENTION]);
 }
 async saveSnapshot(scope:string,witness:Snapshot,inventory:unknown):Promise<void>{
  const encoded=JSON.stringify(inventory),encodedBytes=utf8(encoded).length;if(encodedBytes>1048576)fail('LIMIT_EXCEEDED');const old=(await this.db.query('SELECT witness,inventory FROM library_binary_snapshots WHERE scope=? AND snapshot_id=?',[scope,witness.snapshotId]))[0];if(old&&(JSON.stringify(parse(old.witness))!==JSON.stringify(witness)||String(old.inventory)!==encoded))fail('PLAN_CONFLICT');
  const paths=(inventory as {paths?:Record<string,unknown>}).paths;if(!paths||typeof paths!=='object'||Array.isArray(paths))fail('JOURNAL_CORRUPT');const values=[...new Set(Object.values(paths))];if(values.length>512||values.some(p=>typeof p!=='string'||!/^library-binary\/spool\/[0-9a-f]{64}\.bin$/.test(p)))fail('JOURNAL_CORRUPT');
  await this.budget(encodedBytes+1024+values.length*512);await this.db.transaction([{sql:'INSERT OR IGNORE INTO library_binary_snapshots VALUES(?,?,?,?,?)',params:[scope,witness.snapshotId,JSON.stringify(witness),encoded,this.now()+RETENTION]},...values.map(path=>({sql:'INSERT OR IGNORE INTO library_binary_snapshot_files VALUES(?,?,?)',params:[scope,witness.snapshotId,path]}))]);
 }
 async snapshot(scope:string,id:string):Promise<{witness:Snapshot;inventory:unknown}|null>{const r=(await this.db.query('SELECT witness,inventory,expires_at FROM library_binary_snapshots WHERE scope=? AND snapshot_id=?',[scope,id]))[0];if(!r||Number(r.expires_at)<this.now())return null;return {witness:parse(r.witness),inventory:parse(r.inventory)};}
 async preparation(scope:string,digest:string,body:Row):Promise<void>{await this.budget(utf8(JSON.stringify(body)).length+1024);await this.db.execute('INSERT OR IGNORE INTO library_binary_preparations VALUES(?,?,?,?)',[scope,digest,JSON.stringify(body),this.now()+RETENTION]);}
 /** All scopes share a single journal budget. Reserve the native journal's
  * full 16 MiB bound once, and account outstanding per-job reservations. A
  * smaller negotiated limit cannot borrow space from another job or scope. */
 async budget(extra:number,limit=67108864,reservation?:{scope:string;jobId:string;bytes:number}):Promise<void>{
  const jobs=await this.db.query(`SELECT j.scope,j.job_id,j.description,j.state,j.expires_at,
   length(CAST(j.description AS BLOB))+4096+
   (SELECT COALESCE(SUM(length(CAST(o.description AS BLOB))+4096),0) FROM library_binary_objects o WHERE o.scope=j.scope AND o.job_id=j.job_id)+
   (SELECT COUNT(*)*1024 FROM library_binary_requests r WHERE r.scope=j.scope AND r.job_id=j.job_id)+
   (SELECT COALESCE(SUM(length(CAST(p.result AS BLOB))+512),0) FROM library_binary_pages p WHERE p.scope=j.scope AND p.job_id=j.job_id) AS actual,
   COALESCE((SELECT bytes FROM library_binary_reservations r WHERE r.scope=j.scope AND r.job_id=j.job_id),0) AS reserved
   FROM library_binary_jobs j`);
  let used=0,found=false;
  for(const j of jobs){const p=parse<BeginPayload>(j.description);if(Number(j.expires_at)>=this.now()&&!['COMPLETE','CANCELLED'].includes(String(j.state)))limit=Math.min(limit,p.selection.limits.maxJournalBytes);
   const replacing=reservation!==undefined&&reservation.scope===j.scope&&reservation.jobId===j.job_id;found||=!!replacing;used+=Math.max(Number(j.actual),replacing?reservation!.bytes:Number(j.reserved));}
  if(reservation&&!found)used+=reservation.bytes;
  const shared=(await this.db.query(`SELECT
   (SELECT COUNT(*)*512 FROM library_binary_snapshot_refs)+(SELECT COUNT(*)*512 FROM library_binary_snapshot_files)+(SELECT COUNT(*)*1024 FROM library_binary_source_files)+(SELECT COUNT(*)*1024 FROM library_binary_cancellations)+
   (SELECT COUNT(*)*512 FROM library_binary_connections)+
   (SELECT COUNT(*)*1024 FROM library_binary_book_files)+
   (SELECT COUNT(*)*512 FROM library_binary_book_pages)+
   (SELECT COUNT(*)*256 FROM library_binary_book_chapters)+
   (SELECT COALESCE(SUM(length(CAST(state_json AS BLOB))+1024),0) FROM library_binary_book_states)+
   (SELECT COUNT(*)*1024 FROM library_binary_prepare_requests)+
   (SELECT COALESCE(SUM(length(CAST(inventory AS BLOB))+2048),0) FROM library_binary_snapshots)+
   (SELECT COALESCE(SUM(length(CAST(body AS BLOB))+2048),0) FROM library_binary_preparations) AS bytes`))[0];
  if(used+Number(shared?.bytes??0)+extra+8388608>Math.min(32*1024*1024,limit-16*1024*1024))fail('STORAGE_PRESSURE');
 }
 private planReservation(p:BeginPayload):number{
  const descriptorBound=p.selection.limits.maxMetadataBytes*4/3+256*68+6144;
  return utf8(JSON.stringify(p)).length+4096+p.objectCount*4096+Math.min(p.selection.limits.maxManifestBytes,Math.ceil(p.objectCount*descriptorBound))+p.pageObjectCounts.length*1024;
 }
 async preflightBegin(scope:string,id:string,p:BeginPayload):Promise<void>{
  if(!await this.job(scope,id))await this.budget(0,p.selection.limits.maxJournalBytes,{scope,jobId:id,bytes:this.planReservation(p)});
  else await this.budget(0,p.selection.limits.maxJournalBytes);
 }
 async begin(scope:string,r:Envelope,p:BeginPayload,connectionId:string,epoch:number,lease:Row|null,role:Job['role']='receiver'):Promise<Job>{
  if(p.objectCount===0&&p.objectsRoot!==objectsRoot([]))fail('PLAN_CONFLICT');
  const old=await this.job(scope,r.jobId!);
  if(old){
   if(old.planDigest!==r.planDigest||old.role!==role||JSON.stringify(old.description.pageObjectCounts)!==JSON.stringify(p.pageObjectCounts))fail('JOB_CONFLICT');
   if(old.expiresAt<this.now())fail('EXPIRED');
   if(['COMPLETE','CANCELLED'].includes(old.state)&&p.intent==='create')fail('JOB_CONFLICT');
   if(p.intent==='create'&&old.connectionId!==connectionId)fail('JOB_CONFLICT');
   if(old.state==='CANCELLED'&&p.intent!=='resume')fail('JOB_CANCELLED');
   await this.checkBinding(old,p.direction==='phoneToWatch'?p.phoneDeviceId:p.watchDeviceId,r,connectionId);
  }else{
   if(p.intent==='resume')fail('NOT_FOUND');
   const count=(await this.db.query("SELECT COUNT(*) AS n FROM library_binary_jobs WHERE state NOT IN ('COMPLETE','CANCELLED') AND expires_at>=?",[this.now()]))[0];
   if(Number(count?.n)>=p.selection.limits.maxActiveJobs)fail('WINDOW_FULL');
   // Reserve all descriptor, per-chunk bind and application-receipt overhead.
   await this.preflightBegin(scope,r.jobId!,p);
  }
  const state=old?.state??(p.objectCount===0?'READY':'PLANNING'),expiration=Math.max(old?.expiresAt??0,this.now()+RETENTION);
  const statement={sql:`INSERT INTO library_binary_jobs(scope,job_id,plan_digest,description,state,connection_id,epoch,expires_at,next_page,completion,lease,role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(scope,job_id) DO UPDATE SET connection_id=excluded.connection_id,epoch=excluded.epoch,lease=excluded.lease,expires_at=excluded.expires_at`,params:[scope,r.jobId,r.planDigest,JSON.stringify(p),state,connectionId,epoch,expiration,old?.nextPage??0,old?.completion?JSON.stringify(old.completion):null,lease?JSON.stringify(lease):null,role]};
  await this.db.transaction([statement,...[p.phoneSnapshot,p.watchSnapshot].map(s=>({sql:'INSERT OR IGNORE INTO library_binary_snapshot_refs VALUES(?,?,?)',params:[scope,r.jobId,s.snapshotId]})),...(!old?[{sql:'INSERT INTO library_binary_reservations VALUES(?,?,?)',params:[scope,r.jobId,this.planReservation(p)]}]:[])]);const saved=(await this.job(scope,r.jobId!))!;await this.touch(saved);return saved;
 }
 async objects(job:Job):Promise<{descriptor:ObjectDescriptor;receipt:AppliedReceipt|null;ordinal:number}[]>{return (await this.db.query('SELECT object_id,description,receipt,ordinal FROM library_binary_objects WHERE scope=? AND job_id=? ORDER BY ordinal',[job.scope,job.jobId])).map(r=>({descriptor:descriptor(parse(r.description),job.description.selection.limits),receipt:this.receipt(job,String(r.object_id),r.receipt),ordinal:Number(r.ordinal)}));}
 async objectAt(job:Job,slot:number):Promise<ObjectDescriptor|null>{const r=(await this.db.query('SELECT description FROM library_binary_objects WHERE scope=? AND job_id=? AND ordinal=?',[job.scope,job.jobId,slot]))[0];return r?descriptor(parse(r.description),job.description.selection.limits):null;}
 async object(job:Job,id:string){const r=(await this.db.query('SELECT object_id,description,receipt FROM library_binary_objects WHERE scope=? AND job_id=? AND object_id=?',[job.scope,job.jobId,id]))[0];if(!r)fail();return {descriptor:descriptor(parse(r.description),job.description.selection.limits),receipt:this.receipt(job,id,r.receipt)};}
 private receipt(job:Job,id:string,raw:unknown):AppliedReceipt|null {
  if(raw===null)return null;
  try{const r=exact(JSON.parse(String(raw)),['jobId','planDigest','objectId','applyRequestId','applyRequestDigest','receiverDeviceId','resultDigest','outcome']) as unknown as AppliedReceipt;
   if(r.jobId!==job.jobId||r.planDigest!==job.planDigest||r.objectId!==id||r.applyRequestDigest!==requestDigest(job.jobId,job.planDigest,'apply',{objectId:id})||r.receiverDeviceId!==(job.description.direction==='phoneToWatch'?job.description.watchDeviceId:job.description.phoneDeviceId)||!['merged','retainedLocal','alreadyPresent'].includes(r.outcome)||r.resultDigest!==D('wrss.library-binary.v2/applied',[r.jobId,r.planDigest,r.objectId,hex(r.applyRequestId,32),hex(r.applyRequestDigest),r.receiverDeviceId,r.outcome]))fail('RECEIPT_CONFLICT');return r;
  }catch{fail('RECEIPT_CONFLICT');}
 }
 async manifest(job:Job,r:Envelope,peer:string,p:Row,admitPeak?:(objects:readonly ObjectDescriptor[])=>Promise<void>):Promise<Row>{
  const index=Number(p.pageIndex),start=Number(p.startIndex),entries=(p.entries as unknown[]).map(e=>descriptor(e,job.description.selection.limits));
  if(entries.length!==job.description.pageObjectCounts[index]||start!==job.description.pageObjectCounts.slice(0,index).reduce((a,b)=>a+b,0)||frameBytes(r)+12>job.description.selection.limits.maxManifestPageBytes)fail('PLAN_CONFLICT');
  if(entries.some(e=>!job.description.selection.kinds.some(k=>k.kind===e.kind)))fail('UNSUPPORTED_KIND');
  const digest=pageDigest(job.planDigest,index,start,entries,String(p.previousPageDigest));if(digest!==p.pageDigest)fail('PLAN_CONFLICT');
  const old=(await this.db.query('SELECT digest,result FROM library_binary_pages WHERE scope=? AND job_id=? AND page_index=?',[job.scope,job.jobId,index]))[0];
  if(old){if(old.digest!==digest)fail('PLAN_CONFLICT');return parse(old.result);}
  if(job.state!=='PLANNING'||index!==job.nextPage)fail('PLAN_CONFLICT');
  const prior=index===0?'0'.repeat(64):String((await this.db.query('SELECT digest FROM library_binary_pages WHERE scope=? AND job_id=? AND page_index=?',[job.scope,job.jobId,index-1]))[0]?.digest);
  if(p.previousPageDigest!==prior)fail('PLAN_CONFLICT');
  const all=[...(await this.objects(job)).map(o=>o.descriptor),...entries];sorted(all.map(e=>e.objectId));
  const full=index+1===job.description.pageObjectCounts.length;
  if(all.reduce((n,o)=>n+utf8(JSON.stringify(o)).length,0)>job.description.selection.limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
  if(full){if(all.length!==job.description.objectCount||objectsRoot(all.map(e=>e.objectId))!==job.description.objectsRoot)fail('PLAN_CONFLICT');validateGraph(all);await admitPeak?.(all);}
  const result={pageIndex:index,pageDigest:digest,nextManifestPage:index+1,manifestVerified:full,state:full?'READY':'PLANNING'};
  const reserve=full?utf8(JSON.stringify(job.description)).length+4096+all.reduce((n,e)=>n+utf8(JSON.stringify(e)).length+4096+e.chunkHashes.length*1024,0)+job.description.pageObjectCounts.length*2048:undefined;
  await this.budget(entries.reduce((n,e)=>n+utf8(JSON.stringify(e)).length+4096,0),job.description.selection.limits.maxJournalBytes,reserve===undefined?undefined:{scope:job.scope,jobId:job.jobId,bytes:reserve});
  await this.db.transaction([this.guard(job),...this.bind(job,peer,r,result),...(reserve===undefined?[]:[{sql:'UPDATE library_binary_reservations SET bytes=? WHERE scope=? AND job_id=?',params:[reserve,job.scope,job.jobId]}]),...entries.map((o,i)=>({sql:'INSERT INTO library_binary_objects(scope,job_id,object_id,ordinal,description) VALUES(?,?,?,?,?)',params:[job.scope,job.jobId,o.objectId,start+i,JSON.stringify(o)]})),{sql:'INSERT INTO library_binary_pages VALUES(?,?,?,?,?)',params:[job.scope,job.jobId,index,digest,JSON.stringify(result)]},{sql:'UPDATE library_binary_jobs SET next_page=?,state=? WHERE scope=? AND job_id=?',params:[index+1,result.state,job.scope,job.jobId]}]);return result;
 }
 boundary(job:Job,r:Envelope,peer:string,oid:string,receiver:string,check:()=>void=()=>{}):ReceiptBoundary{return {check,transaction:statements=>this.db.transaction(statements),before:[this.guard(job),...this.bind(job,peer,r)],after:outcome=>{const receipt=appliedReceipt(r,oid,receiver,outcome);return [this.guard(job),{sql:'UPDATE library_binary_objects SET receipt=? WHERE scope=? AND job_id=? AND object_id=? AND receipt IS NULL',params:[JSON.stringify(receipt),job.scope,job.jobId,oid]},{sql:"UPDATE library_binary_jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM library_binary_objects WHERE scope=? AND job_id=? AND receipt IS NULL) THEN 'APPLIED' ELSE 'TRANSFERRING' END,expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",params:[job.scope,job.jobId,this.now()+RETENTION,job.scope,job.jobId]}];}};}
 async complete(job:Job,r:Envelope,peer:string,p:Row):Promise<Completion>{
  if(job.completion){if(p.receiptsRoot!==job.completion.receiptsRoot||p.objectCount!==job.completion.objectCount||p.ackToInclusive!==job.completion.ackToInclusive)fail('RECEIPT_CONFLICT');await this.db.transaction([this.guard(job),...this.bind(job,peer,r,job.completion as unknown as Row)]);return job.completion;}
  const objects=await this.objects(job);if(objects.length!==job.description.objectCount||objects.some(o=>!o.receipt))fail('DEPENDENCIES_PENDING');
  const root=receiptsRoot(objects.map(o=>o.receipt!)),ack=(job.description.direction==='phoneToWatch'?job.description.phoneSnapshot:job.description.watchSnapshot).toInclusive;
  if(p.receiptsRoot!==root||p.objectCount!==objects.length||p.ackToInclusive!==ack)fail('RECEIPT_CONFLICT');
  // Product snapshots conservatively use range=0; positive windows must be
  // attested by the repository's full-range port before any such job is accepted.
  const result=completion(job.jobId,job.planDigest,objects.length,root,ack);
  const cursor:Statement[]=ack===0?[]:[{sql:'UPDATE library_binary_guard SET ok=CASE WHEN COALESCE((SELECT last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?),0)>=? THEN 1 ELSE 0 END WHERE id=1',params:[peer,(job.description.direction==='phoneToWatch'?job.description.phoneSnapshot:job.description.watchSnapshot).fromExclusive]},{sql:'INSERT INTO sync_peer_state(peer_device_id,last_local_seq_acked,last_remote_seq_applied,last_full_sync_at,last_protocol_version,updated_at) VALUES(?,0,?,0,14,?) ON CONFLICT(peer_device_id) DO UPDATE SET last_remote_seq_applied=max(last_remote_seq_applied,excluded.last_remote_seq_applied),updated_at=excluded.updated_at',params:[peer,ack,this.now()]}];
  await this.db.transaction([this.guard(job),...this.bind(job,peer,r,result as unknown as Row),{sql:'DELETE FROM library_binary_reservations WHERE scope=? AND job_id=?',params:[job.scope,job.jobId]},...cursor,{sql:"UPDATE library_binary_jobs SET state='COMPLETE',completion=?,expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",params:[JSON.stringify(result),this.now()+RETENTION,job.scope,job.jobId]}]);return result;
 }
 async cancel(job:Job,r?:Envelope,peer?:string):Promise<Row>{
  const result={state:job.state==='COMPLETE'?'COMPLETE':'CANCELLED',alreadyComplete:job.state==='COMPLETE'};
  await this.db.transaction([this.guard(job,true),...(r?this.bind(job,peer!,r,result):[]),{sql:'DELETE FROM library_binary_reservations WHERE scope=? AND job_id=?',params:[job.scope,job.jobId]},{sql:"UPDATE library_binary_jobs SET state=CASE WHEN state='COMPLETE' THEN state ELSE 'CANCELLED' END,expires_at=max(expires_at,?) WHERE scope=? AND job_id=?",params:[this.now()+RETENTION,job.scope,job.jobId]}]);return result;
 }
 async touch(job:Job){await this.db.transaction(this.touchStatements(job));}
 private touchStatements(job:Job):Statement[]{const until=this.now()+RETENTION;return [{sql:'UPDATE library_binary_jobs SET expires_at=max(expires_at,?) WHERE scope=? AND job_id=?',params:[until,job.scope,job.jobId]},{sql:'UPDATE library_binary_snapshots SET expires_at=max(expires_at,?) WHERE scope=? AND snapshot_id IN (?,?)',params:[until,job.scope,job.description.phoneSnapshot.snapshotId,job.description.watchSnapshot.snapshotId]},{sql:'UPDATE library_binary_connections SET expires_at=max(expires_at,?) WHERE connection_id=?',params:[until,job.connectionId]},{sql:'UPDATE library_binary_preparations SET expires_at=max(expires_at,?) WHERE scope=?',params:[until,job.scope]},{sql:'UPDATE library_binary_prepare_requests SET expires_at=max(expires_at,?) WHERE scope=? AND connection_id=?',params:[until,job.scope,job.connectionId]}];}
 async savePeerAck(job:Job,result:Completion){await this.db.execute('INSERT INTO library_binary_peer_ack VALUES(?,?,?) ON CONFLICT(scope,job_id) DO UPDATE SET completion=excluded.completion',[job.scope,job.jobId,JSON.stringify(result)]);}
}
export function validateGraph(all:readonly ObjectDescriptor[]):void{
 const ids=new Map(all.map(o=>[o.objectId,o])),seen=new Set<string>(),visiting=new Set<string>(),business=new Set<string>();
 const visit=(id:string)=>{if(seen.has(id))return;if(visiting.has(id)||!ids.has(id))fail('PLAN_CONFLICT');visiting.add(id);for(const dep of ids.get(id)!.dependsOn)visit(dep);visiting.delete(id);seen.add(id);};
 for(const o of all){visit(o.objectId);const key=(o.kind.startsWith('article')?'article':o.kind)+'\0'+o.businessId;if(business.has(key))fail('PLAN_CONFLICT');business.add(key);}
}
