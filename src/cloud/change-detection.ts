import {PROTOCOL_VERSION} from '../sync/protocol';
import {DOMAIN_ENCODERS} from '../sync/domain-definitions';
import type {CloudHostRequest} from './host-ports';
/** Only disposable sync receipts live here. No keys, envelopes or content. */
export const CLOUD_SAFETY_CHECK_MS=24*60*60*1000;
const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;
const VERSION='cloud-change-gate-v2:'+PROTOCOL_VERSION+':'+Object.values(DOMAIN_ENCODERS).join(',');
const tables=new Set(('articles channels article_previews article_original_previews source_preferences source_media_preferences notes cloud_article_state cloud_source_state sync_local_identity sync_book_delete_members sync_book_reading_dirty sync_book_display_dirty article_body_chunks article_original_chunks article_original_meta article_saved_states article_saved_entry_times article_reading_state native_reading_sources local_article_deletions sync_saved_states sync_source_states sync_article_ids sync_article_aliases sync_article_deletions sync_article_keeps sync_article_keep_aliases cloud_rss_article_ids article_register_state article_register_conflicts llm_token_usage sync_book_parts sync_books sync_book_aliases sync_book_chapters sync_book_reading sync_book_events').split(' '));
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export interface CloudChangeStamp {scope:string;context:string;generation:string;revision:number;version:string}
export interface CloudChangeCheckpoint {heads:string;recordsRevision:string;revision:number;generation:string;verifiedAt:number}
export interface CloudRemoteCheckpoint {heads:string;recordsRevision:string;generation:string;verifiedAt:number}
export interface CloudChangeRead {stamp:CloudChangeStamp;checkpoint?:CloudChangeCheckpoint;remote?:CloudRemoteCheckpoint}
export interface CloudChangeDetection {read(context:string):Promise<CloudChangeRead>;commit(stamp:CloudChangeStamp,heads:string,recordsRevision:string,now:number,remoteVerifiedAt?:number):Promise<boolean>;commitRemote(stamp:CloudChangeStamp,heads:string,recordsRevision:string,now:number):Promise<boolean>}
export function cloudLocalUnchanged(read:CloudChangeRead,now:number){const c=read.checkpoint,s=read.stamp;return !!c&&c.generation===s.generation&&c.revision===s.revision&&s.revision<MAX_REVISION&&Number.isFinite(now)&&now>=c.verifiedAt&&now-c.verifiedAt<CLOUD_SAFETY_CHECK_MS;}
export function cloudRemoteUnchanged(read:CloudChangeRead,heads:string,recordsRevision:string,now:number){const c=read.remote??read.checkpoint;return !!c&&c.generation===read.stamp.generation&&c.heads===heads&&c.recordsRevision===recordsRevision&&Number.isFinite(now)&&now>=c.verifiedAt&&now-c.verifiedAt<CLOUD_SAFETY_CHECK_MS;}
export function cloudChangeUnchanged(read:CloudChangeRead,heads:string,recordsRevision:string,now:number){return cloudLocalUnchanged(read,now)&&cloudRemoteUnchanged(read,heads,recordsRevision,now);}
/** Canonical SQL writes increment the witness inside their own transaction.
 * An unknown schema/build, a missing trigger, a revision rewind or an expired
 * safety receipt cannot authorize a skip. Rollbacks also roll back the bump. */
