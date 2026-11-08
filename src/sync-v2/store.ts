import {SqlAuthenticatedCache,SQL_AUTHENTICATED_CACHE_SCHEMA} from '@podjs/framework/sql-authenticated-cache';
import {ResourceQuota,type ResourceReservation} from '@podjs/framework/resource-journal';
import {ContentSha256} from '@podjs/framework/content-sha256';
import {updateSha256Parts} from '@podjs/framework/json-text-segments';
import {SqlProgram,SQL_PROGRAM_SCHEMA,sqlExactSetGuards,sqlProgramRelationGuards,type SqlProgramRef} from '@podjs/framework/sql-program';
import {SqlStateJournal,SQL_STATE_SCHEMA} from '@podjs/framework/sql-state-journal';
import {chargedReplayBytes} from './resume';
import {WatchEquivalentLegacy} from './legacy-store';
import {updateRadixIndex,type RadixRow} from '@podjs/framework/radix-index';
import {encodeBase64,base64ToBytes} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
import {CHUNKED_AEAD_BLOCK_BYTES,CHUNKED_REF_KEY,SQL_CHUNKED_VALUE_SCHEMA,SqlChunkedValues,chunkedRef,type AeadBlockPort,type ChunkedValueRef} from '@podjs/framework/chunked-aead';
import {readBoundedKeysetBatch,commitSqlCas,captureSqlBasis,stableSqlTriggers,checkD64,nextD64,compareD64,type ProjectionSql,type Statement} from '@podjs/framework/sql-projection';
import {canonical,canonicalLegacy,jsonBytes,parseCanonicalJson,digest,entityKey,hexId,validateScope,type Scope,type Kind} from './protocol';
import {candidates} from './business';
import {ProjectionGate} from './gate';
import {UNOPENABLE_NOTES_SCHEMA,unopenableNotesStatements} from './note-rows';
import {arrayRecordFeed,arrayStatementFeed,feedPages,type RecordFeed,type StatementFeed} from './record-feed';
import {installBusinessRevision,businessRevision,sameBusinessRevision,stopExistingProjection,revisionDelta,addRevision,type BusinessRevision} from './business-revision';
import {initialState,observeAccount,legacyInputRoute,captureChoice,checkCapture,type Account,type Capture,type SyncState} from './state';
/** open authenticates with an existing key; it must never persist a new key. */
export interface LocalCipher {nativeKey?():Promise<{keyBase64:string;aadJson:boolean}>;seal(aad:string,value:unknown):Promise<string>;open(aad:string,sealed:string):Promise<any>;
 /** N1: bounded single-call AES-GCM under the same key, for values stored as
  * chunk rows (framework chunked AEAD). Without it such values are refused. */
 blocks?:AeadBlockPort}
/** Values above one AEAD block are stored as chunk rows, one block per row, so
 * no single host call (AES-GCM, seal, SQL request or reply) holds a long note. */
export const INLINE_VALUE_BYTES=CHUNKED_AEAD_BLOCK_BYTES;
export function chunkedValues(db:ProjectionSql,cipher:LocalCipher,binding:string){if(!cipher.blocks)throw Error('object_too_large');return new SqlChunkedValues(db,cipher.blocks,binding);}
export type SourceRecord={kind:Kind;logicalId:string;value:Record<string,any>;addedAtMillis?:number;source?:{table:string;locator:string}};
export type ScanBinding={schema:string;descriptorPin:string;accountScope:string;capability:string};
export interface SourcePage {rows:SourceRecord[];after:string;done:boolean}
export interface SourceReader {
 /** Stable keyset token. The caller never passes offset or a full inventory. */
 page(after:string,limit:number):Promise<SourcePage>;
 /** Reserved keyed lookup for future incremental work; never read body recipes. */
 changed(table:string,locator:string):Promise<SourceRecord[]>;
}
export const PROJECTION_SCHEMA=[SQL_STATE_SCHEMA,...SQL_PROGRAM_SCHEMA,...SQL_AUTHENTICATED_CACHE_SCHEMA,...SQL_CHUNKED_VALUE_SCHEMA,
 `CREATE TABLE IF NOT EXISTS syncv2_apply_tree_v2(scope TEXT NOT NULL,plan_id TEXT NOT NULL,step INTEGER NOT NULL,prefix TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,plan_id,prefix,step))`,
 ...sqlProgramRelationGuards('syncv2_apply_tree_v2','scope','plan_id','wrss_apply_tree_ready'),
 `CREATE TABLE IF NOT EXISTS syncv2_apply_work(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id))`,
 `CREATE TABLE IF NOT EXISTS syncv2_prepare_clocks(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id))`,
 `CREATE TABLE IF NOT EXISTS syncv2_apply_keys(scope TEXT NOT NULL,plan_id TEXT NOT NULL,entity_key TEXT NOT NULL,PRIMARY KEY(scope,plan_id,entity_key))`,
 ...sqlProgramRelationGuards('syncv2_apply_keys','scope','plan_id','wrss_apply_keys_ready'),
 `CREATE TABLE IF NOT EXISTS syncv2_rss_states(id TEXT PRIMARY KEY,state_json TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS syncv2_commit_headers(scope TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,oid))`,
 `CREATE TABLE IF NOT EXISTS syncv2_business_basis(scope TEXT PRIMARY KEY,state_version TEXT NOT NULL,epoch TEXT NOT NULL,revision TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS syncv2_state(scope TEXT PRIMARY KEY,state_version TEXT NOT NULL,local_revision TEXT NOT NULL,body TEXT NOT NULL,account_generation TEXT NOT NULL,edit_generation TEXT NOT NULL,awaiting_user INTEGER NOT NULL CHECK(awaiting_user IN (0,1)))`,
 `CREATE TABLE IF NOT EXISTS syncv2_identity_map(local_library TEXT NOT NULL,repo TEXT NOT NULL,kind TEXT NOT NULL,logical_id TEXT NOT NULL,entity_key TEXT NOT NULL,mapping_version INTEGER NOT NULL CHECK(mapping_version=2),PRIMARY KEY(local_library,repo,kind,logical_id))`,
 `CREATE TABLE IF NOT EXISTS syncv2_candidates(scope TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,meta_bytes INTEGER NOT NULL,state_bytes INTEGER NOT NULL,added_at INTEGER NOT NULL,row_sequence TEXT NOT NULL,PRIMARY KEY(scope,entity_key))`,
 `CREATE TABLE IF NOT EXISTS syncv2_source_map(scope TEXT NOT NULL,source_table TEXT NOT NULL,locator TEXT NOT NULL,entity_key TEXT NOT NULL,PRIMARY KEY(scope,source_table,locator))`,
 `CREATE TABLE IF NOT EXISTS syncv2_tree_nodes(scope TEXT NOT NULL,prefix TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,prefix))`,
 `CREATE TABLE IF NOT EXISTS syncv2_change_log(scope TEXT NOT NULL,revision TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,revision,entity_key))`,
 `CREATE TABLE IF NOT EXISTS syncv2_upload_receipts(scope TEXT NOT NULL,plan_id TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,plan_id,oid))`,
 `CREATE TABLE IF NOT EXISTS syncv2_upload_replays(scope TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,oid))`,
 `CREATE TABLE IF NOT EXISTS syncv2_checkpoint(scope TEXT PRIMARY KEY,binding TEXT NOT NULL,body TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS syncv2_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,source_table TEXT NOT NULL,locator TEXT NOT NULL)`,
 `CREATE INDEX IF NOT EXISTS syncv2_outbox_scope ON syncv2_outbox(scope,seq)`,
 `CREATE TABLE IF NOT EXISTS syncv2_control(id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`,
 `CREATE TABLE IF NOT EXISTS syncv2_legacy_inbox(scope TEXT NOT NULL,inbox_key TEXT NOT NULL,input_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,inbox_key))`,
 `CREATE TABLE IF NOT EXISTS syncv2_note_bindings(scope TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,entity_key))`,
 UNOPENABLE_NOTES_SCHEMA,
];
/** rc7 25.3 local output binding of one note life. `revision:null` forces a
 * fresh CSPRNG value at the next segmented encoding of that life. */
export type NoteBinding={revision:string|null;life:'live'|'deleted'};
/** Single-row projection pages may exceed the 384 KiB batch only for a long
 * note candidate already admitted by the rc7 text budget. */
const LONG_CANDIDATE_PAGE=12*1024*1024;
export {PROJECTION_SOURCE_TABLES} from './business-revision';
export type Checkpoint={R0:string;R1:string|null;after:string;tail:string;phase:'scan'|'tail'|'complete';rows:number;tailEnd:string|null;businessRevision?:BusinessRevision;accountApplyVersion?:string};
/** Stored-ciphertext bound of one candidate or cloud-row page on the publish
 * and pull paths. A single long note may exceed it; it is then read alone. */
