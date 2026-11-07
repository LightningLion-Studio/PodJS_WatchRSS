import {ResourceJournal,type Resource,type CacheRow} from '@podjs/framework/resource-journal';
import {ContentFiles} from '@podjs/framework/content-files';
import type {ProjectionSql,Statement as typeStatement} from '@podjs/framework/sql-projection';
import {canonical,digest,jsonBytes,parseCanonicalJson,nextD64} from './protocol';
import type {LocalCipher} from './store';
import {evictionSort,type EvictionItem} from './eviction';
export type CachedBody={item:EvictionItem;metadata:Record<string,unknown>;status:'ready'|'placeholder';plaintextSha256:string;proof?:unknown};
/** A separate derived cache, never an original import or business source.
 * All application metadata is sealed. No title or body is in the scan index. */
export class WatchSpaceStore {
 readonly journal:ResourceJournal;
 constructor(db:ProjectionSql,readonly cipher:LocalCipher,readonly files:ContentFiles,readonly binding:string){this.journal=new ResourceJournal(db,binding);}
 async init(){await this.journal.init();await this.journal.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS sync2_space_settings(binding TEXT PRIMARY KEY,auto_evict INTEGER NOT NULL DEFAULT 0,clock INTEGER NOT NULL DEFAULT 0)'},{sql:'INSERT OR IGNORE INTO sync2_space_settings(binding) VALUES(?)',params:[this.binding]},{sql:"CREATE TABLE IF NOT EXISTS sync2_space_scan(binding TEXT PRIMARY KEY,revision TEXT NOT NULL,after_key TEXT NOT NULL)"},{sql:"INSERT OR IGNORE INTO sync2_space_scan VALUES(?,'0','')",params:[this.binding]},{sql:'CREATE TABLE IF NOT EXISTS sync2_space_candidates(binding TEXT PRIMARY KEY,epoch TEXT NOT NULL)'},{sql:"INSERT OR IGNORE INTO sync2_space_candidates VALUES(?,'0')",params:[this.binding]},{sql:"UPDATE sync2_space_scan SET after_key='' WHERE binding=? AND changes()=1",params:[this.binding]}]);}
 aad(id:string){return canonical({domain:'wrss.sync.v2/space',binding:this.binding,id});}
 seal(id:string,value:CachedBody){if(jsonBytes(value).length>8192)throw Error('space_metadata_limit');return this.cipher.seal(this.aad(id),value);}
 open(row:CacheRow):Promise<CachedBody>{return this.cipher.open(this.aad(row.id),row.value);}
 async enabled(){return Number((await this.journal.db.query('SELECT auto_evict FROM sync2_space_settings WHERE binding=?',[this.binding]))[0]?.auto_evict)===1;}
 async setAutoEvict(enabled:boolean){await this.journal.db.transaction([{sql:'UPDATE sync2_space_settings SET auto_evict=? WHERE binding=?',params:[enabled?1:0,this.binding]}]);}
 async trustedTime(now:number|null){if(now===null||!Number.isSafeInteger(now)||now<0)return false;const old=Number((await this.journal.db.query('SELECT clock FROM sync2_space_settings WHERE binding=?',[this.binding]))[0]?.clock??0);if(now<old)return false;await this.journal.db.transaction([{sql:'UPDATE sync2_space_settings SET clock=MAX(clock,?) WHERE binding=?',params:[now,this.binding]}]);return true;}
 /** Cursor advances only after a row has been examined. Revision fences two
  * independently reopened controllers. Candidate mutations invalidate old pages. */
 async scanCursor(){const row=(await this.journal.db.query('SELECT s.revision,s.after_key,c.epoch FROM sync2_space_scan s JOIN sync2_space_candidates c ON c.binding=s.binding WHERE s.binding=?',[this.binding]))[0]!;return {revision:String(row.revision),after:String(row.after_key),epoch:String(row.epoch)};}
 async advanceScan(cursor:{revision:string;after:string;epoch:string},after:string){try{await this.journal.db.transaction([
  {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
  {sql:'UPDATE sync2_space_scan SET revision=?,after_key=? WHERE binding=? AND revision=? AND after_key=? AND EXISTS(SELECT 1 FROM sync2_space_candidates WHERE binding=? AND epoch=?)',params:[nextD64(cursor.revision),after,this.binding,cursor.revision,cursor.after,this.binding,cursor.epoch]},
  {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'},
  {sql:'DELETE FROM podjs_sql_cas_guard'},
 ]);}catch(error){if(/CHECK constraint failed/.test(String(error)))throw Error('scan_stale');throw error;}return {revision:nextD64(cursor.revision),after,epoch:cursor.epoch};}
 /** Only budget/crash continuation keeps an old position. Registering,
  * opening/editing or restoring a body starts a newly ordered candidate set.
  * The epoch also fences an in-flight placeholder prepared from the old set. */
 invalidateScan():typeStatement[]{return [
  {sql:'UPDATE sync2_space_candidates SET epoch=lower(hex(randomblob(16))) WHERE binding=?',params:[this.binding]},
  {sql:"UPDATE sync2_space_scan SET after_key='' WHERE binding=?",params:[this.binding]},
 ];}
 resetScan(){return this.journal.db.transaction(this.invalidateScan());}
 scanGuard(cursor:{epoch:string}):typeStatement[]{return [
  {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
  {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM sync2_space_candidates WHERE binding=? AND epoch=?) THEN 1 ELSE 0 END',params:[this.binding,cursor.epoch]},
  {sql:'DELETE FROM podjs_sql_cas_guard'},
 ];}
 guard(now:number):typeStatement{return {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM sync2_space_settings WHERE binding=? AND auto_evict=1 AND clock<=?) THEN 1 ELSE 0 END',params:[this.binding,now]};}
 /** Register only immutable synthetic/derived files in this namespace. */
 async register(resources:Resource[]){for(const r of resources)if(!r.path.startsWith(this.binding+'/'))throw Error('source_path_forbidden');await this.journal.db.transaction([...this.journal.register(resources),...resources.flatMap(r=>this.journal.attach('stage:'+r.id,[r.id]))]);}
 async unstage(resources:Resource[]){for(let at=0;at<resources.length;at+=32)await this.journal.db.transaction(resources.slice(at,at+32).map(r=>this.journal.detach('stage:'+r.id)));}
 async add(body:CachedBody,resourceIds:string[]){const id=body.item.entityKey;await this.journal.db.transaction([this.journal.insert(id,evictionSort(body.item),await this.seal(id,body)),...this.journal.attach('body:'+id,resourceIds),...this.invalidateScan()]);await this.unstage(resourceIds.map(id=>({id,path:'',bytes:0}))); }
 async touch(id:string,patch:Partial<Pick<EvictionItem,'openedNow'|'lastOpenedAtMillis'|'dirty'|'bodyRevision'>>){const row=await this.journal.row(id);if(!row)throw Error('object_missing');const body=await this.open(row);body.item={...body.item,...patch};await this.journal.db.transaction([...this.journal.replace(row,await this.seal(id,body),evictionSort(body.item)),...this.invalidateScan()]);}
 placeholder(row:CacheRow,value:string,now:number):typeStatement[]{const change=this.journal.replace(row,value);change.splice(2,0,this.guard(now),{sql:'DELETE FROM podjs_sql_cas_guard'});return [...change,this.journal.authority('body:'+row.id,row.id),this.journal.detach('body:'+row.id)];}
 collect(authorize?:Parameters<ResourceJournal['collect']>[3]){return this.journal.collect(path=>this.files.discard(path),async paths=>(await this.files.stat(paths)).map(s=>s.exists?s.size:0),32,authorize??(async rows=>({ids:rows.filter(r=>!r.authority).map(r=>r.id),commit:s=>this.journal.db.transaction(s)})));}
}
