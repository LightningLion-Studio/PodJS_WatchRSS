import {ResourceJournal,type Resource,type CacheRow} from '@podjs/framework/resource-journal';
import {ContentFiles} from '@podjs/framework/content-files';
import type {ProjectionSql,Statement as typeStatement} from '@podjs/framework/sql-projection';
import {canonical,digest,jsonBytes,parseCanonicalJson,nextD64,hexId,checkD64,uint} from './protocol';
import type {LocalCipher} from './store';
import {evictionSort,type EvictionItem} from './eviction';
export type SpaceRound={round:string;controller:string};
export type Examined={entityKey:string;version:string;validUntil:number|null};
export type CachedBody={item:EvictionItem;metadata:Record<string,unknown>;status:'ready'|'placeholder';plaintextSha256:string;proof?:unknown};
/** A separate derived cache, never an original import or business source.
 * All application metadata is sealed. No title or body is in the scan index. */
export class WatchSpaceStore {
 readonly journal:ResourceJournal;
 constructor(db:ProjectionSql,readonly cipher:LocalCipher,readonly files:ContentFiles,readonly binding:string){this.journal=new ResourceJournal(db,binding);}
 async init(){await this.journal.init();await this.journal.db.transaction([
  {sql:'CREATE TABLE IF NOT EXISTS sync2_space_settings(binding TEXT PRIMARY KEY,auto_evict INTEGER NOT NULL DEFAULT 0,clock INTEGER NOT NULL DEFAULT 0)'},
  {sql:'INSERT OR IGNORE INTO sync2_space_settings(binding) VALUES(?)',params:[this.binding]},
  {sql:'CREATE TABLE IF NOT EXISTS sync2_space_round(binding TEXT PRIMARY KEY,round TEXT NOT NULL,controller TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)))'},
  {sql:"INSERT OR IGNORE INTO sync2_space_round VALUES(?,'0','',0)",params:[this.binding]},
  {sql:'CREATE TABLE IF NOT EXISTS sync2_space_examined(binding TEXT NOT NULL,entity_key TEXT NOT NULL,round TEXT NOT NULL,version TEXT NOT NULL,valid_until INTEGER,PRIMARY KEY(binding,entity_key))'},
 ]);}
 aad(id:string){return canonical({domain:'wrss.sync.v2/space',binding:this.binding,id});}
 seal(id:string,value:CachedBody){if(jsonBytes(value).length>8192)throw Error('space_metadata_limit');return this.cipher.seal(this.aad(id),value);}
 open(row:CacheRow):Promise<CachedBody>{return this.cipher.open(this.aad(row.id),row.value);}
 async enabled(){return Number((await this.journal.db.query('SELECT auto_evict FROM sync2_space_settings WHERE binding=?',[this.binding]))[0]?.auto_evict)===1;}
 async setAutoEvict(enabled:boolean){await this.journal.db.transaction([{sql:'UPDATE sync2_space_settings SET auto_evict=? WHERE binding=?',params:[enabled?1:0,this.binding]}]);}
 async timeValid(now:number|null){if(now===null||!Number.isSafeInteger(now)||now<0)return false;const old=Number((await this.journal.db.query('SELECT clock FROM sync2_space_settings WHERE binding=?',[this.binding]))[0]?.clock??0);return now>=old;}
 advanceClock(now:number):typeStatement{return {sql:'UPDATE sync2_space_settings SET clock=MAX(clock,?) WHERE binding=?',params:[now,this.binding]};}
 timeGuard(now:number):typeStatement{return {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM sync2_space_settings WHERE binding=? AND clock<=?) THEN 1 ELSE 0 END',params:[this.binding,now]};}
 async trustedTime(now:number|null){if(!await this.timeValid(now))return false;await this.journal.db.transaction([this.advanceClock(now!)]);return true;}
 async isCurrentRound(session:SpaceRound){const row=(await this.journal.db.query('SELECT 1 AS current FROM sync2_space_round WHERE binding=? AND round=? AND controller=? AND active=1',[this.binding,session.round,session.controller]))[0];return !!row;}
 /** Each window claims the active round with a new controller token. A crash
  * keeps the checked set; a finished round makes the next claim increment round.
  * Legacy position/candidate tables are deliberately neither read nor written. */
 async roundState(){const row=(await this.journal.db.query('SELECT round,controller,active FROM sync2_space_round WHERE binding=?',[this.binding]))[0]!;return {round:String(row.round),controller:String(row.controller),active:Number(row.active)===1};}
 async beginRound(now?:number):Promise<SpaceRound>{
  if(now!==undefined)uint(now);
  const old=(await this.journal.db.query('SELECT round,controller,active,lower(hex(randomblob(16))) AS claim FROM sync2_space_round WHERE binding=?',[this.binding]))[0]!,round=Number(old.active)===1?String(old.round):nextD64(String(old.round)),controller=String(old.claim);
  await this.commitRound([
   {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
   {sql:'UPDATE sync2_space_round SET round=?,controller=?,active=1 WHERE binding=? AND round=? AND controller=? AND active=?',params:[round,controller,this.binding,old.round,old.controller,old.active]},
   {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'},
   {sql:'DELETE FROM podjs_sql_cas_guard'},
   ...now===undefined?[]:[this.timeGuard(now),{sql:'DELETE FROM podjs_sql_cas_guard'},this.advanceClock(now)],
  ]);return {round,controller};
 }
 roundGuard(session:SpaceRound):typeStatement[]{return [
  {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
  {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM sync2_space_round WHERE binding=? AND round=? AND controller=? AND active=1) THEN 1 ELSE 0 END',params:[this.binding,session.round,session.controller]},
  {sql:'DELETE FROM podjs_sql_cas_guard'},
 ];}
 private async commitRound(statements:typeStatement[]){try{await this.journal.db.transaction(statements);}catch(error){if(/CHECK constraint failed/.test(String(error)))throw Error('round_stale');throw error;}}
 endRound(session:SpaceRound){return this.commitRound([...this.roundGuard(session),{sql:'UPDATE sync2_space_round SET active=0 WHERE binding=? AND round=? AND controller=? AND active=1',params:[this.binding,session.round,session.controller]}]);}
 examineStatements(session:SpaceRound,entries:Examined[]):typeStatement[]{
  if(entries.length>32)throw Error('resource_batch_limit');const out=this.roundGuard(session);
  for(const e of entries){hexId(e.entityKey,64);checkD64(e.version);if(e.validUntil!==null)uint(e.validUntil);out.push({sql:'INSERT INTO sync2_space_examined VALUES(?,?,?,?,?) ON CONFLICT(binding,entity_key) DO UPDATE SET round=excluded.round,version=excluded.version,valid_until=excluded.valid_until',params:[this.binding,e.entityKey,session.round,e.version,e.validUntil]});}return out;
 }
 markExamined(session:SpaceRound,entries:Examined[]){return this.commitRound(this.examineStatements(session,entries));}
 /** Every page starts at the C13 head. SQL skips matching checked versions,
  * except decisions whose time boundary has passed. No position is persisted. */
 private unchecked(session:SpaceRound,now:number){return {
  sql:"SELECT r.id,r.revision,r.sort_key,r.value FROM podjs_resource_rows r WHERE r.binding=? AND length(r.id)=64 AND r.id NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS(SELECT 1 FROM sync2_space_examined e WHERE e.binding=r.binding AND e.entity_key=r.id AND e.round=? AND e.version=r.revision AND (e.valid_until IS NULL OR e.valid_until>?)) AND EXISTS(SELECT 1 FROM sync2_space_round s WHERE s.binding=r.binding AND s.round=? AND s.controller=? AND s.active=1)",
  params:[this.binding,session.round,now,session.round,session.controller],
 };}
 async uncheckedPage(session:SpaceRound,now:number,limit=32):Promise<CacheRow[]>{if(limit<1||limit>32)throw Error('resource_batch_limit');const q=this.unchecked(session,now);return (await this.journal.db.query(q.sql+' ORDER BY r.sort_key LIMIT ?',[...q.params,limit])).map(r=>({id:String(r.id),revision:String(r.revision),sort:String(r.sort_key),value:String(r.value)}));}
 /** Recheck priority in the placeholder transaction. New content, opens and
  * time transitions ahead of this row make its old page snapshot invalid. */
 headGuard(session:SpaceRound,row:CacheRow,now:number):typeStatement[]{const q=this.unchecked(session,now);return [
  ...this.roundGuard(session),
  {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM ('+q.sql+' ORDER BY r.sort_key LIMIT 1) head WHERE head.id=? AND head.revision=?) THEN 1 ELSE 0 END',params:[...q.params,row.id,row.revision]},
  {sql:'DELETE FROM podjs_sql_cas_guard'},
 ];}
 async examinedPage(session:SpaceRound,after='',limit=32){if(limit<1||limit>32)throw Error('resource_batch_limit');return this.journal.db.query('SELECT entity_key AS entityKey,version,valid_until AS validUntil FROM sync2_space_examined WHERE binding=? AND round=? AND entity_key>? ORDER BY entity_key LIMIT ?',[this.binding,session.round,after,limit]);}
 /** GC revalidates a placeholder without inventing a new metadata version. */
 rowGuard(row:CacheRow):typeStatement[]{return [
  {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
  {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM podjs_resource_rows WHERE binding=? AND id=? AND revision=?) THEN 1 ELSE 0 END',params:[this.binding,row.id,row.revision]},
  {sql:'DELETE FROM podjs_sql_cas_guard'},
 ];}
 guard(now:number):typeStatement{return {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM sync2_space_settings WHERE binding=? AND auto_evict=1 AND clock<=?) THEN 1 ELSE 0 END',params:[this.binding,now]};}
 /** Register only immutable synthetic/derived files in this namespace. */
 async register(resources:Resource[]){for(const r of resources)if(!r.path.startsWith(this.binding+'/'))throw Error('source_path_forbidden');await this.journal.db.transaction([...this.journal.register(resources),...resources.flatMap(r=>this.journal.attach('stage:'+r.id,[r.id]))]);}
 async unstage(resources:Resource[]){for(let at=0;at<resources.length;at+=32)await this.journal.db.transaction(resources.slice(at,at+32).map(r=>this.journal.detach('stage:'+r.id)));}
 async add(body:CachedBody,resourceIds:string[]){const id=body.item.entityKey;await this.journal.db.transaction([this.journal.insert(id,evictionSort(body.item),await this.seal(id,body)),...this.journal.attach('body:'+id,resourceIds)]);await this.unstage(resourceIds.map(id=>({id,path:'',bytes:0}))); }
 async touch(id:string,patch:Partial<Pick<EvictionItem,'openedNow'|'lastOpenedAtMillis'|'dirty'|'bodyRevision'>>){const row=await this.journal.row(id);if(!row)throw Error('object_missing');const body=await this.open(row);body.item={...body.item,...patch};await this.journal.db.transaction([...this.journal.replace(row,await this.seal(id,body),evictionSort(body.item))]);}
 placeholder(row:CacheRow,value:string,now:number):typeStatement[]{const change=this.journal.replace(row,value);change.splice(2,0,this.guard(now),{sql:'DELETE FROM podjs_sql_cas_guard'});return [...change,this.journal.authority('body:'+row.id,row.id),this.journal.detach('body:'+row.id)];}
 collect(authorize?:Parameters<ResourceJournal['collect']>[3]){return this.journal.collect(path=>this.files.discard(path),async paths=>(await this.files.stat(paths)).map(s=>s.exists?s.size:0),32,authorize??(async rows=>({ids:rows.filter(r=>!r.authority).map(r=>r.id),commit:s=>this.journal.db.transaction(s)})));}
}
