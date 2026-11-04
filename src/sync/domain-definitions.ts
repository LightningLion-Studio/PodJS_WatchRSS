import {idleHit} from '../diagnostics/idle-counters';
import {repositoryWork,type RepositoryDiagnostic} from './repository-work';
import {querySyncPages} from './sql-pages';
import {querySqlTableInfo} from '@podjs/framework/sql';
import type {ProjectionVersion,ProjectionVersions} from '@podjs/framework/acked-state-vector';
import type {SqlDatabase,SqlParams} from '../core/types';
import {hashJavaText} from './article-export';
import type {SyncBodyCodec} from './article-body';
import {PROTOCOL_VERSION} from './protocol';
export const SYNC_DOMAINS=['library','books','bookReading','reader','notes','account','usage'] as const;
export type SyncDomain=typeof SYNC_DOMAINS[number];
/** Bump the owning domain when wire export/hash/identity semantics change,
 * including same-schema corrections. Native session ABI is included separately. */
export const DOMAIN_ENCODERS:Record<SyncDomain,number>={library:7,books:1,bookReading:1,reader:1,notes:1,account:1,usage:1};
const libraryTables='articles channels article_body_chunks article_original_chunks article_previews article_original_previews article_original_meta article_saved_states article_saved_entry_times sync_saved_states sync_article_ids sync_article_aliases sync_local_identity local_article_deletions sync_source_states sync_article_deletions sync_article_keeps sync_article_keep_aliases article_reading_state cloud_rss_article_ids article_sync_content article_sync_encoding_cache article_native_sync_hash sync_projection_events'.split(' ');
const dependencies:Record<SyncDomain,string[]>={library:libraryTables,books:['articles','channels','sync_books','sync_book_aliases','sync_book_events','sync_book_display_dirty','sync_book_registration_cache'],bookReading:['articles','article_reading_state','article_saved_states','sync_saved_states','sync_books','sync_book_aliases','sync_book_reading','sync_book_reading_dirty'],reader:[],notes:['memo_notes','memo_folders'],account:[],usage:['llm_token_usage']};
const tracked=[['books','sync_books',['INSERT','UPDATE','DELETE']],['books','sync_book_events',['INSERT','UPDATE','DELETE']],['books','sync_book_display_dirty',['INSERT','UPDATE']],['bookReading','sync_book_reading',['INSERT','UPDATE','DELETE']],['bookReading','sync_book_reading_dirty',['INSERT','UPDATE']],['notes','memo_notes',['INSERT','UPDATE','DELETE']],['notes','memo_folders',['INSERT','UPDATE','DELETE']],['usage','llm_token_usage',['INSERT','UPDATE','DELETE']]] as const;
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
type Statement={sql:string;params?:SqlParams};
export interface DomainDefinition extends ProjectionVersion {epoch:string;generation:string;seeded:boolean}
export function projectionGuard(generation:string):Statement{return {sql:"INSERT INTO sync_fast_guard(id,generation) VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM sync_fast_definitions WHERE domain='library' AND generation=?) THEN ? ELSE NULL END) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation",params:[generation,generation]};}
/** Persistent disposable optimization metadata, checked on process restart and
 * SQLite schema-cookie changes. No identity, body or business cursor is erased. */
