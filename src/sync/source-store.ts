import {onlyChangedSql} from '@podjs/framework/sql-changes';
import type {ReceiptBoundary} from './library-resume/store';
import {querySyncPages} from "./sql-pages.ts";
import {cancellableSql} from '../core/sql-cancellation';
import type {SqlCancellationCheck,SqlDatabase,SqlParams} from '../core/types.ts';
import type {SyncedSource} from './library-wire.ts';
import {nativeTrim,type SyncTextPort} from './local-manifest.ts';
import {libraryRevision,revisionGuard} from './revision.ts';
import {deviceOrder} from './saved-state.ts';
import {isImportedContentUrl} from '../core/imported-content';
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
export const binaryChannelProjectionSchema=`CREATE TABLE IF NOT EXISTS library_binary_channel_projection (channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, article_title TEXT NOT NULL, sort_floor INTEGER NOT NULL, source_fetched_at INTEGER, provisional INTEGER NOT NULL CHECK(provisional IN (0,1)))`;
// Refreshing a feed claims the channel as a real source. Local pin, order
// and deletion operations record their own state in sync_source_states.
const articleProjectionJoin='LEFT JOIN library_binary_channel_projection p ON p.channel_id=c.id';
// A source tombstone carries no decision about saved articles or accepted live
// articles. Delete only feed cache rows that have no independent keep evidence.
const disposableArticle=`articles.is_saved=0
 AND NOT EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=articles.id AND s.saved=1)
 AND articles.id NOT IN(SELECT item_id FROM sync_article_keeps WHERE item_id IS NOT NULL)
 AND articles.id NOT IN(SELECT item_id FROM library_binary_article_versions)
 AND articles.id NOT IN(SELECT article_id FROM notes)`;
