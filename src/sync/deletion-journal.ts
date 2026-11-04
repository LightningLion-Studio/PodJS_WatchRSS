import {idleHit} from '../diagnostics/idle-counters';
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {SyncBodyCodec} from './article-body.ts';
import {stableArticleId,type SyncTextPort} from './local-manifest.ts';
import {deviceOrder,SyncSavedStateStore} from './saved-state.ts';
import {libraryRevision,revisionGuard} from './revision.ts';
import {changeLogStatement} from './sequence-store.ts';
/** Replay local deletions before any remote merge. Each page atomically consumes
 * its journal rows, so restart cannot reinterpret an old local event after a
 * later authoritative remote replacement. */
export async function migrateLocalDeletionJournal(db:SqlDatabase,device:string,text:SyncTextPort,codec:SyncBodyCodec):Promise<void>{
 const saved=new SyncSavedStateStore(db);
 for(;;){idleHit(39);const revision=await libraryRevision(db),rows=await db.query('SELECT * FROM local_article_deletions ORDER BY id LIMIT 200');if(!rows.length)return;
  const statements:{sql:string;params?:SqlParams}[]=[revisionGuard(revision)];
  for(const row of rows){const url=String(row.article_url),id=await stableArticleId(url,text.parseUri,codec),at=Number(row.changed_at);if(!Number.isSafeInteger(at))throw new Error('Invalid local deletion clock');
   statements.push({sql:'INSERT INTO sync_article_deletions(article_id,url,changed_at,source_device_id,source_order) VALUES(?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET url=excluded.url,changed_at=excluded.changed_at,source_device_id=excluded.source_device_id,source_order=excluded.source_order',params:[id,url,at,device,deviceOrder(device)]});
   for(const type of ['favorite','watchLater'] as const)if(Number(row[type==='favorite'?'was_favorite':'was_watch_later']))statements.push(...saved.remoteStatements({articleId:id,url,type,saved:false,changedAt:at,sortOrder:0,sourceDeviceId:device},{authoritative:true,tombstone:true}));
   statements.push(changeLogStatement('article',id,at,device,'delete',at),{sql:'DELETE FROM local_article_deletions WHERE id=?',params:[row.id]});
  }
  await db.transaction(statements);
 }
}