export class SqlDomainDefinitions {
 private ready?:Promise<void>;private cookie=-1;private userVersion=-1;private values:Partial<Record<SyncDomain,DomainDefinition>>={};private pending?:Promise<void>;
 constructor(private readonly db:SqlDatabase,private readonly codec:Pick<SyncBodyCodec,'sha256'>,private readonly encoders:Record<SyncDomain,number>=DOMAIN_ENCODERS,private readonly protocolVersion=PROTOCOL_VERSION,private readonly diagnostic?:RepositoryDiagnostic){}
 private init(){return this.ready??=this.db.transaction([
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_definitions(domain TEXT PRIMARY KEY,encoder INTEGER NOT NULL,schema_version INTEGER NOT NULL,definition TEXT NOT NULL,epoch TEXT NOT NULL,generation TEXT NOT NULL,seeded INTEGER NOT NULL DEFAULT 0)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_versions(domain TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_roots(scope TEXT NOT NULL,domain TEXT NOT NULL,revision INTEGER NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,domain))'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_receipts(peer TEXT NOT NULL,scope TEXT NOT NULL,profile TEXT NOT NULL,domain TEXT NOT NULL,local_root TEXT NOT NULL,remote_root TEXT NOT NULL,verified_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(peer,scope,profile,domain))'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_guard(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_library_baseline(peer TEXT PRIMARY KEY,generation TEXT NOT NULL)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_table_shapes(name TEXT PRIMARY KEY,columns_json TEXT NOT NULL)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_fast_encoded_cache(item_id INTEGER PRIMARY KEY,generation TEXT NOT NULL,body_hash TEXT NOT NULL)'},
  // Fast-domain witnesses execute for every imported-body mutation. Match the
  // exact COALESCE expression so a large book is not scanned once per chapter.
  {sql:'CREATE INDEX IF NOT EXISTS sync_fast_import_article_url ON articles(channel_id,COALESCE(link,dedup_key))'},
  {sql:'CREATE INDEX IF NOT EXISTS sync_fast_import_channel_url ON sync_book_aliases(channel_url)'},
 ]).then(async()=>{if(!(await this.db.query('PRAGMA table_info(sync_fast_receipts)')).some(r=>r.name==='verified_at'))await this.db.execute('ALTER TABLE sync_fast_receipts ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0');}).catch(e=>{this.ready=undefined;throw e;});}
 async ensure(){idleHit(36);await this.init();if(this.pending)await this.pending;this.pending=repositoryWork(this.diagnostic,'definitions',()=>this.inspect());try{await this.pending;}finally{this.pending=undefined;}return this.values as Record<SyncDomain,DomainDefinition>;}
 private async inspect(){idleHit(37);
  const cookie=Number(Object.values((await this.db.query('PRAGMA schema_version'))[0]!)[0]);
  const schema=Number(Object.values((await this.db.query('PRAGMA user_version'))[0]!)[0]);
  if(cookie===this.cookie&&schema===this.userVersion){
   const current=await this.db.query('SELECT * FROM sync_fast_definitions');
   if(current.length===SYNC_DOMAINS.length&&current.every(r=>{const v=this.values[String(r.domain) as SyncDomain];return v&&v.definition===r.definition&&v.epoch===r.epoch&&v.generation===r.generation&&v.encoder===this.encoders[String(r.domain) as SyncDomain]&&v.encoder===Number(r.encoder)&&v.schema===Number(r.schema_version);})){for(const r of current)this.values[String(r.domain) as SyncDomain]!.seeded=!!Number(r.seeded);return;}
  }
  const tables=await querySyncPages(this.db,"SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",[],100),tableMap=new Map(tables.map(r=>[String(r.name),r]));
  const columns=await querySqlTableInfo(this.db,[...new Set(Object.values(dependencies).flat())].filter(t=>tableMap.has(t)));
  const triggers=await querySyncPages(this.db,"SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",[],100),actual=new Map(triggers.map(t=>[String(t.name),String(t.sql)]));
  const desired=new Map<SyncDomain,Map<string,string>>(SYNC_DOMAINS.map(d=>[d,new Map()]));
  // Rebuild existing revision UPDATE triggers against today's complete columns.
  // Projection-cache then observes added fields rather than freezing old lists.
  const revisions=new Map<string,string>();
  for(const t of triggers){const name=String(t.name),table=String(t.tbl_name);if(!name.startsWith('sync_revision_')||!name.endsWith('_update')||!columns.has(table))continue;
   const when=columns.get(table)!.map(c=>`OLD.${quote(String(c.name))} IS NOT NEW.${quote(String(c.name))}`).join(' OR ');
   revisions.set(name,`CREATE TRIGGER ${name} AFTER UPDATE ON ${table} WHEN ${when} BEGIN UPDATE sync_library_revision SET revision=revision+1 WHERE id=1; END`);
  }
  const oldShapes=new Map((await this.db.query('SELECT * FROM sync_fast_table_shapes')).map(r=>[String(r.name),JSON.parse(String(r.columns_json)) as string[]]));
  for(const t of triggers){
   const name=String(t.name),table=String(t.tbl_name),source=String(t.sql),old=oldShapes.get(table);
   if(!old||!name.startsWith('sync_book_reading_dirty_')||!name.endsWith('_update'))continue;
   const added=(columns.get(table)??[]).map(c=>String(c.name)).filter(c=>!old.includes(c));if(!added.length)continue;
   const of=/AFTER UPDATE OF ([^]+?) ON /.exec(source)?.[1];if(!of)throw Error('Invalid reading dirty trigger');
   const extra=added.map(c=>`OLD.${quote(c)} IS NOT NEW.${quote(c)}`).join(' OR ');
   const sql=source.replace(/CREATE TRIGGER(?: IF NOT EXISTS)?/, 'CREATE TRIGGER').replace('AFTER UPDATE OF '+of+' ON ', 'AFTER UPDATE OF '+of+','+added.map(quote).join(',')+' ON ').replace(/ AND \(([^]+?)\) BEGIN/,(_all,condition)=>` AND (${condition} OR ${extra}) BEGIN`);
   revisions.set(name,sql);
  }
  for(const [d,t,ops]of tracked){const cols=columns.get(t);if(!cols)continue;for(const op of ops){const name=`sync_fast_${d}_${t}_${op.toLowerCase()}`,condition=op==='UPDATE'?' WHEN '+cols.map(c=>`OLD.${quote(String(c.name))} IS NOT NEW.${quote(String(c.name))}`).join(' OR '):'';desired.get(d)!.set(name,`CREATE TRIGGER ${name} AFTER ${op} ON ${t}${condition} BEGIN UPDATE sync_fast_versions SET revision=revision+1 WHERE domain='${d}';END`);}}
  if(tableMap.has('sync_projection_events')){
   desired.get('library')!.set('sync_fast_cache_manifest',"CREATE TRIGGER sync_fast_cache_manifest AFTER INSERT ON sync_projection_events WHEN NEW.kind NOT IN ('none','cacheNone','bookOnly','bookUrl','bookBodyUrl') AND (NEW.kind<>'cacheUrl' OR (SELECT seeded FROM sync_fast_definitions WHERE domain='library')=1) BEGIN UPDATE sync_fast_versions SET revision=revision+1 WHERE domain='library';END");
   desired.get('books')!.set('sync_fast_import_books',`CREATE TRIGGER sync_fast_import_books AFTER INSERT ON sync_projection_events WHEN NEW.kind='bookBodyUrl' OR NEW.kind IN ('bodyUrl','url','source','full') AND (EXISTS(SELECT 1 FROM channels c WHERE (c.url LIKE '%watchrss.local/import-epub%' OR c.url LIKE '%watchrss.local/import-txt-novel%' OR c.url LIKE '%watchrss.local/import-content%') AND (c.url=NEW.old_url OR c.url=NEW.new_url OR EXISTS(SELECT 1 FROM articles a WHERE a.channel_id=c.id AND COALESCE(a.link,a.dedup_key) IN (NEW.old_url,NEW.new_url)))) OR EXISTS(SELECT 1 FROM sync_book_aliases m WHERE m.url IN (NEW.old_url,NEW.new_url) OR m.channel_url IN (NEW.old_url,NEW.new_url))) BEGIN UPDATE sync_fast_versions SET revision=revision+1 WHERE domain='books';END`);
  }
  const stored=new Map((await this.db.query('SELECT * FROM sync_fast_definitions')).map(r=>[String(r.domain),r]));
  const legacyDerived=(tableMap.has('sync_projection_header')&&!!(await this.db.query('SELECT 1 FROM sync_projection_header LIMIT 1')).length)||(tableMap.has('sync_snapshot_fingerprints')&&!!(await this.db.query('SELECT 1 FROM sync_snapshot_fingerprints LIMIT 1')).length)||!!(await this.db.query('SELECT 1 FROM sync_fast_receipts LIMIT 1')).length;
  const invalidated:SyncDomain[]=[];const invalidationAt=Date.now();const statements:Statement[]=[];const next:Partial<Record<SyncDomain,DomainDefinition>>={};
  for(const d of SYNC_DOMAINS){
   const deps=dependencies[d],owned=desired.get(d)!;
   const layout=deps.map(t=>[t,tableMap.get(t)?.sql??null,columns.get(t)??[]]);
   const effectiveTriggers=triggers.filter(t=>deps.includes(String(t.tbl_name))&&!String(t.name).startsWith('sync_fast_')).map(t=>[t.name,t.tbl_name,revisions.get(String(t.name))??t.sql]);
   const definition=await hashJavaText(JSON.stringify(['watchrss-domain-definition-v2',this.protocolVersion,d,this.encoders[d],schema,layout,effectiveTriggers,[...owned]]),this.codec);
   const old=stored.get(d),expectedGeneration=old?await hashJavaText('watchrss.ble.library-cache.v1\n'+definition+'\n'+String(old.epoch),this.codec):'',ownedTriggersChanged=[...owned].some(([name,sql])=>actual.get(name)!==sql),revisionTriggersChanged=[...revisions].some(([name,sql])=>deps.includes(String(triggers.find(t=>t.name===name)?.tbl_name))&&actual.get(name)!==sql),valid=old?.generation===expectedGeneration&&old?.definition===definition&&!ownedTriggersChanged&&!revisionTriggersChanged;
   if(valid){next[d]={encoder:this.encoders[d],schema,definition,epoch:String(old.epoch),generation:String(old.generation),seeded:!!Number(old.seeded)};continue;}
   invalidated.push(d);try{this.diagnostic?.({event:'library-work',stage:'definitions-invalidate',outcome:'started',domain:d,definitionChanged:old?.definition===definition?0:1,generationChanged:old?.generation===expectedGeneration?0:1,ownedTriggersChanged:ownedTriggersChanged?1:0,revisionTriggersChanged:revisionTriggersChanged?1:0,durationMillis:0});}catch{}
   const epoch=String((await this.db.query('SELECT lower(hex(randomblob(16))) epoch'))[0]!.epoch),generation=await hashJavaText('watchrss.ble.library-cache.v1\n'+definition+'\n'+epoch,this.codec);
   const seeded=d!=='library'||!legacyDerived&&(!old||!!Number(old.seeded));
   next[d]={encoder:this.encoders[d],schema,definition,epoch,generation,seeded};
   for(const [name,sql]of owned)statements.push({sql:'DROP TRIGGER IF EXISTS '+quote(name)},{sql});
   statements.push({sql:'INSERT OR IGNORE INTO sync_fast_versions(domain) VALUES(?)',params:[d]},{sql:'INSERT OR REPLACE INTO sync_fast_definitions VALUES(?,?,?,?,?,?,?)',params:[d,this.encoders[d],schema,definition,epoch,generation,seeded?1:0]},{sql:'DELETE FROM sync_fast_roots WHERE domain=?',params:[d]},{sql:'DELETE FROM sync_fast_receipts WHERE domain=?',params:[d]});
   if(d==='library'){
    for(const [name,sql]of revisions)statements.push({sql:'DROP TRIGGER IF EXISTS '+quote(name)},{sql});
    for(const table of ['sync_projection_header','sync_projection_rows','sync_snapshot_fingerprints','article_native_sync_hash','sync_peer_echo','sync_peer_echo_generation','sync_fast_library_baseline','sync_fast_encoded_cache'])if(tableMap.has(table))statements.push({sql:'DELETE FROM '+table});
   }
   if(d==='usage'&&tableMap.has('sync_token_usage_epoch'))statements.push({sql:'UPDATE sync_token_usage_epoch SET epoch=? WHERE id=1',params:[epoch]});
   if(d==='bookReading'&&tableMap.has('sync_book_reading_meta')){
    for(const table of ['sync_book_reading_hashes','sync_book_reading_book_hashes','sync_book_reading_hash_dirty','sync_book_reading_history','sync_book_reading_versions','sync_book_reading_journal','sync_book_reading_peers','sync_book_registration_cache'])if(tableMap.has(table))statements.push({sql:'DELETE FROM '+table});
    statements.push({sql:'UPDATE sync_book_reading_meta SET epoch=?,root=NULL,count=0 WHERE id=1',params:[epoch]},
     {sql:'INSERT INTO sync_book_reading_journal(book_id,chapter_index) SELECT book_id,chapter_index FROM sync_book_reading'},
     {sql:'INSERT OR IGNORE INTO sync_book_reading_hash_dirty SELECT DISTINCT book_id FROM sync_book_reading'},
     {sql:'INSERT OR IGNORE INTO sync_book_reading_dirty(item_id) SELECT DISTINCT item_id FROM sync_book_aliases WHERE item_id IS NOT NULL'});
   }
  }
  if(statements.length){for(const [name,cols]of columns)statements.push({sql:'INSERT OR REPLACE INTO sync_fast_table_shapes(name,columns_json) VALUES(?,?)',params:[name,JSON.stringify(cols.map(c=>String(c.name)))]});try{await this.db.transaction(statements);for(const domain of invalidated)try{this.diagnostic?.({event:'library-work',stage:'definitions-invalidate',domain,outcome:'complete',durationMillis:Date.now()-invalidationAt});}catch{}}catch(error){for(const domain of invalidated)try{this.diagnostic?.({event:'library-work',stage:'definitions-invalidate',domain,outcome:'failed',durationMillis:Date.now()-invalidationAt});}catch{}throw error;}}
  // Reload persisted seed flags; another installer may have observed a changed
  // schema. The enclosing snapshot guards the frozen generation before publish.
  this.values=next;this.userVersion=schema;this.cookie=Number(Object.values((await this.db.query('PRAGMA schema_version'))[0]!)[0]);
 }
 async versions():Promise<ProjectionVersions>{const v=await this.ensure();return Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{encoder:v[d].encoder,schema:v[d].schema,definition:v[d].definition}]));}
 async libraryGeneration(){return (await this.ensure()).library.generation;}
}
