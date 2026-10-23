import {onlyChangedSql} from '@podjs/framework/sql-changes';
import {querySyncPages} from "./sql-pages.ts";
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {SyncedSource} from './library-wire.ts';
import {nativeTrim,type SyncTextPort} from './local-manifest.ts';
import {libraryRevision,revisionGuard} from './revision.ts';
import {deviceOrder} from './saved-state.ts';
import {lazyRegExpTest} from '../core/lazy-regexp.ts';
export interface SourceUriPort {parseUri:SyncTextPort['parseUri'];parseAndroid:SyncTextPort['parseUri']}
const whitespace=/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const sourceHostCharacter=lazyRegExpTest('[\\p{L}\\p{Nd}.-]','u');
const n=(v:unknown)=>Number(v??0),s=(v:unknown)=>v==null?'':String(v),nullable=(v:unknown)=>v==null?null:String(v);
export function isSyncedSourceUrl(value:string):boolean {const u=nativeTrim(value).toLowerCase();return (u.startsWith('http://')||u.startsWith('https://'))&&u!=='https://watchrss.local/import-content';}
/** Repository source normalization differs from stable-article-id normalization. */
export function normalizeSourceUrl(value:string):string {
 const t=nativeTrim(value),lower=t.toLowerCase();if(!t||lower.startsWith('http://')||lower.startsWith('https://')||t.includes('://'))return t;
 if(t.startsWith('/')||whitespace.test(t))return t;
 const hostPort=t.split(/[/?#]/,1)[0]!,host=hostPort.split(':',1)[0]!;
 if(host.toLowerCase()==='localhost')return 'http://'+t;
 if(!host||host.startsWith('.')||host.endsWith('.')||!host.includes('.'))return t;
 // Kotlin Char iteration rejects a supplementary letter's surrogate halves.
 for(let i=0;i<host.length;i++)if(!sourceHostCharacter(host[i]!))return t;
 return 'http://'+t;
}
const stateSql=onlyChangedSql(`INSERT INTO sync_source_states(url,source_device_id,title,description,site_url,image_url,created_at,updated_at,sort_order,is_pinned,deleted,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET source_device_id=excluded.source_device_id,title=excluded.title,description=excluded.description,site_url=excluded.site_url,image_url=excluded.image_url,created_at=excluded.created_at,updated_at=excluded.updated_at,sort_order=excluded.sort_order,is_pinned=excluded.is_pinned,deleted=excluded.deleted,deleted_at=excluded.deleted_at`);
export class SqlSourceSyncStore {
 constructor(private readonly db:SqlDatabase,private readonly uri:SourceUriPort,private readonly now=Date.now,private readonly onChannelRemoved?:(content:{channel:{id:number;url:string};itemIds:number[]})=>Promise<void>){}
 private async hostLabel(url:string):Promise<string>{const t=nativeTrim(url),u=t.startsWith('http://')||t.startsWith('https://')?t:'https://'+t;const p=await this.uri.parseUri(u);return nativeTrim((p.valid?p.host??'':'').replace(/^www\./,''));}
 async merge(sources:readonly SyncedSource[],remoteDeviceId:string,localDeviceId:string,authoritative=false):Promise<number>{
  if(!this.db.transactionChanges)throw new Error('Source sync requires committed transaction counts');let applied=0;
  for(const source of sources){
   for(const value of [source.createdAt,source.updatedAt,source.sortOrder,source.deletedAt])if(!Number.isSafeInteger(value))throw new Error('Invalid source clock');
   const url=normalizeSourceUrl(source.url);if(url.length>2048||whitespace.test(url))continue;const parsed=await this.uri.parseAndroid(url);
   if(!parsed.valid||!['http','https'].includes(parsed.scheme?.toLowerCase()??'')||!nativeTrim(parsed.host??'')||nativeTrim(url).toLowerCase()==='https://watchrss.local/import-content')continue;
   const title=nativeTrim(source.title)?source.title:await this.hostLabel(url);
   if(source.deleted){
    const updated=source.updatedAt>0?source.updatedAt:source.deletedAt>0?source.deletedAt:source.sortOrder>0?source.sortOrder:source.createdAt,deletedAt=source.deletedAt>0?source.deletedAt:updated;
    const revision=this.onChannelRemoved?await libraryRevision(this.db):undefined;
    const channel=this.onChannelRemoved?(await this.db.query('SELECT id,url FROM channels WHERE url=?',[url]))[0]:undefined;
    const itemIds=channel?(await querySyncPages(this.db,'SELECT id FROM articles WHERE channel_id=? ORDER BY id',[channel.id])).map(row=>n(row.id)):[];
    const counts=await this.db.transactionChanges([...(revision===undefined?[]:[revisionGuard(revision)]),{sql:stateSql,params:[url,nativeTrim(source.sourceDeviceId)?source.sourceDeviceId:remoteDeviceId,title,source.description,source.siteUrl,source.imageUrl,source.createdAt,updated,source.sortOrder,source.isPinned?1:0,1,deletedAt]},{sql:'DELETE FROM channels WHERE url=?',params:[url]}]);
    if(channel)await this.onChannelRemoved!({channel:{id:n(channel.id),url:s(channel.url)},itemIds});if(counts.some(n=>n>0))applied++;continue;
   }
   const old=(await this.db.query('SELECT * FROM sync_source_states WHERE url=?',[url]))[0];
   if(!authoritative&&!old){const local=(await this.db.query('SELECT created_at,sort_order FROM channels WHERE url=?',[url]))[0],incoming=source.updatedAt||source.sortOrder||source.createdAt;if(local&&incoming<Math.max(Number(local.created_at),-Number(local.sort_order)))continue;}
   const clock=source.updatedAt||source.sortOrder||source.createdAt;if(!authoritative&&old&&(clock<Number(old.updated_at)||clock===Number(old.updated_at)&&deviceOrder(source.sourceDeviceId||remoteDeviceId)<deviceOrder(String(old.source_device_id))))continue;
   const updated=source.updatedAt>0?source.updatedAt:source.sortOrder>0?source.sortOrder:source.createdAt,now=this.now(),order=source.sortOrder>0?source.sortOrder:updated>0?updated:now;
   const statements:{sql:string;params:SqlParams}[]=[{sql:`INSERT INTO channels(url,title,description,image_url,created_at,sort_order,is_pinned) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,image_url=excluded.image_url,sort_order=excluded.sort_order,is_pinned=excluded.is_pinned
    WHERE ?=1 OR ?>COALESCE((SELECT updated_at FROM sync_source_states WHERE url=channels.url),max(-channels.sort_order,channels.created_at)) OR (?=COALESCE((SELECT updated_at FROM sync_source_states WHERE url=channels.url),max(-channels.sort_order,channels.created_at)) AND ?>?)`,params:[url,title,nativeTrim(source.description)?source.description:source.siteUrl,source.imageUrl,source.createdAt>0?source.createdAt:now,-order,source.isPinned?1:0,authoritative?1:0,updated,updated,deviceOrder(source.sourceDeviceId||remoteDeviceId),deviceOrder(localDeviceId)]},
    {sql:stateSql,params:[url,nativeTrim(source.sourceDeviceId)?source.sourceDeviceId:remoteDeviceId,title,source.description,source.siteUrl,source.imageUrl,source.createdAt,updated,order,source.isPinned?1:0,0,0]}];
   const changes=await this.db.transactionChanges(statements.map(x=>({...x,sql:onlyChangedSql(x.sql)})));applied+=changes.some(n=>n>0)?1:0;
  }return applied;
 }
 async export(localDeviceId:string,urls?:readonly string[]):Promise<SyncedSource[]>{
  if(urls?.length===0)return [];const persisted=new Map((await this.db.query('SELECT * FROM sync_source_states')).map(r=>[s(r.url),r]));const wanted=urls?new Set(urls):null,active:SyncedSource[]=[],activeUrls=new Set<string>();
  for(let offset=0;;offset+=400){const rows=await this.db.query('SELECT * FROM channels ORDER BY is_pinned DESC,sort_order,created_at DESC,id LIMIT 400 OFFSET ?',[offset]);for(const r of rows){const url=s(r.url);if(!isSyncedSourceUrl(url)||wanted&&!wanted.has(url))continue;activeUrls.add(url);const old=persisted.get(url),same=old&&!n(old.deleted)&&s(old.title)===s(r.title)&&(nativeTrim(s(old.description))?s(old.description):s(old.site_url))===s(r.description)&&nullable(old.image_url)===nullable(r.image_url)&&n(old.sort_order)===-n(r.sort_order)&&!!n(old.is_pinned)===!!n(r.is_pinned);
   const source:SyncedSource={url,sourceDeviceId:same?s(old!.source_device_id):localDeviceId,title:s(r.title),description:same?s(old!.description):s(r.description),siteUrl:same?nullable(old!.site_url):null,imageUrl:nullable(r.image_url),createdAt:n(r.created_at),updatedAt:same?n(old!.updated_at):old?Math.max(this.now(),n(old.updated_at)+1,-n(r.sort_order),n(r.created_at)):Math.max(-n(r.sort_order),n(r.created_at)),sortOrder:-n(r.sort_order),isPinned:!!n(r.is_pinned),deleted:false,deletedAt:0};
   if(!same)await this.db.execute(stateSql,[url,source.sourceDeviceId,source.title,source.description,source.siteUrl,source.imageUrl,source.createdAt,source.updatedAt,source.sortOrder,source.isPinned?1:0,0,0]);active.push(source);}if(rows.length<400)break;}
  for(let offset=0;;offset+=400){const rows=await this.db.query('SELECT * FROM sync_source_states WHERE deleted=1 ORDER BY rowid LIMIT 400 OFFSET ?',[offset]);for(const r of rows){const url=s(r.url);if(activeUrls.has(url)||wanted&&!wanted.has(url))continue;active.push({url,sourceDeviceId:nativeTrim(s(r.source_device_id))?s(r.source_device_id):localDeviceId,title:s(r.title),description:s(r.description),siteUrl:nullable(r.site_url),imageUrl:nullable(r.image_url),createdAt:n(r.created_at),updatedAt:n(r.updated_at),sortOrder:n(r.sort_order),isPinned:!!n(r.is_pinned),deleted:!!n(r.deleted),deletedAt:n(r.deleted_at)});}if(rows.length<400)break;}
  return active;
 }
 /** Add these statements to the same transaction as a local channel removal. */
 async localDeleteStatements(id:number,deviceId:string,at=this.now()):Promise<{sql:string;params:SqlParams}[]>{
  if(!Number.isSafeInteger(at))throw new Error('Invalid source deletion clock');
  const revision=await libraryRevision(this.db),row=(await this.db.query('SELECT url FROM channels WHERE id=?',[id]))[0];
  if(!row||!isSyncedSourceUrl(s(row.url)))return [revisionGuard(revision)];
  // Test eligibility with Kotlin whitespace semantics, then retain the exact
  // stored URL. The revision guard prevents deleting a replacement row.
  return [revisionGuard(revision),{sql:`INSERT OR REPLACE INTO sync_source_states(url,source_device_id,title,description,site_url,image_url,created_at,updated_at,sort_order,is_pinned,deleted,deleted_at)
   SELECT url,?,title,COALESCE(description,''),NULL,image_url,created_at,?,-sort_order,0,1,? FROM channels WHERE id=? AND url=?`,params:[deviceId,at,at,id,s(row.url)]},
   {sql:`INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) SELECT 'rssSource',url,?,?, 'delete',? FROM channels WHERE id=? AND url=?`,params:[at,deviceId,at,id,s(row.url)]}];
 }
}
