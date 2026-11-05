import {updateRadixIndex,type RadixRow} from '@podjs/framework/radix-index';
import {sha256Hex} from '@podjs/framework/crypto';
import {commitSqlCas,stableSqlTriggers,checkD64,nextD64,type ProjectionSql,type Statement} from '@podjs/framework/sql-projection';
import {canonical,canonicalLegacy,jsonBytes,digest,entityKey,hexId,validateScope,type Scope,type Kind} from './protocol';
import {candidates} from './business';
import {ProjectionGate} from './gate';
import {installBusinessRevision,businessRevision,sameBusinessRevision,stopExistingProjection,revisionDelta,addRevision,type BusinessRevision} from './business-revision';
import {initialState,observeAccount,legacyInputRoute,captureChoice,checkCapture,type Account,type Capture,type SyncState} from './state';
export interface LocalCipher {seal(aad:string,value:unknown):Promise<string>;open(aad:string,sealed:string):Promise<any>}
export type SourceRecord={kind:Kind;logicalId:string;value:Record<string,any>;addedAtMillis?:number;source?:{table:string;locator:string}};
export type ScanBinding={schema:string;descriptorPin:string;accountScope:string;capability:string};
export interface SourcePage {rows:SourceRecord[];after:string;done:boolean}
export interface SourceReader {
 /** Stable keyset token. The caller never passes offset or a full inventory. */
 page(after:string,limit:number):Promise<SourcePage>;
 /** Reserved keyed lookup for future incremental work; never read body recipes. */
 changed(table:string,locator:string):Promise<SourceRecord[]>;
}
export const PROJECTION_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS syncv2_state(scope TEXT PRIMARY KEY,state_version TEXT NOT NULL,local_revision TEXT NOT NULL,body TEXT NOT NULL,account_generation TEXT NOT NULL,edit_generation TEXT NOT NULL,awaiting_user INTEGER NOT NULL CHECK(awaiting_user IN (0,1)))`,
 `CREATE TABLE IF NOT EXISTS syncv2_identity_map(local_library TEXT NOT NULL,repo TEXT NOT NULL,kind TEXT NOT NULL,logical_id TEXT NOT NULL,entity_key TEXT NOT NULL,mapping_version INTEGER NOT NULL CHECK(mapping_version=2),PRIMARY KEY(local_library,repo,kind,logical_id))`,
 `CREATE TABLE IF NOT EXISTS syncv2_candidates(scope TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,meta_bytes INTEGER NOT NULL,state_bytes INTEGER NOT NULL,added_at INTEGER NOT NULL,row_sequence TEXT NOT NULL,PRIMARY KEY(scope,entity_key))`,
 `CREATE TABLE IF NOT EXISTS syncv2_source_map(scope TEXT NOT NULL,source_table TEXT NOT NULL,locator TEXT NOT NULL,entity_key TEXT NOT NULL,PRIMARY KEY(scope,source_table,locator))`,
 `CREATE TABLE IF NOT EXISTS syncv2_tree_nodes(scope TEXT NOT NULL,prefix TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,prefix))`,
 `CREATE TABLE IF NOT EXISTS syncv2_change_log(scope TEXT NOT NULL,revision TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,revision,entity_key))`,
 `CREATE TABLE IF NOT EXISTS syncv2_checkpoint(scope TEXT PRIMARY KEY,binding TEXT NOT NULL,body TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS syncv2_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,source_table TEXT NOT NULL,locator TEXT NOT NULL)`,
 `CREATE INDEX IF NOT EXISTS syncv2_outbox_scope ON syncv2_outbox(scope,seq)`,
 `CREATE TABLE IF NOT EXISTS syncv2_control(id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`,
 `CREATE TABLE IF NOT EXISTS syncv2_legacy_inbox(scope TEXT NOT NULL,inbox_key TEXT NOT NULL,input_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,inbox_key))`,
];
export {PROJECTION_SOURCE_TABLES} from './business-revision';
export type Checkpoint={R0:string;R1:string|null;after:string;tail:string;phase:'scan'|'tail'|'complete';rows:number;tailEnd:string|null;businessRevision?:BusinessRevision};
export class WatchProjectionStore {
 private readonly scopeKey:string;
 constructor(private readonly db:ProjectionSql,private readonly cipher:LocalCipher,readonly gate:ProjectionGate,private readonly scope:Scope,private readonly libraryId:string,private readonly key:Uint8Array,private readonly checkIdentity:()=>Promise<void>=async()=>{}){
  validateScope(scope);this.scope=Object.freeze({...scope});this.key=new Uint8Array(key);this.scopeKey=canonical(scope);hexId(libraryId,32);if(key.length!==32)throw Error('authentication_required');this.gate.onClose(()=>stopExistingProjection(this.db));
 }
 private aad(purpose:string,id=''){return canonical({domain:'wrss.sync.v2/local-projection',version:2,scope:this.scope,libraryId:this.libraryId,purpose,id});}
 /** Reopening disabled must durably stop a previously enabled projection. */
 async initialize(){if(!this.gate.isEnabled){await stopExistingProjection(this.db);return {ddl:0,unchanged:0};}
  await this.checkIdentity();await this.db.transaction(PROJECTION_SCHEMA.map(sql=>({sql})));const markerDdl=await installBusinessRevision(this.db);
  if(!(await this.db.query('SELECT 1 FROM syncv2_state WHERE scope=?',[this.scopeKey])).length){
   const initial=initialState();initial.businessRevision=await businessRevision(this.db);const tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(row=>String(row.name)));
   const witnesses=[['sync_change_log',"SELECT 1 FROM sync_change_log WHERE seq>COALESCE((SELECT MIN(last_local_seq_acked) FROM sync_peer_state),0) LIMIT 1"],['memo_notes','SELECT 1 FROM memo_notes WHERE content_hash!=base_content_hash LIMIT 1'],['article_register_state','SELECT 1 FROM article_register_state WHERE pending_json IS NOT NULL OR raw_conflict=1 LIMIT 1'],['sync_book_reading_dirty','SELECT 1 FROM sync_book_reading_dirty LIMIT 1']];
   for(const [table,query]of witnesses)if(tables.has(table!)&&(await this.db.query(query!)).length){initial.hasUnsentEdits=true;break;}
   const body=await this.cipher.seal(this.aad('state'),initial);
   await this.db.transaction([{sql:'INSERT OR IGNORE INTO syncv2_state VALUES(?,?,?,?,?,?,0)',params:[this.scopeKey,'0','0',body,'0','0']}]);
  }
  const result=await stableSqlTriggers(this.db,["CREATE TRIGGER IF NOT EXISTS syncv2_identity_immutable BEFORE INSERT ON syncv2_identity_map WHEN EXISTS(SELECT 1 FROM syncv2_identity_map WHERE local_library=NEW.local_library AND repo=NEW.repo AND kind=NEW.kind AND logical_id=NEW.logical_id AND (entity_key!=NEW.entity_key OR mapping_version!=NEW.mapping_version)) BEGIN SELECT RAISE(ABORT,'identity_conflict');END"]);
  result.ddl+=markerDdl.ddl;result.unchanged+=markerDdl.unchanged;
  // A local test/diagnostic entry must activate explicitly. No cloud transport,
  // worker, settings migration, or account registration is attached here.
  this.gate.require();await this.db.transaction([{sql:'INSERT INTO syncv2_control VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,enabled=1 WHERE scope IS NOT excluded.scope OR enabled!=1',params:[this.scopeKey]}]);if(!this.gate.isEnabled){await stopExistingProjection(this.db);throw Error('feature_disabled');}return result;
 }
 async disable(){await this.gate.close();}
 async readState():Promise<SyncState>{
  this.gate.require();await this.checkIdentity();const row=(await this.db.query('SELECT * FROM syncv2_state WHERE scope=?',[this.scopeKey]))[0];if(!row)throw Error('projection_not_initialized');
  const state:SyncState=await this.cipher.open(this.aad('state'),String(row.body));state.stateVersion=checkD64(row.state_version);state.localChangeRevision=checkD64(row.local_revision);
  if(checkD64(row.account_generation)!==state.rollbackGeneration||checkD64(row.edit_generation)!==state.editBase.generation)throw Error('projection_state_inconsistent');
  if(Number(row.awaiting_user)===1&&!state.pendingChoice)state.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[]};
  const current=await businessRevision(this.db);
  if(!sameBusinessRevision(state.businessRevision,current)){
   nextD64(state.stateVersion);const localRevision=addRevision(state.localChangeRevision,revisionDelta(state.businessRevision,current));
   if(localRevision.length>20||localRevision.length===20&&localRevision>'18446744073709551615')throw Error('counter_exhausted');
   const next={...state,businessRevision:current,localChangeRevision:checkD64(localRevision),hasUnsentEdits:true};
   if(state.rollbackGeneration!==state.editBase.generation&&!next.pendingChoice)next.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[]};
   await this.commit(state,next);return next;
  }
  return state;
 }
 private async commit(state:SyncState,next:SyncState,statements:Statement[]=[],hook?:()=>void){this.gate.require();const following=nextD64(state.stateVersion),marker=next.businessRevision??await businessRevision(this.db);next.stateVersion=following;const body=await this.cipher.seal(this.aad('state'),next);await this.checkIdentity();this.gate.require();hook?.();this.gate.require();
  try{await commitSqlCas(this.db,{table:'syncv2_state',keyColumn:'scope',versionColumn:'state_version',key:this.scopeKey},state.stateVersion,[{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_control WHERE id=1 AND scope=? AND enabled=1) AND EXISTS(SELECT 1 FROM business_sync_revision WHERE id=1 AND epoch=? AND CAST(revision AS TEXT)=?) THEN 1 ELSE 0 END',params:[this.scopeKey,marker.epoch,marker.revision]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'UPDATE syncv2_state SET body=?,local_revision=?,account_generation=?,edit_generation=?,awaiting_user=? WHERE scope=?',params:[body,next.localChangeRevision,next.rollbackGeneration,next.editBase.generation,next.pendingChoice?1:0,this.scopeKey]},...statements]);}catch(error){if(/NOT NULL constraint failed: syncv2_state.state_version|CHECK constraint failed: id=1/.test(String(error)))throw Error('choice_stale');throw error;}
 }
 /** The caller supplies an authenticated HeadPins observation. No network DTO
  * or unverified server checkpoint may be passed as an account observation. */
 async observe(account:Account,authenticate:(account:Account,state:SyncState)=>Promise<{authors:Record<string,unknown>;parents:Record<string,unknown>}>,hook?:()=>void){const state=await this.readState();nextD64(state.stateVersion);const pins=await authenticate(account,state),next=observeAccount(state,account);next.knownAuthors=pins.authors;next.knownAccountParents=pins.parents;await this.commit(state,next,[],hook);}
 async capture(window:Account){return captureChoice(await this.readState(),window);}
 async checkpoint():Promise<Checkpoint|null>{this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0];return row?this.cipher.open(this.aad('checkpoint'),String(row.body)):null;}
 async beginScan(binding:ScanBinding){
  const state=await this.readState();nextD64(state.stateVersion);const bind=canonical(binding),prior=(await this.db.query('SELECT binding FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0],old=await this.checkpoint();
  if(prior?.binding===bind&&old&&(sameBusinessRevision(old.businessRevision,state.businessRevision)||old.phase!=='complete'&&old.businessRevision?.epoch===state.businessRevision?.epoch))return {hit:true,reason:sameBusinessRevision(old.businessRevision,state.businessRevision)?'same-binding-and-revision':'resume-prefix-then-reconcile',checkpoint:old};
  const cp:Checkpoint={R0:state.localChangeRevision,R1:null,after:'',tail:'0',tailEnd:null,phase:'scan',rows:0,businessRevision:state.businessRevision!};
  await this.commit(state,{...state},[{sql:'INSERT INTO syncv2_checkpoint VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET binding=excluded.binding,body=excluded.body',params:[this.scopeKey,bind,await this.cipher.seal(this.aad('checkpoint'),cp)]}]);return {hit:false,reason:prior?'binding-or-revision-changed':'first-scan',checkpoint:cp};
 }
 private async prepareRows(rows:SourceRecord[],revision:string,sequence:string){
  const statements:Statement[]=[],treeChanges:RadixRow[]=[];let total=0;
  for(const row of rows){const entity=entityKey(this.key,this.scope.repoId,row.kind,row.logicalId),candidate=candidates(row.kind,row.logicalId,entity,row.value,row.addedAtMillis),mapKey=[this.libraryId,this.scope.repoId,row.kind,row.logicalId];
   const existing=(await this.db.query('SELECT entity_key FROM syncv2_identity_map WHERE local_library=? AND repo=? AND kind=? AND logical_id=?',mapKey))[0];if(existing&&existing.entity_key!==entity)throw Error('identity_conflict');
   if(row.source)statements.push({sql:'INSERT INTO syncv2_source_map VALUES(?,?,?,?) ON CONFLICT(scope,source_table,locator) DO UPDATE SET entity_key=excluded.entity_key WHERE entity_key IS NOT excluded.entity_key',params:[this.scopeKey,row.source.table,row.source.locator,entity]});
   const prior=(await this.db.query('SELECT body FROM syncv2_candidates WHERE scope=? AND entity_key=?',[this.scopeKey,entity]))[0];
   if(prior&&canonical(await this.cipher.open(this.aad('candidate',entity),String(prior.body)))===canonical(candidate))continue;
   const sealed=await this.cipher.seal(this.aad('candidate',entity),candidate);total+=sealed.length;
   if(total>384*1024)throw Error('page_too_large');
   treeChanges.push({key:entity,value:{candidateHash:sha256Hex(jsonBytes(sealed)),rowSequence:sequence,addedAtMillis:candidate.addedAtMillis}});
   statements.push({sql:'INSERT OR IGNORE INTO syncv2_identity_map VALUES(?,?,?,?,?,2)',params:[...mapKey,entity]},
    {sql:'INSERT INTO syncv2_candidates VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,entity_key) DO UPDATE SET body=excluded.body,meta_bytes=excluded.meta_bytes,state_bytes=excluded.state_bytes,added_at=excluded.added_at,row_sequence=excluded.row_sequence',params:[this.scopeKey,entity,sealed,candidate.metaBytes,candidate.stateBytes,candidate.addedAtMillis,sequence]},
    {sql:'INSERT OR IGNORE INTO syncv2_change_log VALUES(?,?,?,?)',params:[this.scopeKey,revision,entity,canonical({revision,entityKey:entity,candidateHash:sha256Hex(jsonBytes(sealed))})]});
  }
  if(treeChanges.length){const tree=await updateRadixIndex({read:async prefix=>{const saved=(await this.db.query('SELECT hash,body FROM syncv2_tree_nodes WHERE scope=? AND prefix=?',[this.scopeKey,prefix]))[0];return saved?{hash:String(saved.hash),node:JSON.parse(String(saved.body))}:null;},encode:jsonBytes,hash:sha256Hex},treeChanges);
   for(const row of tree.writes){const body=canonical(row.node);total+=body.length;if(total>384*1024)throw Error('page_too_large');statements.push({sql:'INSERT INTO syncv2_tree_nodes VALUES(?,?,?,?,?) ON CONFLICT(scope,prefix) DO UPDATE SET hash=excluded.hash,body=excluded.body,count=excluded.count',params:[this.scopeKey,row.prefix,row.hash,body,row.count]});}
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
  await this.commit(state,{...state},[{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),next),this.scopeKey]}]);return next;
 }
 async catchUpPage(source:SourceReader,limit=32,hook?:()=>void){return this.projectPage(source,limit,'tail',hook);}
 async readCandidateBySource(table:string,locator:string){this.gate.require();const mapped=(await this.db.query('SELECT entity_key FROM syncv2_source_map WHERE scope=? AND source_table=? AND locator=?',[this.scopeKey,table,locator]))[0];return mapped?this.readCandidate(String(mapped.entity_key)):null;}
 async readCandidate(entity:string){this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_candidates WHERE scope=? AND entity_key=?',[this.scopeKey,entity]))[0];return row?this.cipher.open(this.aad('candidate',entity),String(row.body)):null;}
 /** No business apply or ACK. Legacy data is an encrypted shadow journal. */
 async receiveLegacy(input:{peer:string;version:13|14;cursor:string;entityKeys:string[];body:unknown},affected:string[]|null){
  const state=await this.readState();nextD64(state.stateVersion);const inboxKey=canonical([input.peer,input.version,input.cursor]),body=canonicalLegacy(input.body),retained={...input,body,bodyEncoding:'legacy-json'},hash=digest(retained),old=(await this.db.query('SELECT input_hash FROM syncv2_legacy_inbox WHERE scope=? AND inbox_key=?',[this.scopeKey,inboxKey]))[0];
  if(old){if(old.input_hash!==hash)throw Error('idempotency_conflict');return {duplicate:true,ack:false};}
  const route=legacyInputRoute(state,input.entityKeys,affected),pending=route==='pendingChoice',next={...state,localChangeRevision:nextD64(state.localChangeRevision)};
  if(pending)next.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[...state.pendingChoice?.inboxKeys??[],inboxKey]};
  await this.commit(state,next,[{sql:'INSERT INTO syncv2_legacy_inbox VALUES(?,?,?,?)',params:[this.scopeKey,inboxKey,hash,await this.cipher.seal(this.aad('legacy',inboxKey),{...retained,route,applied:false})]}]);return {duplicate:false,route,ack:false};
 }
 /** Preparation guard available to a future UI. P1 never applies a choice. */
 async validateChoice(capture:Capture,key:string){checkCapture(await this.readState(),capture,key);}
}