export class SqlCloudChangeDetection implements CloudChangeDetection {
 private ready?:Promise<void>;
 constructor(private host:CloudHostRequest,private scope:string,private build:string){}
 private query<T=Record<string,any>>(sql:string,params:unknown[]=[]){return this.host<T[]>('sql.query',{sql,params});}
 private tx(statements:{sql:string;params?:unknown[]}[]){return this.host('sql.transaction',{statements});}
 private initialize(){return this.ready??=this.tx([
  {sql:'CREATE TABLE IF NOT EXISTS sync_idle_change_revision(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,schema_cookie INTEGER NOT NULL,user_version INTEGER NOT NULL)'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_idle_change_receipts(scope TEXT NOT NULL,context TEXT NOT NULL,generation TEXT NOT NULL,local_revision INTEGER NOT NULL,heads TEXT NOT NULL,records_revision TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(scope,context))'},
  {sql:'CREATE TABLE IF NOT EXISTS sync_idle_remote_receipts(scope TEXT NOT NULL,context TEXT NOT NULL,generation TEXT NOT NULL,heads TEXT NOT NULL,records_revision TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(scope,context))'},
 ]).then(()=>{}).catch(error=>{this.ready=undefined;throw error;});}
 private async row(context:string){return (await this.query(`SELECT r.*,c.generation AS receipt_generation,c.local_revision,c.heads,c.records_revision,c.verified_at,m.generation AS remote_generation,m.heads AS remote_heads,m.records_revision AS remote_revision,m.verified_at AS remote_verified_at,(SELECT schema_version FROM pragma_schema_version) AS current_schema,(SELECT user_version FROM pragma_user_version) AS current_user FROM sync_idle_change_revision r LEFT JOIN sync_idle_change_receipts c ON c.scope=? AND c.context=? LEFT JOIN sync_idle_remote_receipts m ON m.scope=? AND m.context=? WHERE r.id=1`,[this.scope,context,this.scope,context]))[0];}
 private async install(){
  const schema=(await this.query('SELECT (SELECT schema_version FROM pragma_schema_version) AS cookie,(SELECT user_version FROM pragma_user_version) AS user_version'))[0];
  const found=await this.query("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name");
  const virtual=found.filter(r=>/CREATE\s+VIRTUAL\s+TABLE/i.test(String(r.sql))).map(r=>String(r.name));
  const tracked=found.filter(r=>(tables.has(String(r.name))||String(r.name).startsWith('memo_'))&&!virtual.some(v=>String(r.name)===v||String(r.name).startsWith(v+'_')));
  const statements:{sql:string;params?:unknown[]}[]=[
   {sql:`INSERT OR IGNORE INTO sync_idle_change_revision VALUES(1,?,lower(hex(randomblob(16))),0,-1,-1)`,params:[VERSION+':'+this.build]},
   // Abort on schema drift while the trigger plan was being built. The id
   // CHECK makes this fail closed inside the same installation transaction.
   {sql:'UPDATE sync_idle_change_revision SET id=CASE WHEN (SELECT schema_version FROM pragma_schema_version)=? AND (SELECT user_version FROM pragma_user_version)=? THEN 1 ELSE 0 END WHERE id=1',params:[schema.cookie,schema.user_version]},
  ];
  for(const row of await this.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_idle_track_%'"))statements.push({sql:'DROP TRIGGER '+quote(String(row.name))});
  statements.push({sql:`UPDATE sync_idle_change_revision SET version=?,generation=lower(hex(randomblob(16))),revision=CASE WHEN revision<${MAX_REVISION} THEN revision+1 ELSE revision END,schema_cookie=-1,user_version=-1 WHERE id=1`,params:[VERSION+':'+this.build]});
  for(let at=0;at<tracked.length;at+=8){const part=tracked.slice(at,at+8);const columns=await this.query(part.map(()=>"SELECT ? AS table_name,name AS column_name FROM pragma_table_info(?)").join(' UNION ALL '),part.flatMap(r=>[r.name,r.name]));
   for(const row of part){const table=String(row.name),names=columns.filter(c=>c.table_name===table).map(c=>String(c.column_name));if(!names.length)throw Error('cloud_change_schema_unknown');
    for(const op of ['INSERT','UPDATE','DELETE'])statements.push({sql:`CREATE TRIGGER ${quote('sync_idle_track_'+table+'_'+op.toLowerCase())} AFTER ${op} ON ${quote(table)}${op==='UPDATE'?' WHEN '+names.map(n=>'OLD.'+quote(n)+' IS NOT NEW.'+quote(n)).join(' OR '):''} BEGIN UPDATE sync_idle_change_revision SET revision=CASE WHEN revision<${MAX_REVISION} THEN revision+1 ELSE revision END WHERE id=1; END`});
   }
  }
  statements.push({sql:'UPDATE sync_idle_change_revision SET schema_cookie=(SELECT schema_version FROM pragma_schema_version),user_version=(SELECT user_version FROM pragma_user_version) WHERE id=1'});
  await this.tx(statements);
 }
 async read(context:string):Promise<CloudChangeRead>{
  await this.initialize();let r=await this.row(context);
  if(!r||r.version!==VERSION+':'+this.build||r.schema_cookie!==r.current_schema||r.user_version!==r.current_user){await this.install();r=await this.row(context);}
  if(!r||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.generation!=='string'||r.schema_cookie!==r.current_schema||r.user_version!==r.current_user)throw Error('cloud_change_witness_invalid');
  const stamp={scope:this.scope,context,generation:r.generation,revision:r.revision,version:r.version};
  const checkpoint=typeof r.heads==='string'&&typeof r.records_revision==='string'&&Number.isSafeInteger(r.local_revision)&&r.local_revision>=0&&Number.isSafeInteger(r.verified_at)&&r.verified_at>=0?{heads:r.heads,recordsRevision:r.records_revision,revision:r.local_revision,generation:r.receipt_generation,verifiedAt:r.verified_at}:undefined;
  const remote=typeof r.remote_heads==='string'&&/^(0|[1-9][0-9]*)$/.test(r.remote_revision)&&Number.isSafeInteger(r.remote_verified_at)&&r.remote_verified_at>=0?{heads:r.remote_heads,recordsRevision:r.remote_revision,generation:r.remote_generation,verifiedAt:r.remote_verified_at}:undefined;
  return {stamp,...(checkpoint?{checkpoint}:{}),...(remote?{remote}:{})};
 }
 private remoteStatement(stamp:CloudChangeStamp,heads:string,recordsRevision:string,now:number,localFence=false){return {sql:`INSERT INTO sync_idle_remote_receipts(scope,context,generation,heads,records_revision,verified_at) SELECT ?,?,?,?,?,? FROM sync_idle_change_revision WHERE id=1 AND generation=? AND version=? ${localFence?'AND revision=? ':''}AND schema_cookie=(SELECT schema_version FROM pragma_schema_version) AND user_version=(SELECT user_version FROM pragma_user_version) ON CONFLICT(scope,context) DO UPDATE SET generation=excluded.generation,heads=excluded.heads,records_revision=excluded.records_revision,verified_at=excluded.verified_at`,params:[stamp.scope,stamp.context,stamp.generation,heads,recordsRevision,now,stamp.generation,stamp.version,...(localFence?[stamp.revision]:[])]};}
 async commitRemote(stamp:CloudChangeStamp,heads:string,recordsRevision:string,now:number){
  if(stamp.scope!==this.scope||!Number.isSafeInteger(now)||now<0||!/^(0|[1-9][0-9]*)$/.test(recordsRevision))throw Error('cloud_change_receipt_invalid');
  const changes=await this.host<number[]>('sql.transaction',{reportChanges:true,statements:[this.remoteStatement(stamp,heads,recordsRevision,now)]});return Array.isArray(changes)&&changes[0]===1;
 }
 async commit(stamp:CloudChangeStamp,heads:string,recordsRevision:string,now:number,remoteVerifiedAt=now){
  if(stamp.scope!==this.scope||!Number.isSafeInteger(now)||now<0||!/^(0|[1-9][0-9]*)$/.test(recordsRevision))throw Error('cloud_change_receipt_invalid');
  if(!Number.isSafeInteger(remoteVerifiedAt)||remoteVerifiedAt<0)throw Error('cloud_change_receipt_invalid');
  const changes=await this.host<number[]>('sql.transaction',{reportChanges:true,statements:[{sql:`INSERT INTO sync_idle_change_receipts(scope,context,generation,local_revision,heads,records_revision,verified_at) SELECT ?,?,?,?,?,?,? FROM sync_idle_change_revision WHERE id=1 AND generation=? AND revision=? AND version=? AND schema_cookie=(SELECT schema_version FROM pragma_schema_version) AND user_version=(SELECT user_version FROM pragma_user_version) ON CONFLICT(scope,context) DO UPDATE SET generation=excluded.generation,local_revision=excluded.local_revision,heads=excluded.heads,records_revision=excluded.records_revision,verified_at=excluded.verified_at`,params:[stamp.scope,stamp.context,stamp.generation,stamp.revision,heads,recordsRevision,now,stamp.generation,stamp.revision,stamp.version]},this.remoteStatement(stamp,heads,recordsRevision,remoteVerifiedAt,true)]});
  return Array.isArray(changes)&&changes[0]===1;
 }
}