const articleProjectionCurrent='p.source_fetched_at IS c.last_fetched_at';
export class SqlSourceSyncStore {
 constructor(private readonly db:SqlDatabase,private readonly uri:SourceUriPort,private readonly now=Date.now,private readonly onChannelRemoved?:(content:{channel:{id:number;url:string};itemIds:number[]})=>Promise<void>){}
 private hasBinaryProjection=false;
 private async binaryProjectionAvailable(){
  if(!this.hasBinaryProjection)this.hasBinaryProjection=(await this.db.query(
   "SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_binary_channel_projection'"
  )).length>0;
  return this.hasBinaryProjection;
 }
 private async hostLabel(url:string):Promise<string>{const t=nativeTrim(url),u=t.startsWith('http://')||t.startsWith('https://')?t:'https://'+t;const p=await this.uri.parseUri(u);return nativeTrim((p.valid?p.host??'':'').replace(/^www\./,''));}
 async merge(sources:readonly SyncedSource[],remoteDeviceId:string,localDeviceId:string,authoritative=false,receipt?:ReceiptBoundary,preserveLiveArticles=false,check?:SqlCancellationCheck):Promise<number>{
  const db=cancellableSql(this.db,check);
  if(receipt&&sources.length!==1)throw Error('BUSINESS_REJECTED');
  if(!this.db.transactionChanges)throw new Error('Source sync requires committed transaction counts');let applied=0;
  const projection=sources.length>0&&await this.binaryProjectionAvailable();
  for(const source of sources){
   for(const value of [source.createdAt,source.updatedAt,source.sortOrder,source.deletedAt])if(!Number.isSafeInteger(value))throw new Error('Invalid source clock');
   const url=normalizeSourceUrl(source.url);if(url.length>2048||whitespace.test(url)){if(receipt)throw Error('BUSINESS_REJECTED');continue;}const parsed=await this.uri.parseAndroid(url);
   if(!parsed.valid||!['http','https'].includes(parsed.scheme?.toLowerCase()??'')||!nativeTrim(parsed.host??'')||nativeTrim(url).toLowerCase()==='https://watchrss.local/import-content'){if(receipt)throw Error('BUSINESS_REJECTED');continue;}
   const title=nativeTrim(source.title)?source.title:await this.hostLabel(url);
   // Freeze the current library revision before conflict reads. A concurrent
   // local edit invalidates the transaction instead of accepting a stale delete.
   const revision=await libraryRevision(this.db),old=(await this.db.query('SELECT * FROM sync_source_states WHERE url=?',[url]))[0];
   const clock=source.updatedAt||source.deletedAt||source.sortOrder||source.createdAt;
   if(!authoritative&&old&&(clock<Number(old.updated_at)||clock===Number(old.updated_at)&&deviceOrder(source.sourceDeviceId||remoteDeviceId)<deviceOrder(String(old.source_device_id)))){if(receipt){receipt.check?.();await (receipt.transaction??this.db.transaction)([...receipt.before,revisionGuard(revision),...receipt.after('retainedLocal')]);}continue;}
   const local=old&&!n(old.deleted)?undefined:(await this.db.query(projection?
    `SELECT c.created_at,c.sort_order,c.last_fetched_at,p.provisional,p.sort_floor,${articleProjectionCurrent} AS marker_current FROM channels c ${articleProjectionJoin} WHERE c.url=?`:
    'SELECT created_at,sort_order FROM channels WHERE url=?',[url]))[0];
   const provisional=local?.provisional===1&&local.marker_current===1;
   if(!authoritative&&!old&&local&&!provisional&&clock<Math.max(n(local.created_at),-n(local.sort_order),local.provisional===1?n(local.last_fetched_at):-Infinity)){if(receipt){receipt.check?.();await (receipt.transaction??this.db.transaction)([...receipt.before,revisionGuard(revision),...receipt.after('retainedLocal')]);}continue;}
   if(source.deleted){
    const updated=source.updatedAt>0?source.updatedAt:source.deletedAt>0?source.deletedAt:source.sortOrder>0?source.sortOrder:source.createdAt,deletedAt=source.deletedAt>0?source.deletedAt:updated;
    const channel=this.onChannelRemoved?(await this.db.query('SELECT id,url FROM channels WHERE url=?',[url]))[0]:undefined;
    const filter=preserveLiveArticles?' AND '+disposableArticle:'';
    const itemIds=channel?(await querySyncPages(this.db,'SELECT id FROM articles WHERE channel_id=?'+filter+' ORDER BY id',[channel.id])).map(row=>n(row.id)):[];
    const changes:{sql:string;params:SqlParams}[]=[
     {sql:stateSql,params:[url,nativeTrim(source.sourceDeviceId)?source.sourceDeviceId:remoteDeviceId,title,source.description,source.siteUrl,source.imageUrl,source.createdAt,updated,source.sortOrder,source.isPinned?1:0,1,deletedAt]},
     {sql:'DELETE FROM channels WHERE url=?',params:[url]}
    ];
    if(preserveLiveArticles){
     const latestArticle='(SELECT max(fetched_at) FROM articles WHERE channel_id=channels.id)';
     const imported=isImportedContentUrl(url),keepProjection=provisional?1:0;
     changes.splice(1,1,
      {sql:'DELETE FROM articles WHERE channel_id=(SELECT id FROM channels WHERE url=?) AND '+disposableArticle,params:[url]},
      {sql:'DELETE FROM channels WHERE url=? AND NOT EXISTS(SELECT 1 FROM articles WHERE channel_id=channels.id)',params:[url]},
      {sql:'DELETE FROM rss_local_sources WHERE url=?',params:[url]},
      // A retained channel now holds articles, like the placeholder created
      // when v1 receives those articles after merging the RSS tombstone.
      {sql:`UPDATE channels SET description=NULL,image_url=NULL,is_pinned=0,
       created_at=CASE WHEN ? THEN created_at ELSE ? END,
       sort_order=CASE WHEN ? THEN sort_order ELSE ${latestArticle} END,
       last_fetched_at=CASE WHEN ? THEN ${latestArticle} ELSE NULL END
       WHERE url=? AND (?=0 OR description IS NOT NULL OR image_url IS NOT NULL OR is_pinned!=0)`,
       params:[keepProjection,this.now(),keepProjection,imported?1:0,url,keepProjection]},
      {sql:onlyChangedSql(`INSERT INTO library_binary_channel_projection(channel_id,article_title,sort_floor,source_fetched_at,provisional)
       SELECT id,title,sort_order,last_fetched_at,1 FROM channels WHERE url=?
       ON CONFLICT(channel_id) DO UPDATE SET article_title=excluded.article_title,sort_floor=excluded.sort_floor,
       source_fetched_at=excluded.source_fetched_at,provisional=1`),params:[url]});
    }
    receipt?.check?.();
    const prefix=[...(receipt?.before??[]),revisionGuard(revision)];
    const committed=await (receipt?.transactionChanges??db.transactionChanges!)([...prefix,...changes,...(receipt?.after('merged')??[])]);
    if(channel)await this.onChannelRemoved!({channel:{id:n(channel.id),url:s(channel.url)},itemIds});
    if(committed.slice(prefix.length,prefix.length+changes.length).some(n=>n>0))applied++;continue;
   }
   const updated=source.updatedAt>0?source.updatedAt:source.sortOrder>0?source.sortOrder:source.createdAt,now=this.now(),order=source.sortOrder!==0?source.sortOrder:updated>0?updated:now;
   const description=nativeTrim(source.description)?source.description:source.siteUrl,created=source.createdAt>0?source.createdAt:now;
   // v1 applies the RSS fields before the article's display title and order.
   // Reproduce that channel projection when promoting an article placeholder.
   const channelWrite=provisional?{sql:`UPDATE channels SET description=?,image_url=?,created_at=?,sort_order=?,is_pinned=? WHERE url=?`,
    params:[description,source.imageUrl,created,Math.max(-order,n(local.sort_floor)),source.isPinned?1:0,url]}:{sql:`INSERT INTO channels(url,title,description,image_url,created_at,sort_order,is_pinned) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,image_url=excluded.image_url,sort_order=excluded.sort_order,is_pinned=excluded.is_pinned
    WHERE ?=1 OR ?>COALESCE((SELECT updated_at FROM sync_source_states WHERE url=channels.url),max(-channels.sort_order,channels.created_at)) OR (?=COALESCE((SELECT updated_at FROM sync_source_states WHERE url=channels.url),max(-channels.sort_order,channels.created_at)) AND ?>?)`,params:[url,title,description,source.imageUrl,created,-order,source.isPinned?1:0,authoritative?1:0,updated,updated,deviceOrder(source.sourceDeviceId||remoteDeviceId),deviceOrder(localDeviceId)]};
   const statements:{sql:string;params:SqlParams}[]=[revisionGuard(revision),channelWrite,
    {sql:stateSql,params:[url,nativeTrim(source.sourceDeviceId)?source.sourceDeviceId:remoteDeviceId,title,source.description,source.siteUrl,source.imageUrl,source.createdAt,updated,order,source.isPinned?1:0,0,0]}];
   if(provisional)statements.push({sql:'UPDATE library_binary_channel_projection SET provisional=0 WHERE channel_id=(SELECT id FROM channels WHERE url=?)',params:[url]});
   receipt?.check?.();const committed=await (receipt?.transactionChanges??db.transactionChanges!)([...(receipt?.before??[]),...statements.map(x=>({...x,sql:onlyChangedSql(x.sql)})),...(receipt?.after('merged')??[])]),changes=committed.slice(receipt?.before.length??0,(receipt?.before.length??0)+statements.length);applied+=changes.slice(1).some(n=>n>0)?1:0;
  }return applied;
 }
 private async *storedStates(deletedOnly:boolean){
  let after:string|undefined,limit=400;
  for(;;){
   const predicates=[...(deletedOnly?['deleted=1']:[]),...(after===undefined?[]:['rowid>CAST(? AS INTEGER)'])];
   const where=predicates.length?' WHERE '+predicates.join(' AND '):'';
   let rows;
   try{rows=await this.db.query('SELECT CAST(rowid AS TEXT) AS cursor,* FROM sync_source_states'+where+' ORDER BY rowid LIMIT ?',after===undefined?[limit]:[after,limit]);}
   catch(error){if(limit===1||!/query result too large/i.test(String(error)))throw error;limit=Math.max(1,Math.floor(limit/2));continue;}
   yield* rows;
   if(rows.length<limit)return;
   after=String(rows[rows.length-1]!.cursor);
  }
 }
 async export(localDeviceId:string,urls?:readonly string[],readOnly=false):Promise<SyncedSource[]>{
  if(urls?.length===0)return [];
  const persisted=new Map<string,Record<string,unknown>>();
  for await(const r of this.storedStates(false))persisted.set(s(r.url),r);
  const wanted=urls?new Set(urls):null,active:SyncedSource[]=[],activeUrls=new Set<string>();
  const projection=await this.binaryProjectionAvailable();
  let cursor:number[]=[];
  for(;;){
   const select=projection?`SELECT c.*,p.provisional,p.sort_floor,${articleProjectionCurrent} AS marker_current,
    CASE WHEN ${articleProjectionCurrent} THEN p.article_title END AS article_title FROM channels c ${articleProjectionJoin}`:'SELECT c.* FROM channels c';
   // Each disjoint range seeks into the mixed-direction index. SQLite merges
   // the four ordered streams and stops after the page limit.
   const ranges=['c.is_pinned<?','c.is_pinned=? AND c.sort_order>?',
    'c.is_pinned=? AND c.sort_order=? AND c.created_at<?',
    'c.is_pinned=? AND c.sort_order=? AND c.created_at=? AND c.id>?'];
   const query=cursor.length?ranges.map(range=>select+' WHERE '+range).join(' UNION ALL '):select;
   const params=cursor.length?ranges.flatMap((_,i)=>cursor.slice(0,i+1)):[];
   const rows=await this.db.query(query+' ORDER BY is_pinned DESC,sort_order,created_at DESC,id LIMIT 400',params);
   const writes:{sql:string;params:SqlParams}[]=[];
   for(const r of rows){
    const url=s(r.url);
    if(!isSyncedSourceUrl(url)||wanted&&!wanted.has(url))continue;
    const old=persisted.get(url);
    if(r.provisional===1&&r.marker_current===1&&(!old||n(old.deleted)))continue;
    activeUrls.add(url);
    const projectedTitle=projection&&r.article_title===r.title,storedOrder=-n(r.sort_order);
    const same=old&&!n(old.deleted)&&(s(old.title)===s(r.title)||projectedTitle)&&
     (nativeTrim(s(old.description))?s(old.description):s(old.site_url))===s(r.description)&&nullable(old.image_url)===nullable(r.image_url)&&
     (n(old.sort_order)===storedOrder||projectedTitle&&n(r.sort_order)===Math.max(-n(old.sort_order),n(r.sort_floor)))&&
     !!n(old.is_pinned)===!!n(r.is_pinned);
    const createdAt=n(r.created_at);
    const source:SyncedSource={url,sourceDeviceId:same?s(old.source_device_id):localDeviceId,
     title:same?s(old.title):s(r.title),description:same?s(old.description):s(r.description),
     siteUrl:same?nullable(old.site_url):null,imageUrl:nullable(r.image_url),createdAt,
     updatedAt:same?n(old.updated_at):old?Math.max(this.now(),n(old.updated_at)+1,storedOrder,createdAt):
      Math.max(storedOrder,createdAt,r.provisional===1?n(r.last_fetched_at):-Infinity),
     sortOrder:same?n(old.sort_order):storedOrder,isPinned:!!n(r.is_pinned),deleted:false,deletedAt:0};
    if(!same&&!readOnly)writes.push({sql:stateSql,params:[url,source.sourceDeviceId,source.title,source.description,source.siteUrl,source.imageUrl,source.createdAt,source.updatedAt,source.sortOrder,source.isPinned?1:0,0,0]});
    active.push(source);
   }
   for(let at=0;at<writes.length;at+=32)await this.db.transaction(writes.slice(at,at+32));
   if(rows.length<400)break;
   const last=rows[rows.length-1]!;cursor=[n(last.is_pinned),n(last.sort_order),n(last.created_at),n(last.id)];
  }
  for await(const r of this.storedStates(true)){const url=s(r.url);if(activeUrls.has(url)||wanted&&!wanted.has(url))continue;active.push({url,sourceDeviceId:nativeTrim(s(r.source_device_id))?s(r.source_device_id):localDeviceId,title:s(r.title),description:s(r.description),siteUrl:nullable(r.site_url),imageUrl:nullable(r.image_url),createdAt:n(r.created_at),updatedAt:n(r.updated_at),sortOrder:n(r.sort_order),isPinned:!!n(r.is_pinned),deleted:!!n(r.deleted),deletedAt:n(r.deleted_at)});}
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
