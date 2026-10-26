import {querySyncPages} from './sql-pages.ts';
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {ArticleManifest} from './manifest.ts';
import type {SyncedSource} from './library-wire.ts';
import type {SyncBodyCodec} from './article-body.ts';
import {hashJavaText} from './article-export.ts';
import {revisionGuard} from './revision.ts';
/** Content signatures supplement native timestamp repair: read state and other
 * local edits must remain eligible even when their article timestamp is equal.
 * Each host transaction stays below its 2048-statement limit. */
export async function reconcileSnapshotLog(db:SqlDatabase,codec:SyncBodyCodec,revision:number,device:string,articles:readonly ArticleManifest[],sources:readonly SyncedSource[],now:number,scope='',changedArticleIds?:ReadonlySet<string>,seedOnly=false):Promise<void>{
 const records:{kind:string;id:string;signature:string;changed:number;origin:string}[]=[],keys=new Set<string>();
 for(const a of articles){if(changedArticleIds&&!changedArticleIds.has(a.articleId))continue;const key='article'+scope+'\0'+a.articleId;if(keys.has(key))continue;keys.add(key);records.push({kind:'article',id:a.articleId,signature:await hashJavaText(JSON.stringify(a),codec),changed:Math.max(a.updatedAt,a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt,a.deletedAt,a.readingPositionChangedAt),origin:a.sourceDeviceId||device});}
 for(const s of sources){const key='rssSource'+scope+'\0'+s.url;if(keys.has(key))continue;keys.add(key);records.push({kind:'rssSource',id:s.url,signature:await hashJavaText(JSON.stringify(s),codec),changed:Math.max(s.createdAt,s.updatedAt,s.deletedAt,s.sortOrder),origin:s.sourceDeviceId||device});}
 const stored=new Map<string,string>();
 const remember=(rows:Record<string,unknown>[])=>{for(const row of rows)stored.set(String(row.kind)+'\0'+String(row.entity_id),String(row.signature));};
 if(changedArticleIds){
  remember(await querySyncPages(db,'SELECT kind,entity_id,signature FROM sync_snapshot_fingerprints WHERE kind=? ORDER BY kind,entity_id',['rssSource'+scope]));
  const ids=[...changedArticleIds];for(let at=0;at<ids.length;at+=500){const page=ids.slice(at,at+500);remember(await querySyncPages(db,'SELECT kind,entity_id,signature FROM sync_snapshot_fingerprints WHERE kind=? AND entity_id IN ('+page.map(()=>'?').join(',')+') ORDER BY kind,entity_id',['article'+scope,...page]));}
 }else remember(await querySyncPages(db,'SELECT kind,entity_id,signature FROM sync_snapshot_fingerprints WHERE kind IN (?,?) ORDER BY kind,entity_id',['article'+scope,'rssSource'+scope]));
 let statements:{sql:string;params?:SqlParams}[]=[revisionGuard(revision)];
 const flush=async()=>{await db.transaction(statements);statements=[revisionGuard(revision)];};
 for(const r of records){if(!Number.isSafeInteger(r.changed)||!Number.isSafeInteger(now))throw new Error('Invalid snapshot clock');
  if(stored.get(r.kind+scope+'\0'+r.id)===r.signature)continue;
  statements.push(...(seedOnly?[]:[{sql:`INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) SELECT ?,?,?,?,'snapshotChange',? WHERE NOT EXISTS(SELECT 1 FROM sync_snapshot_fingerprints WHERE kind=? AND entity_id=? AND signature=?)`,params:[r.kind,r.id,r.changed,r.origin,now,r.kind+scope,r.id,r.signature]}]),
   {sql:`INSERT INTO sync_snapshot_fingerprints(kind,entity_id,signature) VALUES(?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET signature=excluded.signature`,params:[r.kind+scope,r.id,r.signature]});if(statements.length>=1001)await flush();
 }
 for(const key of stored.keys())if(!keys.has(key)){const split=key.indexOf('\0'),kind=key.slice(0,split),id=key.slice(split+1);statements.push({sql:'DELETE FROM sync_snapshot_fingerprints WHERE kind=? AND entity_id=?',params:[kind,id]});if(statements.length>=1001)await flush();}
 await flush();
}
