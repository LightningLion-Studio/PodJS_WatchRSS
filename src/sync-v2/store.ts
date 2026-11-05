import {updateRadixIndex,type RadixRow} from '@podjs/framework/radix-index';
import {sha256Hex} from '@podjs/framework/crypto';
import {commitSqlCas,readSqlKeysetPage,stableSqlTriggers,checkD64,nextD64,compareD64,type ProjectionSql,type Statement} from '@podjs/framework/sql-projection';
import {canonical,canonicalLegacy,jsonBytes,digest,entityKey,hexId,validateScope,type Scope,type Kind} from './protocol';
import {candidates} from './business';
import {ProjectionGate} from './gate';
import {initialState,observeAccount,legacyInputRoute,captureChoice,checkCapture,type Account,type Capture,type SyncState} from './state';
export interface LocalCipher {seal(aad:string,value:unknown):Promise<string>;open(aad:string,sealed:string):Promise<any>}
export type SourceRecord={kind:Kind;logicalId:string;value:Record<string,any>;addedAtMillis?:number;source?:{table:string;locator:string}};
export type ScanBinding={schema:string;descriptorPin:string;accountScope:string;capability:string};
export interface SourcePage {rows:SourceRecord[];after:string;done:boolean}
export interface SourceReader {
 /** Stable keyset token. The caller never passes offset or a full inventory. */
 page(after:string,limit:number):Promise<SourcePage>;
 /** Called for a bounded native outbox entry; never read body files/recipes. */
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
export const PROJECTION_SOURCE_TABLES:Record<string,string[]>={
 sync_books:['book_id'],sync_book_reading:['book_id','chapter_index'],article_register_state:['article_id'],
 memo_notes:['note_id'],memo_folders:['folder_id'],sync_source_states:['url'],
 // Native mutations that precede normalization still invalidate a captured
 // choice and create durable work. They cannot be silently omitted on resume.
 articles:['id'],channels:['id'],article_reading_state:['article_id'],article_saved_states:['article_id','save_type'],
 sync_article_ids:['article_id'],cloud_rss_article_ids:['item_id'],article_sync_encoding_cache:['item_id'],article_sync_content:['item_id'],article_native_sync_hash:['item_id'],sync_body_revision:['item_id'],
 sync_saved_states:['article_id','save_type'],sync_article_deletions:['article_id'],note_merge_conflicts:['conflict_id'],
};
/** Decimal successor using only SQLite text and a single digit integer. Native
 * outbox triggers never convert D64 into signed SQLite or JS numeric counters. */
function nextSql(column:string){const head=`rtrim(${column},'9')`,zeros=`replace(substr(${column},length(${head})+1),'9','0')`;return `CASE WHEN ${head}='' THEN '1'||${zeros} ELSE substr(${head},1,length(${head})-1)||CAST(CAST(substr(${head},-1) AS INTEGER)+1 AS TEXT)||${zeros} END`;}
function triggers(table:string,columns:string[],allColumns:string[]){return ['INSERT','UPDATE','DELETE'].map(op=>{
 const ref=op==='DELETE'?'OLD':'NEW',locator="'hex-v1:'||"+columns.map(c=>'hex(CAST('+ref+'.'+c+' AS BLOB))').join("||':'||");
 return `CREATE TRIGGER IF NOT EXISTS syncv2_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} WHEN EXISTS(SELECT 1 FROM syncv2_control WHERE id=1 AND enabled=1)${op==='UPDATE'?' AND ('+allColumns.map(c=>'OLD.'+c+' IS NOT NEW.'+c).join(' OR ')+')':''} BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_state s JOIN syncv2_control c ON s.scope=c.scope WHERE c.id=1 AND (s.state_version='18446744073709551615' OR s.local_revision='18446744073709551615')) THEN RAISE(ABORT,'counter_exhausted') END;
 UPDATE syncv2_state SET state_version=${nextSql('state_version')},local_revision=${nextSql('local_revision')},awaiting_user=CASE WHEN account_generation!=edit_generation THEN 1 ELSE awaiting_user END WHERE scope=(SELECT scope FROM syncv2_control WHERE id=1);
 INSERT INTO syncv2_outbox(scope,source_table,locator) SELECT scope,'${table}',${locator} FROM syncv2_control WHERE id=1;END`;
 });}
export type Checkpoint={R0:string;R1:string|null;after:string;tail:string;phase:'scan'|'tail'|'complete';rows:number;tailEnd:string|null};
export class WatchProjectionStore {
 private readonly scopeKey:string;
 constructor(private readonly db:ProjectionSql,private readonly cipher:LocalCipher,readonly gate:ProjectionGate,private readonly scope:Scope,private readonly libraryId:string,private readonly key:Uint8Array,private readonly checkIdentity:()=>Promise<void>=async()=>{}){
  validateScope(scope);this.scope=Object.freeze({...scope});this.key=new Uint8Array(key);this.scopeKey=canonical(scope);hexId(libraryId,32);if(key.length!==32)throw Error('authentication_required');
 }
 private aad(purpose:string,id=''){return canonical({domain:'wrss.sync.v2/local-projection',version:2,scope:this.scope,libraryId:this.libraryId,purpose,id});}
 /** Gate off means zero SQL/secure/crypto/network calls, including schema work. */
 async initialize(){if(!this.gate.isEnabled)return {ddl:0,unchanged:0};
  await this.checkIdentity();await this.db.transaction(PROJECTION_SCHEMA.map(sql=>({sql})));
  if(!(await this.db.query('SELECT 1 FROM syncv2_state WHERE scope=?',[this.scopeKey])).length){
   const initial=initialState(),tables=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(row=>String(row.name)));
   const witnesses=[['sync_change_log',"SELECT 1 FROM sync_change_log WHERE seq>COALESCE((SELECT MIN(last_local_seq_acked) FROM sync_peer_state),0) LIMIT 1"],['memo_notes','SELECT 1 FROM memo_notes WHERE content_hash!=base_content_hash LIMIT 1'],['article_register_state','SELECT 1 FROM article_register_state WHERE pending_json IS NOT NULL OR raw_conflict=1 LIMIT 1'],['sync_book_reading_dirty','SELECT 1 FROM sync_book_reading_dirty LIMIT 1']];
   for(const [table,query]of witnesses)if(tables.has(table!)&&(await this.db.query(query!)).length){initial.hasUnsentEdits=true;break;}
   const body=await this.cipher.seal(this.aad('state'),initial);
   await this.db.transaction([{sql:'INSERT OR IGNORE INTO syncv2_state VALUES(?,?,?,?,?,?,0)',params:[this.scopeKey,'0','0',body,'0','0']}]);
  }
  const existing=new Set((await this.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name))),definitions:string[]=["CREATE TRIGGER IF NOT EXISTS syncv2_identity_immutable BEFORE INSERT ON syncv2_identity_map WHEN EXISTS(SELECT 1 FROM syncv2_identity_map WHERE local_library=NEW.local_library AND repo=NEW.repo AND kind=NEW.kind AND logical_id=NEW.logical_id AND (entity_key!=NEW.entity_key OR mapping_version!=NEW.mapping_version)) BEGIN SELECT RAISE(ABORT,'identity_conflict');END"];
  for(const [table,keys]of Object.entries(PROJECTION_SOURCE_TABLES))if(existing.has(table)){const columns=(await this.db.query('PRAGMA table_info('+table+')')).map(r=>String(r.name));if(columns.some(c=>!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)))throw Error('unsupported_feature');definitions.push(...triggers(table,keys,columns));}
  const result=await stableSqlTriggers(this.db,definitions);
  // A local test/diagnostic entry must activate explicitly. No cloud transport,
  // worker, settings migration, or account registration is attached here.
  await this.db.transaction([{sql:'INSERT INTO syncv2_control VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,enabled=1 WHERE scope IS NOT excluded.scope OR enabled!=1',params:[this.scopeKey]}]);return result;
 }
 async disable(){if(!this.gate.isEnabled)return;await this.db.transaction([{sql:'UPDATE syncv2_control SET enabled=0 WHERE id=1 AND scope=?',params:[this.scopeKey]}]);this.gate.close();}
 async readState():Promise<SyncState>{this.gate.require();await this.checkIdentity();const row=(await this.db.query('SELECT * FROM syncv2_state WHERE scope=?',[this.scopeKey]))[0];if(!row)throw Error('projection_not_initialized');const state=await this.cipher.open(this.aad('state'),String(row.body));state.stateVersion=checkD64(row.state_version);state.localChangeRevision=checkD64(row.local_revision);if(checkD64(row.account_generation)!==state.rollbackGeneration||checkD64(row.edit_generation)!==state.editBase.generation)throw Error('projection_state_inconsistent');if(Number(row.awaiting_user)===1&&!state.pendingChoice)state.pendingChoice={generation:state.rollbackGeneration,inboxKeys:[]};return state;}
 private async commit(state:SyncState,next:SyncState,statements:Statement[]=[],hook?:()=>void){this.gate.require();const following=nextD64(state.stateVersion);next.stateVersion=following;const body=await this.cipher.seal(this.aad('state'),next);await this.checkIdentity();hook?.();
  try{await commitSqlCas(this.db,{table:'syncv2_state',keyColumn:'scope',versionColumn:'state_version',key:this.scopeKey},state.stateVersion,[{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_control WHERE id=1 AND scope=? AND enabled=1) THEN 1 ELSE 0 END',params:[this.scopeKey]},{sql:'DELETE FROM podjs_sql_cas_guard'},{sql:'UPDATE syncv2_state SET body=?,local_revision=?,account_generation=?,edit_generation=?,awaiting_user=? WHERE scope=?',params:[body,next.localChangeRevision,next.rollbackGeneration,next.editBase.generation,next.pendingChoice?1:0,this.scopeKey]},...statements]);}catch(error){if(/NOT NULL constraint failed: syncv2_state.state_version|CHECK constraint failed: id=1/.test(String(error)))throw Error('choice_stale');throw error;}
 }
 /** The caller supplies an authenticated HeadPins observation. No network DTO
  * or unverified server checkpoint may be passed as an account observation. */
 async observe(account:Account,authenticate:(account:Account,state:SyncState)=>Promise<{authors:Record<string,unknown>;parents:Record<string,unknown>}>,hook?:()=>void){const state=await this.readState();nextD64(state.stateVersion);const pins=await authenticate(account,state),next=observeAccount(state,account);next.knownAuthors=pins.authors;next.knownAccountParents=pins.parents;await this.commit(state,next,[],hook);}
 async capture(window:Account){return captureChoice(await this.readState(),window);}
 async checkpoint():Promise<Checkpoint|null>{this.gate.require();const row=(await this.db.query('SELECT body FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0];return row?this.cipher.open(this.aad('checkpoint'),String(row.body)):null;}
 async beginScan(binding:ScanBinding){const state=await this.readState();nextD64(state.stateVersion);const bind=canonical(binding),prior=(await this.db.query('SELECT binding FROM syncv2_checkpoint WHERE scope=?',[this.scopeKey]))[0];if(prior?.binding===bind)return {hit:true,reason:'same-binding',checkpoint:await this.checkpoint()};
  const outbox=(await this.db.query('SELECT CAST(COALESCE(MAX(seq),0) AS TEXT) AS seq FROM syncv2_outbox WHERE scope=?',[this.scopeKey]))[0];
  const cp:Checkpoint={R0:state.localChangeRevision,R1:null,after:'',tail:String(outbox!.seq),tailEnd:null,phase:'scan',rows:0};
  await this.commit(state,{...state},[{sql:'INSERT INTO syncv2_checkpoint VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET binding=excluded.binding,body=excluded.body',params:[this.scopeKey,bind,await this.cipher.seal(this.aad('checkpoint'),cp)]}]);return {hit:false,reason:prior?'binding-changed':'first-scan',checkpoint:cp};
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
 async scanPage(source:SourceReader,limit=32,hook?:()=>void){
  const state=await this.readState(),revision=nextD64(state.stateVersion),cp=await this.checkpoint();if(!cp)throw Error('scan_not_started');if(cp.phase!=='scan')return cp;
  let page:SourcePage,prepared:Awaited<ReturnType<WatchProjectionStore['prepareRows']>>;
  for(;;){page=await source.page(cp.after,limit);if(page.rows.length>limit||!page.done&&page.after===cp.after)throw Error('scan_no_progress');try{prepared=await this.prepareRows(page.rows,state.localChangeRevision,revision);break;}catch(error){if(limit===1||(error as Error).message!=='page_too_large')throw error;limit=Math.max(1,Math.floor(limit/2));}}
  const nextCp={...cp,after:page.after,rows:cp.rows+page.rows.length};
  if(page.done){nextCp.phase='tail';nextCp.R1=state.localChangeRevision;nextCp.tailEnd=String((await this.db.query('SELECT CAST(COALESCE(MAX(seq),0) AS TEXT) AS seq FROM syncv2_outbox WHERE scope=?',[this.scopeKey]))[0]!.seq);}
  await this.commit(state,{...state},[...prepared.statements,{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),nextCp),this.scopeKey]}],hook);return nextCp;
 }
 async beginTailWindow(){
  const state=await this.readState();nextD64(state.stateVersion);const cp=await this.checkpoint();if(!cp||cp.phase!=='complete')throw Error('scan_not_complete');
  const end=String((await this.db.query('SELECT CAST(COALESCE(MAX(seq),0) AS TEXT) AS seq FROM syncv2_outbox WHERE scope=?',[this.scopeKey]))[0]!.seq);if(end===cp.tail)return cp;
  const next:Checkpoint={...cp,R0:cp.R1!,R1:state.localChangeRevision,tailEnd:end,phase:'tail'};
  await this.commit(state,{...state},[{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),next),this.scopeKey]}]);return next;
 }
 async catchUpPage(source:SourceReader,limit=32,hook?:()=>void){
  const state=await this.readState(),revision=nextD64(state.stateVersion),cp=await this.checkpoint();if(!cp||cp.phase==='scan')throw Error('scan_not_ready');if(cp.phase==='complete')return cp;
  let page:Awaited<ReturnType<typeof readSqlKeysetPage>>,prepared:Awaited<ReturnType<WatchProjectionStore['prepareRows']>>;
  for(;;){
   page=await readSqlKeysetPage(this.db,'SELECT CAST(seq AS TEXT) AS seq,source_table,locator FROM syncv2_outbox WHERE scope=? AND seq>? AND seq<=? ORDER BY seq',[this.scopeKey,cp.tail,cp.tailEnd],limit);
   const byId=new Map<string,SourceRecord>();for(const event of page.rows)for(const row of await source.changed(String(event.source_table),String(event.locator)))byId.set(canonical([row.kind,row.logicalId]),row);
   try{prepared=await this.prepareRows([...byId.values()],state.localChangeRevision,revision);break;}catch(error){if(limit===1||(error as Error).message!=='page_too_large')throw error;limit=Math.max(1,Math.floor(limit/2));}
  }
  const nextCp={...cp,tail:page.rows.length?String(page.rows.at(-1)!.seq):cp.tailEnd!};if(nextCp.tail===cp.tailEnd)nextCp.phase='complete';

  await this.commit(state,{...state},[...prepared.statements,{sql:'UPDATE syncv2_checkpoint SET body=? WHERE scope=?',params:[await this.cipher.seal(this.aad('checkpoint'),nextCp),this.scopeKey]}],hook);return nextCp;
 }
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