export const PAGE_BYTES=384*1024;
/** R4: serialized bytes of business statements appended in one preparation step. */
const BUSINESS_STEP_BYTES=512*1024;
export class WatchProjectionStore {
 private readonly scopeKey:string;
 private legacyAdapter?:WatchEquivalentLegacy;
 private cloudCache:SqlAuthenticatedCache<any>;
 private readonly stateJournal:SqlStateJournal<SyncState>;
 /** Candidate options every builder (scan, follow, choice, recovery) must share. */
 segmentOptions(){return {noteSegments:this.options.noteSegments===true};}
 constructor(private readonly db:ProjectionSql,private readonly cipher:LocalCipher,readonly gate:ProjectionGate,private readonly scope:Scope,private readonly libraryId:string,private readonly key:Uint8Array,private readonly checkIdentity:()=>Promise<void>=async()=>{},readonly options:{noteSegments?:boolean}={}){
  validateScope(scope);this.scope=Object.freeze({...scope});this.key=new Uint8Array(key);this.scopeKey=canonical(scope);this.stateJournal=new SqlStateJournal(this.db,this.cipher,this.scopeKey,(purpose,id)=>this.aad(purpose,id),canonical);this.cloudCache=new SqlAuthenticatedCache(this.db,this.cipher,this.scopeKey,this.key,canonical,this.cipher.blocks?{chunks:this.chunks('cloud-row'),inlineBytes:INLINE_VALUE_BYTES}:undefined);hexId(libraryId,32);if(key.length!==32)throw Error('authentication_required');this.gate.onClose(()=>stopExistingProjection(this.db));
 }
 equivalentLegacy(){this.gate.require();return this.legacyAdapter??=new WatchEquivalentLegacy(this,this.db,this.cipher,this.scopeKey,(kind,key)=>this.aad(kind,key));}
 private chunks(kind:'candidate'|'cloud-row'|'edit-base'){return chunkedValues(this.db,this.cipher,this.scopeKey+'#'+kind);}
 /** Seals one value; above INLINE_VALUE_BYTES its blocks are written first
  * (content-addressed version) and `statements` must commit with the row. */
 private async sealSpilled(kind:'candidate'|'edit-base',owner:string,aad:string,value:unknown):Promise<{body:string;statements:Statement[];ref?:ChunkedValueRef}>{
  const raw=jsonBytes(value);if(raw.length<=INLINE_VALUE_BYTES)return {body:await this.cipher.seal(aad,value),statements:this.cipher.blocks?[this.chunks(kind).keepOnly(owner,null)]:[]};
  const store=this.chunks(kind),ref=await store.write(owner,sha256Hex(raw),aad,raw);return {body:await this.cipher.seal(aad,{[CHUNKED_REF_KEY]:ref}),statements:[...store.guard(ref),store.keepOnly(owner,ref.version)],ref};
 }
 private async openSpilled(kind:'candidate'|'edit-base',owner:string,aad:string,body:string){
  const value=await this.cipher.open(aad,body),ref=chunkedRef(value);if(!ref)return value;if(ref.owner!==owner)throw Error('authentication_required');
  return parseCanonicalJson(await this.chunks(kind).read(ref,aad));
 }
 private openCandidate(entity:string,body:unknown){return this.openSpilled('candidate',entity,this.aad('candidate',entity),String(body));}
 /** Base of an unsent edit kept in state.cloud.editBases. A large base (a long
  * note) is a chunked ref; the caller commits `statements` with the state. */
 async editBaseEntry(entity:string,base:any){const sealed=await this.sealSpilled('edit-base',entity,this.aad('edit-base',entity),base);if(!sealed.ref)return {value:base,statements:[]};return {value:{[CHUNKED_REF_KEY]:sealed.ref},statements:sealed.statements.filter(s=>!s.sql.startsWith('DELETE'))};}
 async editBases(state:SyncState):Promise<Record<string,any>>{const out:Record<string,any>={};for(const [id,v] of Object.entries(state.cloud?.editBases??{})){const ref=chunkedRef(v);out[id]=ref?(ref.owner!==id?(()=>{throw Error('authentication_required');})():parseCanonicalJson(await this.chunks('edit-base').read(ref,this.aad('edit-base',id)))):v;}return out;}
 /** Drops edit-base chunk rows no longer referenced by `state`. */
 async sweepEditBases(state:SyncState){if(!this.cipher.blocks)return;const keep=new Set(Object.values(state.cloud?.editBases??{}).map(v=>chunkedRef(v)).filter(Boolean).map(r=>r!.owner+'\0'+r!.version)),binding=this.scopeKey+'#edit-base';
  const rows=await this.db.query('SELECT DISTINCT owner,version FROM podjs_sql_value_chunks WHERE binding=?',[binding]),drop=rows.filter(r=>!keep.has(String(r.owner)+'\0'+String(r.version)));
  for(let at=0;at<drop.length;at+=32)await this.db.transaction(drop.slice(at,at+32).map(r=>({sql:'DELETE FROM podjs_sql_value_chunks WHERE binding=? AND owner=? AND version=?',params:[binding,r.owner,r.version]})));}
 private aad(purpose:string,id=''){return canonical({domain:'wrss.sync.v2/local-projection',version:2,scope:this.scope,libraryId:this.libraryId,purpose,id});}
 /** Reopening disabled must durably stop a previously enabled projection. */
 async initialize(){if(!this.gate.isEnabled){await stopExistingProjection(this.db);return {ddl:0,unchanged:0};}
  await this.checkIdentity();await this.db.transaction(PROJECTION_SCHEMA.filter(sql=>!sql.startsWith('CREATE TRIGGER')).map(sql=>({sql})));const infrastructureDdl=await stableSqlTriggers(this.db,PROJECTION_SCHEMA.filter(sql=>sql.startsWith('CREATE TRIGGER')));const markerDdl=await installBusinessRevision(this.db);
  if(!(await this.db.query('SELECT 1 FROM syncv2_state WHERE scope=?',[this.scopeKey])).length){
   const initial=initialState();initial.businessRevision=await businessRevision(this.db);const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(row=>String(row.name)));
   const witnesses=[['sync_change_log',"SELECT 1 FROM sync_change_log WHERE seq>COALESCE((SELECT MIN(last_local_seq_acked) FROM sync_peer_state),0) LIMIT 1"],['memo_notes','SELECT 1 FROM memo_notes WHERE content_hash!=base_content_hash LIMIT 1'],['article_register_state','SELECT 1 FROM article_register_state WHERE pending_json IS NOT NULL OR raw_conflict=1 LIMIT 1'],['sync_book_reading_dirty','SELECT 1 FROM sync_book_reading_dirty LIMIT 1']];
   for(const [table,query]of witnesses)if(tables.has(table!)&&(await this.db.query(query!)).length){initial.hasUnsentEdits=true;break;}
   const body=await this.cipher.seal(this.aad('state'),initial);
   await this.db.transaction([{sql:'INSERT OR IGNORE INTO syncv2_state VALUES(?,?,?,?,?,?,0)',params:[this.scopeKey,'0','0',body,'0','0']}]);
  }
  const result=await stableSqlTriggers(this.db,["CREATE TRIGGER IF NOT EXISTS syncv2_identity_immutable BEFORE INSERT ON syncv2_identity_map WHEN EXISTS(SELECT 1 FROM syncv2_identity_map WHERE local_library=NEW.local_library AND repo=NEW.repo AND kind=NEW.kind AND logical_id=NEW.logical_id AND (entity_key!=NEW.entity_key OR mapping_version!=NEW.mapping_version)) BEGIN SELECT RAISE(ABORT,'identity_conflict');END"]);
  result.ddl+=markerDdl.ddl+infrastructureDdl.ddl;result.unchanged+=markerDdl.unchanged+infrastructureDdl.unchanged;
  // A local test/diagnostic entry must activate explicitly. No cloud transport,
  // worker, settings migration, or account registration is attached here.
  this.gate.require();await this.db.transaction([{sql:'INSERT INTO syncv2_control VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,enabled=1 WHERE scope IS NOT excluded.scope OR enabled!=1',params:[this.scopeKey]}]);if(!this.gate.isEnabled){await stopExistingProjection(this.db);throw Error('feature_disabled');}return result;
 }
 async disable(){await this.gate.close();}
 private async persistedState(attempt=0):Promise<SyncState>{
  this.gate.require();await this.checkIdentity();const row=(await this.db.query('SELECT * FROM syncv2_state WHERE scope=?',[this.scopeKey]))[0];if(!row)throw Error('projection_not_initialized');
  let state:SyncState;try{state=await this.stateJournal.read(String(row.body),checkD64(row.state_version));}catch(error){const latest=(await this.db.query('SELECT state_version FROM syncv2_state WHERE scope=?',[this.scopeKey]))[0];if(attempt<3&&latest?.state_version!==row.state_version)return this.persistedState(attempt+1);throw error;}state.stateVersion=checkD64(row.state_version);state.localChangeRevision=checkD64(row.local_revision);
  if(checkD64(row.account_generation)!==state.rollbackGeneration||checkD64(row.edit_generation)!==state.editBase.generation)throw Error('projection_state_inconsistent');
  if(Number(row.awaiting_user)===1&&!state.pendingChoice)state.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[]};
  const basis=(await this.db.query('SELECT epoch,revision FROM syncv2_business_basis WHERE scope=? AND state_version=?',[this.scopeKey,state.stateVersion]))[0];if(basis)state.businessRevision={epoch:String(basis.epoch),revision:String(basis.revision)};
  return state;
 }
 /** Cleanup preparation must never reconcile or recreate a missing witness.
  * A business edit makes this snapshot unusable until a normal sync reconciles.
  * checkIdentity and cipher.open are read-only installed-identity/key checks. */
 async readStableState():Promise<SyncState>{
  const state=await this.persistedState(),row=(await this.db.query('SELECT epoch,CAST(revision AS TEXT) AS revision FROM business_sync_revision WHERE id=1'))[0];
  if(!row||!sameBusinessRevision(state.businessRevision,{epoch:String(row.epoch),revision:String(row.revision)}))throw Error('choice_stale');
  return state;
 }
 async readState():Promise<SyncState>{
  const state=await this.persistedState();
  const current=await businessRevision(this.db);
  if(!sameBusinessRevision(state.businessRevision,current)){
   nextD64(state.stateVersion);const localRevision=addRevision(state.localChangeRevision,revisionDelta(state.businessRevision,current));
   if(localRevision.length>20||localRevision.length===20&&localRevision>'18446744073709551615')throw Error('counter_exhausted');
   const next={...state,businessRevision:current,localChangeRevision:checkD64(localRevision),hasUnsentEdits:true};
   if(state.rollbackGeneration!==state.editBase.generation&&!next.pendingChoice)next.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[]};
   await this.commit(state,next);return next;
  }
  if(!state.pendingChoice&&compareD64(state.editBase.generation,state.rollbackGeneration)<0&&(state.hasUnsentEdits||compareD64(state.localChangeRevision,state.acknowledgedLocalChangeRevision??'0')>0)){const next={...state,pendingChoice:{generation:state.rollbackGeneration,inboxKeys:[],accountOid:state.account!.oid,accountRevision:state.account!.revision,selectedLocalChangeRevision:state.localChangeRevision}};await this.commit(state,next);return next;}
  return state;
 }
 private async commit(state:SyncState,next:SyncState,statements:Statement[]=[],hook?:()=>void){this.gate.require();const expectedVersion=state.stateVersion,following=nextD64(expectedVersion),marker=next.businessRevision;if(!marker)throw Error('choice_stale');next.stateVersion=following;const encoded=await this.stateJournal.prepare(state,next,following),body=encoded.body;await this.checkIdentity();this.gate.require();hook?.();this.gate.require();
  try{await commitSqlCas(this.db,{table:'syncv2_state',keyColumn:'scope',versionColumn:'state_version',key:this.scopeKey},expectedVersion,[{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_control WHERE id=1 AND scope=? AND enabled=1) AND EXISTS(SELECT 1 FROM business_sync_revision WHERE id=1 AND epoch=? AND CAST(revision AS TEXT)=?) THEN 1 ELSE 0 END',params:[this.scopeKey,marker.epoch,marker.revision]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'UPDATE syncv2_state SET body=?,local_revision=?,account_generation=?,edit_generation=?,awaiting_user=? WHERE scope=?',params:[body,next.localChangeRevision,next.rollbackGeneration,next.editBase.generation,next.pendingChoice?1:0,this.scopeKey]},...encoded.statements,...statements]);encoded.accept();}catch(error){if(/NOT NULL constraint failed: syncv2_state.state_version|CHECK constraint failed: id=1/.test(String(error)))throw Error('choice_stale');throw error;}
 }
 /** P2 control persistence uses the same stateVersion and business witness.
  * Preparation runs outside SQL; all prepared statements commit at this CAS. */
 async controlUpdate(expected:SyncState,next:SyncState,statements:Statement[]=[],hook?:()=>void){
  const current=await this.readState();if(canonical(current)!==canonical(expected))throw Error('choice_stale');
  await this.commit(expected,next,statements,hook);
 }
 /** No preliminary coordination transaction. The supplied cleanup guards and
  * every persistent change commit together at the state/business CAS. */
 async controlUpdateStable(expected:SyncState,next:SyncState,statements:Statement[]=[],hook?:()=>void){
  const current=await this.readStableState();if(canonical(current)!==canonical(expected))throw Error('choice_stale');
  await this.commit(expected,next,statements,hook);
 }
 /** Prepare only. Original business rows and identity_map remain untouched until
  * the caller commits this batch with active/applied and edit acknowledgement. */
 async preparationClock(state:SyncState,now:number):Promise<number>{const id=digest(state),row=(await this.db.query('SELECT body FROM syncv2_prepare_clocks WHERE scope=? AND id=?',[this.scopeKey,id]))[0];if(row){const v=await this.cipher.open(this.aad('prepare-clock',id),String(row.body));if(v.stateHash!==id||!Number.isSafeInteger(v.now)||v.now>now)throw Error('clock_unknown');return v.now;}const body=await this.cipher.seal(this.aad('prepare-clock',id),{stateHash:id,now});await this.db.transaction([{sql:'INSERT OR IGNORE INTO syncv2_prepare_clocks VALUES(?,?,?)',params:[this.scopeKey,id,body]}]);return this.preparationClock(state,now);}
 /** Collect obsolete private preparation only. Signed unknown publication
  * journals, upload receipts and original edits are never collection targets. */
 async collectPreparations(before:SyncState,limit=16){const stateHash=digest(before),protectedIds=new Set([before.cloud?.pendingPublish?.applyPlan?.id,before.cloud?.preparingPublication?.applyPlan?.id].filter(Boolean));let removed=0;const rows=await this.db.query('SELECT id,body FROM syncv2_apply_work WHERE scope=? ORDER BY id LIMIT ?',[this.scopeKey,limit]);for(const row of rows){const id=String(row.id);if(protectedIds.has(id))continue;const work=await this.cipher.open(this.aad('apply-work',id),String(row.body));if(work.stateHash===stateHash)continue;const statements:Statement[]=[{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_state WHERE scope=? AND state_version=?) THEN 1 ELSE 0 END',params:[this.scopeKey,before.stateVersion]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'DELETE FROM podjs_sql_programs WHERE binding=? AND id=?',params:[this.scopeKey,id]},...['syncv2_apply_tree_v2','syncv2_apply_keys'].map(table=>({sql:'DELETE FROM '+table+' WHERE scope=? AND plan_id=?',params:[this.scopeKey,id]})),...['podjs_sql_program_pages'].map(table=>({sql:'DELETE FROM '+table+' WHERE binding=? AND id=?',params:[this.scopeKey,id]})),{sql:'DELETE FROM syncv2_apply_work WHERE scope=? AND id=?',params:[this.scopeKey,id]}];if(work.reservation)statements.push({sql:'DELETE FROM podjs_resource_quota WHERE binding=? AND id=? AND bytes=?',params:[work.reservation.binding,work.reservation.id,work.reservation.bytes]});await this.db.transaction(statements);removed++;}return removed;}
 /** The account-apply input digest, one record at a time (R4 feeds compute it
  * while they are built, so preparation needs no extra pass). */
 inputHasher(){const h=new ContentSha256();return {add:(r:SourceRecord)=>updateSha256Parts(h,[jsonBytes(candidates(r.kind,r.logicalId,entityKey(this.key,this.scope.repoId,r.kind,r.logicalId),r.value,r.addedAtMillis,this.segmentOptions()))]),finish:()=>h.finish()};}
 /** Records and business statements may be arrays or R4 feeds; a feed is read
  * again for each pass and step, so no step holds more than one bounded page. */
 async prepareAccountProjection(before:SyncState,input:SourceRecord[]|RecordFeed,businessInput:Statement[]|StatementFeed,budget:{maxSteps?:number;maxMillis?:number;onCheckpoint?:(progress:any)=>void}={}){
  const records=Array.isArray(input)?arrayRecordFeed(input,r=>entityKey(this.key,this.scope.repoId,r.kind,r.logicalId)):input,business=Array.isArray(businessInput)?arrayStatementFeed(businessInput):businessInput;
  await this.collectPreparations(before);let inputHash=records.inputHash;if(inputHash===undefined){const ih=this.inputHasher();for await(const page of feedPages(records))for(const r of page)ih.add(r);inputHash=ih.finish();}
  const bh=new ContentSha256();for await(const page of business.run())for(const op of page)updateSha256Parts(bh,[jsonBytes(JSON.stringify(op))]);const businessHash=bh.finish(),stateHash=digest(before),id=digest(['account-apply-v4',stateHash,inputHash,businessHash]),program=this.applyProgram(id),status=await program.open();
  const saved=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,id]))[0];let savedBody=saved?String(saved.body):null;let work=saved?await this.cipher.open(this.aad('apply-work',id),String(saved.body)):{membershipVersion:1,stateHash,inputHash,businessHash,phase:'membership',offset:0,after:'',step:0,ref:{...program.snapshot(),pages:0,fragments:0,operations:0,bytes:0,root:'0'.repeat(64)}};
  if(work.stateHash!==stateHash||work.inputHash!==inputHash||work.businessHash!==businessHash)throw Error('choice_stale');if(work.phase==='ready')return this.preparedResult(before,work.ref);
  if(status==='ready'&&work.phase!=='finalize')throw Error('sql_program_invalid');if(status!=='ready')await program.rewind(work.ref);
  const checkpoint=async()=>{work.ref=program.snapshot();const body=await this.cipher.seal(this.aad('apply-work',id),work);await this.db.transaction([{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN (? IS NULL AND NOT EXISTS(SELECT 1 FROM syncv2_apply_work WHERE scope=? AND id=?) OR EXISTS(SELECT 1 FROM syncv2_apply_work WHERE scope=? AND id=? AND body=?)) AND EXISTS(SELECT 1 FROM podjs_sql_programs WHERE binding=? AND id=? AND pages=? AND root=?) THEN 1 ELSE 0 END',params:[savedBody,this.scopeKey,id,this.scopeKey,id,savedBody,this.scopeKey,id,work.ref.pages,work.ref.root]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'INSERT INTO syncv2_apply_work VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body',params:[this.scopeKey,id,body]}]);savedBody=body;if(work.phase!=='ready')await this.db.transaction([{sql:'DELETE FROM syncv2_apply_tree_v2 AS t WHERE scope=? AND plan_id=? AND step<? AND EXISTS(SELECT 1 FROM syncv2_apply_tree_v2 newer WHERE newer.scope=t.scope AND newer.plan_id=t.plan_id AND newer.prefix=t.prefix AND newer.step>t.step AND newer.step<=?)',params:[this.scopeKey,id,work.step,work.step]}]);budget.onCheckpoint?.({...work,id});};
  const readTree=async(prefix:string)=>{const row=(await this.db.query('SELECT hash,body FROM syncv2_apply_tree_v2 WHERE scope=? AND plan_id=? AND prefix=? AND step<=? ORDER BY step DESC LIMIT 1',[this.scopeKey,id,prefix,work.step]))[0]??(await this.db.query('SELECT hash,body FROM syncv2_tree_nodes WHERE scope=? AND prefix=?',[this.scopeKey,prefix]))[0];return row?{hash:String(row.hash),node:JSON.parse(String(row.body))}:null;};
  const stageTrees=async(writes:Statement[])=>{let batch:Statement[]=[],size=0;const flush=async()=>{if(batch.length)await this.db.transaction(batch);batch=[];size=0;};for(const op of writes.filter(s=>s.sql.startsWith('INSERT INTO syncv2_tree_nodes'))){const statement={sql:'INSERT INTO syncv2_apply_tree_v2 VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,plan_id,prefix,step) DO UPDATE SET hash=excluded.hash,body=excluded.body,count=excluded.count',params:[this.scopeKey,id,work.step+1,...op.params!.slice(1)]},n=JSON.stringify(statement).length;if(batch.length&&(batch.length>=16||size+n>65536))await flush();batch.push(statement);size+=n;}await flush();work.step++;};
  const membership=sqlExactSetGuards('syncv2_apply_keys',{scope:this.scopeKey,plan_id:id},'entity_key',records.keys);
  // Business statements resume by count; one generator serves all steps of this call.
  let ops:AsyncIterator<Statement[]>|undefined,held:Statement[]=[],opsDone=false;const fill=async()=>{while(!held.length&&!opsDone){const r=await ops!.next();if(r.done)opsDone=true;else held=[...r.value];}};
  const nextOps=async()=>{if(!ops){ops=business.run()[Symbol.asyncIterator]();for(let skip=work.offset;skip>0;){await fill();if(!held.length)throw Error('sql_program_incomplete');const n=Math.min(skip,held.length);held.splice(0,n);skip-=n;}}const out:Statement[]=[];let size=0;for(;;){await fill();if(!held.length)break;const n=JSON.stringify(held[0]).length;if(out.length&&(out.length>=64||size+n>BUSINESS_STEP_BYTES))break;out.push(held.shift()!);size+=n;}await fill();return {page:out,done:!held.length};};
  const start=Date.now();let steps=0;const maxSteps=budget.maxSteps??64,maxMillis=budget.maxMillis??150000;
  while(work.phase!=='ready'){
   if(steps>=maxSteps||Date.now()-start>=maxMillis){await checkpoint();throw Object.assign(Error('projection_preparing'),{preparation:{id,phase:work.phase,offset:work.offset,after:work.after,bytes:work.ref.bytes}});}steps++;
   if(work.phase==='membership'){const page=membership.slice(work.offset,work.offset+64);await program.append(page);work.offset+=page.length;if(work.offset>=membership.length){work.phase='business';work.offset=0;}await checkpoint();continue;}
   if(work.phase==='business'){const {page,done}=await nextOps();await program.append(page);work.offset+=page.length;if(done){work.phase='records';work.offset=0;}await checkpoint();continue;}
   if(work.phase==='records'){
    if(work.offset>=records.keys.length){work.phase='remove';work.after='';await checkpoint();continue;}let limit=Math.min(32,records.keys.length-work.offset),prepared:Awaited<ReturnType<WatchProjectionStore['prepareRows']>>,batch:SourceRecord[];
    for(;;){batch=await records.read(work.offset,limit);if(!batch.length)throw Error('closure_incomplete');try{prepared=await this.prepareRows(batch,before.localChangeRevision,nextD64(before.stateVersion),false,readTree);break;}catch(error){if((error as Error).message!=='page_too_large'||batch.length===1)throw error;limit=Math.max(1,Math.floor(batch.length/2));}}
    await program.append(prepared!.statements.filter(s=>!s.sql.startsWith('INSERT INTO syncv2_tree_nodes')));await stageTrees(prepared!.statements);const keys=batch!.map(r=>({sql:'INSERT OR IGNORE INTO syncv2_apply_keys VALUES(?,?,?)',params:[this.scopeKey,id,entityKey(this.key,this.scope.repoId,r.kind,r.logicalId)]}));for(let i=0;i<keys.length;i+=32)await this.db.transaction(keys.slice(i,i+32));work.offset+=batch!.length;await checkpoint();continue;
   }
   if(work.phase==='remove'){
    const page=await this.db.query('SELECT entity_key FROM syncv2_candidates c WHERE scope=? AND entity_key>? AND NOT EXISTS(SELECT 1 FROM syncv2_apply_keys k WHERE k.scope=c.scope AND k.plan_id=? AND k.entity_key=c.entity_key) ORDER BY entity_key LIMIT 32',[this.scopeKey,work.after,id]);
    if(page.length){const tree=await updateRadixIndex({read:readTree,encode:jsonBytes,hash:sha256Hex},page.map(r=>({key:String(r.entity_key),value:null,remove:true as const}))),writes=tree.writes.map(r=>({sql:'INSERT INTO syncv2_tree_nodes VALUES(?,?,?,?,?) ON CONFLICT(scope,prefix) DO UPDATE SET hash=excluded.hash,body=excluded.body,count=excluded.count',params:[this.scopeKey,r.prefix,r.hash,canonical(r.node),r.count]}));await stageTrees(writes);work.after=String(page.at(-1)!.entity_key);await checkpoint();continue;}
    await program.append([{sql:'INSERT INTO syncv2_tree_nodes(scope,prefix,hash,body,count) SELECT scope,prefix,hash,body,count FROM syncv2_apply_tree_v2 t WHERE scope=? AND plan_id=? AND step=(SELECT MAX(newer.step) FROM syncv2_apply_tree_v2 newer WHERE newer.scope=t.scope AND newer.plan_id=t.plan_id AND newer.prefix=t.prefix) ON CONFLICT(scope,prefix) DO UPDATE SET hash=excluded.hash,body=excluded.body,count=excluded.count',params:[this.scopeKey,id]},{sql:'DELETE FROM syncv2_candidates WHERE scope=? AND NOT EXISTS(SELECT 1 FROM syncv2_apply_keys k WHERE k.scope=syncv2_candidates.scope AND k.plan_id=? AND k.entity_key=syncv2_candidates.entity_key)',params:[this.scopeKey,id]},{sql:'DELETE FROM podjs_sql_value_chunks WHERE binding=? AND NOT EXISTS(SELECT 1 FROM syncv2_candidates c WHERE c.scope=? AND c.entity_key=podjs_sql_value_chunks.owner)',params:[this.scopeKey+'#candidate',this.scopeKey]}]);work.phase='finalize';await checkpoint();continue;
   }
   if(work.phase==='finalize'){work.ref=await program.finish();work.phase='ready';await checkpoint();}
  }
  return this.preparedResult(before,work.ref);
 }
 private async preparedResult(before:SyncState,ref:SqlProgramRef){const result=await this.resumeAccountProjection(before,ref);Object.defineProperty(result,'preparedPlan',{value:ref});return result;}
 async keepPlanReservation(ref:SqlProgramRef,reservation:ResourceReservation){const row=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,ref.id]))[0];if(!row)throw Error('sql_program_incomplete');const work=await this.cipher.open(this.aad('apply-work',ref.id),String(row.body));if(work.reservation&&canonical(work.reservation)===canonical(reservation))return {...ref,reservation};if(work.reservation){try{await new ResourceQuota(this.db,work.reservation.binding).resume(work.reservation);throw Error('choice_stale');}catch(e){if((e as Error).message!=='storage_pressure')throw e;}}work.reservation=reservation;await this.db.transaction([{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_apply_work WHERE scope=? AND id=? AND body=?) AND EXISTS(SELECT 1 FROM podjs_resource_quota WHERE binding=? AND id=? AND bytes=?) THEN 1 ELSE 0 END',params:[this.scopeKey,ref.id,row.body,reservation.binding,reservation.id,reservation.bytes]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'UPDATE syncv2_apply_work SET body=? WHERE scope=? AND id=?',params:[await this.cipher.seal(this.aad('apply-work',ref.id),work),this.scopeKey,ref.id]}]);return {...ref,reservation};}
 async existingPlanReservation(ref:SqlProgramRef){const row=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,ref.id]))[0];if(!row)return null;const work=await this.cipher.open(this.aad('apply-work',ref.id),String(row.body));if(!work.reservation)return null;try{return await new ResourceQuota(this.db,work.reservation.binding).resume(work.reservation);}catch(error){if((error as Error).message==='storage_pressure')return null;throw error;}}
 async planOwned(id:string){const s=await this.readState();if(s.cloud?.pendingPublish?.applyPlan?.id===id||s.cloud?.preparingPublication?.applyPlan?.id===id)return true;const row=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,id]))[0];if(!row)return false;const work=await this.cipher.open(this.aad('apply-work',id),String(row.body));return !!s.cloud?.pendingCloudChoice&&work.stateHash===digest(s);}
 async releasePlanReservation(ref:SqlProgramRef){if(await this.planOwned(ref.id))return;const reservation=(ref as any).reservation as ResourceReservation|undefined,release=reservation?await new ResourceQuota(this.db,reservation.binding).resume(reservation).catch(error=>{if((error as Error).message==='storage_pressure')return null;throw error;}):await this.existingPlanReservation(ref);if(!release?.reservation)return;const before=await this.readState();if(before.cloud?.pendingPublish?.applyPlan?.id===ref.id||before.cloud?.preparingPublication?.applyPlan?.id===ref.id)return;const r=release.reservation;await this.db.transaction([{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_state WHERE scope=? AND state_version=?) THEN 1 ELSE 0 END',params:[this.scopeKey,before.stateVersion]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'DELETE FROM podjs_resource_quota WHERE binding=? AND id=? AND bytes=?',params:[r.binding,r.id,r.bytes]}]);}
 private applyProgram(id:string){return new SqlProgram(this.db,this.cipher,this.scopeKey,id,this.aad('apply-program',id));}
 /** R2/N1: prepare the keep-both copies of quarantined notes the same bounded,
  * resumable way as the follow apply: every statement crosses the host in one
  * encrypted small page at a time, the durable `apply_work` cursor names the
  * operations already appended, and the caller's state CAS carries only the
  * small program marker plus the plan cleanup. No single host call ever holds
  * a whole long note. `run` must be deterministic for a stable `inputDigest`
  * (same statements, same order, in bounded batches); the copy timestamp is
  * fixed by the first checkpoint, so a crash re-run resumes, never duplicates. */
 async prepareQuarantineCopies(before:SyncState,inputDigest:string,now:number,run:(now:number)=>AsyncGenerator<Statement[]>):Promise<Statement[]>{
  this.gate.require();await this.collectPreparations(before);
  const stateHash=digest(before),id=digest(['quarantine-copy-v1',stateHash,inputDigest]);
  const cleanup=[{sql:'DELETE FROM podjs_sql_programs WHERE binding=? AND id=?',params:[this.scopeKey,id]},{sql:'DELETE FROM podjs_sql_program_pages WHERE binding=? AND id=?',params:[this.scopeKey,id]},{sql:'DELETE FROM syncv2_apply_work WHERE scope=? AND id=?',params:[this.scopeKey,id]}];
  const saved=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,id]))[0];
  let savedBody=saved?String(saved.body):null,work=saved?await this.cipher.open(this.aad('apply-work',id),String(saved.body)):null;
  if(work&&(work.kind!=='quarantine-copy'||work.stateHash!==stateHash||work.inputDigest!==inputDigest||!['append','ready'].includes(work.phase)||!Number.isSafeInteger(Number(work.operations))||Number(work.operations)<0||typeof work.now!=='number'||!work.ref))throw Error('choice_stale');
  const reopen=async()=>{const program=this.applyProgram(id);return {program,status:await program.open()};};
  let {program,status}=await reopen();
  const restart=async()=>{await this.db.transaction(cleanup);work=null;savedBody=null;return reopen();};
  // A ready plan is final only when the checkpoint says so and the refs agree;
  // anything else is rebuilt from scratch, which is deterministic under `id`.
  if(status==='ready'&&(work?.phase!=='ready'||canonical(work.ref)!==canonical(program.snapshot())))({program,status}=await restart());
  if(status!=='ready'&&work?.phase==='ready')({program,status}=await restart());
  if(status==='ready'){const marker=await program.statement(work!.ref);return [marker,...cleanup];}
  const expected=work?.ref??{binding:this.scopeKey,id,pages:0,fragments:0,operations:0,bytes:0,root:'0'.repeat(64)};
  if(canonical(expected)!==canonical(program.snapshot()))await program.rewind(expected);
  if(Number(work?.operations??0)>program.snapshot().operations)throw Error('sql_program_incomplete');
  const checkpoint=async(phase:'append'|'ready')=>{const ref=program.snapshot();
   const body=await this.cipher.seal(this.aad('apply-work',id),{kind:'quarantine-copy',stateHash,inputDigest,now:work?.now??now,operations,phase,ref});
   await this.db.transaction([{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN (? IS NULL AND NOT EXISTS(SELECT 1 FROM syncv2_apply_work WHERE scope=? AND id=?) OR EXISTS(SELECT 1 FROM syncv2_apply_work WHERE scope=? AND id=? AND body=?)) AND EXISTS(SELECT 1 FROM podjs_sql_programs WHERE binding=? AND id=? AND pages=? AND root=?) THEN 1 ELSE 0 END',params:[savedBody,this.scopeKey,id,this.scopeKey,id,savedBody,this.scopeKey,id,ref.pages,ref.root]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'INSERT INTO syncv2_apply_work VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body',params:[this.scopeKey,id,body]}]);
   savedBody=body;};
  // The resume cursor is a statement count over the deterministic batches.
  let operations=program.snapshot().operations,skip=Number(work?.operations??0),steps=0;const started=Date.now();
  for await(const raw of run(Number(work?.now??now))){
   let at=0;if(skip>0){const n=Math.min(skip,raw.length);at+=n;skip-=n;}
   for(let off=at;off<raw.length;){const chunk=raw.slice(off,Math.min(raw.length,off+64));off+=chunk.length;
    if(++steps>2048||Date.now()-started>=150000){await checkpoint('append');throw Object.assign(Error('projection_preparing'),{preparation:{id,operations}});}
    await program.append(chunk);operations+=chunk.length;await checkpoint('append');}
   }
  if(skip>0)throw Error('sql_program_incomplete');
  const ref=await program.finish();await checkpoint('ready');
  const marker=await program.statement(ref);return [marker,...cleanup];
 }
 async resumeAccountProjection(before:SyncState,ref:SqlProgramRef,validateOnly=false){
  if(ref.binding!==this.scopeKey)throw Error('choice_stale');const saved=(await this.db.query('SELECT body FROM syncv2_apply_work WHERE scope=? AND id=?',[this.scopeKey,ref.id]))[0];if(!saved)throw Error('sql_program_incomplete');const work=await this.cipher.open(this.aad('apply-work',ref.id),String(saved.body));if(work.membershipVersion!==1||work.phase!=='ready'||canonical(work.ref)!==canonical(Object.fromEntries(['binding','id','pages','fragments','operations','bytes','root'].map(k=>[k,(ref as any)[k]]))))throw Error('sql_program_incomplete');const cp=await this.checkpoint(),tail:Statement[]=[];
  if(cp?.phase==='complete'){const next={...cp,R0:before.localChangeRevision,R1:before.localChangeRevision,accountApplyVersion:nextD64(before.stateVersion)};tail.push({sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),next),this.scopeKey]});}
  return [await this.applyProgram(ref.id).statement(ref,validateOnly),...tail,captureSqlBasis('syncv2_business_basis',this.scopeKey,nextD64(before.stateVersion),'business_sync_revision')];
 }
 accountProjectionReservationBytes(statements:Statement[]){let size=jsonBytes(JSON.stringify(statements)).length*2+32768;for(const s of statements){const program=(s as any).program;if(program)size+=program.bytes*6;}if(!Number.isSafeInteger(size))throw Error('storage_pressure');return size;}
 async validateAccountProjection(before:SyncState,statements:Statement[]){
  const program=(statements as any).preparedPlan as SqlProgramRef|undefined;if(!program)throw Error('sql_program_incomplete');const marker=await this.applyProgram(program.id).statement(program,true);
  // Execute the exact native operations, including constraints, then rollback.
  try{await commitSqlCas(this.db,{table:'syncv2_state',keyColumn:'scope',versionColumn:'state_version',key:this.scopeKey},before.stateVersion,[{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM business_sync_revision WHERE id=1 AND epoch=? AND CAST(revision AS TEXT)=?) THEN 1 ELSE 0 END',params:[before.businessRevision!.epoch,before.businessRevision!.revision]},{sql:'DELETE FROM podjs_sql_cas_guard'},marker]);}catch(error){if(/CHECK constraint failed: id=1/.test(String(error)))throw Error('choice_stale');throw error;}
  return program;
 }
 /** Reset only the scan checkpoint. Retain candidates, IDs, edits and the DB. */
 async restartScan(){
  const before=await this.readState(),row=(await this.db.query('SELECT binding FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0];if(!row)throw Error('scan_not_started');
  const cp:Checkpoint={R0:before.localChangeRevision,R1:null,after:'',tail:'0',phase:'scan',rows:0,tailEnd:null,businessRevision:before.businessRevision!};
  await this.controlUpdate(before,{...before},[{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),cp),this.scopeKey]}]);
 }
 async publicationUpdate(before:SyncState,next:SyncState,statements:Statement[]=[]){
  const plan=before.cloud?.pendingPublish;if(plan?.guardVersion!==undefined){if(plan.guardVersion!==before.stateVersion)throw Error('choice_stale');next.cloud={...next.cloud,pendingPublish:{...next.cloud.pendingPublish,guardVersion:nextD64(before.stateVersion)}};}
  await this.controlUpdate(before,next,statements);
 }
 async preparePublicationFinish(plan:any){
  const header=await this.cipher.seal(this.aad('commit-header',plan.commitOid),plan.commit);
  return [{sql:'INSERT OR IGNORE INTO syncv2_commit_headers VALUES(?,?,?)',params:[this.scopeKey,plan.commitOid,header]},
   {sql:'DELETE FROM syncv2_upload_objects WHERE scope=? AND plan_id=?',params:[this.scopeKey,plan.requestId]},
   {sql:'DELETE FROM syncv2_upload_receipts WHERE scope=? AND plan_id=?',params:[this.scopeKey,plan.requestId]}];
 }
 async legacyChoiceEntry(key:string){
  const row=(await this.db.query('SELECT input_hash,body FROM syncv2_legacy_inbox WHERE scope=? AND inbox_key=?',[this.scopeKey,key]))[0];if(!row)throw Error('choice_stale');
  const entry=await this.cipher.open(this.aad('legacy',key),String(row.body)),{route,applied,...original}=entry;
  if(!(route==='discarded-for-cloud'&&entry.discardedInputHash===row.input_hash)&&digest(original)!==row.input_hash)throw Error('idempotency_conflict');return {entry,inputHash:String(row.input_hash)};
 }
 async prepareLegacyDecision(before:SyncState,key:string,route:'discarded-for-cloud'|'resolve-local'){
  const selected=await this.legacyChoiceEntry(key);checkCapture(before,captureChoice(before,before.account!),key);if(selected.entry.route!=='pendingChoice'||selected.entry.applied)throw Error('choice_stale');
  const rows=await this.db.query('SELECT inbox_key FROM syncv2_legacy_inbox WHERE scope=? ORDER BY rowid',[this.scopeKey]),entries=[];for(const row of rows)entries.push({key:String(row.inbox_key),...(await this.legacyChoiceEntry(String(row.inbox_key)))});
  const value={...selected.entry,route,applied:route==='resolve-local'};if(route==='discarded-for-cloud'){value.body='{}';value.bodyRefsByEntity={};value.discardedInputHash=selected.inputHash;}
  const next=JSON.parse(canonical(before)) as SyncState,remaining=next.pendingChoice!.inboxKeys.filter(k=>k!==key);next.pendingChoice=remaining.length||before.hasUnsentEdits&&before.editBase.generation!==before.rollbackGeneration?{...next.pendingChoice!,inboxKeys:remaining}:null;
  const streams=new Map<string,typeof entries>();for(const e of entries){const stream=canonical([e.entry.peer,e.entry.version]);const list=streams.get(stream)??[];list.push(e.key===key?{...e,entry:value}:e);streams.set(stream,list);}
  for(const [stream,list]of streams){let cursor:string|undefined;for(const e of list){if(!e.entry.applied)break;cursor=e.entry.cursor;}if(cursor!==undefined)next.applied[stream]=cursor;const peer=list[0]!.entry.peer;if([...streams.values()].filter(v=>v[0]!.entry.peer===peer).length===1){if(cursor!==undefined)next.applied[peer]=cursor;}else delete next.applied[peer];}
  return {next,statements:[{sql:'UPDATE syncv2_legacy_inbox SET body=? WHERE scope=? AND inbox_key=? AND input_hash=?',params:[await this.cipher.seal(this.aad('legacy',key),value),this.scopeKey,key,selected.inputHash]}]};
 }
 /** R2: the business-layer read-only set, replaced at the pull's state CAS. */
 unopenableNotesStatements(noteIds:readonly string[]){return unopenableNotesStatements(this.scopeKey,noteIds);}
 validateEntityIdentity(id:string,kind:Kind,logicalId:string){if(entityKey(this.key,this.scope.repoId,kind,logicalId)!==id)throw Error('identity_conflict');}
 async noteBinding(entity:string):Promise<NoteBinding|null>{this.gate.require();hexId(entity,64);const row=(await this.db.query('SELECT body FROM syncv2_note_bindings WHERE scope=? AND entity_key=?',[this.scopeKey,entity]))[0];if(!row)return null;const value=await this.cipher.open(this.aad('note-binding',entity),String(row.body));if(!value||!['live','deleted'].includes(value.life)||value.revision!==null&&!/^[a-f0-9]{32}$/.test(value.revision))throw Error('invalid_schema');return value;}
 async noteBindingStatement(entity:string,value:NoteBinding|null):Promise<Statement>{hexId(entity,64);if(value===null)return {sql:'DELETE FROM syncv2_note_bindings WHERE scope=? AND entity_key=?',params:[this.scopeKey,entity]};return {sql:'INSERT INTO syncv2_note_bindings VALUES(?,?,?) ON CONFLICT(scope,entity_key) DO UPDATE SET body=excluded.body',params:[this.scopeKey,entity,await this.cipher.seal(this.aad('note-binding',entity),{revision:value.revision,life:value.life})]};}
 async identityForEntity(entity:string){
  const row=(await this.db.query('SELECT kind,logical_id FROM syncv2_identity_map WHERE local_library=? AND repo=? AND entity_key=?',[this.libraryId,this.scope.repoId,entity]))[0];if(!row)throw Error('source_identity_missing');return {kind:String(row.kind) as Kind,logicalId:String(row.logical_id)};
 }
 /** With `maxBytes`, stops before the stored ciphertext total exceeds it (at
  * least one row), so pages of long notes are decoded one at a time. */
 async candidatePage(after='',limit=32,maxBytes=Number.POSITIVE_INFINITY){
  this.gate.require();limit=await this.boundedLimit('SELECT length(body)'+(this.cipher.blocks?'+'+this.chunks('candidate').sizeSql('entity_key'):'')+' AS n FROM syncv2_candidates WHERE scope=? AND entity_key>? ORDER BY entity_key LIMIT ?',[this.scopeKey,after,limit],limit,maxBytes);if(!limit)return [];const rows=await this.db.query('SELECT entity_key,body,row_sequence FROM syncv2_candidates WHERE scope=? AND entity_key>? ORDER BY entity_key LIMIT ?',[this.scopeKey,after,limit]);
  const out=[];for(const row of rows)out.push({entityKey:String(row.entity_key),rowSequence:String(row.row_sequence),candidate:await this.openCandidate(String(row.entity_key),row.body)});return out;
 }
 /** Bounded encrypted staging. active tree switches only after all rows authenticate. */
 async stageCloudRows(root:string,rows:any[],baseline:SyncState){
  this.gate.require();await this.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS syncv2_cloud_rows(scope TEXT NOT NULL,root TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,root,entity_key))'}]);
  let state=await this.readState();if(canonical(state)!==canonical(baseline))throw Error('choice_stale');
  for(let at=0;at<rows.length;at+=32){const statements=await this.cloudCache.prepare(root,rows.slice(at,at+32).map(value=>({key:value.row.entityKey,value})));if(!statements.length)continue;const next={...state};await this.controlUpdate(state,next,statements);state=next;}
  return state;
 }
 async cloudRowCount(root:string){this.gate.require();return Math.max(await this.cloudCache.count(root),Number((await this.db.query('SELECT COUNT(*) AS n FROM syncv2_cloud_rows WHERE scope=? AND root=?',[this.scopeKey,root]))[0]?.n??0));}
 async cloudRow(root:string,entityKey:string){
  this.gate.require();hexId(entityKey,64);const cached=await this.cloudCache.get(root,entityKey);if(cached)return cached;const row=(await this.db.query('SELECT body FROM syncv2_cloud_rows WHERE scope=? AND root=? AND entity_key=?',[this.scopeKey,root,entityKey]))[0];return row?this.cipher.open(this.aad('cloud-row',root+entityKey),String(row.body)):null;
 }
 private async boundedLimit(sql:string,params:unknown[],limit:number,maxBytes:number){if(!Number.isFinite(maxBytes))return limit;let total=0,n=0;for(const row of await this.db.query(sql,params)){total+=Number(row.n);if(n&&total>maxBytes)break;n++;}return n;}
 async cloudRows(root:string,after='',limit=32,maxBytes=Number.POSITIVE_INFINITY){
  this.gate.require();if(await this.cloudCache.count(root)>=Number((await this.db.query('SELECT COUNT(*) AS n FROM syncv2_cloud_rows WHERE scope=? AND root=?',[this.scopeKey,root]))[0]?.n??0))return this.cloudCache.page(root,after,limit,maxBytes);limit=await this.boundedLimit('SELECT length(body) AS n FROM syncv2_cloud_rows WHERE scope=? AND root=? AND entity_key>? ORDER BY entity_key LIMIT ?',[this.scopeKey,root,after,limit],limit,maxBytes);if(!limit)return [];const rows=await this.db.query('SELECT entity_key,body FROM syncv2_cloud_rows WHERE scope=? AND root=? AND entity_key>? ORDER BY entity_key LIMIT ?',[this.scopeKey,root,after,limit]);
  const out=[];for(const row of rows)out.push(await this.cipher.open(this.aad('cloud-row',root+String(row.entity_key)),String(row.body)));return out;
 }
 async stageUpload(planId:string,objects:Map<string,Uint8Array>,expected?:SyncState){
  this.gate.require();await this.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS syncv2_upload_objects(scope TEXT NOT NULL,plan_id TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,plan_id,oid))'}]);
  let batch:Statement[]=[],size=0;const flush=async()=>{if(!batch.length)return;const before=await this.readState();if(expected&&canonical(before)!==canonical(expected))throw Error('choice_stale');const next={...before};await this.controlUpdate(before,next,batch);expected=expected?next:undefined;batch=[];size=0;};
  for(const [id,bytes]of objects){const body=await this.cipher.seal(this.aad('upload',planId+id),encodeBase64(bytes));if(batch.length&&(batch.length>=16||size+body.length>65536))await flush();batch.push({sql:'INSERT INTO syncv2_upload_objects VALUES(?,?,?,?) ON CONFLICT(scope,plan_id,oid) DO UPDATE SET body=excluded.body',params:[this.scopeKey,planId,id,body]});size+=body.length;}await flush();
  return expected;
 }
 /** Abandoned preparation only: removes this plan's staged objects. */
 async dropUpload(planId:string){this.gate.require();if(!(await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_upload_objects'")).length)return;const before=await this.readState();if(before.cloud?.pendingPublish?.requestId===planId)return;await this.controlUpdate(before,{...before},[{sql:'DELETE FROM syncv2_upload_objects WHERE scope=? AND plan_id=?',params:[this.scopeKey,planId]}]);}
 async uploadCount(planId:string){this.gate.require();return Number((await this.db.query('SELECT COUNT(*) AS n FROM syncv2_upload_objects WHERE scope=? AND plan_id=?',[this.scopeKey,planId]))[0]?.n??0);}
 async uploadPage(planId:string,after='',limit=1){
  this.gate.require();const rows=await this.db.query('SELECT oid,body FROM syncv2_upload_objects WHERE scope=? AND plan_id=? AND oid>? ORDER BY oid LIMIT ?',[this.scopeKey,planId,after,limit]),out=[];
  for(const row of rows)out.push({oid:String(row.oid),bytes:base64ToBytes(await this.cipher.open(this.aad('upload',planId+String(row.oid)),String(row.body)))});return out;
 }
 async uploadBatch(planId:string,after=''){return readBoundedKeysetBatch(async key=>(await this.uploadPage(planId,key,1))[0],after,item=>item.oid,item=>item.bytes.length,16,65536);}
 async uploadReceipt(planId:string,id:string){
  this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_upload_receipts WHERE scope=? AND plan_id=? AND oid=?',[this.scopeKey,planId,id]))[0];
  return row?this.cipher.open(this.aad('upload-receipt',planId+id),String(row.body)):null;
 }
 async confirmUploadReceipt(planId:string,id:string,totalBytes:number,receipt:any){
  this.gate.require();const prior=await this.uploadReceipt(planId,id),offset=receipt.body.durableOffset;
  if(prior&&prior.totalBytes!==totalBytes)throw Error('hash_mismatch');if(prior&&prior.durableOffset>=offset)return;
  const before=await this.readState(),body=await this.cipher.seal(this.aad('upload-receipt',planId+id),{totalBytes,durableOffset:offset,receipt});
  await this.publicationUpdate(before,{...before},[{sql:'INSERT INTO syncv2_upload_receipts VALUES(?,?,?,?) ON CONFLICT(scope,plan_id,oid) DO UPDATE SET body=excluded.body',params:[this.scopeKey,planId,id,body]}]);
 }
 async consumeUploadReplay(id:string,total:number,confirmed:number,offset:number,length:number){
  this.gate.require();const before=await this.readState(),row=(await this.db.query('SELECT body FROM syncv2_upload_replays WHERE scope=? AND oid=?',[this.scopeKey,id]))[0],prior=row?await this.cipher.open(this.aad('upload-replay',id),String(row.body)):null;
  if(prior&&prior.total!==total)throw Error('hash_mismatch');const high=Math.max(confirmed,prior?.confirmed??0),attempted=Math.max(prior?.attempted??0,offset+length),used=prior?.bytes??0,next=chargedReplayBytes(Math.max(high,prior?.attempted??0),offset,length,total,used);if(prior&&next===used&&attempted===prior.attempted&&high===prior.confirmed)return;
  const body=await this.cipher.seal(this.aad('upload-replay',id),{total,confirmed:high,attempted,bytes:next});
  await this.publicationUpdate(before,{...before},[{sql:'INSERT INTO syncv2_upload_replays VALUES(?,?,?) ON CONFLICT(scope,oid) DO UPDATE SET body=excluded.body',params:[this.scopeKey,id,body]}]);
 }
 async quarantineIncoming(baseline:SyncState,root:string,objects:Map<string,Uint8Array>,code:string){
  this.gate.require();await this.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS syncv2_quarantine(scope TEXT NOT NULL,commit_oid TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,commit_oid,oid))'}]);
  let state=await this.readState();if(canonical(state)!==canonical(baseline))throw Error('choice_stale');
  for(const [id,raw]of objects){const body=await this.cipher.seal(this.aad('quarantine',root+id),encodeBase64(raw)),next={...state};await this.controlUpdate(state,next,[{sql:'INSERT OR IGNORE INTO syncv2_quarantine VALUES(?,?,?,?)',params:[this.scopeKey,root,id,body]}]);state=next;}
  const next={...state,cloud:{...state.cloud,blockedCommitOid:root,blockedCode:code}};await this.controlUpdate(state,next);
 }
 async finishUpload(before:SyncState,next:SyncState,planId:string,plan?:any){await this.controlUpdate(before,next,plan?await this.preparePublicationFinish(plan):[{sql:'DELETE FROM syncv2_upload_objects WHERE scope=? AND plan_id=?',params:[this.scopeKey,planId]},{sql:'DELETE FROM syncv2_upload_receipts WHERE scope=? AND plan_id=?',params:[this.scopeKey,planId]}]);}
 async readHeader(id:string){
  this.gate.require();if(!(await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_commit_headers'")).length)return null;
  const row=(await this.db.query('SELECT body FROM syncv2_commit_headers WHERE scope=? AND oid=?',[this.scopeKey,id]))[0];return row?this.cipher.open(this.aad('commit-header',id),String(row.body)):null;
 }
 async stageHeaders(entries:{oid:string;body:any;signature:string}[],baseline:SyncState){
  this.gate.require();await this.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS syncv2_commit_headers(scope TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,oid))'}]);
  let state=await this.readState();if(canonical(state)!==canonical(baseline))throw Error('choice_stale');
  for(let at=0;at<entries.length;at+=16){const statements:Statement[]=[];for(const entry of entries.slice(at,at+16)){const envelope={body:entry.body,signature:entry.signature},old=await this.readHeader(entry.oid);if(old){if(canonical(old)!==canonical(envelope))throw Error('idempotency_conflict');continue;}statements.push({sql:'INSERT INTO syncv2_commit_headers VALUES(?,?,?)',params:[this.scopeKey,entry.oid,await this.cipher.seal(this.aad('commit-header',entry.oid),envelope)]});}if(statements.length){const next={...state};await this.controlUpdate(state,next,statements);state=next;}}return state;
 }
 async dropInactiveCloudRows(root:string){
  for(;;){const before=await this.readState();if(before.pendingChoice||before.cloud?.pendingPublish||before.cloud?.preparingPublication)return;const rows=await this.db.query('SELECT rowid FROM syncv2_cloud_rows WHERE scope=? AND root!=? LIMIT 32',[this.scopeKey,root]);if(!rows.length){await this.controlUpdate(before,{...before},this.cloudCache.dropExcept(root));return;}await this.controlUpdate(before,{...before},rows.map(row=>({sql:'DELETE FROM syncv2_cloud_rows WHERE scope=? AND rowid=?',params:[this.scopeKey,row.rowid]})));}
 }
 /** The caller supplies an authenticated HeadPins observation. No network DTO
  * or unverified server checkpoint may be passed as an account observation. */
 async observe(account:Account,authenticate:(account:Account,state:SyncState)=>Promise<{authors:Record<string,unknown>;parents:Record<string,unknown>}>,hook?:()=>void){const state=await this.readState();nextD64(state.stateVersion);const pins=await authenticate(account,state),next=observeAccount(state,account);next.knownAuthors=pins.authors;next.knownAccountParents=pins.parents;await this.commit(state,next,[],hook);}
 async capture(window:Account){return captureChoice(await this.readState(),window);}
 async checkpoint():Promise<Checkpoint|null>{this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0];if(!row)return null;const cp:Checkpoint=await this.cipher.open(this.aad('checkpoint'),String(row.body));if(cp.phase==='complete'&&cp.accountApplyVersion){const basis=(await this.db.query('SELECT epoch,revision FROM syncv2_business_basis WHERE scope=? AND state_version=?',[this.scopeKey,cp.accountApplyVersion]))[0];if(!basis)throw Error('projection_state_inconsistent');cp.businessRevision={epoch:String(basis.epoch),revision:String(basis.revision)};}return cp;}
 async beginScan(binding:ScanBinding){
  const state=await this.readState();nextD64(state.stateVersion);const bind=canonical(binding),prior=(await this.db.query('SELECT binding FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0],old=await this.checkpoint();
  if(prior?.binding===bind&&old&&(sameBusinessRevision(old.businessRevision,state.businessRevision)||old.phase!=='complete'&&old.businessRevision?.epoch===state.businessRevision?.epoch))return {hit:true,reason:sameBusinessRevision(old.businessRevision,state.businessRevision)?'same-binding-and-revision':'resume-prefix-then-reconcile',checkpoint:old};
  const cp:Checkpoint={R0:state.localChangeRevision,R1:null,after:'',tail:'0',tailEnd:null,phase:'scan',rows:0,businessRevision:state.businessRevision!};
  await this.commit(state,{...state},[{sql:'INSERT INTO syncv2_checkpoint VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET binding=excluded.binding,body=excluded.body',params:[this.scopeKey,bind,await this.cipher.seal(this.aad('checkpoint'),cp)]}]);return {hit:false,reason:prior?'binding-or-revision-changed':'first-scan',checkpoint:cp};
 }
 private async prepareRows(rows:SourceRecord[],revision:string,sequence:string,force=false,readTree?: (prefix:string)=>Promise<any>){
  const statements:Statement[]=[],treeChanges:RadixRow[]=[];let total=0;
  for(const row of rows){const entity=entityKey(this.key,this.scope.repoId,row.kind,row.logicalId),candidate=candidates(row.kind,row.logicalId,entity,row.value,row.addedAtMillis,this.segmentOptions()),mapKey=[this.libraryId,this.scope.repoId,row.kind,row.logicalId];
   const existing=(await this.db.query('SELECT entity_key FROM syncv2_identity_map WHERE local_library=? AND repo=? AND kind=? AND logical_id=?',mapKey))[0];if(existing&&existing.entity_key!==entity)throw Error('identity_conflict');
   if(row.source)statements.push({sql:'INSERT INTO syncv2_source_map VALUES(?,?,?,?) ON CONFLICT(scope,source_table,locator) DO UPDATE SET entity_key=excluded.entity_key WHERE entity_key IS NOT excluded.entity_key',params:[this.scopeKey,row.source.table,row.source.locator,entity]});
   const prior=(await this.db.query('SELECT body FROM syncv2_candidates WHERE scope=? AND entity_key=?',[this.scopeKey,entity]))[0];
   const priorValue=prior?await this.openCandidate(entity,prior.body):null;
   if(!force&&priorValue&&canonical(priorValue)===canonical(candidate))continue;
   // rc7 25.3: a local deletion ends the note life in the same transaction.
   if(row.kind==='note'&&candidate.state.payload.deleted===true&&priorValue&&priorValue.state.payload.deleted!==true)statements.push(await this.noteBindingStatement(entity,{revision:null,life:'deleted'}));
   const spilled=await this.sealSpilled('candidate',entity,this.aad('candidate',entity),candidate),sealed=spilled.body;total+=sealed.length;statements.push(...spilled.statements);
   if(total>(rows.length===1?LONG_CANDIDATE_PAGE:384*1024))throw Error('page_too_large');
   treeChanges.push({key:entity,value:{candidateHash:sha256Hex(jsonBytes(sealed)),rowSequence:sequence,addedAtMillis:candidate.addedAtMillis}});
   statements.push({sql:'INSERT OR IGNORE INTO syncv2_identity_map VALUES(?,?,?,?,?,2)',params:[...mapKey,entity]},
    {sql:'INSERT INTO syncv2_candidates VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,entity_key) DO UPDATE SET body=excluded.body,meta_bytes=excluded.meta_bytes,state_bytes=excluded.state_bytes,added_at=excluded.added_at,row_sequence=excluded.row_sequence',params:[this.scopeKey,entity,sealed,candidate.metaBytes,candidate.stateBytes,candidate.addedAtMillis,sequence]},
    {sql:'INSERT OR IGNORE INTO syncv2_change_log VALUES(?,?,?,?)',params:[this.scopeKey,revision,entity,canonical({revision,entityKey:entity,candidateHash:sha256Hex(jsonBytes(sealed))})]});
  }
  if(treeChanges.length){const tree=await updateRadixIndex({read:readTree??(async prefix=>{const saved=(await this.db.query('SELECT hash,body FROM syncv2_tree_nodes WHERE scope=? AND prefix=?',[this.scopeKey,prefix]))[0];return saved?{hash:String(saved.hash),node:JSON.parse(String(saved.body))}:null;}),encode:jsonBytes,hash:sha256Hex},treeChanges);
   for(const row of tree.writes){const body=canonical(row.node);total+=body.length;if(total>(rows.length===1?LONG_CANDIDATE_PAGE:384*1024))throw Error('page_too_large');statements.push({sql:'INSERT INTO syncv2_tree_nodes VALUES(?,?,?,?,?) ON CONFLICT(scope,prefix) DO UPDATE SET hash=excluded.hash,body=excluded.body,count=excluded.count',params:[this.scopeKey,row.prefix,row.hash,body,row.count]});}
  }
  return {statements,total};
 }
 /** One bounded page per invocation. Returning is the execution-budget pause;
  * the next host/guest reads the committed checkpoint and resumes its prefix. */
 async scanPage(source:SourceReader,limit=32,hook?:()=>void){return this.projectPage(source,limit,'scan',hook);}
 private async projectPage(source:SourceReader,limit:number,phase:'scan'|'tail',hook?:()=>void){
  const state=await this.readState(),revision=nextD64(state.stateVersion),cp=await this.checkpoint();if(!cp)throw Error('scan_not_started');if(cp.phase!==phase)return cp;
  let page:SourcePage,prepared:Awaited<ReturnType<WatchProjectionStore['prepareRows']>>;
  for(;;){page=await source.page(cp.after,limit);if(page.rows.length>limit||!page.done&&page.after===cp.after)throw Error('scan_no_progress');try{prepared=await this.prepareRows(page.rows,state.localChangeRevision,revision);break;}catch(error){if(limit===1||(error as Error).message!=='page_too_large')throw error;limit=Math.max(1,Math.floor(limit/2));}}
  const nextCp:Checkpoint={...cp,after:page.after,rows:cp.rows+page.rows.length};
  if(page.done){
   nextCp.R1=state.localChangeRevision;
   if(sameBusinessRevision(cp.businessRevision,state.businessRevision)){nextCp.phase='complete';nextCp.tailEnd=state.businessRevision!.revision;nextCp.tail=nextCp.tailEnd;}
   else {nextCp.phase='tail';nextCp.after='';nextCp.rows=0;nextCp.businessRevision=state.businessRevision!;nextCp.tailEnd=null;}
  }
  await this.commit(state,{...state},[...prepared.statements,{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),nextCp),this.scopeKey]}],hook);return nextCp;
 }
 /** A global tiny witness cannot identify changed rows. Conservatively rescan
  * in bounded pages; unchanged candidates and radix paths are not rewritten. */
 async beginTailWindow(){
  const state=await this.readState();nextD64(state.stateVersion);const cp=await this.checkpoint();if(!cp||cp.phase!=='complete')throw Error('scan_not_complete');
  if(sameBusinessRevision(cp.businessRevision,state.businessRevision))return cp;
  const next:Checkpoint={...cp,R0:cp.R1!,R1:state.localChangeRevision,phase:'tail',after:'',rows:0,tailEnd:null,businessRevision:state.businessRevision!};
  delete next.accountApplyVersion;await this.commit(state,{...state},[{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),next),this.scopeKey]}]);return next;
 }
 async catchUpPage(source:SourceReader,limit=32,hook?:()=>void){return this.projectPage(source,limit,'tail',hook);}
 async readCandidateBySource(table:string,locator:string){this.gate.require();const mapped=(await this.db.query('SELECT entity_key FROM syncv2_source_map WHERE scope=? AND source_table=? AND locator=?',[this.scopeKey,table,locator]))[0];return mapped?this.readCandidate(String(mapped.entity_key)):null;}
 async readCandidate(entity:string){this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_candidates WHERE scope=? AND entity_key=?',[this.scopeKey,entity]))[0];return row?this.openCandidate(entity,row.body):null;}
 /** No business apply or ACK. Legacy data is an encrypted shadow journal. */
 async receiveLegacy(input:{peer:string;version:13|14;cursor:string;entityKeys:string[];body:unknown;removedEntityKeys?:string[];bodyRefsByEntity?:Record<string,string[]>;identitiesByEntity?:Record<string,{kind:Kind;logicalId:string}>},affected:string[]|null){
  const state=await this.readState();nextD64(state.stateVersion);const inboxKey=canonical([input.peer,input.version,input.cursor]),body=canonicalLegacy(input.body),retained={...input,body,bodyEncoding:'legacy-json'},hash=digest(retained),old=(await this.db.query('SELECT input_hash FROM syncv2_legacy_inbox WHERE scope=? AND inbox_key=?',[this.scopeKey,inboxKey]))[0];
  if(old){if(old.input_hash!==hash)throw Error('idempotency_conflict');return {duplicate:true,ack:false};}
  const route=legacyInputRoute(state,input.entityKeys,affected),pending=route==='pendingChoice',next={...state,localChangeRevision:nextD64(state.localChangeRevision)};
  if(pending)next.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[...state.pendingChoice?.inboxKeys??[],inboxKey]};
  await this.commit(state,next,[{sql:'INSERT INTO syncv2_legacy_inbox VALUES(?,?,?,?)',params:[this.scopeKey,inboxKey,hash,await this.cipher.seal(this.aad('legacy',inboxKey),{...retained,route,applied:false})]}]);return {duplicate:false,route,ack:false};
 }
 /** Preparation guard available to a future UI. P1 never applies a choice. */
 async validateChoice(capture:Capture,key:string){checkCapture(await this.readState(),capture,key);}
}
